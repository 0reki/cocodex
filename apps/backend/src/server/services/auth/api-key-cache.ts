import type { ApiKeyRecord } from "@workspace/database";

export function lruGet<K, V extends { expiresAtMs: number }>(
  cache: Map<K, V>,
  key: K,
): V | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function lruSet<K, V extends { expiresAtMs: number }>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxSize: number,
) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function createApiKeyCacheServices(deps: {
  apiKeysCache: {
    loaded: boolean;
    items: ApiKeyRecord[];
    byToken: Map<string, ApiKeyRecord[]>;
    loadingPromise: Promise<void> | null;
  };
  apiKeyAuthLruCache: Map<string, { value: ApiKeyRecord; expiresAtMs: number }>;
  ensureDatabaseSchema: () => Promise<void>;
  listApiKeys: () => Promise<ApiKeyRecord[]>;
}) {
  function setApiKeysCache(items: ApiKeyRecord[]) {
    const nextItems = items.map((item) => ({ ...item }));
    const byToken = new Map<string, ApiKeyRecord[]>();
    for (const item of nextItems) {
      const token = item.apiKey;
      if (!token) continue;
      const list = byToken.get(token);
      if (list) {
        list.push(item);
      } else {
        byToken.set(token, [item]);
      }
    }
    deps.apiKeysCache.items = nextItems;
    deps.apiKeysCache.byToken = byToken;
    deps.apiKeysCache.loaded = true;
    deps.apiKeyAuthLruCache.clear();
  }

  async function ensureApiKeysCacheLoaded(force = false) {
    if (deps.apiKeysCache.loaded && !force) return;

    if (deps.apiKeysCache.loadingPromise && !force) {
      await deps.apiKeysCache.loadingPromise;
      return;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      const items = await deps.listApiKeys();
      setApiKeysCache(items);
    })();

    deps.apiKeysCache.loadingPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      deps.apiKeysCache.loadingPromise = null;
    }
  }

  return {
    setApiKeysCache,
    ensureApiKeysCacheLoaded,
  };
}
