import { CHATGPT_BACKEND_ORIGIN } from "./runtime-constants.ts";
import { buildCodexTransportHeaders } from "./runtime-codex.ts";
import type { ForwardCodexBackendRequestOptions } from "./runtime-types.ts";

export function buildChatgptBackendUrl(path: string, query = "") {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!normalized.startsWith("/backend-api/")) {
    throw new Error("Only /backend-api paths can be forwarded to ChatGPT");
  }
  return `${CHATGPT_BACKEND_ORIGIN}${normalized}${query}`;
}

export async function forwardCodexBackendRequest(
  options: ForwardCodexBackendRequestOptions,
): Promise<Response> {
  const headers = new Headers(
    buildCodexTransportHeaders({
      accessToken: options.accessToken,
      accountId: options.accountId,
      sessionId: options.sessionId,
      version: options.version,
      userAgent: options.userAgent,
      platform: options.platform,
      requestHeaders: options.requestHeaders,
    }),
  );
  const method = options.method.toUpperCase();
  const rawBody =
    method === "GET" || method === "HEAD" ? undefined : options.body;
  const body =
    rawBody == null
      ? undefined
      : typeof rawBody === "string"
        ? rawBody
        : Uint8Array.from(rawBody);
  return fetch(buildChatgptBackendUrl(options.path, options.query), {
    method,
    headers,
    body,
    signal: options.signal,
  });
}
