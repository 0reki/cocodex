import type { Request, Response } from "express";
import type { ServerServices } from "../../bootstrap/services.ts";
import type {
  applyServiceTierBillingMultiplier,
  resolveOpenAIUpstreamAccountId,
  resolveFastServiceTierForBilling,
} from "../../utils/index.ts";
import { resolveResponseServiceTierForBilling } from "../../utils/index.ts";

export type OpenAIRequestPreparationDependencies = Pick<
  ServerServices,
  | "authenticateApiKeyWithReason"
  | "getApiKeyAuthErrorDetail"
  | "persistShortCircuitErrorLog"
  | "isApiKeyQuotaExceeded"
  | "persistQuotaExceededLog"
  | "isApiKeyBoundToUser"
  | "tryReserveResponseRequest"
>;

export type ActiveSourceAccountDependencies = Pick<
  ServerServices,
  "getAssignedSourceAccount"
> & {
  resolveOpenAIUpstreamAccountId: typeof resolveOpenAIUpstreamAccountId;
};

export type OpenAIAccountingDependencies = Pick<
  ServerServices,
  "extractResponseUsage" | "estimateUsageCost"
> & {
  applyServiceTierBillingMultiplier: typeof applyServiceTierBillingMultiplier;
};

export type OpenAIResponseLogDependencies = Pick<
  ServerServices,
  "enqueueResponseSettlement" | "cancelResponseRequestReservation"
>;

export type UpstreamQuotaDependencies = Pick<
  ServerServices,
  "ensureUserUpstreamQuota" | "settleUserUpstreamQuota"
>;

export type OpenAIResponsesRouteDependencies =
  OpenAIRequestPreparationDependencies &
    ActiveSourceAccountDependencies &
    OpenAIAccountingDependencies &
    OpenAIResponseLogDependencies &
    UpstreamQuotaDependencies &
    Pick<
      ServerServices,
      | "createRequestAbortContext"
      | "getOpenAIApiRuntimeConfig"
      | "postCodexResponsesWithTokenRefresh"
      | "extractErrorInfo"
      | "isAbortError"
      | "buildPassthroughUpstreamError"
      | "shouldPersistModelResponseLog"
      | "resolveUsagePricingModelId"
    > & {
      resolveFastServiceTierForBilling: typeof resolveFastServiceTierForBilling;
    };

type FastServiceTier = ReturnType<
  typeof resolveFastServiceTierForBilling
>;
type ResponseUsage = ReturnType<ServerServices["extractResponseUsage"]>;

