import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import crypto from "node:crypto";
import { createServer } from "node:http";

import {
  createModelResponseLog,
  createApiKey,
  deleteApiKeyById,
  disableOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  deleteOpenAIAccountByEmail,
  deleteOpenAIAccountsByEmails,
  activateOpenAIAccountByEmail,
  ensureDatabaseSchema,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
  adjustPortalUserBalance,
  getPortalUserSpendAllowance,
  getOpenAIAccountByEmail,
  getActiveOpenAIAccount,
  listOpenAIAccountsPage,
  listApiKeys,
  normalizeOpenAIAccountStatus,
  runDatabaseSelfCheck,
  updateApiKeyById,
  updateOpenAIAccountAccessTokenById,
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
  registerResponsesRoutes,
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
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  apiKeysCache,
  apiKeyAuthLruCache,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
} = createServerRuntimeState();
const modelPricing = loadModelPricingFromEnv();

const {
  setApiKeysCache,
  ensureApiKeysCacheLoaded,
  createRequestAbortContext,
  getOpenAIApiRuntimeConfig,
  authenticatePortalAccessTokenWithReason,
  authenticateApiKeyByAuthorizationHeaderWithReason,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  getAccessTokenAuthErrorDetail,
  getPortalSessionFromLocals,
  isApiKeyQuotaExceeded,
  ensureUserBillingAllowanceOrNull,
  applyUserBillingAllowanceChargeCache,
  isApiKeyBoundToUser,
  applyApiKeyCacheUpdate,
  getActiveSourceAccount,
  extractErrorInfo,
  buildInternalUpstreamErrorDetails,
  buildPassthroughUpstreamError,
  isAbortError,
  shouldPersistModelResponseLog,
  persistQuotaExceededLog,
  persistShortCircuitErrorLog,
  extractResponseUsage,
  estimateUsageCost,
  buildOpenAIModelsList,
  chargeCompletedResponseUsage,
  postCodexResponsesWithTokenRefresh,
  postCodexResponsesCompactWithTokenRefresh,
  connectResponsesWebSocketProxyUpstream,
  getCodexModelsWithTokenRefresh,
} = bootstrapServerServices({
  isRecord,
  lruGet,
  lruSet,
  modelPricing,
  getPortalUserSpendAllowance,
  getActiveOpenAIAccount,
  createModelResponseLog,
  incrementApiKeyUsed,
  adjustPortalUserBalance,
  listApiKeys,
  ensureDatabaseSchema,
  updateOpenAIAccountAccessTokenById,
  disableOpenAIAccountByEmail,
  applyServiceTierBillingMultiplier,
  randomUUID: () => crypto.randomUUID(),
  resolveOpenAIUpstreamAccountId,
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  apiKeysCache,
  apiKeyAuthLruCache,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
});

const app = express();
const port = Number(process.env.PORT ?? 53141);
const host = process.env.HOST?.trim() || "localhost";
const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const defaultJsonParser = express.json({ limit: JSON_BODY_LIMIT_BYTES });
const responsesWebSocketServer = new WsServerCtor({ noServer: true });

app.use(cors());
app.use((req, res, next) => {
  const encodings = parseContentEncodingHeader(req.headers["content-encoding"]);
  const isZstdOnly = encodings.length === 1 && encodings[0] === "zstd";
  if (!isZstdOnly) {
    defaultJsonParser(req, res, next);
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
    const compressed = await readRequestBodyBuffer(req, JSON_BODY_LIMIT_BYTES);
    const decompressed = await zstdDecompressBuffer(compressed);
    if (decompressed.byteLength > JSON_BODY_LIMIT_BYTES) {
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

    const { session, reason } =
      await authenticatePortalAccessTokenWithReason(req);
    if (!session) {
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
    res.locals.portalSession = session;
    const isApiPath = req.path.startsWith("/api/");
    const nonAdminAllowed =
      req.path === "/api/api-keys" ||
      req.path.startsWith("/api/api-keys/");
    if (isApiPath && !nonAdminAllowed && session.role !== "admin") {
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
  getActiveSourceAccount,
  getOpenAIApiRuntimeConfig,
  resolveOpenAIUpstreamAccountId,
  postCodexResponsesWithTokenRefresh,
  postCodexResponsesCompactWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  buildInternalUpstreamErrorDetails,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
  applyApiKeyCacheUpdate,
  adjustPortalUserBalance,
  applyUserBillingAllowanceChargeCache,
  createModelResponseLog,
});

registerAdminRoutes(app, {
  listOpenAIAccountsPage,
  ensureApiKeysCacheLoaded,
  getPortalSessionFromLocals,
  apiKeysCache,
  generateApiKeyValue,
  setApiKeysCache,
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

registerAccountMaintenanceRoutes(app, {
  getOpenAIApiRuntimeConfig,
  getOpenAIAccountByEmail,
  postCodexResponsesWithTokenRefresh,
  extractCodexResultFromSse,
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
      responsesWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
        upgradeHandled = true;
        socket.off("close", releaseOnUpgradeSocketClose);
        setupResponsesWebSocketProxy(
          {
            shouldPersistModelResponseLog,
            createModelResponseLog,
            extractResponseUsage,
            applyServiceTierBillingMultiplier,
            estimateUsageCost,
            normalizeWsCloseCode,
            normalizeWsCloseReason,
            resolvePriorityServiceTierForBilling,
            chargeCompletedResponseUsage,
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
    await ensureApiKeysCacheLoaded(true);
  } catch (error) {
    console.error("[backend] schema init failed:", error);
  }
  console.log(`[backend] listening at http://${host}:${port}`);
});
