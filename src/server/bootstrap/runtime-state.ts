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
  const ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS = positiveInteger(
    process.env.ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS,
    30_000,
  );
  const API_KEY_AUTH_LRU_MAX = positiveInteger(
    process.env.API_KEY_AUTH_LRU_MAX,
    5000,
  );
  const API_KEY_AUTH_LRU_TTL_MS = positiveInteger(
    process.env.API_KEY_AUTH_LRU_TTL_MS,
    30_000,
  );
  const BILLING_ALLOWANCE_LRU_MAX = positiveInteger(
    process.env.BILLING_ALLOWANCE_LRU_MAX,
    5000,
  );
  const BILLING_ALLOWANCE_LRU_TTL_MS = positiveInteger(
    process.env.BILLING_ALLOWANCE_LRU_TTL_MS,
    300_000,
  );
  const BILLING_OVERDRAFT_LIMIT_USD = positiveUsdAmount(
    process.env.BILLING_OVERDRAFT_LIMIT_USD,
    "10",
  );
  const BILLING_INFLIGHT_RESERVE_USD = positiveUsdAmount(
    process.env.BILLING_INFLIGHT_RESERVE_USD,
    "1",
  );
  const PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS = 272_000;
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

  const apiKeyAuthLruCache = new Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >();
  const apiKeyAuthTokenById = new Map<string, string>();
  const apiKeyAuthLoadingPromises = new Map<
    string,
    Promise<ApiKeyRecord | null>
  >();
  const apiKeyAuthTokenVersions = new Map<string, number>();
  const apiKeyPendingCharges = new Map<string, UsdAmount>();
  const billingAllowanceLruCache = new Map<
    string,
    { value: PortalUserSpendAllowanceValue; expiresAtMs: number }
  >();
  const billingAllowanceLoadingPromises = new Map<
    string,
    Promise<PortalUserSpendAllowanceValue>
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
    ACTIVE_SOURCE_ACCOUNT_CACHE_TTL_MS,
    API_KEY_AUTH_LRU_MAX,
    API_KEY_AUTH_LRU_TTL_MS,
    BILLING_ALLOWANCE_LRU_MAX,
    BILLING_ALLOWANCE_LRU_TTL_MS,
    BILLING_OVERDRAFT_LIMIT_USD,
    BILLING_INFLIGHT_RESERVE_USD,
    PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    RESPONSE_SETTLEMENT_BATCH_SIZE,
    RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS,
    RESPONSE_SETTLEMENT_ID_CACHE_SIZE,
    RESPONSE_SETTLEMENT_QUEUE_MAX,
    RESPONSE_SETTLEMENT_RETRY_MAX_MS,
    apiKeyAuthLruCache,
    apiKeyAuthTokenById,
    apiKeyAuthLoadingPromises,
    apiKeyAuthTokenVersions,
    apiKeyPendingCharges,
    billingAllowanceLruCache,
    billingAllowanceLoadingPromises,
    billingPendingChargesByOwnerId,
    billingReservationById,
    billingReservedAmountsByOwnerId,
  };
}
