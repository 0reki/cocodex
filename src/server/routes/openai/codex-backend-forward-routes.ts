import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { Express, Request, Response as ExpressResponse } from "express";
import * as openaiApiModule from "../../../openai-api/index.ts";
import { isRecord } from "../../openai-response-utils.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import {
  finalizeOpenAIRouteAccounting,
  getReadyAssignedSourceAccount,
  persistOpenAIResponseLog,
  prepareOpenAIRouteRequest,
  type ActiveSourceAccountDependencies,
  type OpenAIAccountingDependencies,
  type OpenAIRequestPreparationDependencies,
  type OpenAIResponseLogDependencies,
  type OpenAIResponsesRouteDependencies,
  type UpstreamQuotaDependencies,
} from "../../services/openai/openai-route-services.ts";
import {
  forwardUpstreamResponse,
  type ResponseTerminalStatus,
} from "../../services/openai/transparent-response-proxy.ts";
import {
  applyUpstreamResponseHeaders,
  classifyCodexBackendForward,
  getForwardRequestHeaders,
  parseContentEncodingHeader,
  readRequestBodyBuffer,
  resolveFastServiceTierForBilling,
  zstdDecompressBuffer,
  type CodexBackendForwardKind,
} from "../../utils/index.ts";

const BACKEND_API_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

type CodexBackendForwardDependencies = OpenAIRequestPreparationDependencies &
  ActiveSourceAccountDependencies &
  OpenAIAccountingDependencies &
  OpenAIResponseLogDependencies &
  UpstreamQuotaDependencies &
  Pick<
    ServerServices,
    | "createRequestAbortContext"
    | "getOpenAIApiRuntimeConfig"
    | "forwardCodexBackendWithTokenRefresh"
    | "extractErrorInfo"
    | "isAbortError"
    | "buildPassthroughUpstreamError"
    | "shouldPersistModelResponseLog"
    | "resolveUsagePricingModelId"
  > & {
    resolveFastServiceTierForBilling: typeof resolveFastServiceTierForBilling;
  };

async function clientBody(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return req.body;
  if (req.readableEnded || req.complete) {
    if (req.body && typeof req.body === "object") {
      return Buffer.from(JSON.stringify(req.body));
    }
    return null;
  }
  return readRequestBodyBuffer(req, BACKEND_API_BODY_LIMIT_BYTES);
}

function requestQuery(req: Request) {
  const url = req.originalUrl || req.url;
  const index = url.indexOf("?");
  return index >= 0 ? url.slice(index) : "";
}

function upstreamBackendPath(req: Request) {
  if (req.path.startsWith("/backend-api/")) return req.path;
  return `/backend-api${req.path === "/" ? "" : req.path}`;
}

