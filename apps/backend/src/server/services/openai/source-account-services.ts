import type {
  OpenAIAccountRecord,
  TeamAccountRecord,
} from "@workspace/database";

type UpstreamSourceAccountRecord = OpenAIAccountRecord | TeamAccountRecord;

export function createSourceAccountServices(deps: {
  isRecord: (value: unknown) => value is Record<string, unknown>;
  getNestedNumber: (
    source: Record<string, unknown> | null,
    path: string[],
  ) => number | null;
  ensureDatabaseSchema: () => Promise<void>;
  recoverExpiredOpenAIAccountCooldowns: () => Promise<unknown>;
  recoverExpiredTeamAccountCooldowns: () => Promise<unknown>;
  listOpenAIAccountsForModelCache: (
    limit: number,
  ) => Promise<OpenAIAccountRecord[]>;
  listTeamAccountsForModelCache: (
    limit: number,
  ) => Promise<TeamAccountRecord[]>;
  setOpenAIAccountCooldownById: (args: {
    id: string;
    cooldownUntil: string;
    rateLimit: Record<string, unknown> | null;
  }) => Promise<unknown>;
  setTeamAccountCooldownById: (args: {
    id: string;
    cooldownUntil: string;
    rateLimit: Record<string, unknown> | null;
  }) => Promise<unknown>;
  isOpenAIUpstreamSourceAccount: (
    account: UpstreamSourceAccountRecord,
  ) => account is OpenAIAccountRecord;
  openAIAccountsLruCache: {
    loaded: boolean;
    items: Map<string, OpenAIAccountRecord>;
    maxSize: number;
    refreshSeconds: number;
    loadedAtMs: number;
    loadingPromise: Promise<void> | null;
  };
  teamAccountsLruCache: {
    loaded: boolean;
    items: Map<string, TeamAccountRecord>;
    maxSize: number;
    refreshSeconds: number;
    loadedAtMs: number;
    loadingPromise: Promise<void> | null;
  };
  openAIAccountsHashSelectionCache: {
    dirty: boolean;
    items: OpenAIAccountRecord[];
  };
  teamAccountsHashSelectionCache: {
    dirty: boolean;
    items: TeamAccountRecord[];
  };
  temporarilyExcludedSourceAccounts: Map<string, number>;
  temporarilyExcludedTeamSourceAccounts: Map<string, number>;
  stickyPromptAccountOverrides: Map<
    string,
    { accountId: string; expiresAt: number }
  >;
  sourceAccountTransientExcludeMs: number;
  stickyPromptAccountOverrideTtlMs: number;
  stickyPromptAccountOverrideMax: number;
  markOpenAIAccountsHashSelectionDirty: () => void;
  markTeamAccountsHashSelectionDirty: () => void;
}) {
  function setOpenAIAccountsLru(records: OpenAIAccountRecord[]) {
    const map = new Map<string, OpenAIAccountRecord>();
    for (const record of records) {
      map.set(record.email, record);
      if (map.size >= deps.openAIAccountsLruCache.maxSize) break;
    }
    deps.openAIAccountsLruCache.items = map;
    deps.openAIAccountsLruCache.loaded = true;
    deps.openAIAccountsLruCache.loadedAtMs = Date.now();
    deps.markOpenAIAccountsHashSelectionDirty();
  }

  function setTeamAccountsLru(records: TeamAccountRecord[]) {
    const map = new Map<string, TeamAccountRecord>();
    for (const record of records) {
      map.set(record.email, record);
      if (map.size >= deps.teamAccountsLruCache.maxSize) break;
    }
    deps.teamAccountsLruCache.items = map;
    deps.teamAccountsLruCache.loaded = true;
    deps.teamAccountsLruCache.loadedAtMs = Date.now();
    deps.markTeamAccountsHashSelectionDirty();
  }

  async function ensureOpenAIAccountsLruLoaded(force = false) {
    const staleByTime =
      deps.openAIAccountsLruCache.loaded &&
      Date.now() - deps.openAIAccountsLruCache.loadedAtMs >
        deps.openAIAccountsLruCache.refreshSeconds * 1000;
    if (!force && deps.openAIAccountsLruCache.loaded && !staleByTime) {
      return;
    }

    if (deps.openAIAccountsLruCache.loadingPromise && !force) {
      await deps.openAIAccountsLruCache.loadingPromise;
      return;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      await deps.recoverExpiredOpenAIAccountCooldowns();
      const accounts = await deps.listOpenAIAccountsForModelCache(
        deps.openAIAccountsLruCache.maxSize,
      );
      setOpenAIAccountsLru(accounts);
    })();
    deps.openAIAccountsLruCache.loadingPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      deps.openAIAccountsLruCache.loadingPromise = null;
    }
  }

  async function ensureTeamAccountsLruLoaded(force = false) {
    const staleByTime =
      deps.teamAccountsLruCache.loaded &&
      Date.now() - deps.teamAccountsLruCache.loadedAtMs >
        deps.teamAccountsLruCache.refreshSeconds * 1000;
    if (!force && deps.teamAccountsLruCache.loaded && !staleByTime) {
      return;
    }

    if (deps.teamAccountsLruCache.loadingPromise && !force) {
      await deps.teamAccountsLruCache.loadingPromise;
      return;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      await deps.recoverExpiredTeamAccountCooldowns();
      const accounts = await deps.listTeamAccountsForModelCache(
        deps.teamAccountsLruCache.maxSize,
      );
      setTeamAccountsLru(accounts);
    })();
    deps.teamAccountsLruCache.loadingPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      deps.teamAccountsLruCache.loadingPromise = null;
    }
  }

  function parseRetryAfterSeconds(headers: Headers): number | null {
    const retryAfter = headers.get("retry-after");
    if (!retryAfter) return null;
    const asNumber = Number(retryAfter);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.ceil(asNumber);
    }
    const asDateMs = Date.parse(retryAfter);
    if (!Number.isNaN(asDateMs)) {
      const sec = Math.ceil((asDateMs - Date.now()) / 1000);
      return sec > 0 ? sec : null;
    }
    return null;
  }

  function isRateLimitReached(
    rateLimit: Record<string, unknown> | null,
  ): boolean {
    if (!rateLimit) return false;
    if (rateLimit.limit_reached === true) return true;
    const primary = deps.isRecord(rateLimit.primary_window)
      ? (rateLimit.primary_window as Record<string, unknown>)
      : null;
    const usedPercent = primary
      ? deps.getNestedNumber(primary, ["used_percent"])
      : null;
    return typeof usedPercent === "number" && Number.isFinite(usedPercent)
      ? usedPercent >= 100
      : false;
  }

  function computeCooldownUntilFromRateLimit(
    rateLimit: Record<string, unknown> | null,
  ): string | null {
    if (!rateLimit) return null;
    const primary = deps.isRecord(rateLimit.primary_window)
      ? (rateLimit.primary_window as Record<string, unknown>)
      : null;
    const secondary = deps.isRecord(rateLimit.secondary_window)
      ? (rateLimit.secondary_window as Record<string, unknown>)
      : null;
    const windows = [primary, secondary].filter(
      (item): item is Record<string, unknown> => Boolean(item),
    );

    for (const win of windows) {
      const resetAfter = deps.getNestedNumber(win, ["reset_after_seconds"]);
      if (resetAfter && Number.isFinite(resetAfter) && resetAfter > 0) {
        return new Date(Date.now() + Math.ceil(resetAfter) * 1000).toISOString();
      }
      const resetAt = deps.getNestedNumber(win, ["reset_at"]);
      if (resetAt && Number.isFinite(resetAt) && resetAt > 0) {
        return new Date(Math.ceil(resetAt) * 1000).toISOString();
      }
    }
    return null;
  }

  async function markAccountCoolingDown(params: {
    account: UpstreamSourceAccountRecord;
    headers?: Headers | null;
    fallbackRateLimit?: Record<string, unknown> | null;
  }) {
    const rateLimit =
      params.fallbackRateLimit ?? params.account.rateLimit ?? null;
    if (!isRateLimitReached(rateLimit)) return;

    const retryAfterSeconds = params.headers
      ? parseRetryAfterSeconds(params.headers)
      : null;
    const cooldownUntil =
      (retryAfterSeconds && retryAfterSeconds > 0
        ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
        : null) ??
      computeCooldownUntilFromRateLimit(rateLimit) ??
      new Date(Date.now() + 60 * 1000).toISOString();

    try {
      if (deps.isOpenAIUpstreamSourceAccount(params.account)) {
        await deps.setOpenAIAccountCooldownById({
          id: params.account.id,
          cooldownUntil,
          rateLimit,
        });
      } else {
        await deps.setTeamAccountCooldownById({
          id: params.account.id,
          cooldownUntil,
          rateLimit,
        });
      }
    } catch (error) {
      console.warn(
        `[cooldown] failed to update account ${params.account.email}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (deps.isOpenAIUpstreamSourceAccount(params.account)) {
      deps.openAIAccountsLruCache.items.delete(params.account.email);
      deps.markOpenAIAccountsHashSelectionDirty();
    } else {
      deps.teamAccountsLruCache.items.delete(params.account.email);
      deps.markTeamAccountsHashSelectionDirty();
    }
  }

  function getCurrentModelResponseAccountFromLru() {
    const entry = deps.openAIAccountsLruCache.items.entries().next();
    if (entry.done) return null;
    return entry.value[1];
  }

  function getCurrentModelResponseTeamAccountFromLru() {
    const entry = deps.teamAccountsLruCache.items.entries().next();
    if (entry.done) return null;
    return entry.value[1];
  }

  function getHashSelectionCandidatesFromLru(): OpenAIAccountRecord[] {
    const now = Date.now();
    let removedExpiredExclusion = false;
    for (const [
      accountId,
      expiresAt,
    ] of deps.temporarilyExcludedSourceAccounts.entries()) {
      if (expiresAt <= now) {
        deps.temporarilyExcludedSourceAccounts.delete(accountId);
        removedExpiredExclusion = true;
      }
    }
    if (removedExpiredExclusion) {
      deps.markOpenAIAccountsHashSelectionDirty();
    }
    if (deps.openAIAccountsHashSelectionCache.dirty) {
      deps.openAIAccountsHashSelectionCache.items = Array.from(
        deps.openAIAccountsLruCache.items.values(),
      )
        .filter(
          (item) =>
            typeof item.accessToken === "string" &&
            item.accessToken.trim().length > 0 &&
            !deps.temporarilyExcludedSourceAccounts.has(item.id),
        )
        .sort((a, b) =>
          `${a.id}:${a.email}`.localeCompare(`${b.id}:${b.email}`),
        );
      if (deps.openAIAccountsHashSelectionCache.items.length === 0) {
        deps.openAIAccountsHashSelectionCache.items = Array.from(
          deps.openAIAccountsLruCache.items.values(),
        )
          .filter(
            (item) =>
              typeof item.accessToken === "string" &&
              item.accessToken.trim().length > 0,
          )
          .sort((a, b) =>
            `${a.id}:${a.email}`.localeCompare(`${b.id}:${b.email}`),
          );
      }
      deps.openAIAccountsHashSelectionCache.dirty = false;
    }
    return deps.openAIAccountsHashSelectionCache.items;
  }

  function markSourceAccountTransientFailure(
    accountId: string | null,
    stickyPromptCacheKey?: string | null,
  ) {
    if (!accountId) return;
    deps.temporarilyExcludedSourceAccounts.set(
      accountId,
      Date.now() + deps.sourceAccountTransientExcludeMs,
    );
    if (stickyPromptCacheKey) {
      const normalizedKey = stickyPromptCacheKey.trim();
      if (normalizedKey) {
        const current = deps.stickyPromptAccountOverrides.get(normalizedKey);
        if (current?.accountId === accountId) {
          deps.stickyPromptAccountOverrides.delete(normalizedKey);
        }
      }
    }
    deps.markOpenAIAccountsHashSelectionDirty();
  }

  function markTeamSourceAccountTransientFailure(
    accountId: string | null,
    stickyPromptCacheKey?: string | null,
  ) {
    if (!accountId) return;
    deps.temporarilyExcludedTeamSourceAccounts.set(
      accountId,
      Date.now() + deps.sourceAccountTransientExcludeMs,
    );
    deps.markTeamAccountsHashSelectionDirty();
    const stickyKey = stickyPromptCacheKey?.trim() ?? "";
    if (stickyKey) {
      deps.stickyPromptAccountOverrides.delete(stickyKey);
    }
  }

  function rememberStickyPromptAccountOverride(
    stickyPromptCacheKey: string | null,
    accountId: string | null,
  ) {
    const key = stickyPromptCacheKey?.trim() ?? "";
    if (!key || !accountId) return;
    const now = Date.now();
    for (const [k, v] of deps.stickyPromptAccountOverrides.entries()) {
      if (v.expiresAt <= now) {
        deps.stickyPromptAccountOverrides.delete(k);
      }
    }
    while (
      deps.stickyPromptAccountOverrides.size >=
      deps.stickyPromptAccountOverrideMax
    ) {
      const oldestKey = deps.stickyPromptAccountOverrides.keys().next().value;
      if (!oldestKey) break;
      deps.stickyPromptAccountOverrides.delete(oldestKey);
    }
    deps.stickyPromptAccountOverrides.set(key, {
      accountId,
      expiresAt: now + deps.stickyPromptAccountOverrideTtlMs,
    });
  }

  function getStickyPromptCacheKey(
    requestBody: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): string | null {
    const fromPayloadSnake =
      typeof payload.prompt_cache_key === "string"
        ? payload.prompt_cache_key.trim()
        : "";
    if (fromPayloadSnake) return fromPayloadSnake;
    const fromPayloadCamel =
      typeof payload.promptCacheKey === "string"
        ? payload.promptCacheKey.trim()
        : "";
    if (fromPayloadCamel) return fromPayloadCamel;
    const fromBodySnake =
      typeof requestBody.prompt_cache_key === "string"
        ? requestBody.prompt_cache_key.trim()
        : "";
    if (fromBodySnake) return fromBodySnake;
    const fromBodyCamel =
      typeof requestBody.promptCacheKey === "string"
        ? requestBody.promptCacheKey.trim()
        : "";
    if (fromBodyCamel) return fromBodyCamel;
    return null;
  }

  function selectSourceAccountForModelResponse(params: {
    stickyPromptCacheKey: string | null;
    attemptNo: number;
    excludeAccountIds?: Set<string>;
  }): OpenAIAccountRecord | null {
    const excluded = params.excludeAccountIds;
    const current = getCurrentModelResponseAccountFromLru();
    if (current && !excluded?.has(current.id)) {
      return current;
    }
    for (const account of deps.openAIAccountsLruCache.items.values()) {
      if (!excluded?.has(account.id)) return account;
    }
    return current;
  }

  function selectTeamSourceAccountForModelResponse(params: {
    stickyPromptCacheKey: string | null;
    attemptNo: number;
    excludeAccountIds?: Set<string>;
  }): TeamAccountRecord | null {
    const excluded = params.excludeAccountIds;
    const current = getCurrentModelResponseTeamAccountFromLru();
    if (current && !excluded?.has(current.id)) {
      return current;
    }
    for (const account of deps.teamAccountsLruCache.items.values()) {
      if (!excluded?.has(account.id)) return account;
    }
    return current;
  }

  function selectRandomSourceAccountForResponsesWebSocket(
    excludeAccountIds?: Set<string>,
  ): OpenAIAccountRecord | null {
    const candidates = getHashSelectionCandidatesFromLru().filter((item) => {
      if (!item.accessToken?.trim()) return false;
      if (excludeAccountIds?.has(item.id)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    const selected =
      candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    return selected ?? null;
  }

  async function ensureSourceAccountPoolLoaded(
    pool: "openai" | "team",
    force = false,
  ) {
    if (pool === "team") {
      await ensureTeamAccountsLruLoaded(force);
      return;
    }
    await ensureOpenAIAccountsLruLoaded(force);
  }

  function selectSourceAccountForModelRequest(params: {
    pool: "openai" | "team";
    stickyPromptCacheKey: string | null;
    attemptNo: number;
    excludeAccountIds?: Set<string>;
  }): UpstreamSourceAccountRecord | null {
    if (params.pool === "team") {
      return selectTeamSourceAccountForModelResponse(params);
    }
    return selectSourceAccountForModelResponse(params);
  }

  function markSelectedSourceAccountTransientFailure(params: {
    account: UpstreamSourceAccountRecord;
    stickyPromptCacheKey?: string | null;
  }) {
    if (deps.isOpenAIUpstreamSourceAccount(params.account)) {
      markSourceAccountTransientFailure(
        params.account.id,
        params.stickyPromptCacheKey,
      );
      return;
    }
    markTeamSourceAccountTransientFailure(
      params.account.id,
      params.stickyPromptCacheKey,
    );
  }

  return {
    ensureOpenAIAccountsLruLoaded,
    ensureTeamAccountsLruLoaded,
    markAccountCoolingDown,
    markSourceAccountTransientFailure,
    markTeamSourceAccountTransientFailure,
    rememberStickyPromptAccountOverride,
    getStickyPromptCacheKey,
    selectSourceAccountForModelResponse,
    selectRandomSourceAccountForResponsesWebSocket,
    ensureSourceAccountPoolLoaded,
    selectSourceAccountForModelRequest,
    markSelectedSourceAccountTransientFailure,
  };
}
