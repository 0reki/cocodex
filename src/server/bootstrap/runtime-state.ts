import path from "node:path";

import type { ApiKeyRecord } from "../../database/index.ts";
import type { PortalUserSpendAllowanceValue } from "./types.ts";
import { parseUsdAmount, type UsdAmount } from "../../shared/usd.ts";

export function createServerRuntimeState() {
  const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  };
  const positiveUsdAmount = (value: string | undefined, fallback: string) => {
    const parsed = parseUsdAmount(value ?? fallback);
    const fallbackAmount = parseUsdAmount(fallback);
    if (fallbackAmount === null) throw new Error("Invalid USD fallback");
    return parsed !== null && parsed > 0n ? parsed : fallbackAmount;
  };
  const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0";
  const DEFAULT_OPENAI_API_CLIENT_VERSION = "0.152.0";
  const BILLING_OVERDRAFT_LIMIT_USD = positiveUsdAmount(
    process.env.BILLING_OVERDRAFT_LIMIT_USD,
    "10",
  );
  const BILLING_INFLIGHT_RESERVE_USD = positiveUsdAmount(
    process.env.BILLING_INFLIGHT_RESERVE_USD,
    "5",
  );
  const RESPONSE_SETTLEMENT_BATCH_SIZE = positiveInteger(
    process.env.RESPONSE_SETTLEMENT_BATCH_SIZE,
    200,
  );
  const RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS = positiveInteger(
    process.env.RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
    1_000,
  );
  const RESPONSE_SETTLEMENT_ID_CACHE_SIZE = positiveInteger(
    process.env.RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
    10_000,
  );
  const RESPONSE_SETTLEMENT_QUEUE_MAX = Math.max(
    RESPONSE_SETTLEMENT_BATCH_SIZE,
    positiveInteger(process.env.RESPONSE_SETTLEMENT_QUEUE_MAX, 20_000),
  );
  const RESPONSE_SETTLEMENT_RETRY_MAX_MS = positiveInteger(
    process.env.RESPONSE_SETTLEMENT_RETRY_MAX_MS,
    5_000,
  );
  const responseSettlementDataDirectory = process.env.COCODEX_CONFIG_PATH?.trim()
    ? path.dirname(path.resolve(process.env.COCODEX_CONFIG_PATH.trim()))
    : path.join(process.cwd(), "data");
  const RESPONSE_SETTLEMENT_WAL_PATH = path.resolve(
    process.env.RESPONSE_SETTLEMENT_WAL_PATH?.trim() ||
      path.join(responseSettlementDataDirectory, "response-settlements.wal"),
  );
  const RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS = positiveInteger(
    process.env.RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS,
    10_000,
  );
  const UPSTREAM_QUOTA_REFRESH_INTERVAL_MS = positiveInteger(
    process.env.UPSTREAM_QUOTA_REFRESH_INTERVAL_MS,
    30_000,
  );

  const apiKeyAuthLruCache = new Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >();
  const apiKeyAuthTokenById = new Map<string, string>();
  const apiKeyPendingCharges = new Map<string, UsdAmount>();
  const billingAllowanceLruCache = new Map<
    string,
    { value: PortalUserSpendAllowanceValue; expiresAtMs: number }
  >();
  const billingPendingChargesByOwnerId = new Map<string, UsdAmount>();
  const billingReservationById = new Map<
    string,
    { ownerUserId: string; amount: UsdAmount }
  >();
  const billingReservedAmountsByOwnerId = new Map<string, UsdAmount>();
  return {
    DEFAULT_OPENAI_API_USER_AGENT,
    DEFAULT_OPENAI_API_CLIENT_VERSION,
    BILLING_OVERDRAFT_LIMIT_USD,
    BILLING_INFLIGHT_RESERVE_USD,
    RESPONSE_SETTLEMENT_BATCH_SIZE,
    RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
    RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
    RESPONSE_SETTLEMENT_QUEUE_MAX,
    RESPONSE_SETTLEMENT_RETRY_MAX_MS,
    RESPONSE_SETTLEMENT_WAL_PATH,
    RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS,
    UPSTREAM_QUOTA_REFRESH_INTERVAL_MS,
    apiKeyAuthLruCache,
    apiKeyAuthTokenById,
    apiKeyPendingCharges,
    billingAllowanceLruCache,
    billingPendingChargesByOwnerId,
    billingReservationById,
    billingReservedAmountsByOwnerId,
  };
}
