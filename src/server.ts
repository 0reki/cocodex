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
  getPortalUserSpendAllowance,
  getPortalUserById,
  getApiKeyByToken,
  getModelHourlyStatsSeries,
  getPortalUserModelHourlyStatsSeries,
  getOpenAIAccountByEmail,
  getActiveOpenAIAccount,
  listOpenAIAccountsPage,
  listApiKeys,
  listModelResponseLogsCursor,
  listModelResponseLogsCursorByOwnerUserId,
  listPortalUsers,
  normalizeOpenAIAccountStatus,
  runDatabaseSelfCheck,
  setPortalUserEnabledById,
  updateApiKeyById,
  updateOpenAIAccountTokensById,
  updatePortalUsernameById,
  updatePortalUserPasswordById,
  upsertOpenAIAccount,
} from "./database/index.ts";
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
  resolvePriorityServiceTierForBilling,
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
  registerUserRoutes,
  ResponsesWebSocketUpgradeError,
  prepareResponsesWebSocketProxyContext,
  setupResponsesWebSocketProxy,
} from "./server/routes/index.ts";
import { lruGet, lruSet } from "./server/services/index.ts";
import {
  bootstrapServerServices,
  createServerRuntimeState,
  sendWsErrorEvent,
} from "./server/bootstrap/index.ts";
import {
  extractCodexResultFromSse,
  isRecord,
  parseJsonRecordText,
} from "./server/openai-response-utils.ts";

loadBackendEnv();

const {
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS,
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  BILLING_OVERDRAFT_LIMIT_USD,
  BILLING_INFLIGHT_RESERVE_USD,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  RESPONSE_SETTLEMENT_BATCH_SIZE,
  RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
  RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
  RESPONSE_SETTLEMENT_QUEUE_MAX,
  RESPONSE_SETTLEMENT_RETRY_MAX_MS,
  apiKeyAuthLruCache,
  apiKeyAuthTokenById,
  apiKeyAuthLoadingPromises,
  apiKeyAuthTokenVersions,
  apiKeyPendingCharges,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
  billingPendingChargesByOwnerId,
  billingReservationById,
  billingReservedAmountsByOwnerId,
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
  ensureUserBillingAllowanceOrNull,
  isUserBillingAllowanceExceeded,
  isApiKeyBoundToUser,
  getActiveSourceAccount,
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
  flushAllResponseSettlements,
  stopResponseSettlementServices,
  extractResponseUsage,
  estimateUsageCost,
  resolveUsagePricingModelId,
  buildOpenAIModelsList,
  postCodexResponsesWithTokenRefresh,
  postCodexImageWithTokenRefresh,
  connectResponsesWebSocketProxyUpstream,
  getCodexDailyWorkspaceUsageWithTokenRefresh,
  getCodexModelsWithTokenRefresh,
  getCodexUsageWithTokenRefresh,
} = bootstrapServerServices({
  isRecord,
  lruGet,
  lruSet,
  modelPricing,
  getPortalUserSpendAllowance,
  getPortalUserById,
  getApiKeyByToken,
  getActiveOpenAIAccount,
  flushResponseSettlements,
  ensureDatabaseSchema,
  updateOpenAIAccountTokensById,
  randomUUID: () => crypto.randomUUID(),
  resolveOpenAIUpstreamAccountId,
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS,
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  BILLING_OVERDRAFT_LIMIT_USD,
  BILLING_INFLIGHT_RESERVE_USD,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  RESPONSE_SETTLEMENT_BATCH_SIZE,
  RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
  RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
  RESPONSE_SETTLEMENT_QUEUE_MAX,
  RESPONSE_SETTLEMENT_RETRY_MAX_MS,
  apiKeyAuthLruCache,
  apiKeyAuthTokenById,
  apiKeyAuthLoadingPromises,
  apiKeyAuthTokenVersions,
  apiKeyPendingCharges,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
  billingPendingChargesByOwnerId,
  billingReservationById,
  billingReservedAmountsByOwnerId,
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
    const decompressed = await zstdDecompressBuffer(compressed);
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
    if (status === 413) {
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
  getActiveSourceAccount,
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
  resolvePriorityServiceTierForBilling,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  ensureUserBillingAllowanceOrNull,
  tryReserveResponseRequest,
  getActiveSourceAccount,
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
});

registerImageRoutes(app, {
  createRequestAbortContext,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  ensureUserBillingAllowanceOrNull,
  tryReserveResponseRequest,
  getActiveSourceAccount,
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
});

registerUserRoutes(app, {
  getPortalPrincipalFromLocals,
  invalidateApiKeyAuthCacheByOwnerUserId,
  listPortalUsers,
  createPortalUser,
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
});

registerAccountMaintenanceRoutes(app, {
  getOpenAIApiRuntimeConfig,
  getCodexDailyWorkspaceUsageWithTokenRefresh,
  getCodexUsageWithTokenRefresh,
  getOpenAIAccountByEmail,
  postCodexResponsesWithTokenRefresh,
  extractCodexResultFromSse,
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
          resolvePriorityServiceTierForBilling,
          authenticateApiKeyByAuthorizationHeaderWithReason,
          getApiKeyAuthErrorDetail,
          isApiKeyQuotaExceeded,
          isApiKeyBoundToUser,
          ensureUserBillingAllowanceOrNull,
          isUserBillingAllowanceExceeded,
          getActiveSourceAccount,
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
            resolvePriorityServiceTierForBilling,
            sendWsErrorEvent,
            wsRawDataToText,
            parseJsonRecordText,
            isRecord,
            WS_READY_STATE_OPEN,
            WS_READY_STATE_CONNECTING,
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

httpServer.listen(port, host, async () => {
  try {
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
  } catch (error) {
    console.error("[backend] schema init failed:", error);
  }
  console.log(`[backend] listening at http://${host}:${port}`);
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
  await flushAllResponseSettlements();
  await closePromise;
  await stopResponseSettlementServices();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error("[backend] graceful shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
