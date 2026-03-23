type OpenAIApiRuntimeConfig = {
  userAgent: string;
  clientVersion: string;
};

type V1ModelObject = {
  id: string;
  created: number;
  object: "model";
  owned_by: string;
};

export function createOpenAIRuntimeServices(deps: {
  isOpenAIModelEnabled: (model: Record<string, unknown>) => boolean;
  normalizeAccountCacheSize: (value: unknown) => number;
  normalizeAccountCacheRefreshSeconds: (value: unknown) => number;
  normalizeMaxAttemptCount: (value: unknown) => number;
  normalizeUserRpmLimit: (value: unknown) => number;
  normalizeUserMaxInFlight: (value: unknown) => number;
  ensureDatabaseSchema: () => Promise<unknown>;
  getSystemSettings: () => Promise<{
    openaiModels?: unknown[] | null;
    openaiModelsUpdatedAt?: string | null;
    openaiApiUserAgent?: string | null;
    openaiClientVersion?: string | null;
    accountCacheSize?: number | null;
    accountCacheRefreshSeconds?: number | null;
    maxAttemptCount?: number | null;
    userRpmLimit?: number | null;
    userMaxInFlight?: number | null;
  } | null>;
  defaultOpenAIApiUserAgent: string;
  defaultOpenAIApiClientVersion: string;
  openaiApiRuntimeConfigTtlMs: number;
  openAIModelsCache: {
    loaded: boolean;
    models: Array<Record<string, unknown>>;
    v1Models: V1ModelObject[];
    knownModelIds: Set<string>;
    updatedAt: string | null;
    loadingPromise: Promise<void> | null;
  };
  openAIApiRuntimeConfigCache: {
    value: OpenAIApiRuntimeConfig | null;
    expiresAtMs: number;
    loadingPromise: Promise<OpenAIApiRuntimeConfig> | null;
  };
  openAIAccountsLruCache: {
    items: Map<string, unknown>;
    maxSize: number;
    refreshSeconds: number;
    loaded: boolean;
  };
  teamAccountsLruCache: {
    items: Map<string, unknown>;
    maxSize: number;
    refreshSeconds: number;
    loaded: boolean;
  };
  upstreamRetryConfig: {
    maxAttemptCount: number;
  };
  requestRateLimitConfig: {
    userRpmLimit: number;
    userMaxInFlight: number;
  };
  userRpmCounters: Map<string, unknown>;
  userInFlightCounters: Map<string, unknown>;
  markOpenAIAccountsHashSelectionDirty: () => void;
  markTeamAccountsHashSelectionDirty: () => void;
}) {
  function setOpenAIModelsCache(
    models: Array<Record<string, unknown>>,
    updatedAt: string | null,
  ) {
    const nextModels = models.map((item) => ({ ...item }));
    const enabledModels = nextModels.filter((item) =>
      deps.isOpenAIModelEnabled(item),
    );
    const fallbackCreated = Math.floor(Date.now() / 1000);
    const created = updatedAt
      ? Math.floor(Date.parse(updatedAt) / 1000) || fallbackCreated
      : fallbackCreated;

    const nextV1Models = enabledModels
      .map((item) => {
        const idRaw = (typeof item.slug === "string" && item.slug.trim()) || "";
        if (!idRaw) return null;
        return {
          id: idRaw,
          created,
          object: "model" as const,
          owned_by: "openai",
        };
      })
      .filter((item): item is V1ModelObject => Boolean(item));

    deps.openAIModelsCache.models = nextModels;
    deps.openAIModelsCache.v1Models = nextV1Models;
    deps.openAIModelsCache.knownModelIds = new Set(
      nextV1Models.map((item) => item.id),
    );
    deps.openAIModelsCache.updatedAt = updatedAt;
    deps.openAIModelsCache.loaded = true;
  }

  function invalidateOpenAIApiRuntimeConfigCache() {
    deps.openAIApiRuntimeConfigCache.value = null;
    deps.openAIApiRuntimeConfigCache.expiresAtMs = 0;
  }

  function applyOpenAIAccountCacheOptionsFromSettings(
    settings: {
      accountCacheSize?: number | null;
      accountCacheRefreshSeconds?: number | null;
      maxAttemptCount?: number | null;
      userRpmLimit?: number | null;
      userMaxInFlight?: number | null;
    } | null,
  ) {
    const nextSize = deps.normalizeAccountCacheSize(settings?.accountCacheSize);
    const nextRefreshSeconds = deps.normalizeAccountCacheRefreshSeconds(
      settings?.accountCacheRefreshSeconds,
    );
    const sizeChanged = deps.openAIAccountsLruCache.maxSize !== nextSize;
    const teamSizeChanged = deps.teamAccountsLruCache.maxSize !== nextSize;
    deps.openAIAccountsLruCache.maxSize = nextSize;
    deps.openAIAccountsLruCache.refreshSeconds = nextRefreshSeconds;
    deps.teamAccountsLruCache.maxSize = nextSize;
    deps.teamAccountsLruCache.refreshSeconds = nextRefreshSeconds;
    deps.upstreamRetryConfig.maxAttemptCount = deps.normalizeMaxAttemptCount(
      settings?.maxAttemptCount,
    );
    const nextUserRpmLimit = deps.normalizeUserRpmLimit(settings?.userRpmLimit);
    const prevUserRpmLimit = deps.requestRateLimitConfig.userRpmLimit;
    deps.requestRateLimitConfig.userRpmLimit = nextUserRpmLimit;
    if (prevUserRpmLimit > 0 && nextUserRpmLimit <= 0) {
      deps.userRpmCounters.clear();
    }
    const nextUserMaxInFlight = deps.normalizeUserMaxInFlight(
      settings?.userMaxInFlight,
    );
    const prevUserMaxInFlight = deps.requestRateLimitConfig.userMaxInFlight;
    deps.requestRateLimitConfig.userMaxInFlight = nextUserMaxInFlight;
    if (prevUserMaxInFlight > 0 && nextUserMaxInFlight <= 0) {
      deps.userInFlightCounters.clear();
    }

    if (sizeChanged) {
      while (deps.openAIAccountsLruCache.items.size > nextSize) {
        const oldest = deps.openAIAccountsLruCache.items.keys().next().value;
        if (!oldest) break;
        deps.openAIAccountsLruCache.items.delete(oldest);
        deps.markOpenAIAccountsHashSelectionDirty();
      }
      if (deps.openAIAccountsLruCache.items.size < nextSize) {
        deps.openAIAccountsLruCache.loaded = false;
      }
    }
    if (teamSizeChanged) {
      while (deps.teamAccountsLruCache.items.size > nextSize) {
        const oldest = deps.teamAccountsLruCache.items.keys().next().value;
        if (!oldest) break;
        deps.teamAccountsLruCache.items.delete(oldest);
        deps.markTeamAccountsHashSelectionDirty();
      }
      if (deps.teamAccountsLruCache.items.size < nextSize) {
        deps.teamAccountsLruCache.loaded = false;
      }
    }
  }

  async function refreshRuntimeSystemSettings() {
    await deps.ensureDatabaseSchema();
    const settings = await deps.getSystemSettings();
    applyOpenAIAccountCacheOptionsFromSettings(settings);
    return settings;
  }

  async function ensureOpenAIModelsCacheLoaded(force = false) {
    if (deps.openAIModelsCache.loaded && !force) return;

    if (deps.openAIModelsCache.loadingPromise && !force) {
      await deps.openAIModelsCache.loadingPromise;
      return;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      const row = await deps.getSystemSettings();
      applyOpenAIAccountCacheOptionsFromSettings(row);
      setOpenAIModelsCache(
        ((row?.openaiModels ?? []) as Array<Record<string, unknown>>).map(
          (item) => ({
            ...item,
          }),
        ),
        row?.openaiModelsUpdatedAt ?? null,
      );
    })();

    deps.openAIModelsCache.loadingPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      deps.openAIModelsCache.loadingPromise = null;
    }
  }

  async function getOpenAIApiRuntimeConfig(): Promise<OpenAIApiRuntimeConfig> {
    const now = Date.now();
    if (
      deps.openAIApiRuntimeConfigCache.value &&
      deps.openAIApiRuntimeConfigCache.expiresAtMs > now
    ) {
      return deps.openAIApiRuntimeConfigCache.value;
    }
    if (deps.openAIApiRuntimeConfigCache.loadingPromise) {
      return deps.openAIApiRuntimeConfigCache.loadingPromise;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      const settings = await deps.getSystemSettings();
      const userAgent =
        settings?.openaiApiUserAgent?.trim() ||
        process.env.OPENAI_API_USER_AGENT?.trim() ||
        deps.defaultOpenAIApiUserAgent;
      const clientVersion =
        settings?.openaiClientVersion?.trim() ||
        process.env.CODEX_CLIENT_VERSION?.trim() ||
        deps.defaultOpenAIApiClientVersion;
      const resolved = {
        userAgent,
        clientVersion,
      };
      deps.openAIApiRuntimeConfigCache.value = resolved;
      deps.openAIApiRuntimeConfigCache.expiresAtMs =
        Date.now() + deps.openaiApiRuntimeConfigTtlMs;
      return resolved;
    })();

    deps.openAIApiRuntimeConfigCache.loadingPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      deps.openAIApiRuntimeConfigCache.loadingPromise = null;
    }
  }

  return {
    setOpenAIModelsCache,
    invalidateOpenAIApiRuntimeConfigCache,
    applyOpenAIAccountCacheOptionsFromSettings,
    refreshRuntimeSystemSettings,
    ensureOpenAIModelsCacheLoaded,
    getOpenAIApiRuntimeConfig,
  };
}
