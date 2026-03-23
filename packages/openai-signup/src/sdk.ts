import { fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

type HeaderFactory = (
  extra?: Record<string, string>,
  url?: string,
) => Promise<Record<string, string>>;

type CookieUpdater = (
  setCookie: string[] | string | null,
  currentUrl: string,
) => Promise<void>;

export type SentinelSdkBootstrap = {
  scriptUrl: string;
  bootstrapJs: string;
};

export type SentinelSdkPayload = {
  bootstrapJs: string;
  scriptUrl: string;
  sdkJs: string;
};

type FetchSentinelSdkBootstrapParams = {
  sentinelUrl: string;
  authUrl: string;
  getHeaders: HeaderFactory;
  updateCookies: CookieUpdater;
  dispatcher: Dispatcher;
};

const SCRIPT_SRC_REGEX = /script\.src\s*=\s*['"]([^'"]+)['"]/i;

type HeaderLike = {
  get: (name: string) => string | null;
  getSetCookie?: () => string[];
};

function isBunRuntime() {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

async function fetchSentinelAsset(
  input: string,
  init: RequestInit,
  dispatcher: Dispatcher,
) {
  if (isBunRuntime()) {
    return fetch(input, init as any);
  }
  return undiciFetch(input, {
    ...(init as any),
    dispatcher,
  });
}

function getSetCookies(headers: HeaderLike): string[] {
  const maybe = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof maybe.getSetCookie === "function") {
    const values = maybe.getSetCookie();
    if (Array.isArray(values) && values.length > 0) return values;
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function readHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string") {
      return value;
    }
  }
  return null;
}

function pickWhitelistedSentinelScriptHeaders(
  source: Record<string, string>,
  authUrl: string,
): Record<string, string> {
  const referer = `${authUrl}/`;
  const selected: Record<string, string> = {
    accept: "*/*",
    "accept-encoding": "identity",
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-site": "same-site",
    referer,
  };

  const allowedOptional = [
    "accept-language",
    "cookie",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "user-agent",
  ];

  for (const key of allowedOptional) {
    const value = readHeaderCaseInsensitive(source, key);
    if (value) selected[key] = value;
  }

  return selected;
}

export function extractSdkScriptUrl(bootstrapJs: string): string {
  const match = bootstrapJs.match(SCRIPT_SRC_REGEX);
  if (!match?.[1]) {
    throw new Error(
      "Failed to extract Sentinel SDK script URL from bootstrap response",
    );
  }
  return match[1];
}

export async function fetchSentinelSdkBootstrap({
  sentinelUrl,
  authUrl,
  getHeaders,
  updateCookies,
  dispatcher,
}: FetchSentinelSdkBootstrapParams): Promise<SentinelSdkBootstrap> {
  const endpoint = `${sentinelUrl}/backend-api/sentinel/sdk.js`;
  const baseHeaders = await getHeaders(
    {
      Accept: "*/*",
      Referer: `${authUrl}/`,
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-site",
    },
    sentinelUrl,
  );
  const requestHeaders = pickWhitelistedSentinelScriptHeaders(
    baseHeaders,
    authUrl,
  );
  const res = await fetchSentinelAsset(
    endpoint,
    {
      method: "GET",
      headers: requestHeaders,
    },
    dispatcher,
  );
  const bootstrapJs = await res.text();
  await updateCookies(getSetCookies(res.headers), sentinelUrl);

  if (!res.ok) {
    throw new Error(
      `Sentinel sdk bootstrap failed: ${res.status} ${res.statusText} ${bootstrapJs.substring(0, 500)}`,
    );
  }

  let scriptUrl: string;
  try {
    scriptUrl = extractSdkScriptUrl(bootstrapJs);
  } catch (error) {
    throw error;
  }
  return { scriptUrl, bootstrapJs };
}

type FetchSentinelSdkJsParams = {
  scriptUrl: string;
  sentinelUrl: string;
  authUrl: string;
  getHeaders: HeaderFactory;
  updateCookies: CookieUpdater;
  dispatcher: Dispatcher;
};

export async function fetchSentinelSdkJs({
  scriptUrl,
  sentinelUrl,
  authUrl,
  getHeaders,
  updateCookies,
  dispatcher,
}: FetchSentinelSdkJsParams): Promise<string> {
  const baseHeaders = await getHeaders(
    {
      Accept: "*/*",
      Referer: `${authUrl}/`,
      "sec-fetch-dest": "script",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-site",
    },
    sentinelUrl,
  );
  const requestHeaders = pickWhitelistedSentinelScriptHeaders(
    baseHeaders,
    authUrl,
  );
  const res = await fetchSentinelAsset(
    scriptUrl,
    {
      method: "GET",
      headers: requestHeaders,
    },
    dispatcher,
  );
  const sdkJs = await res.text();
  await updateCookies(getSetCookies(res.headers), sentinelUrl);

  if (!res.ok) {
    throw new Error(
      `Sentinel sdk fetch failed: ${res.status} ${res.statusText} ${sdkJs.substring(0, 500)}`,
    );
  }

  return sdkJs;
}

// Always dynamic: each call re-fetches bootstrap and then fetches the extracted sdk URL.
export async function fetchSentinelSdkDynamic(
  params: FetchSentinelSdkBootstrapParams,
): Promise<SentinelSdkPayload> {
  const { scriptUrl, bootstrapJs } = await fetchSentinelSdkBootstrap(params);
  const sdkJs = await fetchSentinelSdkJs({
    scriptUrl,
    sentinelUrl: params.sentinelUrl,
    authUrl: params.authUrl,
    getHeaders: params.getHeaders,
    updateCookies: params.updateCookies,
    dispatcher: params.dispatcher,
  });
  return { bootstrapJs, scriptUrl, sdkJs };
}
