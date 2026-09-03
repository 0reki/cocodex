import type { EnqueueResponseSettlementInput } from "./response-settlement-services.ts";

export function createUpstreamErrorServices(deps: {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  enqueueResponseSettlement: (
    input: EnqueueResponseSettlementInput,
  ) => Promise<void>;
}) {
  function extractUpstreamStatusCode(error: unknown): number | null {
    if (deps.isRecord(error) && typeof error.status === "number") {
      const status = Math.trunc(error.status);
      if (status >= 100 && status <= 599) return status;
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    if (!message) return null;
    const match = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return null;
    const status = Math.trunc(parsed);
    return status >= 100 && status <= 599 ? status : null;
  }

  function normalizeUpstreamErrorMessage(message: string | null): string | null {
    if (!message) return message;
    const trimmed = message.trim();
    const stripped = trimmed.replace(
      /^\/backend-api\/[^\s]+\s+HTTP\s+\d{3}\s*:\s*/i,
      "",
    );
    return stripped || trimmed;
  }

  function extractAttachedResponseText(error: unknown): string | null {
    if (!deps.isRecord(error)) return null;
    const candidateKeys = [
      "responseText",
      "responseBodyText",
      "bodyText",
      "rawResponseText",
    ] as const;
    for (const key of candidateKeys) {
      const value = error[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  function extractErrorInfo(error: unknown): {
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
    rawResponseText: string | null;
  } {
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : null;
    const rawResponseText = extractAttachedResponseText(error);
    let status = extractUpstreamStatusCode(error);
    let errorPayload: Record<string, unknown> | null = null;
    let message: string | null = null;

    const candidates: string[] = [];
    if (rawResponseText) {
      candidates.push(rawResponseText);
    }
    if (rawMessage) {
      if (!candidates.includes(rawMessage)) {
        candidates.push(rawMessage);
      }
      const httpBodyMatch = rawMessage.match(/\bHTTP\s+\d{3}\s*:\s*([\s\S]+)$/i);
      if (httpBodyMatch && typeof httpBodyMatch[1] === "string") {
        const httpBodyText = httpBodyMatch[1].trim();
        if (httpBodyText && !candidates.includes(httpBodyText)) {
          candidates.push(httpBodyText);
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (!deps.isRecord(parsed)) continue;
        if (typeof parsed.status === "number" && status === null) {
          const parsedStatus = Math.trunc(parsed.status);
          if (parsedStatus >= 100 && parsedStatus <= 599) {
            status = parsedStatus;
          }
        }
        if (deps.isRecord(parsed.error)) {
          errorPayload = parsed.error;
        } else if (
          typeof parsed.message === "string" ||
          typeof parsed.detail === "string" ||
          typeof parsed.code === "string"
        ) {
          errorPayload = parsed;
        }
        if (errorPayload) {
          message =
            typeof errorPayload.message === "string"
              ? errorPayload.message
              : typeof errorPayload.detail === "string"
                ? errorPayload.detail
                : null;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!message) {
      message = rawMessage;
    }

    return {
      status,
      errorPayload,
      message: normalizeUpstreamErrorMessage(message),
      rawResponseText,
    };
  }

  function buildPassthroughUpstreamError(args: {
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    fallbackCode: string;
    fallbackMessage: string;
  }): {
    status: number;
    error: {
      message: string;
      type: string;
      code: string;
    };
  } {
    const status =
      typeof args.status === "number" &&
      Number.isFinite(args.status) &&
      args.status >= 400 &&
      args.status <= 599
        ? Math.trunc(args.status)
        : 502;
    const payload = deps.isRecord(args.errorPayload?.error)
      ? (args.errorPayload?.error as Record<string, unknown>)
      : args.errorPayload;
    const message =
      (typeof payload?.message === "string" && payload.message.trim()) ||
      (typeof payload?.detail === "string" && payload.detail.trim()) ||
      args.fallbackMessage;
    const type =
      (typeof payload?.type === "string" && payload.type.trim()) ||
      (status >= 500 ? "server_error" : "invalid_request_error");
    const code =
      (typeof payload?.code === "string" && payload.code.trim()) ||
      args.fallbackCode;
    return {
      status,
      error: {
        message,
        type,
        code,
      },
    };
  }

  function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException) {
      return error.name === "AbortError";
    }
    if (error instanceof Error) {
      if (error.name === "AbortError") return true;
      const normalized = error.message.toLowerCase();
      return normalized.includes("aborted") || normalized.includes("aborterror");
    }
    if (deps.isRecord(error)) {
      const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
      if (name === "aborterror") return true;
      const code = typeof error.code === "string" ? error.code.toLowerCase() : "";
      if (code === "aborted" || code === "abort_err") return true;
      const message =
        typeof error.message === "string" ? error.message.toLowerCase() : "";
      if (message.includes("aborted") || message.includes("aborterror")) {
        return true;
      }
    }
    return false;
  }

  function shouldPersistModelResponseLog(requestPath: string): boolean {
    return !/^\/api(?:\/|$)/i.test(requestPath);
  }

  async function persistQuotaExceededLog(args: {
    requestPath: string;
    intentId: string;
    model: string | null;
    keyId: string | null;
    ownerUserId?: string | null;
    startedAtMs: number;
  }) {
    if (!shouldPersistModelResponseLog(args.requestPath)) return;
    try {
      await deps.enqueueResponseSettlement({
        settlementId: args.intentId,
        intentId: args.intentId,
        ownerUserId: args.ownerUserId,
        apiKeyId: args.keyId,
        isFinal: false,
        path: args.requestPath,
        modelId: args.model,
        statusCode: 429,
        latencyMs: 0,
        errorCode: "insufficient_quota",
        errorMessage: "API key quota exceeded",
        requestTime: new Date(args.startedAtMs).toISOString(),
      });
    } catch (error) {
      console.warn(
        `[logs] failed to write quota log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function persistShortCircuitErrorLog(args: {
    requestPath: string;
    intentId: string;
    model: string | null;
    keyId: string | null;
    ownerUserId?: string | null;
    startedAtMs: number;
    statusCode: number;
    errorCode: string;
    errorMessage: string;
  }) {
    if (!shouldPersistModelResponseLog(args.requestPath)) return;
    try {
      await deps.enqueueResponseSettlement({
        settlementId: args.intentId,
        intentId: args.intentId,
        ownerUserId: args.ownerUserId,
        apiKeyId: args.keyId,
        isFinal: false,
        path: args.requestPath,
        modelId: args.model,
        statusCode: args.statusCode,
        latencyMs: 0,
        errorCode: args.errorCode,
        errorMessage: args.errorMessage,
        requestTime: new Date(args.startedAtMs).toISOString(),
      });
    } catch (error) {
      console.warn(
        `[logs] failed to write short-circuit log: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function isTokenInvalidatedError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    return /\bHTTP\s+401\b/i.test(message);
  }

  return {
    extractErrorInfo,
    buildPassthroughUpstreamError,
    isAbortError,
    shouldPersistModelResponseLog,
    persistQuotaExceededLog,
    persistShortCircuitErrorLog,
    isTokenInvalidatedError,
  };
}
