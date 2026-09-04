import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import crypto from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

import {
  createApiKey,
  deleteApiKeyById,
  disableOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  deleteOpenAIAccountByEmail,
  deleteOpenAIAccountsByEmails,
  activateOpenAIAccountByEmail,
  ensureDatabaseSchema,
  flushResponseSettlements,
  createPortalUser,
  createPortalInvitation,
  getUserUpstreamQuotaAllocation,
  listUpstreamQuotaMemberAllocations,
  getPortalUserById,
  getModelHourlyStatsSeries,
  getPortalUserModelHourlyStatsSeries,
  getRequestRateStats,
  getOpenAIAccountByEmail,
  listOpenAIAccountsPage,
  listApiKeys,
  listAssignedOpenAIAccounts,
  listModelResponseLogsCursor,
  listModelResponseLogsCursorByOwnerUserId,
  listPortalUsers,
  listPortalUserUpstreamAssignments,
  normalizeOpenAIAccountStatus,
  runDatabaseSelfCheck,
  recordUserUpstreamQuotaUsage,
  setPortalUserEnabledById,
  setPortalUserUpstreamAssignment,
  syncUpstreamQuotaWindow,
  updateApiKeyById,
  updateOpenAIAccountTokensById,
  updatePortalUsernameById,
  updatePortalUserPasswordById,
  upsertOpenAIAccount,
} from "./database/index.ts";
import { resetDatabasePool } from "./database/core/db.ts";
import {
  loadModelPricingFromEnv,
} from "./server/utils/index.ts";
import {
  parseContentEncodingHeader,
  readRequestBodyBuffer,
  zstdDecompressBuffer,
} from "./server/utils/index.ts";
import {
  WS_READY_STATE_CONNECTING,
  WS_READY_STATE_OPEN,
  WsServerCtor,
  normalizeWsCloseCode,
  normalizeWsCloseReason,
  parseUpgradePathname,
  sendWebSocketUpgradeErrorResponse,
  wsRawDataToText,
} from "./server/utils/index.ts";
import {
  applyServiceTierBillingMultiplier,
  generateApiKeyValue,
  loadBackendEnv,
  resolveFastServiceTierForBilling,
  resolveOpenAIUpstreamAccountId,
} from "./server/utils/index.ts";
import {
  registerAccountMaintenanceRoutes,
  registerAdminRoutes,
  registerPortalAuthRoutes,
  registerPublicOpenAIRoutes,
  registerImageRoutes,
  registerRequestLogRoutes,
  registerResponsesRoutes,
  registerSearchRoutes,
  registerSetupRoutes,
  registerUserRoutes,
  ResponsesWebSocketUpgradeError,
  prepareResponsesWebSocketProxyContext,
  setupResponsesWebSocketProxy,
} from "./server/routes/index.ts";
import { lruGet } from "./server/services/index.ts";
import {
  bootstrapServerServices,
  createServerRuntimeState,
  sendWsErrorEvent,
} from "./server/bootstrap/index.ts";
import {
  extractCodexResultFromSse,
  extractCodexTerminalResponseFromSse,
  isRecord,
  parseJsonRecordText,
} from "./server/openai-response-utils.ts";
import {
  pollCodexDeviceAuth,
  requestCodexDeviceCode,
} from "./openai-api/index.ts";

loadBackendEnv();

const {
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  RESPONSE_SETTLEMENT_BATCH_SIZE,
  RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
  RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
  RESPONSE_SETTLEMENT_QUEUE_MAX,
  RESPONSE_SETTLEMENT_RETRY_MAX_MS,
  RESPONSE_SETTLEMENT_WAL_PATH,
  RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS,
  UPSTREAM_QUOTA_REFRESH_INTERVAL_MS,
  apiKeyAuthLruCache,
  apiKeyAuthTokenById,
  apiKeyPendingCharges,
} = createServerRuntimeState();
const modelPricing = loadModelPricingFromEnv();