export async function prepareOpenAIRouteRequest(args: {
  req: Request;
  res: Response;
  deps: OpenAIRequestPreparationDependencies;
  intentId: string;
  model: string | null;
  startedAtMs: number;
  billable?: boolean;
}) {
  const { req, res, deps, intentId, model, startedAtMs, billable = true } = args;

  const { apiKey, reason: apiKeyAuthFailureReason } =
    await deps.authenticateApiKeyWithReason(req);
  if (!apiKey) {
    const authError = deps.getApiKeyAuthErrorDetail(apiKeyAuthFailureReason);
    await deps.persistShortCircuitErrorLog({
      requestPath: req.path,
      intentId,
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

  if (billable && deps.isApiKeyQuotaExceeded(apiKey)) {
    await deps.persistQuotaExceededLog({
      requestPath: req.path,
      intentId,
      model,
      keyId: apiKey.id,
      ownerUserId: apiKey.ownerUserId,
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
      model,
      keyId: apiKey.id,
      ownerUserId: apiKey.ownerUserId,
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
  const reservation = deps.tryReserveResponseRequest({
    reservationId: intentId,
  });
  if (!reservation.ok) {
    res.status(503).json({
      error: {
        message: "Request log settlement is temporarily unavailable",
        type: "server_error",
        code: "settlement_queue_unavailable",
      },
    });
    return {
      ok: false as const,
      alreadyPersistedQuotaLog: false,
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

export async function getReadyAssignedSourceAccount(args: {
  deps: ActiveSourceAccountDependencies;
  ownerUserId: string;
}) {
  const sourceAccount = await args.deps.getAssignedSourceAccount(
    args.ownerUserId,
  );
  if (!sourceAccount) {
    return { ok: false as const, reason: "unassigned" as const };
  }
  if (
    sourceAccount.status === "disabled" ||
    !sourceAccount.accessToken?.trim() ||
    !args.deps.resolveOpenAIUpstreamAccountId(sourceAccount)
  ) {
    return { ok: false as const, reason: "unavailable" as const };
  }
  return { ok: true as const, sourceAccount };
}

export function finalizeOpenAIRouteAccounting(args: {
  deps: OpenAIAccountingDependencies;
  apiKeyId: string | null;
  model: string | null;
  pricingModelId?: string | null;
  usageResponsePayload: Record<string, unknown> | null;
  lastErrorPayload: Record<string, unknown> | null;
  serviceTier: FastServiceTier;
  billable?: boolean;
}) {
  const {
    deps,
    apiKeyId,
    model,
    pricingModelId,
    usageResponsePayload,
    lastErrorPayload,
    serviceTier,
    billable = true,
  } = args;

  const usageSource = usageResponsePayload
    ? { response: usageResponsePayload }
    : lastErrorPayload;
  const usage = deps.extractResponseUsage(usageSource);
  const billedModelId = pricingModelId ?? model;
  const resolvedServiceTier = resolveResponseServiceTierForBilling(
    usageResponsePayload?.service_tier,
    serviceTier,
  );
  const cost = billable
    ? deps.applyServiceTierBillingMultiplier(
        deps.estimateUsageCost(billedModelId, usage.tokensInfo),
        resolvedServiceTier.fastServiceTier,
        billedModelId,
      )
    : null;
  const shouldCharge =
    apiKeyId &&
    typeof cost === "bigint" &&
    cost > 0n;
  return {
    usage,
    cost,
    charge: shouldCharge ? cost : 0n,
    serviceTier: resolvedServiceTier.serviceTier,
  };
}

export async function persistOpenAIResponseLog(args: {
  deps: OpenAIResponseLogDependencies;
  shouldPersist: boolean;
  path: string;
  intentId: string;
  isFinal: boolean;
  streamEndReason?: string | null;
  model: string | null;
  apiKeyId: string | null;
  ownerUserId: string | null;
  charge: bigint;
  serviceTier: string | null;
  statusCode: number | null;
  startedAtMs: number;
  firstEventAtMs: number | null;
  finishedAtMs: number | null;
  usage: ResponseUsage;
  cost: bigint | null;
  fallbackErrorCode: string | null;
  fallbackErrorMessage: string | null;
}) {
  const {
    deps,
    shouldPersist,
    path,
    intentId,
    isFinal,
    streamEndReason = null,
    model,
    apiKeyId,
    ownerUserId,
    charge,
    serviceTier,
    statusCode,
    startedAtMs,
    firstEventAtMs,
    finishedAtMs,
    usage,
    cost,
    fallbackErrorCode,
    fallbackErrorMessage,
  } = args;

  if (!shouldPersist) {
    deps.cancelResponseRequestReservation(intentId);
    return;
  }
  await deps.enqueueResponseSettlement({
    settlementId: intentId,
    reservationId: intentId,
    intentId,
    ownerUserId,
    apiKeyId,
    charge,
    isFinal,
    streamEndReason,
    path,
    modelId: model,
    serviceTier,
    statusCode,
    ttfbMs: firstEventAtMs ? Math.max(0, firstEventAtMs - startedAtMs) : null,
    latencyMs: finishedAtMs ? Math.max(0, finishedAtMs - startedAtMs) : null,
    tokensInfo: usage.tokensInfo,
    totalTokens: usage.totalTokens,
    cost,
    errorCode: isFinal ? null : (usage.errorCode ?? fallbackErrorCode),
    errorMessage: isFinal ? null : (usage.errorMessage ?? fallbackErrorMessage),
    requestTime: new Date(startedAtMs).toISOString(),
  });
}
