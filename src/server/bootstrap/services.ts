import { createAuthServices } from "../services/auth/auth-services.ts";
import { createOpenAIRuntimeServices } from "../services/openai/openai-runtime-services.ts";
import { createSourceAccountServices } from "../services/openai/source-account-services.ts";
import { createModelServices } from "../services/openai/model-services.ts";
import { createResponseSettlementServices } from "../services/openai/response-settlement-services.ts";
import { createUpstreamRequestServices } from "../services/openai/upstream-request-services.ts";
import { createUpstreamErrorServices } from "../services/openai/upstream-error-services.ts";
import type { UsdAmount } from "../../shared/usd.ts";

type AuthDependencies = Parameters<typeof createAuthServices>[0];
type SourceAccountDependencies = Parameters<
  typeof createSourceAccountServices
>[0];
type ModelDependencies = Parameters<typeof createModelServices>[0];
type SettlementDependencies = Parameters<
  typeof createResponseSettlementServices
>[0];
type UpstreamErrorDependencies = Parameters<
  typeof createUpstreamErrorServices
>[0];
type UpstreamRequestDependencies = Parameters<
  typeof createUpstreamRequestServices
>[0];

type BootstrapServerServicesDependencies =
  Pick<
    AuthDependencies,
    | "lruGet"
    | "lruSet"
    | "apiKeyAuthLruCache"
    | "apiKeyAuthTokenById"
    | "apiKeyAuthLoadingPromises"
    | "apiKeyAuthTokenVersions"
    | "apiKeyPendingCharges"
    | "getApiKeyByToken"
    | "billingAllowanceLruCache"
    | "billingAllowanceLoadingPromises"
    | "billingPendingChargesByOwnerId"
    | "billingReservationById"
    | "billingReservedAmountsByOwnerId"
    | "getPortalUserSpendAllowance"
    | "getPortalUserById"
  > &
  Pick<
    SourceAccountDependencies,
    "ensureDatabaseSchema" | "getActiveOpenAIAccount"
  > &
  Pick<UpstreamErrorDependencies, "isRecord"> &
  Pick<ModelDependencies, "modelPricing"> &
  Pick<SettlementDependencies, "flushResponseSettlements"> &
  Pick<
    UpstreamRequestDependencies,
    | "randomUUID"
    | "resolveOpenAIUpstreamAccountId"
    | "updateOpenAIAccountTokensById"
  > & {
    DEFAULT_OPENAI_API_USER_AGENT: string;
    DEFAULT_OPENAI_API_CLIENT_VERSION: string;
    ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS: number;
    API_KEY_AUTH_LRU_MAX: number;
    API_KEY_AUTH_LRU_TTL_MS: number;
    BILLING_ALLOWANCE_LRU_MAX: number;
    BILLING_ALLOWANCE_LRU_TTL_MS: number;
    BILLING_OVERDRAFT_LIMIT_USD: UsdAmount;
    BILLING_INFLIGHT_RESERVE_USD: UsdAmount;
    PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS: number;
    RESPONSE_SETTLEMENT_BATCH_SIZE: number;
    RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS: number;
    RESPONSE_SETTLEMENT_ID_CACHE_SIZE: number;
    RESPONSE_SETTLEMENT_QUEUE_MAX: number;
    RESPONSE_SETTLEMENT_RETRY_MAX_MS: number;
  };

export function bootstrapServerServices(
  deps: BootstrapServerServicesDependencies,
) {
  const runtime = createOpenAIRuntimeServices({
    defaultOpenAIApiUserAgent: deps.DEFAULT_OPENAI_API_USER_AGENT,
    defaultOpenAIApiClientVersion: deps.DEFAULT_OPENAI_API_CLIENT_VERSION,
  });

  const auth = createAuthServices({
    lruGet: deps.lruGet,
    lruSet: deps.lruSet,
    apiKeyAuthLruCache: deps.apiKeyAuthLruCache,
    apiKeyAuthTokenById: deps.apiKeyAuthTokenById,
    apiKeyAuthLoadingPromises: deps.apiKeyAuthLoadingPromises,
    apiKeyAuthTokenVersions: deps.apiKeyAuthTokenVersions,
    apiKeyPendingCharges: deps.apiKeyPendingCharges,
    apiKeyAuthLruMax: deps.API_KEY_AUTH_LRU_MAX,
    apiKeyAuthLruTtlMs: deps.API_KEY_AUTH_LRU_TTL_MS,
    getApiKeyByToken: deps.getApiKeyByToken,
    billingAllowanceLruCache: deps.billingAllowanceLruCache,
    billingAllowanceLoadingPromises: deps.billingAllowanceLoadingPromises,
    billingAllowanceLruMax: deps.BILLING_ALLOWANCE_LRU_MAX,
    billingAllowanceLruTtlMs: deps.BILLING_ALLOWANCE_LRU_TTL_MS,
    billingOverdraftLimitUsd: deps.BILLING_OVERDRAFT_LIMIT_USD,
    billingInflightReserveUsd: deps.BILLING_INFLIGHT_RESERVE_USD,
    billingPendingChargesByOwnerId: deps.billingPendingChargesByOwnerId,
    billingReservationById: deps.billingReservationById,
    billingReservedAmountsByOwnerId: deps.billingReservedAmountsByOwnerId,
    getPortalUserSpendAllowance: deps.getPortalUserSpendAllowance,
    getPortalUserById: deps.getPortalUserById,
  });

  const source = createSourceAccountServices({
    ensureDatabaseSchema: deps.ensureDatabaseSchema,
    getActiveOpenAIAccount: deps.getActiveOpenAIAccount,
    cacheTtlMs: deps.ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS,
  });

  const settlement = createResponseSettlementServices({
    flushResponseSettlements: deps.flushResponseSettlements,
    applyApiKeyPendingCharge: auth.applyApiKeyPendingCharge,
    settleApiKeyPendingCharge: auth.settleApiKeyPendingCharge,
    applyUserBillingAllowanceChargeCache:
      auth.applyUserBillingAllowanceChargeCache,
    settleUserBillingAllowanceChargeCache:
      auth.settleUserBillingAllowanceChargeCache,
    tryReserveUserBillingRequest: auth.tryReserveUserBillingRequest,
    releaseUserBillingRequestReservation:
      auth.releaseUserBillingRequestReservation,
    batchSize: deps.RESPONSE_SETTLEMENT_BATCH_SIZE,
    flushIntervalMs: deps.RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
    settledIdCacheSize: deps.RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
    queueMaxSize: deps.RESPONSE_SETTLEMENT_QUEUE_MAX,
    retryMaxMs: deps.RESPONSE_SETTLEMENT_RETRY_MAX_MS,
  });

  const upstreamError = createUpstreamErrorServices({
    isRecord: deps.isRecord,
    enqueueResponseSettlement: settlement.enqueueResponseSettlement,
  });

  const model = createModelServices({
    priceAfter272kInputThresholdTokens: deps.PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    modelPricing: deps.modelPricing,
  });

  const upstreamRequest = createUpstreamRequestServices({
    randomUUID: deps.randomUUID,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    updateOpenAIAccountTokensById: deps.updateOpenAIAccountTokensById,
    isTokenInvalidatedError: upstreamError.isTokenInvalidatedError,
  });

  return {
    ...runtime,
    ...auth,
    ...source,
    ...settlement,
    ...upstreamError,
    ...model,
    ...upstreamRequest,
  };
}

export type ServerServices = ReturnType<typeof bootstrapServerServices>;
