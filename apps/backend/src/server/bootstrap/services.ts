import { createAuthServices } from "../services/auth/auth-services.ts";
import { createOpenAIRuntimeServices } from "../services/openai/openai-runtime-services.ts";
import { createRequestLimitServices } from "../services/auth/request-limits.ts";
import { createSourceAccountServices } from "../services/openai/source-account-services.ts";
import { createSignupProxyPoolServices } from "../services/signup/signup-proxy-pool.ts";
import { createApiKeyCacheServices } from "../services/auth/api-key-cache.ts";
import {
  createModelServices,
  getNestedNumberFromRecord,
} from "../services/openai/model-services.ts";
import { createTeamServices } from "../services/team/team-services.ts";
import { createUpstreamRequestServices } from "../services/openai/upstream-request-services.ts";
import { createUpstreamErrorServices } from "../services/openai/upstream-error-services.ts";
import { createModelRefreshServices } from "../services/openai/model-refresh-services.ts";

export function bootstrapServerServices(deps: any) {
  const apiKeyCache = createApiKeyCacheServices({
    apiKeysCache: deps.apiKeysCache,
    apiKeyAuthLruCache: deps.apiKeyAuthLruCache,
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    listApiKeys: deps.listApiKeys,
  });

  const requestLimits = createRequestLimitServices({
    normalizeUserRpmLimit: deps.normalizeUserRpmLimit,
    normalizeUserMaxInFlight: deps.normalizeUserMaxInFlight,
    requestRateLimitConfig: deps.requestRateLimitConfig,
    userRpmCounters: deps.userRpmCounters,
    userRpmCounterMax: deps.USER_RPM_COUNTER_MAX,
    userRpmCleanupState: deps.userRpmCleanupState,
    userInFlightCounters: deps.userInFlightCounters,
    userInFlightStaleMs: deps.USER_IN_FLIGHT_STALE_MS,
    userInFlightCleanupState: deps.userInFlightCleanupState,
  });

  const runtime = createOpenAIRuntimeServices({
    isOpenAIModelEnabled: deps.isOpenAIModelEnabled,
    normalizeAccountCacheSize: deps.normalizeAccountCacheSize,
    normalizeAccountCacheRefreshSeconds: deps.normalizeAccountCacheRefreshSeconds,
    normalizeMaxAttemptCount: deps.normalizeMaxAttemptCount,
    normalizeUserRpmLimit: deps.normalizeUserRpmLimit,
    normalizeUserMaxInFlight: deps.normalizeUserMaxInFlight,
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    getSystemSettings: deps.getSystemSettings,
    defaultOpenAIApiUserAgent: deps.DEFAULT_OPENAI_API_USER_AGENT,
    defaultOpenAIApiClientVersion: deps.DEFAULT_OPENAI_API_CLIENT_VERSION,
    openaiApiRuntimeConfigTtlMs: deps.OPENAI_API_RUNTIME_CONFIG_TTL_MS,
    openAIModelsCache: deps.openAIModelsCache,
    openAIApiRuntimeConfigCache: deps.openAIApiRuntimeConfigCache,
    openAIAccountsLruCache: deps.openAIAccountsLruCache,
    teamAccountsLruCache: deps.teamAccountsLruCache,
    upstreamRetryConfig: deps.upstreamRetryConfig,
    requestRateLimitConfig: deps.requestRateLimitConfig,
    userRpmCounters: deps.userRpmCounters,
    userInFlightCounters: deps.userInFlightCounters,
    markOpenAIAccountsHashSelectionDirty: deps.markOpenAIAccountsHashSelectionDirty,
    markTeamAccountsHashSelectionDirty: deps.markTeamAccountsHashSelectionDirty,
  });

  const auth = createAuthServices({
    adminAccessCookieName: "admin_access_token",
    isRecord: deps.isRecord,
    lruGet: deps.lruGet,
    lruSet: deps.lruSet,
    apiKeysCache: deps.apiKeysCache,
    apiKeyAuthLruCache: deps.apiKeyAuthLruCache,
    apiKeyAuthLruMax: deps.API_KEY_AUTH_LRU_MAX,
    apiKeyAuthLruTtlMs: deps.API_KEY_AUTH_LRU_TTL_MS,
    ensureApiKeysCacheLoaded: apiKeyCache.ensureApiKeysCacheLoaded,
    billingAllowanceLruCache: deps.billingAllowanceLruCache,
    billingAllowanceLoadingPromises: deps.billingAllowanceLoadingPromises,
    billingAllowanceLruMax: deps.BILLING_ALLOWANCE_LRU_MAX,
    billingAllowanceLruTtlMs: deps.BILLING_ALLOWANCE_LRU_TTL_MS,
    userRateLimitLruCache: deps.userRateLimitLruCache,
    userRateLimitLoadingPromises: deps.userRateLimitLoadingPromises,
    userRateLimitLruMax: deps.USER_RATE_LIMIT_LRU_MAX,
    userRateLimitLruTtlMs: deps.USER_RATE_LIMIT_LRU_TTL_MS,
    requestRateLimitConfig: deps.requestRateLimitConfig,
    normalizeUserRpmLimit: deps.normalizeUserRpmLimit,
    normalizeUserMaxInFlight: deps.normalizeUserMaxInFlight,
    getPortalUserSpendAllowance: deps.getPortalUserSpendAllowance,
    getPortalUserById: deps.getPortalUserById,
    setApiKeysCache: apiKeyCache.setApiKeysCache,
  });

  const source = createSourceAccountServices({
    isRecord: deps.isRecord,
    getNestedNumber: getNestedNumberFromRecord,
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    recoverExpiredOpenAIAccountCooldowns: deps.recoverExpiredOpenAIAccountCooldowns,
    recoverExpiredTeamAccountCooldowns: deps.recoverExpiredTeamAccountCooldowns,
    listOpenAIAccountsForModelCache: deps.listOpenAIAccountsForModelCache,
    listTeamAccountsForModelCache: deps.listTeamAccountsForModelCache,
    setOpenAIAccountCooldownById: deps.setOpenAIAccountCooldownById,
    setTeamAccountCooldownById: deps.setTeamAccountCooldownById,
    isOpenAIUpstreamSourceAccount: deps.isOpenAIUpstreamSourceAccount,
    openAIAccountsLruCache: deps.openAIAccountsLruCache,
    teamAccountsLruCache: deps.teamAccountsLruCache,
    openAIAccountsHashSelectionCache: deps.openAIAccountsHashSelectionCache,
    teamAccountsHashSelectionCache: deps.teamAccountsHashSelectionCache,
    temporarilyExcludedSourceAccounts: deps.temporarilyExcludedSourceAccounts,
    temporarilyExcludedTeamSourceAccounts: deps.temporarilyExcludedTeamSourceAccounts,
    stickyPromptAccountOverrides: deps.stickyPromptAccountOverrides,
    sourceAccountTransientExcludeMs: deps.SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS,
    stickyPromptAccountOverrideTtlMs: deps.STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS,
    stickyPromptAccountOverrideMax: deps.STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX,
    markOpenAIAccountsHashSelectionDirty: deps.markOpenAIAccountsHashSelectionDirty,
    markTeamAccountsHashSelectionDirty: deps.markTeamAccountsHashSelectionDirty,
  });

  const signupProxy = createSignupProxyPoolServices({
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    listSignupProxies: deps.listSignupProxies,
    signupProxyPoolCache: deps.signupProxyPoolCache,
    signupProxyPoolCacheTtlMs: deps.SIGNUP_PROXY_POOL_CACHE_TTL_MS,
  });

  const upstreamError = createUpstreamErrorServices({
    isRecord: deps.isRecord,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    createModelResponseLog: deps.createModelResponseLog,
  });

  const model = createModelServices({
    priceAfter272kInputThresholdTokens: deps.PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    openAIModelsCache: deps.openAIModelsCache,
    isOpenAIModelEnabled: deps.isOpenAIModelEnabled,
    ensureOpenAIModelsCacheLoaded: runtime.ensureOpenAIModelsCacheLoaded,
    incrementApiKeyUsed: deps.incrementApiKeyUsed,
    applyApiKeyCacheUpdate: (updatedKey: unknown) =>
      auth.applyApiKeyCacheUpdate(updatedKey as never),
    ensureUserBillingAllowanceOrNull: auth.ensureUserBillingAllowanceOrNull,
    consumePortalUserAllowanceQuota: deps.consumePortalUserAllowanceQuota,
    adjustPortalUserBalance: deps.adjustPortalUserBalance,
    applyUserBillingAllowanceChargeCache: auth.applyUserBillingAllowanceChargeCache,
    applyServiceTierBillingMultiplier: deps.applyServiceTierBillingMultiplier,
  });

  const modelRefresh = createModelRefreshServices({
    listTeamOwnerAccountsPage: deps.listTeamOwnerAccountsPage,
    listOpenAIAccountsForModelCache: deps.listOpenAIAccountsForModelCache,
  });

  let refreshAccessTokenByRefreshTokenRef:
    | ((...args: any[]) => Promise<{ accessToken: string; refreshToken?: string | null }>)
    | null = null;
  let resolveRateLimitForAccountRef:
    | ((...args: any[]) => Promise<Record<string, unknown> | null>)
    | null = null;

  const upstreamRequest = createUpstreamRequestServices({
    randomUUID: deps.randomUUID,
    rateLimitRefreshTimeoutMs: deps.RATE_LIMIT_REFRESH_TIMEOUT_MS,
    resolveOpenAIUpstreamProxyUrl: signupProxy.resolveOpenAIUpstreamProxyUrl,
    isOpenAIUpstreamSourceAccount: deps.isOpenAIUpstreamSourceAccount,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    refreshAccessTokenByRefreshToken: (...args: any[]) => {
      if (!refreshAccessTokenByRefreshTokenRef) {
        throw new Error("team refreshAccessTokenByRefreshToken is not initialized");
      }
      return refreshAccessTokenByRefreshTokenRef(...args);
    },
    updateOpenAIAccountAccessTokenById: deps.updateOpenAIAccountAccessTokenById,
    updateTeamAccountTokensById: deps.updateTeamAccountTokensById,
    disableOpenAIAccountByEmail: deps.disableOpenAIAccountByEmail,
    markOpenAIAccountsHashSelectionDirty: deps.markOpenAIAccountsHashSelectionDirty,
    markTeamAccountsHashSelectionDirty: deps.markTeamAccountsHashSelectionDirty,
    openAIAccountsLruCache: deps.openAIAccountsLruCache,
    teamAccountsLruCache: deps.teamAccountsLruCache,
    ensureOpenAIAccountsLruLoaded: source.ensureOpenAIAccountsLruLoaded,
    refreshRuntimeSystemSettings: runtime.refreshRuntimeSystemSettings,
    selectRandomSourceAccountForResponsesWebSocket:
      source.selectRandomSourceAccountForResponsesWebSocket,
    markSourceAccountTransientFailure: source.markSourceAccountTransientFailure,
    upstreamRetryConfig: deps.upstreamRetryConfig,
    extractErrorInfo: upstreamError.extractErrorInfo,
    isAbortError: upstreamError.isAbortError,
    isTokenInvalidatedError: upstreamError.isTokenInvalidatedError,
    isConnectionTimeoutError: upstreamError.isConnectionTimeoutError,
    isRetryableUpstreamServerErrorStatus:
      upstreamError.isRetryableUpstreamServerErrorStatus,
    isUpstreamAccountSwitchRetryableError:
      upstreamError.isUpstreamAccountSwitchRetryableError,
    computeRetryDelayMs: upstreamError.computeRetryDelayMs,
    sleep: upstreamError.sleep,
    createAbortError: upstreamError.createAbortError,
  });

  const team = createTeamServices({
    authUserAgent: deps.TEAM_AUTH_USER_AGENT,
    ownerSignupProxyUrl: deps.OWNER_SIGNUP_PROXY_URL,
    teamOwnerMaxMembers: deps.TEAM_OWNER_MAX_MEMBERS,
    getSystemSettings: deps.getSystemSettings,
    getOpenAIApiRuntimeConfig: runtime.getOpenAIApiRuntimeConfig,
    resolveRateLimitForAccount: (...args: any[]) => {
      if (!resolveRateLimitForAccountRef) {
        throw new Error("upstream resolveRateLimitForAccount is not initialized");
      }
      return resolveRateLimitForAccountRef(...args);
    },
    upsertTeamMemberAccount: deps.upsertTeamMemberAccount,
    upsertTeamOwnerAccount: deps.upsertTeamOwnerAccount,
    listTeamOwnerAccountsPage: deps.listTeamOwnerAccountsPage,
    getTeamAccountLoginByEmail: deps.getTeamAccountLoginByEmail,
    getTeamOwnerAccountByEmail: deps.getTeamOwnerAccountByEmail,
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    refreshAccessTokenByRefreshTokenExternal: undefined,
  });
  refreshAccessTokenByRefreshTokenRef = team.refreshAccessTokenByRefreshToken;
  resolveRateLimitForAccountRef = upstreamRequest.resolveRateLimitForAccount;

  return {
    ...apiKeyCache,
    ...requestLimits,
    ...runtime,
    ...auth,
    ...source,
    ...signupProxy,
    ...upstreamError,
    ...model,
    ...modelRefresh,
    ...team,
    ...upstreamRequest,
  };
}