const {
  createRequestAbortContext,
  getOpenAIApiRuntimeConfig,
  authenticatePortalAccessTokenWithReason,
  authenticateApiKeyByAuthorizationHeaderWithReason,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  getAccessTokenAuthErrorDetail,
  getPortalPrincipalFromLocals,
  cacheApiKey,
  invalidateApiKeyAuthCacheByToken,
  invalidateApiKeyAuthCacheByOwnerUserId,
  isApiKeyQuotaExceeded,
  isApiKeyBoundToUser,
  getAssignedSourceAccount,
  hydrateResponseAuthState,
  hydrateSourceAccountCache,
  hydrateUpstreamQuotaCache,
  invalidateActiveSourceAccount,
  extractErrorInfo,
  buildPassthroughUpstreamError,
  isAbortError,
  shouldPersistModelResponseLog,
  persistQuotaExceededLog,
  persistShortCircuitErrorLog,
  enqueueResponseSettlement,
  tryReserveResponseRequest,
  cancelResponseRequestReservation,
  getResponseSettlementQueueHealth,
  initializeResponseSettlementServices,
  flushAllResponseSettlements,
  flushUpstreamTokenPersistence,
  stopResponseSettlementServices,
  stopUpstreamQuotaServices,
  extractResponseUsage,
  estimateUsageCost,
  resolveUsagePricingModelId,
  buildOpenAIModelsList,
  postCodexResponsesWithTokenRefresh,
  postCodexImageWithTokenRefresh,
  postCodexSearchWithTokenRefresh,
  connectResponsesWebSocketProxyUpstream,
  getCodexDailyWorkspaceUsageWithTokenRefresh,
  getCodexModelsWithTokenRefresh,
  getCodexUsageWithTokenRefresh,
  ensureUserUpstreamQuota,
  getUserUpstreamQuotaSummary,
  settleUserUpstreamQuota,
} = bootstrapServerServices({
  isRecord,
  lruGet,
  modelPricing,
  listAssignedOpenAIAccounts,
  getUserUpstreamQuotaAllocation,
  listUpstreamQuotaMemberAllocations,
  listPortalUserUpstreamAssignments,
  recordUserUpstreamQuotaUsage,
  syncUpstreamQuotaWindow,
  getPortalUserById,
  flushResponseSettlements,
  updateOpenAIAccountTokensById,
  randomUUID: () => crypto.randomUUID(),
  resolveOpenAIUpstreamAccountId,
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  RESPONSE_SETTLEMENT_BATCH_SIZE,
  RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
  RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
  RESPONSE_SETTLEMENT_QUEUE_MAX,
  RESPONSE_SETTLEMENT_RETRY_MAX_MS,
  RESPONSE_SETTLEMENT_WAL_PATH,
  RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS,
  UPSTREAM_QUOTA_REFRESH_INTERVAL_MS,
  apiKeyAuthLruCache,
  apiKeyAuthTokenById,
  apiKeyPendingCharges,
});

const app = express();
const port = Number(process.env.PORT ?? 53141);
const host = process.env.HOST?.trim() || "localhost";
const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const IMAGE_JSON_BODY_LIMIT_BYTES = 128 * 1024 * 1024;
const defaultJsonParser = express.json({ limit: JSON_BODY_LIMIT_BYTES });
const imageJsonParser = express.json({ limit: IMAGE_JSON_BODY_LIMIT_BYTES });
const responsesWebSocketServer = new WsServerCtor({ noServer: true });
const responsesWebSocketUpgradeHeaders = new WeakMap<
  IncomingMessage,
  Record<string, string>
>();
responsesWebSocketServer.on("headers", (headers, request) => {
  const upstreamHeaders = responsesWebSocketUpgradeHeaders.get(request);
  responsesWebSocketUpgradeHeaders.delete(request);
  if (!upstreamHeaders) return;
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (!value.includes("\r") && !value.includes("\n")) {
      headers.push(`${name}: ${value}`);
    }
  }
});

const isImageApiPath = (path: string) =>
  path === "/v1/images/generations" || path === "/v1/images/edits";

