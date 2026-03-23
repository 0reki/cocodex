import {
  AUTH_BASE_URL,
  describeFetchError,
  formatRequestBody,
  getSetCookies,
  headersInitToRecord,
} from "../shared/runtime.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);

function summarizeCookieNames(cookieHeader: string): string {
  return cookieHeader
    .split(/;\s*/)
    .map((part) => part.split("=")[0]?.trim())
    .filter(Boolean)
    .join(",");
}

export type FetchContext = {
  baseUrl: string;
  userAgent: string;
  acceptLanguage: string;
  debug: boolean;
  getCookieString: (url: string) => Promise<string>;
  updateCookies: (setCookie: string[] | string | null, currentUrl: string) => Promise<void>;
};

type FetchWithCookiesInit = RequestInit & {
  skipOriginHeader?: boolean;
  skipRefererHeader?: boolean;
  skipAcceptLanguageHeader?: boolean;
  skipAcceptEncodingHeader?: boolean;
  skipSecFetchHeaders?: boolean;
  skipSecChHeaders?: boolean;
  skipCookieHeader?: boolean;
};

export async function fetchWithCookies(
  ctx: FetchContext,
  input: string,
  init: FetchWithCookiesInit = {},
) {
  const url = new URL(input, ctx.baseUrl).toString();
  const target = new URL(url);
  const base = new URL(ctx.baseUrl);
  const method = (init.method ?? "GET").toUpperCase();
  const skipOriginHeader = init.skipOriginHeader === true;
  const skipRefererHeader = init.skipRefererHeader === true;
  const skipAcceptLanguageHeader = init.skipAcceptLanguageHeader === true;
  const skipAcceptEncodingHeader = init.skipAcceptEncodingHeader === true;
  const skipSecFetchHeaders = init.skipSecFetchHeaders === true;
  const skipSecChHeaders = init.skipSecChHeaders === true;
  const skipCookieHeader = init.skipCookieHeader === true;
  const accept = typeof init.headers !== "undefined"
    ? new Headers(init.headers).get("Accept")
    : null;
  const isNavigationRequest =
    method === "GET" &&
    typeof accept === "string" &&
    accept.includes("text/html");
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", target.host);
  if (!headers.has("Connection")) headers.set("Connection", "keep-alive");
  if (!skipOriginHeader && !headers.has("Origin")) headers.set("Origin", target.origin);
  if (!headers.has("User-Agent")) headers.set("User-Agent", ctx.userAgent);
  if (!skipAcceptLanguageHeader && !headers.has("Accept-Language")) {
    headers.set("Accept-Language", ctx.acceptLanguage);
  }
  if (!skipAcceptEncodingHeader && !headers.has("Accept-Encoding")) {
    headers.set("Accept-Encoding", "gzip, deflate, br, zstd");
  }
  if (!skipSecFetchHeaders && isNavigationRequest && !headers.has("sec-fetch-user")) {
    headers.set("sec-fetch-user", "?1");
  }
  if (!skipSecFetchHeaders && isNavigationRequest && !headers.has("upgrade-insecure-requests")) {
    headers.set("upgrade-insecure-requests", "1");
  }
  if (!isNavigationRequest) {
    if (!skipSecChHeaders && !headers.has("sec-ch-ua")) {
      headers.set("sec-ch-ua", '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"');
    }
    if (!skipSecChHeaders && !headers.has("sec-ch-ua-mobile")) {
      headers.set("sec-ch-ua-mobile", "?0");
    }
    if (!skipSecChHeaders && !headers.has("sec-ch-ua-platform")) {
      headers.set("sec-ch-ua-platform", '"Windows"');
    }
    if (!skipSecFetchHeaders && !headers.has("sec-fetch-dest")) {
      headers.set("sec-fetch-dest", "empty");
    }
    if (!skipSecFetchHeaders && !headers.has("sec-fetch-mode")) {
      headers.set("sec-fetch-mode", "cors");
    }
    if (!skipSecFetchHeaders && !headers.has("sec-fetch-site")) {
      headers.set(
        "sec-fetch-site",
        target.origin === base.origin ? "same-origin" : "cross-site",
      );
    }
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (method !== "GET" && method !== "HEAD") {
    if (!skipRefererHeader && !headers.has("Referer")) {
      headers.set("Referer", `${AUTH_BASE_URL}/`);
    }
  }

  const cookie = skipCookieHeader ? "" : await ctx.getCookieString(url);
  if (!skipCookieHeader && cookie) headers.set("Cookie", cookie);
  const requestHeaders = headersInitToRecord(headers);

  if (ctx.debug) {
    const bodyText = formatRequestBody(init.body);
    console.log(`[codex-auth] ${method} ${url}`);
    console.log(`[codex-auth] request_headers=${JSON.stringify(requestHeaders)}`);
    console.log(
      `[codex-auth] request_cookie_names=${cookie ? summarizeCookieNames(cookie) : ""}`,
    );
    if (bodyText) {
      console.log(`[codex-auth] request_body=${bodyText}`);
    }
  }
  let response: Response;
  try {
    response = await nativeFetch(url, {
      ...init,
      headers: requestHeaders,
      redirect: init.redirect ?? "manual",
    });
  } catch (error) {
    throw describeFetchError(error, url);
  }

  await ctx.updateCookies(getSetCookies(response.headers), url);

  if (ctx.debug) {
    console.log(`[codex-auth] response_status=${response.status}`);
    console.log(
      `[codex-auth] response_headers=${JSON.stringify(Object.fromEntries(response.headers.entries()))}`,
    );
    const setCookies = getSetCookies(response.headers);
    console.log(
      `[codex-auth] response_set_cookie_names=${setCookies
        .map((value) => value.split("=")[0]?.trim())
        .filter(Boolean)
        .join(",")}`,
    );
  }

  return response;
}

export async function readJsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response: ${text.slice(0, 1000)}`);
  }
}
