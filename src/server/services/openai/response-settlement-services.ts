import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

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

type SerializedResponseSettlement = Omit<
  ResponseSettlement,
  "charge" | "cost"
> & {
  charge: string;
  cost: string | null;
};

type WalPayload =
  | {
      version: 1;
      operation: "put";
      settlement: SerializedResponseSettlement;
    }
  | {
      version: 1;
      operation: "ack";
      settlementIds: string[];
    };

type WalEnvelope = {
  checksum: string;
  payload: WalPayload;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new Error(`Invalid WAL settlement field: ${field}`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Invalid WAL settlement field: ${field}`);
}

function serializeSettlement(
  settlement: ResponseSettlement,
): SerializedResponseSettlement {
  return {
    ...settlement,
    charge: settlement.charge.toString(),
    cost: settlement.cost === null ? null : settlement.cost.toString(),
  };
}

function deserializeSettlement(value: unknown): ResponseSettlement {
  if (!isRecord(value)) throw new Error("Invalid WAL settlement payload");
  const settlementId =
    typeof value.settlementId === "string" ? value.settlementId.trim() : "";
  const requestPath = typeof value.path === "string" ? value.path.trim() : "";
  const requestTime =
    typeof value.requestTime === "string" ? value.requestTime : "";
  if (!settlementId || !requestPath || !requestTime) {
    throw new Error("Invalid WAL settlement identity");
  }
  if (typeof value.charge !== "string") {
    throw new Error("Invalid WAL settlement charge");
  }
  const charge = BigInt(value.charge);
  let cost: bigint | null;
  if (value.cost === null) {
    cost = null;
  } else if (typeof value.cost === "string") {
    cost = BigInt(value.cost);
  } else {
    throw new Error("Invalid WAL settlement cost");
  }
  if (charge < 0n || (cost !== null && cost < 0n)) {
    throw new Error("Invalid negative WAL settlement amount");
  }
  if (value.isFinal !== null && typeof value.isFinal !== "boolean") {
    throw new Error("Invalid WAL settlement field: isFinal");
  }
  if (value.tokensInfo !== null && !isRecord(value.tokensInfo)) {
    throw new Error("Invalid WAL settlement field: tokensInfo");
  }
  return {
    settlementId,
    intentId: nullableString(value.intentId, "intentId"),
    ownerUserId: nullableString(value.ownerUserId, "ownerUserId"),
    apiKeyId: nullableString(value.apiKeyId, "apiKeyId"),
    charge,
    isFinal: value.isFinal,
    streamEndReason: nullableString(value.streamEndReason, "streamEndReason"),
    path: requestPath,
    modelId: nullableString(value.modelId, "modelId"),
    serviceTier: nullableString(value.serviceTier, "serviceTier"),
    statusCode: nullableNumber(value.statusCode, "statusCode"),
    ttfbMs: nullableNumber(value.ttfbMs, "ttfbMs"),
    latencyMs: nullableNumber(value.latencyMs, "latencyMs"),
    tokensInfo: value.tokensInfo,
    totalTokens: nullableNumber(value.totalTokens, "totalTokens"),
    cost,
    errorCode: nullableString(value.errorCode, "errorCode"),
    errorMessage: nullableString(value.errorMessage, "errorMessage"),
    requestTime,
  };
}

function encodeWalPayload(payload: WalPayload) {
  const serializedPayload = JSON.stringify(payload);
  const checksum = createHash("sha256")
    .update(serializedPayload)
    .digest("hex");
  return `${JSON.stringify({ checksum, payload } satisfies WalEnvelope)}\n`;
}

function decodeWalPayload(line: string): WalPayload {
  const decoded = JSON.parse(line) as unknown;
  if (!isRecord(decoded) || !isRecord(decoded.payload)) {
    throw new Error("Invalid WAL record");
  }
  const serializedPayload = JSON.stringify(decoded.payload);
  const checksum = createHash("sha256")
    .update(serializedPayload)
    .digest("hex");
  if (decoded.checksum !== checksum) {
    throw new Error("Response settlement WAL checksum mismatch");
  }
  const payload = decoded.payload;
  if (payload.version !== 1) {
    throw new Error("Unsupported response settlement WAL version");
  }
  if (payload.operation === "put") {
    return {
      version: 1,
      operation: "put",
      settlement: serializeSettlement(
        deserializeSettlement(payload.settlement),
      ),
    };
  }
  if (
    payload.operation === "ack" &&
    Array.isArray(payload.settlementIds) &&
    payload.settlementIds.every((item) => typeof item === "string")
  ) {
    return {
      version: 1,
      operation: "ack",
      settlementIds: payload.settlementIds,
    };
  }
  throw new Error("Invalid response settlement WAL operation");
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

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
  walPath: string;
  walCompactAfterRecords: number;
}) {
  const pending = new Map<string, ResponseSettlement>();
  const queuedIds = new Set<string>();
  const reservedIds = new Set<string>();
  const walPendingIds = new Set<string>();
  const settledIds = new Map<string, true>();
  const liveWalSettlements = new Map<string, ResponseSettlement>();
  const walPutTasks = new Map<string, Promise<void>>();
  const cacheSettledIds = new Set<string>();
  let flushPromise: Promise<void> | null = null;
  let initializationPromise: Promise<void> | null = null;
  let walOperationTail: Promise<void> = Promise.resolve();
  let walHandle: FileHandle | null = null;
  let walRecordCount = 0;
  let consecutiveFlushFailures = 0;
  let nextFlushAttemptAtMs = 0;
  let lastFlushSucceededAtMs: number | null = null;
  let lastFlushFailedAtMs: number | null = null;
  let walFailure: Error | null = null;
  let initialized = false;
  let stopped = false;

  const walPath = path.resolve(deps.walPath);
  const walDirectory = path.dirname(walPath);
  const walBasename = path.basename(walPath);

  const rememberSettled = (settlementId: string) => {
    settledIds.delete(settlementId);
    settledIds.set(settlementId, true);
    while (settledIds.size > deps.settledIdCacheSize) {
      const oldest = settledIds.keys().next().value;
      if (oldest === undefined) break;
      settledIds.delete(oldest);
    }
  };

  function queueWalOperation<T>(operation: () => Promise<T>) {
    const result = walOperationTail.then(operation, operation);
    walOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function syncWalDirectory() {
    let directoryHandle: FileHandle | null = null;
    try {
      directoryHandle = await open(walDirectory, "r");
      await directoryHandle.sync();
    } catch (error) {
      const code = isRecord(error) ? error.code : null;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  }

  async function appendWalPayloadLocked(payload: WalPayload) {
    if (!walHandle) throw new Error("Response settlement WAL is not open");
    await walHandle.appendFile(encodeWalPayload(payload), "utf8");
    await walHandle.sync();
    walRecordCount += 1;
  }

  async function compactWalLocked(force = false) {
    if (!force && walRecordCount < deps.walCompactAfterRecords) return;
    const temporaryPath = `${walPath}.compact.${process.pid}.${randomBytes(6).toString("hex")}`;
    let temporaryHandle: FileHandle | null = null;
    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      for (const settlement of liveWalSettlements.values()) {
        await temporaryHandle.appendFile(
          encodeWalPayload({
            version: 1,
            operation: "put",
            settlement: serializeSettlement(settlement),
          }),
          "utf8",
        );
      }
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = null;

      const previousHandle = walHandle;
      walHandle = null;
      await previousHandle?.close();
      try {
        await rename(temporaryPath, walPath);
        await syncWalDirectory();
        walRecordCount = liveWalSettlements.size;
      } finally {
        walHandle = await open(walPath, "a+", 0o600);
        await chmod(walPath, 0o600);
      }
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  function scheduleWalCompaction() {
    if (walRecordCount < deps.walCompactAfterRecords) return;
    void queueWalOperation(() => compactWalLocked()).catch((error) => {
      console.warn(
        `[settlements] WAL compaction failed: ${asError(error).message}`,
      );
    });
  }

  function applyPendingCharge(settlement: ResponseSettlement) {
    if (settlement.charge > 0n && settlement.apiKeyId) {
      deps.applyApiKeyPendingCharge(settlement.apiKeyId, settlement.charge);
    }
    if (settlement.charge > 0n && settlement.ownerUserId) {
      deps.applyUserBillingAllowanceChargeCache(settlement.ownerUserId, {
        chargedFromBalance: settlement.charge,
      });
    }
  }

  async function initializeResponseSettlementServices() {
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      await mkdir(walDirectory, { recursive: true, mode: 0o700 });
      const entries = await readdir(walDirectory).catch(() => [] as string[]);
      await Promise.all(
        entries
          .filter((name) => name.startsWith(`${walBasename}.compact.`))
          .map((name) =>
            rm(path.join(walDirectory, name), { force: true }).catch(
              () => undefined,
            ),
          ),
      );

      let existed = true;
      let contents: Buffer;
      try {
        contents = await readFile(walPath);
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
        existed = false;
        contents = Buffer.alloc(0);
      }
      const finalNewline = contents.lastIndexOf(0x0a);
      const validLength = finalNewline < 0 ? 0 : finalNewline + 1;
      if (validLength < contents.byteLength && existed) {
        await truncate(walPath, validLength);
      }
      const completeContents = contents.subarray(0, validLength).toString("utf8");
      const lines = completeContents.split("\n").filter(Boolean);
      for (const [index, line] of lines.entries()) {
        let payload: WalPayload;
        try {
          payload = decodeWalPayload(line);
        } catch (error) {
          throw new Error(
            `Invalid response settlement WAL record ${index + 1}: ${asError(error).message}`,
          );
        }
        if (payload.operation === "put") {
          const settlement = deserializeSettlement(payload.settlement);
          liveWalSettlements.set(settlement.settlementId, settlement);
        } else {
          for (const settlementId of payload.settlementIds) {
            liveWalSettlements.delete(settlementId);
          }
        }
      }
      walRecordCount = lines.length;
      if (liveWalSettlements.size > deps.queueMaxSize) {
        throw new Error(
          `Response settlement WAL contains ${liveWalSettlements.size} records, exceeding queue capacity ${deps.queueMaxSize}`,
        );
      }

      walHandle = await open(walPath, "a+", 0o600);
      await chmod(walPath, 0o600);
      if (!existed) await syncWalDirectory();
      if (walRecordCount >= deps.walCompactAfterRecords) {
        await compactWalLocked(true);
      }
      for (const settlement of liveWalSettlements.values()) {
        pending.set(settlement.settlementId, settlement);
        queuedIds.add(settlement.settlementId);
        applyPendingCharge(settlement);
      }
      initialized = true;
    })().catch(async (error) => {
      walFailure = asError(error);
      await walHandle?.close().catch(() => undefined);
      walHandle = null;
      throw error;
    });
    return initializationPromise;
  }

  const triggerFlush = () => {
    if (!initialized || Date.now() < nextFlushAttemptAtMs) return;
    void flushResponseSettlementsNow().catch((error) => {
      console.warn(`[settlements] flush failed: ${asError(error).message}`);
    });
  };

  function getOccupiedQueueSize() {
    return queuedIds.size + reservedIds.size + walPendingIds.size;
  }

  function tryReserveResponseRequest(input: {
    reservationId: string;
    ownerUserId: string | null;
  }): { ok: true } | { ok: false; reason: "billing" | "queue" } {
    const reservationId = input.reservationId.trim();
    if (!reservationId || stopped || !initialized || walFailure) {
      return { ok: false, reason: "queue" };
    }
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
        initialized &&
        !stopped &&
        walFailure === null &&
        getOccupiedQueueSize() < deps.queueMaxSize,
      queued: queuedIds.size,
      walPending: walPendingIds.size,
      reserved: reservedIds.size,
      capacity: deps.queueMaxSize,
      walHealthy: initialized && walFailure === null,
      walError: walFailure?.message ?? null,
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
    const requestPath = input.path.trim();
    if (!settlementId || !requestPath) {
      return Promise.reject(new Error("settlementId and path are required"));
    }
    if (!initialized || stopped || walFailure) {
      return Promise.reject(
        walFailure ?? new Error("Response settlement WAL is unavailable"),
      );
    }
    if (queuedIds.has(settlementId) || settledIds.has(settlementId)) {
      cancelResponseRequestReservation(reservationId);
      return Promise.resolve();
    }
    const currentTask = walPutTasks.get(settlementId);
    if (currentTask) return currentTask;

    const hadReservation = reservedIds.has(reservationId);
    if (!hadReservation && getOccupiedQueueSize() >= deps.queueMaxSize) {
      return Promise.reject(new Error("Response settlement queue is full"));
    }
    if (!hadReservation) walPendingIds.add(settlementId);

    const charge =
      typeof input.charge === "bigint" && input.charge > 0n
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
      path: requestPath,
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

    const task = queueWalOperation(async () => {
      await appendWalPayloadLocked({
        version: 1,
        operation: "put",
        settlement: serializeSettlement(settlement),
      });
      liveWalSettlements.set(settlementId, settlement);
    })
      .then(() => {
        walFailure = null;
        walPendingIds.delete(settlementId);
        if (reservedIds.delete(reservationId)) {
          deps.releaseUserBillingRequestReservation(reservationId);
        }
        pending.set(settlementId, settlement);
        queuedIds.add(settlementId);
        applyPendingCharge(settlement);
        scheduleWalCompaction();
        if (pending.size >= deps.batchSize) triggerFlush();
      })
      .catch((error) => {
        walFailure = asError(error);
        walPendingIds.delete(settlementId);
        if (reservedIds.delete(reservationId)) {
          deps.releaseUserBillingRequestReservation(reservationId);
        }
        throw error;
      })
      .finally(() => {
        if (walPutTasks.get(settlementId) === task) {
          walPutTasks.delete(settlementId);
        }
      });
    walPutTasks.set(settlementId, task);
    return task;
  }

  async function appendWalAcknowledgement(settlementIds: string[]) {
    try {
      await queueWalOperation(async () => {
        await appendWalPayloadLocked({
          version: 1,
          operation: "ack",
          settlementIds,
        });
        for (const settlementId of settlementIds) {
          liveWalSettlements.delete(settlementId);
        }
      });
      walFailure = null;
      scheduleWalCompaction();
    } catch (error) {
      walFailure = asError(error);
      throw error;
    }
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
        if (cacheSettledIds.has(item.settlementId)) continue;
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
        cacheSettledIds.add(item.settlementId);
      }
      await appendWalAcknowledgement(batch.map((item) => item.settlementId));
      for (const item of batch) {
        cacheSettledIds.delete(item.settlementId);
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
    while (walPutTasks.size > 0) {
      await Promise.all(walPutTasks.values());
    }
    while (pending.size > 0 || flushPromise) {
      await flushResponseSettlementsNow();
    }
    await walOperationTail;
  }

  const flushTimer = setInterval(triggerFlush, deps.flushIntervalMs);
  flushTimer.unref();

  async function stopResponseSettlementServices() {
    stopped = true;
    clearInterval(flushTimer);
    await flushAllResponseSettlements();
    await queueWalOperation(async () => {
      await compactWalLocked(true);
      await walHandle?.close();
      walHandle = null;
    });
  }

  return {
    enqueueResponseSettlement,
    tryReserveResponseRequest,
    cancelResponseRequestReservation,
    getResponseSettlementQueueHealth,
    initializeResponseSettlementServices,
    flushResponseSettlementsNow,
    flushAllResponseSettlements,
    stopResponseSettlementServices,
  };
}