export async function peekCodexRequestRecord(
  body: Buffer | string | null,
  contentEncoding: string | string[] | undefined,
): Promise<Record<string, unknown> | null> {
  if (body == null) return null;
  const encodings = parseContentEncodingHeader(contentEncoding);
  try {
    let text: string;
    if (encodings.length === 1 && encodings[0] === "zstd") {
      const buffer = typeof body === "string" ? Buffer.from(body) : body;
      const decompressed = await zstdDecompressBuffer(
        buffer,
        BACKEND_API_BODY_LIMIT_BYTES,
      );
      text = decompressed.toString("utf8");
    } else if (encodings.length === 0) {
      text = typeof body === "string" ? body : body.toString("utf8");
    } else {
      return null;
    }
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pipeUpstreamBody(upstream: globalThis.Response, res: ExpressResponse) {
  applyUpstreamResponseHeaders(res, upstream.headers);
  res.status(upstream.status);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  const stream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(value));
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  stream.pipe(res);
}

async function handlePassthroughForward(
  req: Request,
  res: ExpressResponse,
  deps: CodexBackendForwardDependencies,
  body: Buffer | string | null,
) {
  const requestAbort = deps.createRequestAbortContext(req, res);
  try {
    const { apiKey, reason } = await deps.authenticateApiKeyWithReason(req);
    if (!apiKey) {
      const authError = deps.getApiKeyAuthErrorDetail(reason);
      res.status(401).json({
        error: {
          message: authError.message,
          type: "invalid_request_error",
          code: authError.code,
        },
      });
      return;
    }
    if (!deps.isApiKeyBoundToUser(apiKey)) {
      res.status(403).json({
        error: {
          message: "API key must be bound to a user",
          type: "invalid_request_error",
          code: "api_key_owner_missing",
        },
      });
      return;
    }

    const assignedAccount = await getReadyAssignedSourceAccount({
      deps,
      ownerUserId: apiKey.ownerUserId,
    });
    if (!assignedAccount.ok) {
      res.status(403).json({
        error: {
          message: "No upstream account assigned",
          type: "invalid_request_error",
          code: "upstream_account_unassigned",
        },
      });
      return;
    }

    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    const upstream = await deps.forwardCodexBackendWithTokenRefresh({
      module: openaiApiModule,
      account: assignedAccount.sourceAccount,
      runtimeConfig,
      method: req.method,
      path: upstreamBackendPath(req),
      query: requestQuery(req),
      requestHeaders: getForwardRequestHeaders(req.headers),
      body,
      signal: requestAbort.signal,
    });
    pipeUpstreamBody(upstream, res);
  } catch (error) {
    if (res.headersSent) return;
    const errorInfo = deps.extractErrorInfo(error);
    const passthrough = deps.buildPassthroughUpstreamError({
      status: errorInfo.status,
      errorPayload: errorInfo.errorPayload,
      fallbackCode: "codex_backend_forward_failed",
      fallbackMessage: errorInfo.message ?? "Failed to forward Codex backend request",
    });
    res.status(passthrough.status).json({ error: passthrough.error });
  } finally {
    requestAbort.cleanup();
  }
}

async function handleAccountedForward(
  req: Request,
  res: ExpressResponse,
  deps: CodexBackendForwardDependencies,
  args: {
    kind: Exclude<CodexBackendForwardKind, "passthrough">;
    requestPath: string;
    body: Buffer | string | null;
    requestRecord: Record<string, unknown> | null;
  },
) {
  const { kind, requestPath, body, requestRecord } = args;
  const startedAtMs = Date.now();
  const intentId = crypto.randomUUID();
  res.locals.intentId = intentId;
  const billable = kind === "responses";
  let model = stringField(requestRecord, "model");
  const serviceTier = deps.resolveFastServiceTierForBilling(
    requestRecord?.service_tier,
  );
  let pricingModelId = deps.resolveUsagePricingModelId(
    model,
    requestRecord ?? {},
  );
  const requestAbort = deps.createRequestAbortContext(req, res);

  let apiKeyId: string | null = null;
  let ownerUserId: string | null = null;
  let upstreamStatus: number | null = null;
  let firstEventAtMs: number | null = null;
  let finishedAtMs: number | null = null;
  let terminalResponsePayload: Record<string, unknown> | null = null;
  let terminalStatus: ResponseTerminalStatus | null = null;
  let lastErrorPayload: Record<string, unknown> | null = null;
  let errorMessage: string | null = null;
  let alreadyPersistedQuotaLog = false;
  let terminalSettlementPersisted = false;
  let quotaSourceAccount: Parameters<
    OpenAIResponsesRouteDependencies["ensureUserUpstreamQuota"]
  >[0]["sourceAccount"] | null = null;
  let upstreamRequestStarted = false;
  let upstreamQuotaRejected = false;
  let requestSucceeded = false;

  const applyObservedModel = (payload: Record<string, unknown> | null) => {
    const observedModel = stringField(payload, "model");
    if (!observedModel) return;
    if (!model) model = observedModel;
    pricingModelId = deps.resolveUsagePricingModelId(
      model,
      requestRecord ?? payload,
    );
  };

  try {
    const preparedRequest = await prepareOpenAIRouteRequest({
      req,
      res,
      deps,
      intentId,
      model,
      startedAtMs,
      billable,
      requestPath,
    });
    if (!preparedRequest.ok) {
      alreadyPersistedQuotaLog = preparedRequest.alreadyPersistedQuotaLog;
      apiKeyId = preparedRequest.apiKeyId ?? null;
      ownerUserId = preparedRequest.ownerUserId ?? null;
      return;
    }
    apiKeyId = preparedRequest.apiKeyId;
    ownerUserId = preparedRequest.ownerUserId;

    const assignedAccount = await getReadyAssignedSourceAccount({
      deps,
      ownerUserId,
    });
    if (!assignedAccount.ok) {
      upstreamStatus = 403;
      res.status(403).json({
        error: {
          message: "No upstream account assigned",
          type: "invalid_request_error",
          code: "upstream_account_unassigned",
        },
      });
      return;
    }
    quotaSourceAccount = assignedAccount.sourceAccount;

    if (billable) {
      const quota = await deps.ensureUserUpstreamQuota({
        sourceAccount: assignedAccount.sourceAccount,
        ownerUserId,
        model,
      });
      if (!quota.allowed) {
        upstreamQuotaRejected = true;
        upstreamStatus = 429;
        errorMessage = "Upstream weekly user quota exceeded";
        res.status(429).json({
          error: {
            message: errorMessage,
            type: "insufficient_quota",
            code: "upstream_user_quota_exceeded",
          },
        });
        return;
      }
    }

    const runtimeConfig = await deps.getOpenAIApiRuntimeConfig();
    upstreamRequestStarted = true;
    const upstream = await deps.forwardCodexBackendWithTokenRefresh({
      module: openaiApiModule,
      account: assignedAccount.sourceAccount,
      runtimeConfig,
      method: req.method,
      path: requestPath,
      query: requestQuery(req),
      requestHeaders: getForwardRequestHeaders(req.headers),
      body,
      signal: requestAbort.signal,
    });
    upstreamStatus = upstream.status;
    requestSucceeded = upstream.ok;

    const observation = await forwardUpstreamResponse(upstream, res, {
      expectEventStream: billable && upstream.ok,
      jsonTailBytes: billable ? undefined : 256 * 1024,
      onTerminalResponse: billable
        ? async (terminal) => {
            firstEventAtMs = terminal.firstByteAtMs;
            finishedAtMs = Date.now();
            terminalResponsePayload = terminal.terminalResponsePayload;
            terminalStatus = terminal.terminalStatus;
            lastErrorPayload = terminal.errorPayload;
            applyObservedModel(terminal.terminalResponsePayload);
            const accounting = finalizeOpenAIRouteAccounting({
              deps,
              apiKeyId,
              model,
              pricingModelId,
              usageResponsePayload: terminal.terminalResponsePayload,
              lastErrorPayload: terminal.errorPayload,
              serviceTier,
              billable,
            });
            const completed = terminal.terminalStatus === "completed";
            await persistOpenAIResponseLog({
              deps,
              shouldPersist:
                !alreadyPersistedQuotaLog &&
                deps.shouldPersistModelResponseLog(requestPath),
              path: requestPath,
              intentId,
              isFinal: completed,
              streamEndReason: terminal.terminalStatus,
              model,
              apiKeyId,
              ownerUserId,
              charge: accounting.charge,
              serviceTier: accounting.serviceTier,
              statusCode: upstreamStatus,
              startedAtMs,
              firstEventAtMs: terminal.firstByteAtMs,
              finishedAtMs,
              usage: accounting.usage,
              cost: accounting.cost,
              fallbackErrorCode: completed
                ? null
                : `response_${terminal.terminalStatus}`,
              fallbackErrorMessage: completed
                ? null
                : `Responses stream ended with status ${terminal.terminalStatus}`,
            });
            terminalSettlementPersisted = true;
          }
        : undefined,
    });
    firstEventAtMs = observation.firstByteAtMs;
    finishedAtMs = observation.finishedAtMs;
    terminalResponsePayload =
      observation.terminalResponsePayload ?? observation.responsePayload;
    terminalStatus = observation.terminalStatus;
    lastErrorPayload = observation.errorPayload;
    applyObservedModel(terminalResponsePayload);
  } catch (error) {
    const errorInfo = deps.extractErrorInfo(error);
    upstreamStatus = upstreamStatus ?? errorInfo.status;
    errorMessage = errorInfo.message;
    lastErrorPayload = errorInfo.errorPayload ?? lastErrorPayload;
    finishedAtMs = Date.now();
    const wasAborted = requestAbort.signal.aborted || deps.isAbortError(error);
    if (!wasAborted && !res.headersSent) {
      const passthrough = deps.buildPassthroughUpstreamError({
        status: upstreamStatus,
        errorPayload: lastErrorPayload,
        fallbackCode: "codex_backend_forward_failed",
        fallbackMessage:
          errorInfo.message ?? "Failed to forward Codex backend request",
      });
      res.status(passthrough.status).json({ error: passthrough.error });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    let accounting: ReturnType<typeof finalizeOpenAIRouteAccounting> | null =
      null;
    try {
      accounting = finalizeOpenAIRouteAccounting({
        deps,
        apiKeyId,
        model,
        pricingModelId,
        usageResponsePayload: terminalResponsePayload,
        lastErrorPayload,
        serviceTier,
        billable,
      });
      const completed =
        terminalStatus === "completed" || (!billable && requestSucceeded);
      const protocolFailure =
        billable && terminalStatus && !completed
          ? `response_${terminalStatus}`
          : null;
      const endedBeforeTerminal =
        billable &&
        !terminalStatus &&
        !errorMessage &&
        upstreamStatus !== null &&
        upstreamStatus >= 200 &&
        upstreamStatus < 300;
      const streamEndReason = billable
        ? (terminalStatus ??
          errorMessage ??
          (endedBeforeTerminal
            ? "upstream_eof_before_terminal"
            : upstreamStatus
              ? `http_${upstreamStatus}`
              : null))
        : requestSucceeded
          ? "completed"
          : (errorMessage ??
            (upstreamStatus ? `http_${upstreamStatus}` : null));
      await persistOpenAIResponseLog({
        deps,
        shouldPersist:
          !terminalSettlementPersisted &&
          !alreadyPersistedQuotaLog &&
          deps.shouldPersistModelResponseLog(requestPath),
        path: requestPath,
        intentId,
        isFinal: completed,
        streamEndReason,
        model,
        apiKeyId,
        ownerUserId,
        charge: accounting.charge,
        serviceTier: billable ? accounting.serviceTier : null,
        statusCode: upstreamStatus ?? (res.headersSent ? res.statusCode : null),
        startedAtMs,
        firstEventAtMs,
        finishedAtMs,
        usage: accounting.usage,
        cost: accounting.cost,
        fallbackErrorCode: upstreamQuotaRejected
          ? "upstream_user_quota_exceeded"
          : protocolFailure ??
            (endedBeforeTerminal
              ? "upstream_eof_before_terminal"
              : errorMessage
                ? "codex_backend_forward_failed"
                : null),
        fallbackErrorMessage:
          errorMessage ??
          (protocolFailure
            ? `Responses stream ended with status ${terminalStatus}`
            : endedBeforeTerminal
              ? "Responses stream ended before a terminal event"
              : null),
      });
    } catch (error) {
      deps.cancelResponseRequestReservation(intentId);
      console.warn(
        `[logs] failed to write ${requestPath} log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      billable &&
      accounting &&
      upstreamRequestStarted &&
      quotaSourceAccount &&
      ownerUserId
    ) {
      try {
        await deps.settleUserUpstreamQuota({
          settlementId: intentId,
          sourceAccount: quotaSourceAccount,
          ownerUserId,
          model,
          cost: accounting.cost,
          totalTokens: accounting.usage.totalTokens,
        });
      } catch (error) {
        console.warn(
          `[quota] failed to settle ${requestPath} usage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    requestAbort.cleanup();
  }
}

export function registerCodexBackendForwardRoutes(
  app: Express,
  deps: CodexBackendForwardDependencies,
) {
  app.use("/backend-api", async (req: Request, res: ExpressResponse) => {
    const requestPath = upstreamBackendPath(req);
    const kind = classifyCodexBackendForward(requestPath);
    const body = await clientBody(req);
    if (kind === "passthrough") {
      await handlePassthroughForward(req, res, deps, body);
      return;
    }
    const requestRecord = await peekCodexRequestRecord(
      body,
      req.headers["content-encoding"],
    );
    await handleAccountedForward(req, res, deps, {
      kind,
      requestPath,
      body,
      requestRecord,
    });
  });
}
