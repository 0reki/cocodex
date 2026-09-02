import type { OpenAIAccountRecord } from "../../../database/index.ts";

export function createSourceAccountServices(deps: {
  ensureDatabaseSchema: () => Promise<void>;
  getActiveOpenAIAccount: () => Promise<OpenAIAccountRecord | null>;
  cacheTtlMs: number;
}) {
  let cached: { value: OpenAIAccountRecord | null; expiresAtMs: number } | null =
    null;
  let loading: Promise<OpenAIAccountRecord | null> | null = null;
  let invalidationVersion = 0;

  async function getActiveSourceAccount(): Promise<OpenAIAccountRecord | null> {
    if (cached && cached.expiresAtMs > Date.now()) return cached.value;
    if (loading) return loading;

    const version = invalidationVersion;
    const task = (async () => {
      await deps.ensureDatabaseSchema();
      return deps.getActiveOpenAIAccount();
    })();
    loading = task;
    try {
      const account = await task;
      if (version !== invalidationVersion) {
        if (loading === task) loading = null;
        return getActiveSourceAccount();
      }
      cached = {
        value: account,
        expiresAtMs: Date.now() + deps.cacheTtlMs,
      };
      return account;
    } finally {
      if (loading === task) loading = null;
    }
  }

  function invalidateActiveSourceAccount() {
    invalidationVersion += 1;
    cached = null;
    loading = null;
  }

  return {
    getActiveSourceAccount,
    invalidateActiveSourceAccount,
  };
}
