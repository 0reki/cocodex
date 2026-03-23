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
  createPortalInboxMessages,
  deleteApiKeyById,
  deleteSignupTaskById,
  disableOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  deleteOpenAIAccountByEmail,
  deleteOpenAIAccountsByEmails,
  enableOpenAIAccountByEmail,
  ensureDatabaseSchema,
  getSignupTaskById,
  listSignupTasks,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
  adjustPortalUserBalance,
  consumePortalUserAllowanceQuota,
  getSystemSettings,
  getPortalUserById,
  getPortalUserSpendAllowance,
  getOpenAIAccountByEmail,
  getTeamAccountLoginByEmail,
  getTeamOwnerAccountByEmail,
  listTeamOwnerAccountsPage,
  listOpenAIAccountsForModelCache,
  listTeamAccountsForModelCache,
  listOpenAIAccountsPage,
  listApiKeys,
  recoverExpiredOpenAIAccountCooldowns,
  recoverExpiredTeamAccountCooldowns,
  setOpenAIAccountCooldownById,
  setTeamAccountCooldownById,
  listSignupProxies,
  replaceSignupProxies,
  runDatabaseSelfCheck,
  recoverOrphanedSignupTasks,
  upsertSignupTask,
  updateApiKeyById,
  updateOpenAIAccountAccessTokenById,
  updateOpenAIAccountRateLimitById,
  updateTeamAccountRateLimitById,
  updateTeamAccountTokensById,
  updateSystemSettingsOpenAIModels,
  upsertSystemSettings,
  upsertOpenAIAccount,
  upsertTeamMemberAccount,
  upsertTeamOwnerAccount,
} from "@workspace/database";
import {
  normalizeAccountCacheRefreshSeconds,
  normalizeAccountCacheSize,
  normalizeCheckInReward,
  normalizeCloudMailDomains,
  normalizeMaxAttemptCount,
  normalizeOwnerMailDomains,
  normalizeUserMaxInFlight,
  normalizeUserRpmLimit,
  isOpenAIModelEnabled,
  sanitizeOpenAIModelsForStorage,
} from "./server/utils/index.ts";
import {
  createSseHeartbeatController,
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
  parseUpgradeQueryParam,
  sendWebSocketUpgradeErrorResponse,
  wsRawDataToText,
} from "./server/utils/index.ts";
import {
  PRIORITY_SERVICE_TIER,
  PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
  applyServiceTierBillingMultiplier,
  buildInvalidPriorityServiceTierErrorPayload,
  generateApiKeyValue,
  loadBackendEnv,
  parsePriorityServiceTier,
  resolvePriorityServiceTierForBilling,
  isOpenAIUpstreamSourceAccount,
  resolveOpenAIUpstreamAccountId,
  type UpstreamSourceAccountRecord,
} from "./server/utils/index.ts";
import {
  registerAccountMaintenanceRoutes,
  registerAdminRoutes,
  registerChatRoutes,
  registerPublicOpenAIRoutes,
  registerResponsesRoutes,
  ResponsesWebSocketUpgradeError,
  prepareResponsesWebSocketProxyContext,
  setupResponsesWebSocketProxy,
} from "./server/routes/index.ts";
import {
  registerSignupTaskRoutes,
  summarizeSignupResult,
} from "./server/signup-tasks/index.ts";
import {
  lruGet,
  lruSet,
  shuffleInPlace,
} from "./server/services/index.ts";
import {
  bootstrapServerServices,
  createSelectionCacheMarkers,
  createServerRuntimeState,
  sendWsErrorEvent,
} from "./server/bootstrap/index.ts";
import {
  buildPassthroughResponseFailureError,
  extractCodexResultFromSse,
  extractResponseErrorPayload,
  getResponseStatusFromPayload,
  isRecord,
  isResponseOutputTextDeltaEvent,
  isRetrySafePreTextResponsesEventType,
  isRetryableResponseFailurePayload,
  mapChatRequestToResponsesPayload,
  mapResponseEventToChatStreamChunks,
  mapResponseToChatCompletion,
  mapResponseUsageToChatUsage,
  parseJsonRecordText,
  stripUnsupportedResponsesFields,
} from "./server/openai-response-utils.ts";
const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0";
const {
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  MODELS_REFRESH_CLIENT_VERSION,
  DEFAULT_CHECK_IN_REWARD_MIN,
  DEFAULT_CHECK_IN_REWARD_MAX,
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  USER_RATE_LIMIT_LRU_MAX,
  USER_RATE_LIMIT_LRU_TTL_MS,
  SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS,
  STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS,
  STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX,
  USER_RPM_COUNTER_MAX,
  USER_IN_FLIGHT_STALE_MS,
  OPENAI_API_RUNTIME_CONFIG_TTL_MS,
  SIGNUP_PROXY_POOL_CACHE_TTL_MS,
  RATE_LIMIT_REFRESH_TIMEOUT_MS,
  TEAM_AUTH_USER_AGENT,
  TEAM_OWNER_MAX_MEMBERS,
  OWNER_SIGNUP_PROXY_URL,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  openAIModelsCache,
  apiKeysCache,
  apiKeyAuthLruCache,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
  userRateLimitLruCache,
  userRateLimitLoadingPromises,
  openAIAccountsLruCache,
  teamAccountsLruCache,
  openAIAccountsHashSelectionCache,
  teamAccountsHashSelectionCache,
  temporarilyExcludedSourceAccounts,
  temporarilyExcludedTeamSourceAccounts,
  stickyPromptAccountOverrides,
  upstreamRetryConfig,
  requestRateLimitConfig,
  userRpmCounters,
  userInFlightCounters,
  userRpmCleanupState,
  userInFlightCleanupState,
  openAIApiRuntimeConfigCache,
  signupProxyPoolCache,
} = createServerRuntimeState({
  normalizeUserMaxInFlight,
});
const {
  markOpenAIAccountsHashSelectionDirty,
  markTeamAccountsHashSelectionDirty,
} = createSelectionCacheMarkers({
  openAIAccountsHashSelectionCache,
  teamAccountsHashSelectionCache,
});

