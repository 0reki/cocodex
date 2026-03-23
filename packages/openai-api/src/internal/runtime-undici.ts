import { ProxyAgent } from "undici";

type UndiciRuntimeModule = {
  fetch: typeof globalThis.fetch;
  ProxyAgent: typeof ProxyAgent;
};

export const undiciProxyDispatcherCache = new Map<string, unknown>();

function resolveNativeFetch(): typeof globalThis.fetch {
  const bunRuntime = globalThis as typeof globalThis & {
    Bun?: {
      fetch?: typeof globalThis.fetch;
    };
  };
  if (typeof bunRuntime.Bun?.fetch === "function") {
    return bunRuntime.Bun.fetch.bind(bunRuntime.Bun);
  }
  return globalThis.fetch.bind(globalThis);
}

export async function getUndiciRuntimeModule(): Promise<UndiciRuntimeModule> {
  return {
    fetch: resolveNativeFetch(),
    ProxyAgent,
  };
}
