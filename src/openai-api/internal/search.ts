import { CHATGPT_CODEX_SEARCH_URL } from "./runtime-constants.ts";
import { resolveResponseTransport } from "./responses-shared.ts";
import type { PostCodexSearchOptions } from "./runtime-types.ts";

export async function postCodexSearch(
  options: PostCodexSearchOptions,
): Promise<Response> {
  const { transportHeaders } = resolveResponseTransport(options);
  const headers = new Headers(transportHeaders);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");

  return fetch(CHATGPT_CODEX_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(options.payload),
    signal: options.signal,
  });
}