const {
  setApiKeysCache,
  ensureApiKeysCacheLoaded,
  touchUserInFlightSlot,
  consumeUserRpmAllowance,
  acquireUserInFlightSlot,
  createRequestAbortContext,
  setOpenAIModelsCache,
  invalidateOpenAIApiRuntimeConfigCache,
  applyOpenAIAccountCacheOptionsFromSettings,
  refreshRuntimeSystemSettings,
  ensureOpenAIModelsCacheLoaded,
  getOpenAIApiRuntimeConfig,
  authenticatePortalAccessTokenWithReason,
  authenticateApiKeyByAuthorizationHeaderWithReason,
  authenticateApiKeyWithReason,
  authenticateApiKey,
  getApiKeyAuthErrorDetail,
  getAccessTokenAuthErrorDetail,
  getPortalSessionFromLocals,
  isApiKeyQuotaExceeded,
  ensureUserBillingAllowanceOrNull,
  ensureEffectiveUserRateLimitOrNull,
  applyUserBillingAllowanceChargeCache,
  isApiKeyBoundToUser,
  applyApiKeyCacheUpdate,
  ensureOpenAIAccountsLruLoaded,
  markAccountCoolingDown,
  markSourceAccountTransientFailure,
  rememberStickyPromptAccountOverride,
  getStickyPromptCacheKey,
  selectSourceAccountForModelResponse,
  ensureSourceAccountPoolLoaded,
  selectSourceAccountForModelRequest,
  markSelectedSourceAccountTransientFailure,
  invalidateSignupProxyPoolCache,
  extractErrorInfo,
  buildInternalUpstreamErrorDetails,
  logInternalUpstreamFailure,
  buildPassthroughUpstreamError,
  isAbortError,
  isConnectionTimeoutError,
  isUpstreamBufferRetryLimitError,
  isRetryableUpstreamServerErrorStatus,
  computeRetryDelayMs,
  sleep,
  shouldPersistModelResponseLog,
  persistQuotaExceededLog,
  persistShortCircuitErrorLog,
  isRetryableEmptyForbiddenUpstreamError,
  isUpstreamAccountSwitchRetryableError,
  buildPublicModelsList,
  extractResponseUsage,
  estimateUsageCost,
  isDisabledOpenAIModel,
  isConfiguredOpenAIModel,
  resolveOpenAIModelUpstreamPool,
  chargeCompletedResponseUsage,
  mergeModelPricesBySlug,
  getRandomTeamOwnerModelRefreshAccount,
  getRandomOpenAIModelRefreshAccount,
  runTeamMemberSignupBatch,
  runTeamOwnerSignupBatch,
  reloginTeamAccount,
  listAvailableTeamOwners,
  getTeamOwnerEffectiveAvailableSlotsByEmail,
  listTeamOwnerMembersByEmail,
  inviteTeamOwnerMemberByEmail,
  removeTeamOwnerMemberByEmail,
  joinMembersToOwnerTeam,
  joinMembersToAvailableTeams,
  resolveRateLimitForAccount,
  postCodexResponsesWithTokenRefresh,
  postCodexResponsesCompactWithTokenRefresh,
  connectResponsesWebSocketProxyUpstream,
  postAudioTranscriptionWithTokenRefresh,
} = bootstrapServerServices({
  isRecord,
  lruGet,
  lruSet,
  normalizeUserRpmLimit,
  normalizeUserMaxInFlight,
  normalizeAccountCacheSize,
  normalizeAccountCacheRefreshSeconds,
  normalizeMaxAttemptCount,
  isOpenAIModelEnabled,
  getPortalUserSpendAllowance,
  getPortalUserById,
  recoverExpiredOpenAIAccountCooldowns,
  recoverExpiredTeamAccountCooldowns,
  listOpenAIAccountsForModelCache,
  listTeamAccountsForModelCache,
  setOpenAIAccountCooldownById,
  setTeamAccountCooldownById,
  listSignupProxies,
  createModelResponseLog,
  incrementApiKeyUsed,
  consumePortalUserAllowanceQuota,
  adjustPortalUserBalance,
  getSystemSettings,
  listApiKeys,
  listTeamOwnerAccountsPage,
  getTeamAccountLoginByEmail,
  getTeamOwnerAccountByEmail,
  ensureDatabaseSchema,
  updateOpenAIAccountAccessTokenById,
  updateTeamAccountTokensById,
  disableOpenAIAccountByEmail,
  upsertTeamMemberAccount,
  upsertTeamOwnerAccount,
  applyServiceTierBillingMultiplier,
  randomUUID: () => crypto.randomUUID(),
  markOpenAIAccountsHashSelectionDirty,
  markTeamAccountsHashSelectionDirty,
  isOpenAIUpstreamSourceAccount: (account: unknown) =>
    isOpenAIUpstreamSourceAccount(account as UpstreamSourceAccountRecord),
  resolveOpenAIUpstreamAccountId,
  DEFAULT_OPENAI_API_USER_AGENT,
  DEFAULT_OPENAI_API_CLIENT_VERSION,
  API_KEY_AUTH_LRU_MAX,
  API_KEY_AUTH_LRU_TTL_MS,
  BILLING_ALLOWANCE_LRU_MAX,
  BILLING_ALLOWANCE_LRU_TTL_MS,
  USER_RATE_LIMIT_LRU_MAX,
  USER_RATE_LIMIT_LRU_TTL_MS,
  SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS,
  STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS,
  STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX,
  USER_RPM_COUNTER_MAX,
  USER_IN_FLIGHT_STALE_MS,
  OPENAI_API_RUNTIME_CONFIG_TTL_MS,
  SIGNUP_PROXY_POOL_CACHE_TTL_MS,
  RATE_LIMIT_REFRESH_TIMEOUT_MS,
  TEAM_AUTH_USER_AGENT,
  TEAM_OWNER_MAX_MEMBERS,
  OWNER_SIGNUP_PROXY_URL,
  PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
  openAIModelsCache,
  apiKeysCache,
  apiKeyAuthLruCache,
  billingAllowanceLruCache,
  billingAllowanceLoadingPromises,
  userRateLimitLruCache,
  userRateLimitLoadingPromises,
  openAIAccountsLruCache,
  teamAccountsLruCache,
  openAIAccountsHashSelectionCache,
  teamAccountsHashSelectionCache,
  temporarilyExcludedSourceAccounts,
  temporarilyExcludedTeamSourceAccounts,
  stickyPromptAccountOverrides,
  upstreamRetryConfig,
  requestRateLimitConfig,
  userRpmCounters,
  userInFlightCounters,
  userRpmCleanupState,
  userInFlightCleanupState,
  openAIApiRuntimeConfigCache,
  signupProxyPoolCache,
});
loadBackendEnv();

