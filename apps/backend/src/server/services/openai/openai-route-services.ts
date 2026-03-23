import type { Request, Response } from "express";

export async function prepareOpenAIRouteRequest(args: {
  req: Request;
  res: Response;
  deps: any;
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
  let releaseUserInFlightSlot = () => {};
  let refundUserRpmAllowance = () => {};

  if (ownerUserId) {
    const userRateLimit =
      await deps.ensureEffectiveUserRateLimitOrNull(ownerUserId);
    const inFlightResult = deps.acquireUserInFlightSlot(
      ownerUserId,
      userRateLimit?.userMaxInFlight,
    );
    if (!inFlightResult.allowed) {
      await deps.persistShortCircuitErrorLog({
        requestPath: req.path,
        intentId,
        attemptNo,
        retryReason,
        model,
        keyId: apiKey.id,
        startedAtMs,
        statusCode: 429,
        errorCode: "user_concurrency_limit_exceeded",
        errorMessage: "User concurrent request limit exceeded",
      });
      if (inFlightResult.retryAfterSec) {
        res.setHeader("retry-after", String(inFlightResult.retryAfterSec));
      }
      res.status(429).json({
        error: {
          message: "User concurrent request limit exceeded",
          type: "rate_limit_error",
          code: "user_concurrency_limit_exceeded",
        },
      });
      return {
        ok: false as const,
        alreadyPersistedQuotaLog: true,
        apiKeyId: apiKey.id,
        ownerUserId,
      };
    }
    releaseUserInFlightSlot = inFlightResult.release;

    const rpmResult = deps.consumeUserRpmAllowance(
      ownerUserId,
      userRateLimit?.userRpmLimit,
    );
    if (!rpmResult.allowed) {
      releaseUserInFlightSlot();
      await deps.persistShortCircuitErrorLog({
        requestPath: req.path,
        intentId,
        attemptNo,
        retryReason,
        model,
        keyId: apiKey.id,
        startedAtMs,
        statusCode: 429,
        errorCode: "user_rpm_limit_exceeded",
        errorMessage: "User RPM limit exceeded",
      });
      if (rpmResult.retryAfterSec) {
        res.setHeader("retry-after", String(rpmResult.retryAfterSec));
      }
      res.status(429).json({
        error: {
          message: "User RPM limit exceeded",
          type: "rate_limit_error",
          code: "user_rpm_limit_exceeded",
        },
      });
      return {
        ok: false as const,
        alreadyPersistedQuotaLog: true,
        apiKeyId: apiKey.id,
        ownerUserId,
      };
    }
    refundUserRpmAllowance = rpmResult.refund;

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
      releaseUserInFlightSlot();
      refundUserRpmAllowance();
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
      allowanceRemainingBeforeRequest: allowanceResult.allowanceRemaining,
      releaseUserInFlightSlot,
      refundUserRpmAllowance,
    };
  }

  return {
    ok: true as const,
    apiKeyId: apiKey.id,
    ownerUserId,
    allowanceRemainingBeforeRequest: 0,
    releaseUserInFlightSlot,
    refundUserRpmAllowance,
  };
}

