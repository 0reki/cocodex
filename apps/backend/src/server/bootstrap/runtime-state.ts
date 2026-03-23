import type {
  ApiKeyRecord,
  OpenAIAccountRecord,
  SignupProxyRecord,
  TeamAccountRecord,
} from "@workspace/database";

import type {
  AccountsLruState,
  ApiKeysCacheState,
  OpenAIApiRuntimeConfig,
  PortalUserSpendAllowanceValue,
  V1ModelObject,
} from "./types.ts";

export function createServerRuntimeState(deps: {
  normalizeUserMaxInFlight: (value: unknown) => number;
}) {
  const DEFAULT_OPENAI_API_USER_AGENT = "node/22.14.0";
  const DEFAULT_OPENAI_API_CLIENT_VERSION = "0.98.0";
  const MODELS_REFRESH_CLIENT_VERSION = "0.102.0";
  const DEFAULT_ACCOUNT_CACHE_SIZE = 50;
  const DEFAULT_ACCOUNT_CACHE_REFRESH_SECONDS = 60;
  const DEFAULT_MAX_ATTEMPT_COUNT = 1;
  const DEFAULT_USER_RPM_LIMIT = 0;
  const DEFAULT_USER_MAX_IN_FLIGHT = Number(process.env.USER_MAX_IN_FLIGHT ?? 0);
  const DEFAULT_CHECK_IN_REWARD_MIN = 0.1;
  const DEFAULT_CHECK_IN_REWARD_MAX = 1;
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
  const USER_RATE_LIMIT_LRU_MAX = Number(
    process.env.USER_RATE_LIMIT_LRU_MAX ?? 5000,
  );
  const USER_RATE_LIMIT_LRU_TTL_MS = Number(
    process.env.USER_RATE_LIMIT_LRU_TTL_MS ?? 60_000,
  );
  const SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS = Number(
    process.env.SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS ?? 60_000,
  );
  const STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS = Number(
    process.env.STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS ?? 30 * 60_000,
  );
  const STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX = Number(
    process.env.STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX ?? 20_000,
  );
  const USER_RPM_COUNTER_MAX = Number(process.env.USER_RPM_COUNTER_MAX ?? 50_000);
  const USER_IN_FLIGHT_STALE_MS = Number(
    process.env.USER_IN_FLIGHT_STALE_MS ?? 10 * 60_000,
  );
  const OPENAI_API_RUNTIME_CONFIG_TTL_MS = Number(
    process.env.OPENAI_API_RUNTIME_CONFIG_TTL_MS ?? 5_000,
  );
  const SIGNUP_PROXY_POOL_CACHE_TTL_MS = Number(
    process.env.SIGNUP_PROXY_POOL_CACHE_TTL_MS ?? 30_000,
  );
  const RATE_LIMIT_REFRESH_TIMEOUT_MS = Number(
    process.env.RATE_LIMIT_REFRESH_TIMEOUT_MS ?? 10_000,
  );
  const TEAM_AUTH_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
  const TEAM_OWNER_MAX_MEMBERS = 5;
  const OWNER_SIGNUP_PROXY_URL =
    process.env.OWNER_SIGNUP_PROXY_URL?.trim() || null;
  const PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS = 272_000;

  const openAIModelsCache: {
    loaded: boolean;
    models: Array<Record<string, unknown>>;
    v1Models: V1ModelObject[];
    knownModelIds: Set<string>;
    updatedAt: string | null;
    loadingPromise: Promise<void> | null;
  } = {
    loaded: false,
    models: [],
    v1Models: [],
    knownModelIds: new Set<string>(),
    updatedAt: null,
    loadingPromise: null,
  };

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

  const userRateLimitLruCache = new Map<
    string,
    {
      value: { userRpmLimit: number | null; userMaxInFlight: number | null };
      expiresAtMs: number;
    }
  >();
  const userRateLimitLoadingPromises = new Map<
    string,
    Promise<{ userRpmLimit: number | null; userMaxInFlight: number | null }>
  >();

  const openAIAccountsLruCache: AccountsLruState<OpenAIAccountRecord> = {
    loaded: false,
    items: new Map(),
    maxSize: DEFAULT_ACCOUNT_CACHE_SIZE,
    refreshSeconds: DEFAULT_ACCOUNT_CACHE_REFRESH_SECONDS,
    loadedAtMs: 0,
    loadingPromise: null,
  };

  const teamAccountsLruCache: AccountsLruState<TeamAccountRecord> = {
    loaded: false,
    items: new Map(),
    maxSize: DEFAULT_ACCOUNT_CACHE_SIZE,
    refreshSeconds: DEFAULT_ACCOUNT_CACHE_REFRESH_SECONDS,
    loadedAtMs: 0,
    loadingPromise: null,
  };

  const openAIAccountsHashSelectionCache = {
    dirty: true,
    items: [] as OpenAIAccountRecord[],
  };
  const teamAccountsHashSelectionCache = {
    dirty: true,
    items: [] as TeamAccountRecord[],
  };
  const temporarilyExcludedSourceAccounts = new Map<string, number>();
  const temporarilyExcludedTeamSourceAccounts = new Map<string, number>();
  const stickyPromptAccountOverrides = new Map<
    string,
    { accountId: string; expiresAt: number }
  >();
  const upstreamRetryConfig = {
    maxAttemptCount: DEFAULT_MAX_ATTEMPT_COUNT,
  };
  const requestRateLimitConfig = {
    userRpmLimit: DEFAULT_USER_RPM_LIMIT,
    userMaxInFlight: deps.normalizeUserMaxInFlight(DEFAULT_USER_MAX_IN_FLIGHT),
  };
  const userRpmCounters = new Map<
    string,
    { windowStartMs: number; count: number; lastSeenMs: number }
  >();
  const userInFlightCounters = new Map<
    string,
    { count: number; lastSeenMs: number }
  >();
  const userRpmCleanupState = { tick: 0 };
  const userInFlightCleanupState = { tick: 0 };
  const openAIApiRuntimeConfigCache: {
    value: OpenAIApiRuntimeConfig | null;
    expiresAtMs: number;
    loadingPromise: Promise<OpenAIApiRuntimeConfig> | null;
  } = {
    value: null,
    expiresAtMs: 0,
    loadingPromise: null,
  };
  const signupProxyPoolCache: {
    value: SignupProxyRecord[] | null;
    expiresAtMs: number;
    loadingPromise: Promise<SignupProxyRecord[]> | null;
  } = {
    value: null,
    expiresAtMs: 0,
    loadingPromise: null,
  };

  return {
    DEFAULT_OPENAI_API_USER_AGENT,
    DEFAULT_OPENAI_API_CLIENT_VERSION,
    MODELS_REFRESH_CLIENT_VERSION,
    DEFAULT_ACCOUNT_CACHE_SIZE,
    DEFAULT_ACCOUNT_CACHE_REFRESH_SECONDS,
    DEFAULT_MAX_ATTEMPT_COUNT,
    DEFAULT_USER_RPM_LIMIT,
    DEFAULT_USER_MAX_IN_FLIGHT,
    DEFAULT_CHECK_IN_REWARD_MIN,
    DEFAULT_CHECK_IN_REWARD_MAX,
    API_KEY_AUTH_LRU_MAX,
    API_KEY_AUTH_LRU_TTL_MS,
    BILLING_ALLOWANCE_LRU_MAX,
    BILLING_ALLOWANCE_LRU_TTL_MS,
    USER_RATE_LIMIT_LRU_MAX,
    USER_RATE_LIMIT_LRU_TTL_MS,
    SOURCE_ACCOUNT_TRANSIENT_EXCLUDE_MS,
    STICKY_PROMPT_ACCOUNT_OVERRIDE_TTL_MS,
    STICKY_PROMPT_ACCOUNT_OVERRIDE_MAX,
    USER_RPM_COUNTER_MAX,
    USER_IN_FLIGHT_STALE_MS,
    OPENAI_API_RUNTIME_CONFIG_TTL_MS,
    SIGNUP_PROXY_POOL_CACHE_TTL_MS,
    RATE_LIMIT_REFRESH_TIMEOUT_MS,
    TEAM_AUTH_USER_AGENT,
    TEAM_OWNER_MAX_MEMBERS,
    OWNER_SIGNUP_PROXY_URL,
    PRICE_AFTER_272K_INPUT_THRESHOLD_TOKENS,
    openAIModelsCache,
    apiKeysCache,
    apiKeyAuthLruCache,
    billingAllowanceLruCache,
    billingAllowanceLoadingPromises,
    userRateLimitLruCache,
    userRateLimitLoadingPromises,
    openAIAccountsLruCache,
    teamAccountsLruCache,
    openAIAccountsHashSelectionCache,
    teamAccountsHashSelectionCache,
    temporarilyExcludedSourceAccounts,
    temporarilyExcludedTeamSourceAccounts,
    stickyPromptAccountOverrides,
    upstreamRetryConfig,
    requestRateLimitConfig,
    userRpmCounters,
    userInFlightCounters,
    userRpmCleanupState,
    userInFlightCleanupState,
    openAIApiRuntimeConfigCache,
    signupProxyPoolCache,
  };
}
