import {
  CHATGPT_CODEX_IMAGE_EDITS_URL,
  CHATGPT_CODEX_IMAGE_GENERATIONS_URL,
} from "./runtime-constants.ts";
import { resolveResponseTransport } from "./responses-shared.ts";
import type { PostCodexImageOptions } from "./runtime-types.ts";

export async function postCodexImage(
  options: PostCodexImageOptions,
): Promise<Response> {
  const { sessionId, transportHeaders } = resolveResponseTransport(options);
  const headers = new Headers(transportHeaders);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (!headers.has("x-codex-image-turn-id")) {
    headers.set("x-codex-image-turn-id", sessionId);
  }

  const url =
    options.operation === "generations"
      ? CHATGPT_CODEX_IMAGE_GENERATIONS_URL
      : CHATGPT_CODEX_IMAGE_EDITS_URL;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(options.payload),
    signal: options.signal,
  });
}