app.use(cors());
app.use((req, res, next) => {
  const encodings = parseContentEncodingHeader(req.headers["content-encoding"]);
  const isZstdOnly = encodings.length === 1 && encodings[0] === "zstd";
  if (!isZstdOnly) {
    (isImageApiPath(req.path) ? imageJsonParser : defaultJsonParser)(
      req,
      res,
      next,
    );
    return;
  }

  const contentTypeRaw = req.headers["content-type"];
  const contentType = Array.isArray(contentTypeRaw)
    ? (contentTypeRaw[0] ?? "")
    : (contentTypeRaw ?? "");
  if (!contentType.toLowerCase().includes("application/json")) {
    res.status(415).json({
      error: {
        message: 'unsupported content encoding "zstd" for non-JSON payloads',
        type: "invalid_request_error",
        code: "unsupported_content_encoding",
      },
    });
    return;
  }

  void (async () => {
    const bodyLimitBytes = isImageApiPath(req.path)
      ? IMAGE_JSON_BODY_LIMIT_BYTES
      : JSON_BODY_LIMIT_BYTES;
    const compressed = await readRequestBodyBuffer(req, bodyLimitBytes);
    const decompressed = await zstdDecompressBuffer(compressed, bodyLimitBytes);
    if (decompressed.byteLength > bodyLimitBytes) {
      res.status(413).json({
        error: {
          message: "Request payload too large",
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
      return;
    }

    const text = decompressed.toString("utf8");
    if (!text.trim()) {
      req.body = {};
    } else {
      try {
        req.body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        res.status(400).json({
          error: {
            message: "Invalid JSON payload",
            type: "invalid_request_error",
            code: "invalid_json",
          },
        });
        return;
      }
    }

    delete req.headers["content-encoding"];
    req.headers["content-length"] = String(decompressed.byteLength);
    next();
  })().catch((error: unknown) => {
    const status =
      isRecord(error) &&
        typeof error.status === "number" &&
        Number.isFinite(error.status)
        ? Math.trunc(error.status)
        : null;
    const code =
      isRecord(error) && typeof error.code === "string" ? error.code : null;
    if (status === 413 || code === "ERR_BUFFER_TOO_LARGE") {
      res.status(413).json({
        error: {
          message: "Request payload too large",
          type: "invalid_request_error",
          code: "payload_too_large",
        },
      });
      return;
    }
    res.status(400).json({
      error: {
        message: "invalid zstd-compressed JSON payload",
        type: "invalid_request_error",
        code: "invalid_content_encoding",
      },
    });
  });
});

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (
      req.path.startsWith("/v1/") &&
      res.statusCode >= 400 &&
      isRecord(body)
    ) {
      const intentId =
        typeof res.locals.intentId === "string" && res.locals.intentId.trim()
          ? res.locals.intentId.trim()
          : crypto.randomUUID();
      const suffix = `(Intent id: ${intentId})`;
      const errorValue = body.error;
      if (typeof errorValue === "string") {
        if (!errorValue.includes("Intent id:")) {
          return originalJson({
            ...body,
            error: `${errorValue} ${suffix}`,
          });
        }
        return originalJson(body);
      }
      if (isRecord(errorValue)) {
        const message = errorValue.message;
        if (typeof message === "string" && !message.includes("Intent id:")) {
          return originalJson({
            ...body,
            error: {
              ...errorValue,
              message: `${message} ${suffix}`,
            },
          });
        }
      }
    }
    return originalJson(body);
  }) as typeof res.json;
  next();
});

registerSetupRoutes(app);
registerPortalAuthRoutes(app);