const app = express();
const port = Number(process.env.PORT ?? 53141);
const host = process.env.HOST?.trim() || "localhost";
const JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const defaultJsonParser = express.json({ limit: JSON_BODY_LIMIT_BYTES });
const AUDIO_TRANSCRIPTION_BODY_MAX_BYTES = Number(
  process.env.AUDIO_TRANSCRIPTION_BODY_MAX_BYTES ?? 64 * 1024 * 1024,
);
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

app.use(async (req, res, next) => {
  try {
    if (
      req.path.startsWith("/v1/") ||
      req.path === "/api/public/models" ||
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
      req.path.startsWith("/api/api-keys/") ||
      req.path === "/api/team-accounts/owner/fill-members" ||
      /^\/api\/team-accounts\/owner\/[^/]+\/available-slots$/.test(req.path) ||
      /^\/api\/team-accounts\/owner\/[^/]+\/members$/.test(req.path);
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
  } catch (error) {
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
  authenticateApiKey,
  ensureOpenAIModelsCacheLoaded,
  openAIModelsCache,
  isOpenAIModelEnabled,
  buildPublicModelsList,
  createRequestAbortContext,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  ensureEffectiveUserRateLimitOrNull,
  acquireUserInFlightSlot,
  consumeUserRpmAllowance,
  ensureUserBillingAllowanceOrNull,
  readRequestBodyBuffer,
  AUDIO_TRANSCRIPTION_BODY_MAX_BYTES,
  refreshRuntimeSystemSettings,
  ensureOpenAIAccountsLruLoaded,
  getOpenAIApiRuntimeConfig,
  postAudioTranscriptionWithTokenRefresh,
  upstreamRetryConfig,
  selectSourceAccountForModelResponse,
  extractErrorInfo,
  isAbortError,
  isUpstreamAccountSwitchRetryableError,
  isRetryableUpstreamServerErrorStatus,
  isConnectionTimeoutError,
  markSourceAccountTransientFailure,
  sleep,
  computeRetryDelayMs,
  shouldPersistModelResponseLog,
  createModelResponseLog,
});

registerResponsesRoutes(app, {
  createRequestAbortContext,
  parsePriorityServiceTier,
  PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
  buildInvalidPriorityServiceTierErrorPayload,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  ensureEffectiveUserRateLimitOrNull,
  acquireUserInFlightSlot,
  consumeUserRpmAllowance,
  ensureUserBillingAllowanceOrNull,
  refreshRuntimeSystemSettings,
  upstreamRetryConfig,
  ensureOpenAIModelsCacheLoaded,
  stripUnsupportedResponsesFields,
  getStickyPromptCacheKey,
  isDisabledOpenAIModel,
  isConfiguredOpenAIModel,
  resolveOpenAIModelUpstreamPool,
  ensureSourceAccountPoolLoaded,
  getOpenAIApiRuntimeConfig,
  selectSourceAccountForModelRequest,
  resolveOpenAIUpstreamAccountId,
  postCodexResponsesWithTokenRefresh,
  postCodexResponsesCompactWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  buildInternalUpstreamErrorDetails,
  logInternalUpstreamFailure,
  isUpstreamAccountSwitchRetryableError,
  isRetryableEmptyForbiddenUpstreamError,
  isUpstreamBufferRetryLimitError,
  isRetryableUpstreamServerErrorStatus,
  isConnectionTimeoutError,
  markSelectedSourceAccountTransientFailure,
  sleep,
  computeRetryDelayMs,
  getResponseStatusFromPayload,
  extractResponseErrorPayload,
  isRetryableResponseFailurePayload,
  markSourceAccountTransientFailure,
  createSseHeartbeatController,
  touchUserInFlightSlot,
  isRetrySafePreTextResponsesEventType,
  isResponseOutputTextDeltaEvent,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
  applyApiKeyCacheUpdate,
  consumePortalUserAllowanceQuota,
  adjustPortalUserBalance,
  applyUserBillingAllowanceChargeCache,
  resolveRateLimitForAccount,
  markAccountCoolingDown,
  isOpenAIUpstreamSourceAccount,
  updateOpenAIAccountRateLimitById,
  updateTeamAccountRateLimitById,
  createModelResponseLog,
  rememberStickyPromptAccountOverride,
});

registerChatRoutes(app, {
  createRequestAbortContext,
  parsePriorityServiceTier,
  PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
  buildInvalidPriorityServiceTierErrorPayload,
  authenticateApiKeyWithReason,
  getApiKeyAuthErrorDetail,
  persistShortCircuitErrorLog,
  isApiKeyQuotaExceeded,
  persistQuotaExceededLog,
  isApiKeyBoundToUser,
  ensureEffectiveUserRateLimitOrNull,
  acquireUserInFlightSlot,
  consumeUserRpmAllowance,
  ensureUserBillingAllowanceOrNull,
  refreshRuntimeSystemSettings,
  upstreamRetryConfig,
  ensureOpenAIModelsCacheLoaded,
  mapChatRequestToResponsesPayload,
  getStickyPromptCacheKey,
  isDisabledOpenAIModel,
  isConfiguredOpenAIModel,
  resolveOpenAIModelUpstreamPool,
  ensureSourceAccountPoolLoaded,
  getOpenAIApiRuntimeConfig,
  isRecord,
  selectSourceAccountForModelRequest,
  resolveOpenAIUpstreamAccountId,
  postCodexResponsesWithTokenRefresh,
  extractErrorInfo,
  isAbortError,
  isUpstreamAccountSwitchRetryableError,
  isRetryableEmptyForbiddenUpstreamError,
  isUpstreamBufferRetryLimitError,
  isRetryableUpstreamServerErrorStatus,
  isConnectionTimeoutError,
  markSelectedSourceAccountTransientFailure,
  sleep,
  computeRetryDelayMs,
  getResponseStatusFromPayload,
  extractResponseErrorPayload,
  isRetryableResponseFailurePayload,
  buildPassthroughResponseFailureError,
  mapResponseToChatCompletion,
  markSourceAccountTransientFailure,
  createSseHeartbeatController,
  touchUserInFlightSlot,
  isResponseOutputTextDeltaEvent,
  mapResponseEventToChatStreamChunks,
  mapResponseUsageToChatUsage,
  buildPassthroughUpstreamError,
  shouldPersistModelResponseLog,
  extractResponseUsage,
  applyServiceTierBillingMultiplier,
  estimateUsageCost,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
  applyApiKeyCacheUpdate,
  consumePortalUserAllowanceQuota,
  adjustPortalUserBalance,
  applyUserBillingAllowanceChargeCache,
  resolveRateLimitForAccount,
  markAccountCoolingDown,
  isOpenAIUpstreamSourceAccount,
  updateOpenAIAccountRateLimitById,
  updateTeamAccountRateLimitById,
  createModelResponseLog,
  rememberStickyPromptAccountOverride,
  isRetrySafePreTextResponsesEventType,
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
  enableOpenAIAccountByEmail,
  disableOpenAIAccountsByEmails,
  ensureDatabaseSchema,
  listSignupProxies,
  replaceSignupProxies,
  invalidateSignupProxyPoolCache,
  getOpenAIApiRuntimeConfig,
  resolveRateLimitForAccount,
  upsertOpenAIAccount,
  markAccountCoolingDown,
  ensureOpenAIModelsCacheLoaded,
  ensureOpenAIAccountsLruLoaded,
  getSystemSettings,
  applyOpenAIAccountCacheOptionsFromSettings,
  openAIModelsCache,
  openAIAccountsLruCache,
  upstreamRetryConfig,
  requestRateLimitConfig,
  DEFAULT_CHECK_IN_REWARD_MIN,
  DEFAULT_CHECK_IN_REWARD_MAX,
  normalizeCloudMailDomains,
  normalizeOwnerMailDomains,
  normalizeAccountCacheSize,
  normalizeAccountCacheRefreshSeconds,
  normalizeMaxAttemptCount,
  normalizeUserRpmLimit,
  normalizeUserMaxInFlight,
  normalizeCheckInReward,
  sanitizeOpenAIModelsForStorage,
  upsertSystemSettings,
  updateSystemSettingsOpenAIModels,
  setOpenAIModelsCache,
  invalidateOpenAIApiRuntimeConfigCache,
  getRandomOpenAIModelRefreshAccount,
  getRandomTeamOwnerModelRefreshAccount,
  mergeModelPricesBySlug,
  MODELS_REFRESH_CLIENT_VERSION,
  isOpenAIModelEnabled,
});

registerSignupTaskRoutes(app, {
  createPortalInboxMessages,
  ensureDatabaseSchema,
  listSignupProxies,
  listSignupTasks,
  listOpenAIAccountsForModelCache,
  getSignupTaskById,
  deleteSignupTaskById,
  getSystemSettings,
  getPortalUserById,
  shuffleInPlace,
  upsertSignupTask,
  runTeamMemberSignupBatch,
  runTeamOwnerSignupBatch,
  joinMembersToOwnerTeam,
  joinMembersToAvailableTeams,
  getOpenAIApiRuntimeConfig,
  resolveRateLimitForAccount,
  upsertOpenAIAccount,
  markAccountCoolingDown,
  getTeamOwnerAccountByEmail,
});
registerAccountMaintenanceRoutes(app, {
  summarizeSignupResult,
  ensureDatabaseSchema,
  getOpenAIApiRuntimeConfig,
  resolveRateLimitForAccount,
  upsertOpenAIAccount,
  markAccountCoolingDown,
  getTeamOwnerAccountByEmail,
  listAvailableTeamOwners,
  getTeamOwnerEffectiveAvailableSlotsByEmail,
  listTeamOwnerMembersByEmail,
  inviteTeamOwnerMemberByEmail,
  removeTeamOwnerMemberByEmail,
  reloginTeamAccount,
  getOpenAIAccountByEmail,
  postCodexResponsesWithTokenRefresh,
  extractCodexResultFromSse,
  extractResponseUsage,
  ensureOpenAIModelsCacheLoaded,
  estimateUsageCost,
  updateOpenAIAccountRateLimitById,
  shouldPersistModelResponseLog,
  createModelResponseLog,
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
          PRIORITY_SERVICE_TIER,
          PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
          isRecord,
          parsePriorityServiceTier,
          parseUpgradeQueryParam,
          buildInvalidPriorityServiceTierErrorPayload,
          authenticateApiKeyByAuthorizationHeaderWithReason,
          getApiKeyAuthErrorDetail,
          isApiKeyQuotaExceeded,
          isApiKeyBoundToUser,
          ensureEffectiveUserRateLimitOrNull,
          acquireUserInFlightSlot,
          consumeUserRpmAllowance,
          ensureUserBillingAllowanceOrNull,
          ensureOpenAIModelsCacheLoaded,
          ensureOpenAIAccountsLruLoaded,
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
        context.releaseUserInFlightSlot();
        context.refundUserRpmAllowance();
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
            PRIORITY_SERVICE_TIER,
            PRIORITY_SERVICE_TIER_ERROR_MESSAGE,
            shouldPersistModelResponseLog,
            createModelResponseLog,
            extractResponseUsage,
            applyServiceTierBillingMultiplier,
            estimateUsageCost,
            normalizeWsCloseCode,
            normalizeWsCloseReason,
            resolvePriorityServiceTierForBilling,
            chargeCompletedResponseUsage,
            touchUserInFlightSlot,
            sendWsErrorEvent,
            wsRawDataToText,
            parseJsonRecordText,
            isRecord,
            parsePriorityServiceTier,
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
      // Release upgrade-time resources if the ws handshake fails before the
      // proxy fully takes ownership of the socket lifecycle.
      context.releaseUserInFlightSlot();
      context.refundUserRpmAllowance();
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
    const recoveredSignupTasks = await recoverOrphanedSignupTasks();
    if (recoveredSignupTasks > 0) {
      console.warn(
        `[backend] recovered orphaned signup tasks: ${recoveredSignupTasks}`,
      );
    }
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
    await ensureOpenAIModelsCacheLoaded(true);
    await ensureApiKeysCacheLoaded(true);
    await ensureOpenAIAccountsLruLoaded(true);
  } catch (error) {
    console.error("[backend] schema init failed:", error);
  }
  console.log(`[backend] listening at http://${host}:${port}`);
});
