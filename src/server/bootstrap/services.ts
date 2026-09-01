import { createAuthServices } from "../services/auth/auth-services.ts";
import { createOpenAIRuntimeServices } from "../services/openai/openai-runtime-services.ts";
import { createSourceAccountServices } from "../services/openai/source-account-services.ts";
import { createApiKeyCacheServices } from "../services/auth/api-key-cache.ts";
import { createModelServices } from "../services/openai/model-services.ts";
import { createUpstreamRequestServices } from "../services/openai/upstream-request-services.ts";
import { createUpstreamErrorServices } from "../services/openai/upstream-error-services.ts";

type ApiKeyCacheDependencies = Parameters<
  typeof createApiKeyCacheServices
>[0];
type AuthDependencies = Parameters<typeof createAuthServices>[0];
type SourceAccountDependencies = Parameters<
  typeof createSourceAccountServices
>[0];
type ModelDependencies = Parameters<typeof createModelServices>[0];
type UpstreamErrorDependencies = Parameters<
  typeof createUpstreamErrorServices
>[0];
type UpstreamRequestDependencies = Parameters<
  typeof createUpstreamRequestServices
>[0];

type BootstrapServerServicesDependencies = Pick<
  ApiKeyCacheDependencies,
  | "apiKeysCache"
  | "apiKeyAuthLruCache"
  | "ensureDatabaseSchema"
  | "listApiKeys"
> &
  Pick<
    AuthDependencies,
    | "lruGet"
    | "lruSet"
    | "billingAllowanceLruCache"
    | "billingAllowanceLoadingPromises"
    | "getPortalUserSpendAllowance"
  > &
  Pick<SourceAccountDependencies, "getActiveOpenAIAccount"> &
  Pick<
    UpstreamErrorDependencies,
    "isRecord" | "resolveOpenAIUpstreamAccountId" | "createModelResponseLog"
  > &
  Pick<
    ModelDependencies,
    | "modelPricing"
    | "incrementApiKeyUsed"
    | "adjustPortalUserBalance"
    | "applyServiceTierBillingMultiplier"
  > &
  Pick<
    UpstreamRequestDependencies,
    | "randomUUID"
    | "updateOpenAIAccountAccessTokenById"
    | "disableOpenAIAccountByEmail"
  > & {
    DEFAULT_OPENAI_API_USER_AGENT: string;
    DEFAULT_OPENAI_API_CLIENT_VERSION: string;
    API_KEY_AUTH_LRU_MAX: number;
    API_KEY_AUTH_LRU_TTL_MS: number;
    BILLING_ALLOWANCE_LRU_MAX: number;
    BILLING_ALLOWANCE_LRU_TTL_MS: number;
    PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS: number;
  };

export function bootstrapServerServices(
  deps: BootstrapServerServicesDependencies,
) {
  const apiKeyCache = createApiKeyCacheServices({
    apiKeysCache: deps.apiKeysCache,
    apiKeyAuthLruCache: deps.apiKeyAuthLruCache,
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    listApiKeys: deps.listApiKeys,
  });

  const runtime = createOpenAIRuntimeServices({
    defaultOpenAIApiUserAgent: deps.DEFAULT_OPENAI_API_USER_AGENT,
    defaultOpenAIApiClientVersion: deps.DEFAULT_OPENAI_API_CLIENT_VERSION,
  });

  const auth = createAuthServices({
    adminAccessCookieName: "admin_access_token",
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
    getPortalUserSpendAllowance: deps.getPortalUserSpendAllowance,
    setApiKeysCache: apiKeyCache.setApiKeysCache,
  });

  const source = createSourceAccountServices({
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    getActiveOpenAIAccount: deps.getActiveOpenAIAccount,
  });

  const upstreamError = createUpstreamErrorServices({
    isRecord: deps.isRecord,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    createModelResponseLog: deps.createModelResponseLog,
  });

  const model = createModelServices({
    priceAfter272kInputThresholdTokens: deps.PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    modelPricing: deps.modelPricing,
    incrementApiKeyUsed: deps.incrementApiKeyUsed,
    applyApiKeyCacheUpdate: auth.applyApiKeyCacheUpdate,
    adjustPortalUserBalance: deps.adjustPortalUserBalance,
    applyUserBillingAllowanceChargeCache: auth.applyUserBillingAllowanceChargeCache,
    applyServiceTierBillingMultiplier: deps.applyServiceTierBillingMultiplier,
  });

  const upstreamRequest = createUpstreamRequestServices({
    randomUUID: deps.randomUUID,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    updateOpenAIAccountAccessTokenById: deps.updateOpenAIAccountAccessTokenById,
    disableOpenAIAccountByEmail: deps.disableOpenAIAccountByEmail,
    extractErrorInfo: upstreamError.extractErrorInfo,
    isTokenInvalidatedError: upstreamError.isTokenInvalidatedError,
    createAbortError: upstreamError.createAbortError,
  });

  return {
    ...apiKeyCache,
    ...runtime,
    ...auth,
    ...source,
    ...upstreamError,
    ...model,
    ...upstreamRequest,
  };
}

export type ServerServices = ReturnType<typeof bootstrapServerServices>;
