import type { ApiKeyRecord } from "../../database/index.ts";
import type {
  ApiKeysCacheState,
  PortalUserSpendAllowanceValue,
} from "./types.ts";

export function createServerRuntimeState() {
  const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0";
  const DEFAULT_OPENAI_API_CLIENT_VERSION = "0.98.0";
  const API_KEY_AUTH_LRU_MAX = Number(process.env.API_KEY_AUTH_LRU_MAX ?? 5000);
  const API_KEY_AUTH_LRU_TTL_MS = Number(
    process.env.API_KEY_AUTH_LRU_TTL_MS ?? 30_000,
  );
  const BILLING_ALLOWANCE_LRU_MAX = Number(
    process.env.BILLING_ALLOWANCE_LRU_MAX ?? 5000,
  );
  const BILLING_ALLOWANCE_LRU_TTL_MS = Number(
    process.env.BILLING_ALLOWANCE_LRU_TTL_MS ?? 300_000,
  );
  const PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS = 272_000;

  const apiKeysCache: ApiKeysCacheState = {
    loaded: false,
    items: [],
    byToken: new Map<string, ApiKeyRecord[]>(),
    loadingPromise: null,
  };
  const apiKeyAuthLruCache = new Map<
    string,
    { value: ApiKeyRecord; expiresAtMs: number }
  >();
  const billingAllowanceLruCache = new Map<
    string,
    { value: PortalUserSpendAllowanceValue; expiresAtMs: number }
  >();
  const billingAllowanceLoadingPromises = new Map<
    string,
    Promise<PortalUserSpendAllowanceValue>
  >();
  return {
    DEFAULT_OPENAI_API_USER_AGENT,
    DEFAULT_OPENAI_API_CLIENT_VERSION,
    API_KEY_AUTH_LRU_MAX,
    API_KEY_AUTH_LRU_TTL_MS,
    BILLING_ALLOWANCE_LRU_MAX,
    BILLING_ALLOWANCE_LRU_TTL_MS,
    PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    apiKeysCache,
    apiKeyAuthLruCache,
    billingAllowanceLruCache,
    billingAllowanceLoadingPromises,
  };
}