export async function ensureBillingAllowanceOrRespond(args: {
  req: Request;
  res: Response;
  deps: any;
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
    return { ok: true as const, allowanceRemaining: 0 };
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

  return {
    ok: true as const,
    allowanceRemaining: allowance.allowanceRemaining,
  };
}

export async function selectReadySourceAccountForModelRequest(args: {
  deps: any;
  pool: string;
  stickyPromptCacheKey: string | null;
  attemptNo: number;
  triedSourceAccountIds: Set<string>;
}) {
  const { deps, pool, stickyPromptCacheKey, attemptNo, triedSourceAccountIds } =
    args;

  let sourceAccount = deps.selectSourceAccountForModelRequest({
    pool,
    stickyPromptCacheKey,
    attemptNo,
    excludeAccountIds: triedSourceAccountIds,
  });
  if (!sourceAccount || !sourceAccount.accessToken?.trim()) {
    await deps.ensureSourceAccountPoolLoaded(pool, true);
    sourceAccount = deps.selectSourceAccountForModelRequest({
      pool,
      stickyPromptCacheKey,
      attemptNo,
      excludeAccountIds: triedSourceAccountIds,
    });
  }
  if (!sourceAccount || !sourceAccount.accessToken?.trim()) {
    return { ok: false as const, reason: "unavailable" as const };
  }
  if (!deps.resolveOpenAIUpstreamAccountId(sourceAccount)) {
    triedSourceAccountIds.add(sourceAccount.id);
    return { ok: false as const, reason: "retry" as const };
  }
  triedSourceAccountIds.add(sourceAccount.id);
  return { ok: true as const, sourceAccount };
}

export async function finalizeOpenAIRouteAccounting(args: {
  deps: any;
  apiKeyId: string | null;
  ownerUserId: string | null;
  intentId: string;
  path: string;
  model: string | null;
  completedResponsePayload: Record<string, unknown> | null;
  lastErrorPayload: Record<string, unknown> | null;
  serviceTier: unknown;
  allowanceRemainingBeforeRequest: number;
  runtimeConfig: any;
  lastUsedSourceAccount: any;
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
    allowanceRemainingBeforeRequest,
    runtimeConfig,
    lastUsedSourceAccount,
    requestSucceeded,
  } = args;

  await deps.ensureOpenAIModelsCacheLoaded();
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
      const consumedFromAllowance = Math.max(
        0,
        Math.min(cost, allowanceRemainingBeforeRequest),
      );
      if (consumedFromAllowance > 0) {
        await deps.consumePortalUserAllowanceQuota(
          ownerUserId,
          consumedFromAllowance,
        );
      }
      const chargedFromBalance = Math.max(
        0,
        cost - consumedFromAllowance,
      );
      if (chargedFromBalance > 0) {
        await deps.adjustPortalUserBalance(ownerUserId, -chargedFromBalance);
      }
      deps.applyUserBillingAllowanceChargeCache(ownerUserId, {
        consumedFromAllowance,
        chargedFromBalance,
      });
    }
  }

  if (runtimeConfig && lastUsedSourceAccount) {
    try {
      const latestRateLimit = await deps.resolveRateLimitForAccount(
        {
          id: lastUsedSourceAccount.id,
          email: lastUsedSourceAccount.email,
          accessToken: lastUsedSourceAccount.accessToken,
          sessionToken: deps.isOpenAIUpstreamSourceAccount(lastUsedSourceAccount)
            ? lastUsedSourceAccount.sessionToken
            : null,
          refreshToken: deps.isOpenAIUpstreamSourceAccount(lastUsedSourceAccount)
            ? null
            : lastUsedSourceAccount.refreshToken,
          accountId: lastUsedSourceAccount.accountId,
          proxyId: lastUsedSourceAccount.proxyId,
          userId: lastUsedSourceAccount.userId,
        },
        runtimeConfig,
      );
      await deps.markAccountCoolingDown({
        account: lastUsedSourceAccount,
        fallbackRateLimit: latestRateLimit,
      });
      if (deps.isOpenAIUpstreamSourceAccount(lastUsedSourceAccount)) {
        await deps.updateOpenAIAccountRateLimitById(
          lastUsedSourceAccount.id,
          latestRateLimit,
        );
      } else {
        await deps.updateTeamAccountRateLimitById(
          lastUsedSourceAccount.id,
          latestRateLimit,
        );
      }
    } catch (error) {
      console.warn(
        `[usage] failed to refresh account rate limit (${lastUsedSourceAccount.email}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    usage,
    cost,
    alreadyCharged,
  };
}

export async function persistOpenAIResponseLog(args: {
  deps: any;
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
  serviceTier: unknown;
  statusCode: number | null;
  startedAtMs: number;
  firstEventAtMs: number | null;
  finishedAtMs: number | null;
  usage: {
    tokensInfo: unknown;
    totalTokens: unknown;
    errorCode: string | null;
    errorMessage: string | null;
  };
  cost: unknown;
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
