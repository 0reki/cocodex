import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import type { HeaderLike, SignupRunOptions } from "./types.ts";

export function parseRunOptions(argv: string[]): SignupRunOptions {
  let count = 1;
  let concurrency = 1;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--count" || arg === "-n") && argv[i + 1]) {
      count = Number(argv[++i]);
      continue;
    }
    if ((arg === "--concurrency" || arg === "-c") && argv[i + 1]) {
      concurrency = Number(argv[++i]);
      continue;
    }
  }

  if (!Number.isFinite(count) || count < 1) count = 1;
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = 1;
  count = Math.floor(count);
  concurrency = Math.min(Math.floor(concurrency), count);

  return { count, concurrency };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${minutes}m ${seconds}s ${millis}ms`;
}

export const AUTH_URL = "https://auth.openai.com";
export const CHATGPT_URL = "https://chatgpt.com";
export const SENTINEL_URL = "https://sentinel.openai.com";
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
export const DEFAULT_CLIENT_VERSION = "prod-5c8b2a2c4c06545065bcbbc7b78f7b9bb6cf1134";
export const DEFAULT_BUILD_NUMBER = "4614017";
const REQUEST_TIMEOUT_MS = Number(
  process.env.SIGNUP_REQUEST_TIMEOUT_MS ?? 20_000,
);
const FETCH_RETRY_TIMES = Math.max(
  0,
  Number(process.env.SIGNUP_FETCH_RETRIES ?? 5),
);
const NativeAbortController = globalThis.AbortController;

const CHROME_LIKE_TLS_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
].join(":");

const CHROME_LIKE_TLS_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
].join(":");

const baseAgent = new Agent({
  connect: {
    ciphers: CHROME_LIKE_TLS_CIPHERS,
    sigalgs: CHROME_LIKE_TLS_SIGALGS,
    ecdhCurve: "X25519:P-256:P-384",
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    ALPNProtocols: ["h2", "http/1.1"],
  },
});

export const requestContextStorage = new AsyncLocalStorage<{
  dispatcher: Dispatcher;
  proxyUrl: string | null;
  runId?: number;
  total?: number;
}>();

export function getActiveDispatcher(): Dispatcher {
  return requestContextStorage.getStore()?.dispatcher ?? baseAgent;
}

export function getActiveProxyUrl(): string | null {
  return requestContextStorage.getStore()?.proxyUrl ?? null;
}

export function getActiveRunPrefix(): string {
  const store = requestContextStorage.getStore();
  if (!store?.runId || !store?.total) return "";
  return `[Run ${store.runId}/${store.total}] `;
}

export function withActiveRunPrefix(message: string): string {
  return `${getActiveRunPrefix()}${message}`;
}

export function createDispatcher(proxyUrl?: string | null): Dispatcher {
  if (typeof proxyUrl === "string" && proxyUrl.trim().length > 0) {
    const normalized = proxyUrl.trim();
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol === "https:" && isIP(parsed.hostname)) {
        parsed.protocol = "http:";
      }
      return new ProxyAgent(parsed.toString());
    } catch {
      return new ProxyAgent(normalized);
    }
  }
  return baseAgent;
}

export async function closeDispatcherIfNeeded(dispatcher: Dispatcher) {
  if (dispatcher === baseAgent) return;
  const maybe = dispatcher as unknown as { close?: () => Promise<void> | void };
  if (typeof maybe.close === "function") {
    await maybe.close();
  }
}

export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  const toErrorText = (error: unknown): string => {
    const parts: string[] = [];
    let cursor: unknown = error;
    let depth = 0;
    while (cursor && depth < 5) {
      if (cursor instanceof Error) {
        parts.push(cursor.message);
        cursor = (cursor as { cause?: unknown }).cause;
        depth += 1;
        continue;
      }
      if (typeof cursor === "object" && cursor !== null) {
        const maybeCause = (cursor as { cause?: unknown }).cause;
        if (typeof maybeCause !== "undefined") {
          cursor = maybeCause;
          depth += 1;
          continue;
        }
      }
      parts.push(String(cursor));
      break;
    }
    return parts.join(" | ").toLowerCase();
  };

  const isTransientNetworkError = (error: unknown) => {
    const text = toErrorText(error);
    return (
      text.includes("etimedout") ||
      text.includes("econnrefused") ||
      text.includes("econnreset") ||
      text.includes("enotfound") ||
      text.includes("eai_again") ||
      text.includes("und_err_") ||
      text.includes("socket hang up") ||
      text.includes("fetch failed") ||
      text.includes("aborted") ||
      text.includes("timeout")
    );
  };

  for (let attempt = 0; ; attempt += 1) {
    const controller = new NativeAbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const mergedInit = {
      ...init,
      signal: controller.signal,
    };

    try {
      return await fetch(input, mergedInit);
    } catch (error) {
      const canRetry =
        attempt < FETCH_RETRY_TIMES && isTransientNetworkError(error);
      if (!canRetry) {
        throw error;
      }
      const backoffMs = 350 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getSetCookies(headers: HeaderLike): string[] {
  const maybe = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof maybe.getSetCookie === "function") {
    const values = maybe.getSetCookie();
    if (Array.isArray(values) && values.length > 0) return values;
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function getCookieValueFromSetCookies(
  setCookies: string[],
  name: string,
): string | null {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(";", 1);
    if (!pair) continue;
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = pair.slice(0, eqIndex).trim();
    if (key !== name) continue;
    return pair.slice(eqIndex + 1).trim();
  }
  return null;
}
