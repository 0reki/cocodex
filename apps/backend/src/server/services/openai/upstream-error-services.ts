export function createUpstreamErrorServices(deps: {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  resolveOpenAIUpstreamAccountId: (account: {
    accountId: string | null;
    userId: string | null;
  }) => string | null;
  createModelResponseLog: (args: {
    intentId?: string | null;
    attemptNo?: number | null;
    isFinal?: boolean | null;
    retryReason?: string | null;
    heartbeatCount?: number | null;
    path: string;
    modelId?: string | null;
    keyId?: string | null;
    userId?: string | null;
    sourceAccountId?: string | null;
    sourceAccountEmail?: string | null;
    sourceProxyId?: string | null;
    selectedUpstreamAccountId?: string | null;
    selectedProxyUrl?: string | null;
    statusCode?: number | null;
    latencyMs?: number | null;
    errorCode?: string | null;
    errorType?: string | null;
    errorMessage?: string | null;
    internalErrorDetails?: Record<string, unknown> | null;
    requestTime?: string | Date | null;
  }) => Promise<unknown>;
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

  function normalizeProxyErrorMessage(message: string | null): string | null {
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
      message: normalizeProxyErrorMessage(message),
      rawResponseText,
    };
  }

  function redactProxyUrlForInternalLogs(proxyUrl: string | null): string | null {
    if (!proxyUrl) return null;
    const trimmed = proxyUrl.trim();
    if (!trimmed) return null;
    try {
      const url = new URL(trimmed);
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return trimmed.replace(/\/\/[^/@]+@/, "//");
    }
  }

  function buildInternalUpstreamErrorDetails(args: {
    path: string;
    model: string | null;
    status: number | null;
    sourceAccount: {
      id: string;
      email: string;
      proxyId?: string | null;
      accountId?: string | null;
      userId?: string | null;
    } | null;
    trace: {
      sourceAccountId?: string | null;
      sourceAccountEmail?: string | null;
      sourceProxyId?: string | null;
      selectedUpstreamAccountId?: string | null;
      selectedProxyUrl?: string | null;
    } | null;
    errorInfo: ReturnType<typeof extractErrorInfo>;
  }): Record<string, unknown> | null {
    const sourceAccount = args.sourceAccount;
    const trace = args.trace;
    const proxyUrl =
      typeof trace?.selectedProxyUrl === "string" ? trace.selectedProxyUrl : null;
    const payload = args.errorInfo.errorPayload;
    const details: Record<string, unknown> = {
      path: args.path,
      model: args.model,
      status: args.status,
      sourceAccountId: trace?.sourceAccountId ?? sourceAccount?.id ?? null,
      sourceAccountEmail:
        trace?.sourceAccountEmail ?? sourceAccount?.email ?? null,
      sourceProxyId: trace?.sourceProxyId ?? sourceAccount?.proxyId ?? null,
      selectedUpstreamAccountId:
        trace?.selectedUpstreamAccountId ??
        (sourceAccount
          ? deps.resolveOpenAIUpstreamAccountId({
              accountId: sourceAccount.accountId ?? null,
              userId: sourceAccount.userId ?? null,
            })
          : null),
      selectedProxyUrl: redactProxyUrlForInternalLogs(proxyUrl),
      publicErrorMessage: args.errorInfo.message,
      upstreamErrorCode: typeof payload?.code === "string" ? payload.code : null,
      upstreamErrorType: typeof payload?.type === "string" ? payload.type : null,
      upstreamErrorMessage:
        typeof payload?.message === "string"
          ? payload.message
          : typeof payload?.detail === "string"
            ? payload.detail
            : null,
      upstreamErrorPayload: payload,
      upstreamResponseText: args.errorInfo.rawResponseText?.slice(0, 4_000) ?? null,
    };

    return Object.values(details).some((value) => value !== null) ? details : null;
  }

  function logInternalUpstreamFailure(args: {
    intentId: string;
    path: string;
    details: Record<string, unknown> | null;
  }) {
    if (!args.details) return;
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

  function isConnectionTimeoutError(error: unknown): boolean {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const normalized = message.toLowerCase();
    return (
      normalized === "fetch failed" ||
      normalized.includes("fetch failed") ||
      normalized.includes("terminated") ||
      normalized.includes("socketerror") ||
      normalized.includes("und_err_socket") ||
      normalized.includes("econnreset") ||
      normalized.includes("socket hang up") ||
      normalized.includes("other side closed") ||
      normalized.includes("network error") ||
      normalized.includes("timeout") ||
      normalized.includes("timed out") ||
      normalized.includes("etimedout") ||
      normalized.includes("connect_timeout") ||
      normalized.includes("headers timeout") ||
      normalized.includes("body timeout") ||
      normalized.includes("connection refused") ||
      normalized.includes("connect error") ||
      normalized.includes("connect_exception") ||
      normalized.includes("delayed connect error") ||
      normalized.includes("remote connection failure") ||
      normalized.includes("transport failure") ||
      normalized.includes("disconnect/reset before headers") ||
      normalized.includes("upstream connect error")
    );
  }

  function isUpstreamBufferRetryLimitError(args: {
    error: unknown;
    status: number | null;
    message: string | null;
    errorPayload: Record<string, unknown> | null;
  }): boolean {
    const code =
      args.errorPayload && typeof args.errorPayload.code === "string"
        ? args.errorPayload.code.toLowerCase()
        : "";
    const rawMessage =
      args.message ??
      (args.errorPayload && typeof args.errorPayload.message === "string"
        ? args.errorPayload.message
        : args.error instanceof Error
          ? args.error.message
          : typeof args.error === "string"
            ? args.error
            : "");
    const normalized = rawMessage.toLowerCase();

    if (args.status !== 503 && args.status !== 507) return false;
    if (code === "upstream_connect_error") return true;
    return (
      normalized.includes(
        "exceeded request buffer limit while retrying upstream",
      ) ||
      normalized.includes("retrying upstream") ||
      normalized.includes("upstream connect error") ||
      normalized.includes("disconnect/reset before headers")
    );
  }

  function isRetryableUpstreamServerErrorStatus(status: number | null): boolean {
    return status !== null && status >= 500 && status <= 599 && status !== 507;
  }

  function computeRetryDelayMs(attemptNo: number): number {
    const base = 250;
    return Math.min(2_000, base * 2 ** Math.max(0, attemptNo - 1));
  }

  function createAbortError() {
    const error = new Error("Aborted");
    error.name = "AbortError";
    return error;
  }

  async function sleep(ms: number, signal?: AbortSignal) {
    if (!signal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (signal.aborted) {
      throw createAbortError();
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function shouldPersistModelResponseLog(requestPath: string): boolean {
    return !/^\/api(?:\/|$)/i.test(requestPath);
  }

  async function persistQuotaExceededLog(args: {
    requestPath: string;
    intentId: string;
    attemptNo: number;
    retryReason: string | null;
    model: string | null;
    keyId: string | null;
    startedAtMs: number;
  }) {
    if (!shouldPersistModelResponseLog(args.requestPath)) return;
    try {
      await deps.createModelResponseLog({
        intentId: args.intentId,
        attemptNo: args.attemptNo,
        isFinal: false,
        retryReason: args.retryReason,
        path: args.requestPath,
        modelId: args.model,
        keyId: args.keyId,
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
    attemptNo: number;
    retryReason: string | null;
    model: string | null;
    keyId: string | null;
    startedAtMs: number;
    statusCode: number;
    errorCode: string;
    errorMessage: string;
  }) {
    if (!shouldPersistModelResponseLog(args.requestPath)) return;
    try {
      await deps.createModelResponseLog({
        intentId: args.intentId,
        attemptNo: args.attemptNo,
        isFinal: false,
        retryReason: args.retryReason,
        path: args.requestPath,
        modelId: args.model,
        keyId: args.keyId,
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
    const normalized = message.toLowerCase();
    return (
      /\bHTTP\s+401\b/i.test(message) &&
      (normalized.includes("token_invalidated") ||
        normalized.includes("token_revoked"))
    );
  }

  function isRetryableEmptyForbiddenUpstreamError(args: {
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
    rawResponseText: string | null;
  }): boolean {
    if (args.status !== 403) return false;
    if (args.errorPayload && Object.keys(args.errorPayload).length > 0) {
      return false;
    }
    const rawResponseText = args.rawResponseText?.trim() ?? "";
    if (rawResponseText.length > 0) return false;
    const message = (args.message ?? "").trim().toLowerCase();
    return message.length === 0 || message.includes("http 403");
  }

  function isUpstreamAccountSwitchRetryableError(args: {
    error: unknown;
    status: number | null;
    errorPayload: Record<string, unknown> | null;
    message: string | null;
  }): boolean {
    if (isTokenInvalidatedError(args.error)) return true;

    const code =
      args.errorPayload && typeof args.errorPayload.code === "string"
        ? args.errorPayload.code.toLowerCase()
        : "";
    const message = (args.message ?? "").toLowerCase();

    if (args.status === 401) return true;
    if (code === "token_invalidated" || code === "token_revoked") return true;
    if (message.includes("account disabled:")) return true;
    if (
      args.status === 403 &&
      (message.includes("does not have access to any accounts") ||
        message.includes("does not have access to any account"))
    ) {
      return true;
    }
    if (message.includes("invalidated oauth token")) return true;
    if (message.includes("token_revoked")) return true;
    return false;
  }

  return {
    extractErrorInfo,
    buildInternalUpstreamErrorDetails,
    logInternalUpstreamFailure,
    buildPassthroughUpstreamError,
    isAbortError,
    isConnectionTimeoutError,
    isUpstreamBufferRetryLimitError,
    isRetryableUpstreamServerErrorStatus,
    computeRetryDelayMs,
    createAbortError,
    sleep,
    shouldPersistModelResponseLog,
    persistQuotaExceededLog,
    persistShortCircuitErrorLog,
    isTokenInvalidatedError,
    isRetryableEmptyForbiddenUpstreamError,
    isUpstreamAccountSwitchRetryableError,
  };
}
