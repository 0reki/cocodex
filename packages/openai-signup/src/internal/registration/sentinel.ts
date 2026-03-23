import { setupSentinelEnv } from "../../env.ts";
import { fetchSentinelSdkDynamic } from "../../sdk.ts";
import {
  AUTH_URL,
  CHATGPT_URL,
  SENTINEL_URL,
  USER_AGENT,
  fetchWithTimeout,
  getActiveDispatcher,
  getSetCookies,
  withActiveRunPrefix,
} from "../shared/runtime.ts";
import {
  extractIdFromSentinelToken,
  getBuildId,
  normalizeTokenWithStableP,
} from "./helpers.ts";

export async function getSentinelTokenViaSdk(args: {
  flow: string;
  deviceId: string;
  stableP: string | null;
  clientVersion: string;
  getHeaders: (
    extra?: Record<string, string>,
    url?: string,
  ) => Promise<Record<string, string>>;
  updateCookies: (setCookie: string[] | string | null, currentUrl: string) => Promise<void>;
  syncDidCookies: () => Promise<void>;
}): Promise<{
  token: string;
  p: string | null;
  stableP: string | null;
}> {
  const timeoutMs = Number(process.env.SIGNUP_SENTINEL_TIMEOUT_MS ?? 20_000);
  const withTimeout = async <T>(label: string, run: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        run,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Sentinel ${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  console.log(withActiveRunPrefix(`[Sentinel] Loading SDK for flow: ${args.flow}...`));
  await args.syncDidCookies();

  const { sdkJs } = await fetchSentinelSdkDynamic({
    sentinelUrl: SENTINEL_URL,
    authUrl: AUTH_URL,
    getHeaders: args.getHeaders,
    updateCookies: args.updateCookies,
    dispatcher: getActiveDispatcher(),
  });
  console.log(withActiveRunPrefix("[Sentinel] Script resolved."));

  const customFetch = async (url: string, init?: any) => {
    const target = typeof url === "string" ? url : String(url);
    const baseHeaders = await args.getHeaders({}, target);
    const mergedHeaders: Record<string, string> = {
      ...baseHeaders,
      ...(init?.headers as Record<string, string> | undefined),
    };

    const res = await fetchWithTimeout(target, {
      ...init,
      headers: mergedHeaders,
      dispatcher: getActiveDispatcher(),
    } as any);
    await args.updateCookies(getSetCookies(res.headers), target);
    return res;
  };

  setupSentinelEnv({
    userAgent: USER_AGENT,
    buildId: getBuildId(args.clientVersion),
    oaiDid: args.deviceId,
    origin: CHATGPT_URL,
    customFetch,
  });

  const runSdk = new Function(`${sdkJs}; return SentinelSDK;`);
  const SentinelSDK = runSdk();
  await withTimeout("init", SentinelSDK.init(args.flow));
  const rawToken = await withTimeout("token", SentinelSDK.token(args.flow));
  if (typeof rawToken !== "string") {
    throw new Error("Sentinel returned non-string token");
  }
  const tokenDid = extractIdFromSentinelToken(rawToken);
  if (tokenDid && tokenDid !== args.deviceId) {
    throw new Error(
      `Sentinel token id mismatch: expected ${args.deviceId}, got ${tokenDid}`,
    );
  }
  const normalized = normalizeTokenWithStableP(rawToken, args.stableP);
  if (normalized.patched) {
    console.log(withActiveRunPrefix("[Sentinel] Token acquired."));
  }
  return {
    token: normalized.token,
    p: normalized.p,
    stableP: normalized.stableP,
  };
}