app.use(async (req, res, next) => {
  try {
    if (
      req.path.startsWith("/v1/") ||
      req.path === "/health"
    ) {
      next();
      return;
    }

    const { principal, reason } =
      await authenticatePortalAccessTokenWithReason(req);
    if (!principal) {
      const authError = getAccessTokenAuthErrorDetail(reason);
      res.status(authError.status).json({
        error: {
          message: authError.message,
          type:
            authError.status >= 500 ? "server_error" : "invalid_request_error",
          code: authError.code,
        },
      });
      return;
    }
    res.locals.portalPrincipal = principal;
    const isApiPath = req.path.startsWith("/api/");
    const nonAdminAllowed =
      req.path === "/api/api-keys" ||
      req.path.startsWith("/api/api-keys/") ||
      req.path === "/api/my-usage" ||
      req.path === "/api/request-logs" ||
      req.path.startsWith("/api/request-logs/");
    if (isApiPath && !nonAdminAllowed && principal.role !== "admin") {
      res.status(403).json({
        error: {
          message: "Forbidden",
          type: "invalid_request_error",
          code: "forbidden",
        },
      });
      return;
    }
    next();
  } catch {
    res.status(500).json({
      error: {
        message: "Failed to validate access token scope",
        type: "server_error",
        code: "access_token_validation_failed",
      },
    });
  }
});

registerPublicOpenAIRoutes(app, {
  ensureDatabaseSchema,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  isApiKeyBoundToUser,
  getAssignedSourceAccount,
  resolveOpenAIUpstreamAccountId,
  getOpenAIApiRuntimeConfig,
  getCodexModelsWithTokenRefresh,
  buildOpenAIModelsList,
  extractErrorInfo,
  buildPassthroughUpstreamError,
  getResponseSettlementQueueHealth,
});

registerResponsesRoutes(app, {
  createRequestAbortContext,
  resolveFastServiceTierForBilling,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  tryReserveResponseRequest,
  getAssignedSourceAccount,
  getOpenAIApiRuntimeConfig,
  resolveOpenAIUpstreamAccountId,
  postCodexResponsesWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  resolveUsagePricingModelId,
  enqueueResponseSettlement,
  cancelResponseRequestReservation,
  ensureUserUpstreamQuota,
  settleUserUpstreamQuota,
});

registerImageRoutes(app, {
  createRequestAbortContext,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  tryReserveResponseRequest,
  getAssignedSourceAccount,
  getOpenAIApiRuntimeConfig,
  resolveOpenAIUpstreamAccountId,
  postCodexImageWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  enqueueResponseSettlement,
  cancelResponseRequestReservation,
});

registerSearchRoutes(app, {
  createRequestAbortContext,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  tryReserveResponseRequest,
  getAssignedSourceAccount,
  getOpenAIApiRuntimeConfig,
  resolveOpenAIUpstreamAccountId,
  postCodexSearchWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  enqueueResponseSettlement,
  cancelResponseRequestReservation,
});

registerAdminRoutes(app, {
  listOpenAIAccountsPage,
  getPortalPrincipalFromLocals,
  listApiKeys,
  cacheApiKey,
  invalidateApiKeyAuthCacheByToken,
  invalidateActiveSourceAccount,
  generateApiKeyValue,
  createApiKey,
  deleteApiKeyById,
  updateApiKeyById,
  getOpenAIAccountByEmail,
  deleteOpenAIAccountByEmail,
  deleteOpenAIAccountsByEmails,
  disableOpenAIAccountByEmail,
  activateOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  normalizeOpenAIAccountStatus,
  upsertOpenAIAccount,
  requestCodexDeviceCode,
  pollCodexDeviceAuth,
});

registerUserRoutes(app, {
  cacheApiKey,
  getPortalPrincipalFromLocals,
  getAssignedSourceAccount,
  getUserUpstreamQuotaSummary,
  hydrateUpstreamQuotaCache,
  invalidateActiveSourceAccount,
  invalidateApiKeyAuthCacheByOwnerUserId,
  listApiKeys,
  listPortalUsers,
  listPortalUserUpstreamAssignments,
  setPortalUserUpstreamAssignment,
  createPortalUser,
  createPortalInvitation,
  updatePortalUsernameById,
  updatePortalUserPasswordById,
  setPortalUserEnabledById,
});

