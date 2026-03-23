import type { SignupProxyRecord } from "@workspace/database";

export function createSignupProxyPoolServices(deps: {
  ensureDatabaseSchema: () => Promise<unknown>;
  listSignupProxies: (enabledOnly?: boolean) => Promise<SignupProxyRecord[]>;
  signupProxyPoolCache: {
    value: SignupProxyRecord[] | null;
    expiresAtMs: number;
    loadingPromise: Promise<SignupProxyRecord[]> | null;
  };
  signupProxyPoolCacheTtlMs: number;
}) {
  function invalidateSignupProxyPoolCache() {
    deps.signupProxyPoolCache.value = null;
    deps.signupProxyPoolCache.expiresAtMs = 0;
    deps.signupProxyPoolCache.loadingPromise = null;
  }

  async function listEnabledSignupProxiesCached(): Promise<SignupProxyRecord[]> {
    const now = Date.now();
    if (
      deps.signupProxyPoolCache.value &&
      deps.signupProxyPoolCache.expiresAtMs > now
    ) {
      return deps.signupProxyPoolCache.value;
    }
    if (deps.signupProxyPoolCache.loadingPromise) {
      return deps.signupProxyPoolCache.loadingPromise;
    }

    const loadPromise = (async () => {
      await deps.ensureDatabaseSchema();
      const proxies = await deps.listSignupProxies(true);
      deps.signupProxyPoolCache.value = proxies;
      deps.signupProxyPoolCache.expiresAtMs =
        Date.now() + deps.signupProxyPoolCacheTtlMs;
      return proxies;
    })();

    deps.signupProxyPoolCache.loadingPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      deps.signupProxyPoolCache.loadingPromise = null;
    }
  }

  async function resolveOpenAIUpstreamProxyUrl(
    account?: { proxyId?: string | null } | null,
  ): Promise<string | null> {
    const proxies = await listEnabledSignupProxiesCached();
    if (proxies.length === 0) return null;

    const preferredProxyId =
      typeof account?.proxyId === "string" && account.proxyId.trim()
        ? account.proxyId.trim()
        : "";
    if (preferredProxyId) {
      const preferred = proxies.find((item) => item.id === preferredProxyId);
      if (preferred?.proxyUrl?.trim()) {
        return preferred.proxyUrl.trim();
      }
    }

    const selected = proxies[Math.floor(Math.random() * proxies.length)] ?? null;
    return selected?.proxyUrl?.trim() || null;
  }

  return {
    invalidateSignupProxyPoolCache,
    listEnabledSignupProxiesCached,
    resolveOpenAIUpstreamProxyUrl,
  };
}
