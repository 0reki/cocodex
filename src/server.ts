import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import crypto from "node:crypto";
import { createServer } from "node:http";

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
  normalizeOpenAIAccountPlatform,
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
  updatePortalUserQuotaById,
  upsertOpenAIAccount,
} from "./database/index.ts";
import { resetDatabasePool } from "./database/core/db.ts";
import { loadModelPricingFromEnv } from "./server/utils/index.ts";
import {
  parseContentEncodingHeader,
  readRequestBodyBuffer,
  zstdDecompressBuffer,
} from "./server/utils/index.ts";
import {
  generateApiKeyValue,
  loadBackendEnv,
  resolveOpenAIUpstreamAccountId,
} from "./server/utils/index.ts";
import {
  startNodeIpcServer,
  type IpcServerInstance,
} from "./server/ipc/uds-server.ts";
import {
  registerAccountMaintenanceRoutes,
  registerAdminRoutes,
  registerPortalAuthRoutes,
  registerPublicOpenAIRoutes,
  registerRequestLogRoutes,
  registerSetupRoutes,
  registerUserRoutes,
} from "./server/routes/index.ts";
import { lruGet } from "./server/services/index.ts";
import {
  bootstrapServerServices,
  createServerRuntimeState,
} from "./server/bootstrap/index.ts";
import {
  extractCodexResultFromSse,
  extractCodexTerminalResponseFromSse,
  isRecord,
} from "./server/openai-response-utils.ts";
import {
  pollCodexDeviceAuth,
  requestCodexDeviceCode,
} from "./openai-api/index.ts";

loadBackendEnv();

const authInvalidateListeners: Array<(ownerUserId: string) => void> = [];
const upstreamInvalidateListeners: Array<() => void> = [];

const {
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
  getOpenAIApiRuntimeConfig,
  authenticatePortalAccessTokenWithReason,
  getAccessTokenAuthErrorDetail,
  getPortalPrincipalFromLocals,
  cacheApiKey,
  invalidateApiKeyAuthCacheByToken,
  invalidateApiKeyAuthCacheByOwnerUserId,
  getAssignedSourceAccount,
  hydrateResponseAuthState,
  hydrateSourceAccountCache,
  hydrateUpstreamQuotaCache,
  invalidateActiveSourceAccount,
  getResponseSettlementQueueHealth,
  initializeResponseSettlementServices,
  enqueueResponseSettlement,
  flushAllResponseSettlements,
  flushUpstreamTokenPersistence,
  stopResponseSettlementServices,
  stopUpstreamQuotaServices,
  extractResponseUsage,
  estimateUsageCost,
  postCodexResponsesWithTokenRefresh,
  getCodexDailyWorkspaceUsageWithTokenRefresh,
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
  onAuthInvalidate: (ownerUserId) => {
    for (const listener of authInvalidateListeners) listener(ownerUserId);
  },
  onUpstreamInvalidate: () => {
    for (const listener of upstreamInvalidateListeners) listener();
  },
  onOwnerSettled: (ownerUserId, usedUsd) => {
    void getPortalUserById(ownerUserId)
      .then((user) => {
        if (
          user?.quota !== null &&
          user?.quota !== undefined &&
          Number(usedUsd) >= Number(user.quota)
        ) {
          for (const listener of authInvalidateListeners) listener(ownerUserId);
        }
      })
      .catch(() => undefined);
  },
});

const app = express();
const port = Number(process.env.PORT ?? 53141);
const host = process.env.HOST?.trim() || "localhost";
const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const defaultJsonParser = express.json({ limit: JSON_BODY_LIMIT_BYTES });

app.use(cors());
app.use(express.urlencoded({ extended: false }));
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
    const bodyLimitBytes = JSON_BODY_LIMIT_BYTES;
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

registerSetupRoutes(app);
registerPortalAuthRoutes(app);

app.use(async (req, res, next) => {
  try {
    if (req.path === "/health") {
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
      req.path.startsWith("/api/request-logs/") ||
      req.path.startsWith("/api/codex-client/");
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
  getResponseSettlementQueueHealth,
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
  normalizeOpenAIAccountPlatform,
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
  updatePortalUserQuotaById,
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

let ipcServerInstance: IpcServerInstance | null = null;

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

    try {
      ipcServerInstance = await startNodeIpcServer({
        enqueueSettlement: enqueueResponseSettlement,
      });
      authInvalidateListeners.push((ownerUserId) => {
        ipcServerInstance?.invalidateAuth(ownerUserId);
      });
      upstreamInvalidateListeners.push(() => {
        ipcServerInstance?.invalidateUpstream();
      });
    } catch (ipcErr) {
      console.warn("[backend] failed to start UDS IPC server:", ipcErr);
    }
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
  if (ipcServerInstance) {
    try {
      await ipcServerInstance.close();
    } catch {
      // ignore
    }
  }
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
