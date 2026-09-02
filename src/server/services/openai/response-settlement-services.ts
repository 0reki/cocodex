import type { ResponseSettlement } from "../../../database/index.ts";
import type { UsdAmount } from "../../../shared/usd.ts";

export type EnqueueResponseSettlementInput = Omit<
  ResponseSettlement,
  | "intentId"
  | "ownerUserId"
  | "apiKeyId"
  | "charge"
  | "isFinal"
  | "streamEndReason"
  | "modelId"
  | "serviceTier"
  | "statusCode"
  | "ttfbMs"
  | "latencyMs"
  | "tokensInfo"
  | "totalTokens"
  | "cost"
  | "errorCode"
  | "errorMessage"
> & {
  reservationId?: string | null;
  intentId?: string | null;
  ownerUserId?: string | null;
  apiKeyId?: string | null;
  charge?: UsdAmount | null;
  isFinal?: boolean | null;
  streamEndReason?: string | null;
  modelId?: string | null;
  serviceTier?: string | null;
  statusCode?: number | null;
  ttfbMs?: number | null;
  latencyMs?: number | null;
  tokensInfo?: Record<string, unknown> | null;
  totalTokens?: number | null;
  cost?: UsdAmount | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export function createResponseSettlementServices(deps: {
  flushResponseSettlements: (
    settlements: ResponseSettlement[],
  ) => Promise<{
    acceptedSettlementIds: string[];
    apiKeyUsedUsd: Record<string, string>;
  }>;
  applyApiKeyPendingCharge: (apiKeyId: string, amount: UsdAmount) => void;
  settleApiKeyPendingCharge: (
    apiKeyId: string,
    amount: UsdAmount,
    accepted: boolean,
    committedUsedUsd?: string,
  ) => void;
  applyUserBillingAllowanceChargeCache: (
    ownerUserId: string | null,
    amounts: { chargedFromBalance: UsdAmount },
  ) => void;
  settleUserBillingAllowanceChargeCache: (
    ownerUserId: string | null,
    amount: UsdAmount,
    accepted: boolean,
  ) => void;
  tryReserveUserBillingRequest: (
    ownerUserId: string,
    reservationId: string,
  ) => boolean;
  releaseUserBillingRequestReservation: (reservationId: string) => void;
  batchSize: number;
  flushIntervalMs: number;
  settledIdCacheSize: number;
  queueMaxSize: number;
  retryMaxMs: number;
}) {
  const pending = new Map<string, ResponseSettlement>();
  const queuedIds = new Set<string>();
  const reservedIds = new Set<string>();
  const settledIds = new Map<string, true>();
  let flushPromise: Promise<void> | null = null;
  let consecutiveFlushFailures = 0;
  let nextFlushAttemptAtMs = 0;
  let lastFlushSucceededAtMs: number | null = null;
  let lastFlushFailedAtMs: number | null = null;
  let stopped = false;

  const rememberSettled = (settlementId: string) => {
    settledIds.delete(settlementId);
    settledIds.set(settlementId, true);
    while (settledIds.size > deps.settledIdCacheSize) {
      const oldest = settledIds.keys().next().value;
      if (oldest === undefined) break;
      settledIds.delete(oldest);
    }
  };

  const triggerFlush = () => {
    if (Date.now() < nextFlushAttemptAtMs) return;
    void flushResponseSettlementsNow().catch((error) => {
      console.warn(
        `[settlements] flush failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  function getOccupiedQueueSize() {
    return queuedIds.size + reservedIds.size;
  }

  function tryReserveResponseRequest(input: {
    reservationId: string;
    ownerUserId: string | null;
  }): { ok: true } | { ok: false; reason: "billing" | "queue" } {
    const reservationId = input.reservationId.trim();
    if (!reservationId || stopped) return { ok: false, reason: "queue" };
    if (
      reservedIds.has(reservationId) ||
      queuedIds.has(reservationId) ||
      settledIds.has(reservationId)
    ) {
      return { ok: true };
    }
    if (getOccupiedQueueSize() >= deps.queueMaxSize) {
      return { ok: false, reason: "queue" };
    }
    const ownerUserId = input.ownerUserId?.trim() || null;
    if (
      ownerUserId &&
      !deps.tryReserveUserBillingRequest(ownerUserId, reservationId)
    ) {
      return { ok: false, reason: "billing" };
    }
    reservedIds.add(reservationId);
    return { ok: true };
  }

  function cancelResponseRequestReservation(reservationId: string) {
    const normalized = reservationId.trim();
    if (!normalized || !reservedIds.delete(normalized)) return;
    deps.releaseUserBillingRequestReservation(normalized);
  }

  function getResponseSettlementQueueHealth() {
    return {
      acceptingRequests:
        !stopped && getOccupiedQueueSize() < deps.queueMaxSize,
      queued: queuedIds.size,
      reserved: reservedIds.size,
      capacity: deps.queueMaxSize,
      consecutiveFlushFailures,
      lastFlushSucceededAt:
        lastFlushSucceededAtMs === null
          ? null
          : new Date(lastFlushSucceededAtMs).toISOString(),
      lastFlushFailedAt:
        lastFlushFailedAtMs === null
          ? null
          : new Date(lastFlushFailedAtMs).toISOString(),
    };
  }

  function enqueueResponseSettlement(input: EnqueueResponseSettlementInput) {
    const settlementId = input.settlementId.trim();
    const reservationId = input.reservationId?.trim() || settlementId;
    const path = input.path.trim();
    if (!settlementId || !path) {
      throw new Error("settlementId and path are required");
    }
    if (queuedIds.has(settlementId) || settledIds.has(settlementId)) {
      cancelResponseRequestReservation(reservationId);
      return;
    }
    const hadReservation = reservedIds.delete(reservationId);
    if (!hadReservation && getOccupiedQueueSize() >= deps.queueMaxSize) {
      throw new Error("Response settlement queue is full");
    }
    if (hadReservation) {
      deps.releaseUserBillingRequestReservation(reservationId);
    }
    const charge =
      typeof input.charge === "bigint" &&
      input.charge > 0n
        ? input.charge
        : 0n;
    const settlement: ResponseSettlement = {
      settlementId,
      intentId: input.intentId?.trim() || null,
      ownerUserId: input.ownerUserId?.trim() || null,
      apiKeyId: input.apiKeyId?.trim() || null,
      charge,
      isFinal: input.isFinal ?? null,
      streamEndReason: input.streamEndReason?.trim() || null,
      path,
      modelId: input.modelId?.trim() || null,
      serviceTier: input.serviceTier?.trim() || null,
      statusCode: input.statusCode ?? null,
      ttfbMs: input.ttfbMs ?? null,
      latencyMs: input.latencyMs ?? null,
      tokensInfo: input.tokensInfo ?? null,
      totalTokens: input.totalTokens ?? null,
      cost: input.cost ?? null,
      errorCode: input.errorCode?.trim() || null,
      errorMessage: input.errorMessage?.trim() || null,
      requestTime: input.requestTime,
    };
    pending.set(settlementId, settlement);
    queuedIds.add(settlementId);
    if (charge > 0n && settlement.apiKeyId) {
      deps.applyApiKeyPendingCharge(settlement.apiKeyId, charge);
    }
    if (charge > 0n && settlement.ownerUserId) {
      deps.applyUserBillingAllowanceChargeCache(settlement.ownerUserId, {
        chargedFromBalance: charge,
      });
    }
    if (pending.size >= deps.batchSize) triggerFlush();
  }

  async function flushBatch() {
    const batch: ResponseSettlement[] = [];
    for (const item of pending.values()) {
      batch.push(item);
      if (batch.length >= deps.batchSize) break;
    }
    if (batch.length === 0) return;
    for (const item of batch) pending.delete(item.settlementId);
    try {
      const result = await deps.flushResponseSettlements(batch);
      const accepted = new Set(result.acceptedSettlementIds);
      for (const item of batch) {
        const wasAccepted = accepted.has(item.settlementId);
        if (item.charge > 0n && item.apiKeyId) {
          deps.settleApiKeyPendingCharge(
            item.apiKeyId,
            item.charge,
            wasAccepted,
            result.apiKeyUsedUsd[item.apiKeyId],
          );
        }
        if (item.charge > 0n && item.ownerUserId) {
          deps.settleUserBillingAllowanceChargeCache(
            item.ownerUserId,
            item.charge,
            wasAccepted,
          );
        }
        queuedIds.delete(item.settlementId);
        rememberSettled(item.settlementId);
      }
      consecutiveFlushFailures = 0;
      nextFlushAttemptAtMs = 0;
      lastFlushSucceededAtMs = Date.now();
    } catch (error) {
      for (const item of batch) {
        if (!pending.has(item.settlementId)) {
          pending.set(item.settlementId, item);
        }
      }
      consecutiveFlushFailures += 1;
      lastFlushFailedAtMs = Date.now();
      nextFlushAttemptAtMs =
        Date.now() +
        Math.min(
          deps.retryMaxMs,
          deps.flushIntervalMs * 2 ** (consecutiveFlushFailures - 1),
        );
      throw error;
    }
  }

  async function flushResponseSettlementsNow() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      do {
        await flushBatch();
      } while (pending.size >= deps.batchSize);
    })().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  async function flushAllResponseSettlements() {
    while (pending.size > 0 || flushPromise) {
      await flushResponseSettlementsNow();
    }
  }

  const flushTimer = setInterval(triggerFlush, deps.flushIntervalMs);
  flushTimer.unref();

  async function stopResponseSettlementServices() {
    stopped = true;
    clearInterval(flushTimer);
    await flushAllResponseSettlements();
  }

  return {
    enqueueResponseSettlement,
    tryReserveResponseRequest,
    cancelResponseRequestReservation,
    getResponseSettlementQueueHealth,
    flushResponseSettlementsNow,
    flushAllResponseSettlements,
    stopResponseSettlementServices,
  };
}
