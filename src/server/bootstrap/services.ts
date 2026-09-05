import { createAuthServices } from "../services/auth/auth-services.ts";
import { createOpenAIRuntimeServices } from "../services/openai/openai-runtime-services.ts";
import { createSourceAccountServices } from "../services/openai/source-account-services.ts";
import { createModelServices } from "../services/openai/model-services.ts";
import { createResponseSettlementServices } from "../services/openai/response-settlement-services.ts";
import { createUpstreamRequestServices } from "../services/openai/upstream-request-services.ts";
import { createUpstreamQuotaServices } from "../services/openai/upstream-quota-services.ts";
import { createUpstreamErrorServices } from "../services/openai/upstream-error-services.ts";

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
type UpstreamQuotaDependencies = Parameters<
  typeof createUpstreamQuotaServices
>[0];

type BootstrapServerServicesDependencies =
  Pick<
    AuthDependencies,
    | "lruGet"
    | "apiKeyAuthLruCache"
    | "apiKeyAuthTokenById"
    | "apiKeyPendingCharges"
    | "getPortalUserById"
  > &
  Pick<SourceAccountDependencies, "listAssignedOpenAIAccounts"> &
  Pick<UpstreamErrorDependencies, "isRecord"> &
  Pick<ModelDependencies, "modelPricing"> &
  Pick<SettlementDependencies, "flushResponseSettlements"> &
  Pick<
    UpstreamQuotaDependencies,
    | "getUserUpstreamQuotaAllocation"
    | "listPortalUserUpstreamAssignments"
    | "listUpstreamQuotaMemberAllocations"
    | "recordUserUpstreamQuotaUsage"
    | "syncUpstreamQuotaWindow"
  > &
  Pick<
    UpstreamRequestDependencies,
    | "randomUUID"
    | "resolveOpenAIUpstreamAccountId"
    | "updateOpenAIAccountTokensById"
  > & {
    RESPONSE_SETTLEMENT_BATCH_SIZE: number;
    RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS: number;
    RESPONSE_SETTLEMENT_ID_CACHE_SIZE: number;
    RESPONSE_SETTLEMENT_QUEUE_MAX: number;
    RESPONSE_SETTLEMENT_RETRY_MAX_MS: number;
    RESPONSE_SETTLEMENT_WAL_PATH: string;
    RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS: number;
    UPSTREAM_QUOTA_REFRESH_INTERVAL_MS: number;
  };

export function bootstrapServerServices(
  deps: BootstrapServerServicesDependencies,
) {
  const runtime = createOpenAIRuntimeServices();

  const auth = createAuthServices({
    lruGet: deps.lruGet,
    apiKeyAuthLruCache: deps.apiKeyAuthLruCache,
    apiKeyAuthTokenById: deps.apiKeyAuthTokenById,
    apiKeyPendingCharges: deps.apiKeyPendingCharges,
    getPortalUserById: deps.getPortalUserById,
  });

  const source = createSourceAccountServices({
    listAssignedOpenAIAccounts: deps.listAssignedOpenAIAccounts,
  });

  const settlement = createResponseSettlementServices({
    flushResponseSettlements: deps.flushResponseSettlements,
    applyApiKeyPendingCharge: auth.applyApiKeyPendingCharge,
    settleApiKeyPendingCharge: auth.settleApiKeyPendingCharge,
    batchSize: deps.RESPONSE_SETTLEMENT_BATCH_SIZE,
    flushIntervalMs: deps.RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
    settledIdCacheSize: deps.RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
    queueMaxSize: deps.RESPONSE_SETTLEMENT_QUEUE_MAX,
    retryMaxMs: deps.RESPONSE_SETTLEMENT_RETRY_MAX_MS,
    walPath: deps.RESPONSE_SETTLEMENT_WAL_PATH,
    walCompactAfterRecords:
      deps.RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS,
  });

  const upstreamError = createUpstreamErrorServices({
    isRecord: deps.isRecord,
    enqueueResponseSettlement: settlement.enqueueResponseSettlement,
  });

  const model = createModelServices({
    modelPricing: deps.modelPricing,
  });

  const upstreamRequest = createUpstreamRequestServices({
    randomUUID: deps.randomUUID,
    resolveOpenAIUpstreamAccountId: deps.resolveOpenAIUpstreamAccountId,
    updateOpenAIAccountTokensById: deps.updateOpenAIAccountTokensById,
    isTokenInvalidatedError: upstreamError.isTokenInvalidatedError,
  });

  const upstreamQuota = createUpstreamQuotaServices({
    getCodexUsageWithTokenRefresh:
      upstreamRequest.getCodexUsageWithTokenRefresh,
    getOpenAIApiRuntimeConfig: runtime.getOpenAIApiRuntimeConfig,
    getUserUpstreamQuotaAllocation: deps.getUserUpstreamQuotaAllocation,
    listPortalUserUpstreamAssignments:
      deps.listPortalUserUpstreamAssignments,
    listUpstreamQuotaMemberAllocations:
      deps.listUpstreamQuotaMemberAllocations,
    recordUserUpstreamQuotaUsage: deps.recordUserUpstreamQuotaUsage,
    syncUpstreamQuotaWindow: deps.syncUpstreamQuotaWindow,
    refreshIntervalMs: deps.UPSTREAM_QUOTA_REFRESH_INTERVAL_MS,
  });

  return {
    ...runtime,
    ...auth,
    ...source,
    ...settlement,
    ...upstreamError,
    ...model,
    ...upstreamRequest,
    ...upstreamQuota,
  };
}

export type ServerServices = ReturnType<typeof bootstrapServerServices>;