registerRequestLogRoutes(app, {
  getPortalPrincipalFromLocals,
  listModelResponseLogsCursor,
  listModelResponseLogsCursorByOwnerUserId,
  getModelHourlyStatsSeries,
  getPortalUserModelHourlyStatsSeries,
  getRequestRateStats,
});

registerAccountMaintenanceRoutes(app, {
  getOpenAIApiRuntimeConfig,
  getCodexDailyWorkspaceUsageWithTokenRefresh,
  getCodexUsageWithTokenRefresh,
  getOpenAIAccountByEmail,
  postCodexResponsesWithTokenRefresh,
  extractCodexResultFromSse,
  extractCodexTerminalResponseFromSse,
  getPortalPrincipalFromLocals,
  ensureUserUpstreamQuota,
  settleUserUpstreamQuota,
  extractResponseUsage,
  estimateUsageCost,
  invalidateActiveSourceAccount,
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const err = error as
    | (Error & { type?: string; status?: number; statusCode?: number })
    | undefined;
  const status = err?.statusCode ?? err?.status ?? 500;

  if (err?.type === "entity.too.large" || status === 413) {
    res.status(413).json({
      error: {
        message: "Request payload too large",
        type: "invalid_request_error",
        code: "payload_too_large",
      },
    });
    return;
  }

  if (err instanceof SyntaxError && status === 400) {
    res.status(400).json({
      error: {
        message: "Invalid JSON payload",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
    return;
  }

  if (err?.type === "encoding.unsupported" || status === 415) {
    res.status(415).json({
      error: {
        message: err?.message || "Unsupported content encoding",
        type: "invalid_request_error",
        code: "unsupported_content_encoding",
      },
    });
    return;
  }

  res.status(status).json({
    error: {
      message: err?.message || "Internal server error",
      type: "server_error",
      code: "internal_error",
    },
  });
});

const httpServer = createServer(app);

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = parseUpgradePathname(request);
  if (pathname !== "/v1/responses") {
    sendWebSocketUpgradeErrorResponse(socket, 404, {
      error: {
        message: "Not found",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
    return;
  }

  void (async () => {
    let context: Awaited<
      ReturnType<typeof prepareResponsesWebSocketProxyContext>
    > | null = null;
    try {
      context = await prepareResponsesWebSocketProxyContext(
        {
          isRecord,
          resolveFastServiceTierForBilling,
          authenticateApiKeyByAuthorizationHeaderWithReason,
          getApiKeyAuthErrorDetail,
          isApiKeyQuotaExceeded,
          isApiKeyBoundToUser,
          getAssignedSourceAccount,
          resolveOpenAIUpstreamAccountId,
          getOpenAIApiRuntimeConfig,
          connectResponsesWebSocketProxyUpstream,
          extractErrorInfo,
          buildPassthroughUpstreamError,
        },
        request,
      );
    } catch (error) {
      if (error instanceof ResponsesWebSocketUpgradeError) {
        sendWebSocketUpgradeErrorResponse(socket, error.status, error.payload);
        return;
      }
      const errorInfo = extractErrorInfo(error);
      const passthroughError = buildPassthroughUpstreamError({
        status: errorInfo.status,
        errorPayload: errorInfo.errorPayload,
        fallbackCode: "responses_websocket_upgrade_failed",
        fallbackMessage:
          errorInfo.message ?? "Failed to establish responses websocket",
      });
      sendWebSocketUpgradeErrorResponse(socket, passthroughError.status, {
        error: passthroughError.error,
      });
      return;
    }

    try {
      let upgradeHandled = false;
      const releaseOnUpgradeSocketClose = () => {
        if (upgradeHandled) return;
        if (
          context.upstreamSocket.readyState === WS_READY_STATE_OPEN ||
          context.upstreamSocket.readyState === WS_READY_STATE_CONNECTING
        ) {
          context.upstreamSocket.close(1011, "client_closed_before_upgrade");
        }
      };
      socket.once("close", releaseOnUpgradeSocketClose);
      responsesWebSocketUpgradeHeaders.set(
        request,
        context.upstreamResponseHeaders,
      );
      responsesWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
        upgradeHandled = true;
        responsesWebSocketUpgradeHeaders.delete(request);
        socket.off("close", releaseOnUpgradeSocketClose);
        setupResponsesWebSocketProxy(
          {
            shouldPersistModelResponseLog,
            enqueueResponseSettlement,
            tryReserveResponseRequest,
            cancelResponseRequestReservation,
            extractResponseUsage,
            applyServiceTierBillingMultiplier,
            estimateUsageCost,
            resolveUsagePricingModelId,
            normalizeWsCloseCode,
            normalizeWsCloseReason,
            resolveFastServiceTierForBilling,
            sendWsErrorEvent,
            wsRawDataToText,
            parseJsonRecordText,
            isRecord,
            WS_READY_STATE_OPEN,
            WS_READY_STATE_CONNECTING,
            ensureUserUpstreamQuota,
            settleUserUpstreamQuota,
          },
          {
            clientSocket: ws,
            upstreamSocket: context.upstreamSocket,
            context,
          },
        );
      });
    } catch (error) {
      responsesWebSocketUpgradeHeaders.delete(request);
      if (
        context.upstreamSocket.readyState === WS_READY_STATE_OPEN ||
        context.upstreamSocket.readyState === WS_READY_STATE_CONNECTING
      ) {
        context.upstreamSocket.close(1011, "upgrade_failed");
      }
      sendWebSocketUpgradeErrorResponse(socket, 500, {
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Failed to complete websocket upgrade",
          type: "server_error",
          code: "responses_websocket_upgrade_failed",
        },
      });
    }
  })().catch((error) => {
    sendWebSocketUpgradeErrorResponse(socket, 500, {
      error: {
        message:
          error instanceof Error
            ? error.message
            : "Unexpected websocket upgrade error",
        type: "server_error",
        code: "responses_websocket_upgrade_failed",
      },
    });
  });
});

async function startServer() {
  if (!process.env.DATABASE_URL?.trim()) {
    await initializeResponseSettlementServices();
    httpServer.listen(port, host, () => {
      console.log("[setup] initialization required; open the web setup page");
      console.log(`[backend] listening at http://${host}:${port}`);
    });
    return;
  } else {
    await ensureDatabaseSchema();
    const selfCheck = await runDatabaseSelfCheck();
    if (!selfCheck.ok || selfCheck.issues.length > 0) {
      console.warn("[backend] database self-check issues detected:", {
        ok: selfCheck.ok,
        checkedAt: selfCheck.checkedAt,
        issues: selfCheck.issues,
      });
    } else {
      console.log("[backend] database self-check passed");
    }
    const [apiKeys, users, assignedAccounts] = await Promise.all([
      listApiKeys(),
      listPortalUsers(),
      hydrateSourceAccountCache(),
    ]);
    await hydrateUpstreamQuotaCache({
      sourceAccounts: assignedAccounts.map((item) => item.account),
    });
    hydrateResponseAuthState({ apiKeys, users });
    await initializeResponseSettlementServices();
  }
  httpServer.listen(port, host, () => {
    console.log(`[backend] listening at http://${host}:${port}`);
  });
}

void startServer().catch((error) => {
  console.error("[backend] startup failed:", error);
  process.exitCode = 1;
});

let shutdownStarted = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`[backend] received ${signal}, flushing pending settlements`);
  let closePromise: Promise<void> | null = null;
  if (httpServer.listening) {
    closePromise = new Promise<void>((resolve) =>
      httpServer.close(() => resolve()),
    );
  }
  await closePromise;
  try {
    await Promise.all([
      flushAllResponseSettlements(),
      stopUpstreamQuotaServices(),
    ]);
    await flushUpstreamTokenPersistence();
    await stopResponseSettlementServices();
  } finally {
    await resetDatabasePool();
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("[backend] graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
