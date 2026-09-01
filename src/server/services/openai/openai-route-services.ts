import type { Request, Response } from "express";
import type {
  adjustPortalUserBalance,
  createModelResponseLog,
  hasSuccessfulFinalChargeLog,
  incrementApiKeyUsed,
} from "../../../database/index.ts";
import type { ServerServices } from "../../bootstrap/services.ts";
import type {
  applyServiceTierBillingMultiplier,
  resolveOpenAIUpstreamAccountId,
  resolvePriorityServiceTierForBilling,
} from "../../utils/index.ts";

export type OpenAIRequestPreparationDependencies = Pick<
  ServerServices,
  | "authenticateApiKeyWithReason"
  | "getApiKeyAuthErrorDetail"
  | "persistShortCircuitErrorLog"
  | "isApiKeyQuotaExceeded"
  | "persistQuotaExceededLog"
  | "isApiKeyBoundToUser"
  | "ensureUserBillingAllowanceOrNull"
>;

export type ActiveSourceAccountDependencies = Pick<
  ServerServices,
  "getActiveSourceAccount"
> & {
  resolveOpenAIUpstreamAccountId: typeof resolveOpenAIUpstreamAccountId;
};

export type OpenAIAccountingDependencies = Pick<
  ServerServices,
  | "extractResponseUsage"
  | "estimateUsageCost"
  | "applyApiKeyCacheUpdate"
  | "applyUserBillingAllowanceChargeCache"
> & {
  applyServiceTierBillingMultiplier: typeof applyServiceTierBillingMultiplier;
  hasSuccessfulFinalChargeLog: typeof hasSuccessfulFinalChargeLog;
  incrementApiKeyUsed: typeof incrementApiKeyUsed;
  adjustPortalUserBalance: typeof adjustPortalUserBalance;
};

export type OpenAIResponseLogDependencies = {
  createModelResponseLog: typeof createModelResponseLog;
};

export type OpenAIResponsesRouteDependencies =
  OpenAIRequestPreparationDependencies &
    ActiveSourceAccountDependencies &
    OpenAIAccountingDependencies &
    OpenAIResponseLogDependencies &
    Pick<
      ServerServices,
      | "createRequestAbortContext"
      | "getOpenAIApiRuntimeConfig"
      | "postCodexResponsesWithTokenRefresh"
      | "postCodexResponsesCompactWithTokenRefresh"
      | "extractErrorInfo"
      | "isAbortError"
      | "buildInternalUpstreamErrorDetails"
      | "buildPassthroughUpstreamError"
      | "shouldPersistModelResponseLog"
    > & {
      resolvePriorityServiceTierForBilling: typeof resolvePriorityServiceTierForBilling;
    };

type PriorityServiceTier = ReturnType<
  typeof resolvePriorityServiceTierForBilling
>;
type ResponseUsage = ReturnType<ServerServices["extractResponseUsage"]>;

export async function prepareOpenAIRouteRequest(args: {
  req: Request;
  res: Response;
  deps: OpenAIRequestPreparationDependencies;
  intentId: string;
  attemptNo: number;
  retryReason: string | null;
  model: string | null;
  startedAtMs: number;
}) {
  const {
    req,
    res,
    deps,
    intentId,
    attemptNo,
    retryReason,
    model,
    startedAtMs,
  } = args;

  const { apiKey, reason: apiKeyAuthFailureReason } =
    await deps.authenticateApiKeyWithReason(req);
  if (!apiKey) {
    const authError = deps.getApiKeyAuthErrorDetail(apiKeyAuthFailureReason);
    await deps.persistShortCircuitErrorLog({
      requestPath: req.path,
      intentId,
      attemptNo,
      retryReason,
      model,
      keyId: null,
      startedAtMs,
      statusCode: 401,
      errorCode: authError.code,
      errorMessage: authError.message,
    });
    res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return { ok: false as const, alreadyPersistedQuotaLog: true };
  }

  if (deps.isApiKeyQuotaExceeded(apiKey)) {
    await deps.persistQuotaExceededLog({
      requestPath: req.path,
      intentId,
      attemptNo,
      retryReason,
      model,
      keyId: apiKey.id,
      startedAtMs,
    });
    res.status(429).json({
      error: {
        message: "API key quota exceeded",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    return {
      ok: false as const,
      alreadyPersistedQuotaLog: true,
      apiKeyId: apiKey.id,
    };
  }

  if (!deps.isApiKeyBoundToUser(apiKey)) {
    await deps.persistShortCircuitErrorLog({
      requestPath: req.path,
      intentId,
      attemptNo,
      retryReason,
      model,
      keyId: apiKey.id,
      startedAtMs,
      statusCode: 403,
      errorCode: "api_key_owner_missing",
      errorMessage: "API key must be bound to a user for billing enforcement",
    });
    res.status(403).json({
      error: {
        message: "API key must be bound to a user for billing enforcement",
        type: "invalid_request_error",
        code: "api_key_owner_missing",
      },
    });
    return {
      ok: false as const,
      alreadyPersistedQuotaLog: true,
      apiKeyId: apiKey.id,
    };
  }

  const ownerUserId = apiKey.ownerUserId;
  if (ownerUserId) {
    const allowanceResult = await ensureBillingAllowanceOrRespond({
      req,
      res,
      deps,
      ownerUserId,
      apiKeyId: apiKey.id,
      intentId,
      attemptNo,
      retryReason,
      model,
      startedAtMs,
    });
    if (!allowanceResult.ok) {
      return {
        ok: false as const,
        alreadyPersistedQuotaLog: true,
        apiKeyId: apiKey.id,
        ownerUserId,
      };
    }

    return {
      ok: true as const,
      apiKeyId: apiKey.id,
      ownerUserId,
    };
  }

  return {
    ok: true as const,
    apiKeyId: apiKey.id,
    ownerUserId,
  };
}

export async function ensureBillingAllowanceOrRespond(args: {
  req: Request;
  res: Response;
  deps: Pick<
    OpenAIRequestPreparationDependencies,
    "ensureUserBillingAllowanceOrNull" | "persistShortCircuitErrorLog"
  >;
  ownerUserId: string | null;
  apiKeyId: string | null;
  intentId: string;
  attemptNo: number;
  retryReason: string | null;
  model: string | null;
  startedAtMs: number;
}) {
  const {
    req,
    res,
    deps,
    ownerUserId,
    apiKeyId,
    intentId,
    attemptNo,
    retryReason,
    model,
    startedAtMs,
  } = args;

  if (!ownerUserId) {
    return { ok: true as const };
  }

  const allowance = await deps.ensureUserBillingAllowanceOrNull(ownerUserId);
  if (!allowance || allowance.totalAvailable <= 0) {
    await deps.persistShortCircuitErrorLog({
      requestPath: req.path,
      intentId,
      attemptNo,
      retryReason,
      model,
      keyId: apiKeyId,
      startedAtMs,
      statusCode: 429,
      errorCode: "insufficient_quota",
      errorMessage: "Billing quota exceeded",
    });
    res.status(429).json({
      error: {
        message: "Billing quota exceeded",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    return { ok: false as const };
  }

  return { ok: true as const };
}

export async function getReadyActiveSourceAccount(args: {
  deps: ActiveSourceAccountDependencies;
}) {
  const { deps } = args;

  const sourceAccount = await deps.getActiveSourceAccount();
  if (
    !sourceAccount ||
    !sourceAccount.accessToken?.trim() ||
    !deps.resolveOpenAIUpstreamAccountId(sourceAccount)
  ) {
    return { ok: false as const, reason: "unavailable" as const };
  }
  return { ok: true as const, sourceAccount };
}

export async function finalizeOpenAIRouteAccounting(args: {
  deps: OpenAIAccountingDependencies;
  apiKeyId: string | null;
  ownerUserId: string | null;
  intentId: string;
  path: string;
  model: string | null;
  completedResponsePayload: Record<string, unknown> | null;
  lastErrorPayload: Record<string, unknown> | null;
  serviceTier: PriorityServiceTier;
  requestSucceeded: boolean;
}) {
  const {
    deps,
    apiKeyId,
    ownerUserId,
    intentId,
    path,
    model,
    completedResponsePayload,
    lastErrorPayload,
    serviceTier,
    requestSucceeded,
  } = args;

  const usageSource = completedResponsePayload
    ? { response: completedResponsePayload }
    : lastErrorPayload;
  const usage = deps.extractResponseUsage(usageSource);
  const cost = deps.applyServiceTierBillingMultiplier(
    deps.estimateUsageCost(model, usage.tokensInfo),
    serviceTier,
  );
  const alreadyCharged =
    apiKeyId && intentId
      ? await deps.hasSuccessfulFinalChargeLog({
          intentId,
          keyId: apiKeyId,
          path,
        })
      : false;
  const shouldCharge =
    requestSucceeded &&
    apiKeyId &&
    typeof cost === "number" &&
    Number.isFinite(cost) &&
    cost > 0 &&
    !alreadyCharged;
  if (shouldCharge && apiKeyId) {
    const updatedKey = await deps.incrementApiKeyUsed(apiKeyId, cost);
    if (updatedKey) {
      deps.applyApiKeyCacheUpdate(updatedKey);
    }
    if (ownerUserId) {
      const chargedFromBalance = cost;
      if (chargedFromBalance > 0) {
        await deps.adjustPortalUserBalance(ownerUserId, -chargedFromBalance);
      }
      deps.applyUserBillingAllowanceChargeCache(ownerUserId, {
        chargedFromBalance,
      });
    }
  }

  return {
    usage,
    cost,
    alreadyCharged,
  };
}

export async function persistOpenAIResponseLog(args: {
  deps: OpenAIResponseLogDependencies;
  shouldPersist: boolean;
  path: string;
  intentId: string;
  attemptNo: number;
  isFinal: boolean;
  retryReason: string | null;
  heartbeatCount?: number | null;
  streamEndReason?: string | null;
  model: string | null;
  apiKeyId: string | null;
  serviceTier: PriorityServiceTier;
  statusCode: number | null;
  startedAtMs: number;
  firstEventAtMs: number | null;
  finishedAtMs: number | null;
  usage: ResponseUsage;
  cost: number | null;
  fallbackErrorCode: string | null;
  fallbackErrorMessage: string | null;
  internalErrorDetails?: Record<string, unknown> | null;
}) {
  const {
    deps,
    shouldPersist,
    path,
    intentId,
    attemptNo,
    isFinal,
    retryReason,
    heartbeatCount = null,
    streamEndReason = null,
    model,
    apiKeyId,
    serviceTier,
    statusCode,
    startedAtMs,
    firstEventAtMs,
    finishedAtMs,
    usage,
    cost,
    fallbackErrorCode,
    fallbackErrorMessage,
    internalErrorDetails = null,
  } = args;

  if (!shouldPersist) return;
  await deps.createModelResponseLog({
    intentId,
    attemptNo,
    isFinal,
    retryReason,
    heartbeatCount,
    streamEndReason,
    path,
    modelId: model,
    keyId: apiKeyId,
    serviceTier,
    statusCode,
    ttfbMs: firstEventAtMs ? Math.max(0, firstEventAtMs - startedAtMs) : null,
    latencyMs: finishedAtMs ? Math.max(0, finishedAtMs - startedAtMs) : null,
    tokensInfo: usage.tokensInfo,
    totalTokens: usage.totalTokens,
    cost,
    errorCode: isFinal ? null : (usage.errorCode ?? fallbackErrorCode),
    errorMessage: isFinal ? null : (usage.errorMessage ?? fallbackErrorMessage),
    internalErrorDetails,
    requestTime: new Date(startedAtMs).toISOString(),
  });
}
