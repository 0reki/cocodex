import { buildCodexTransportHeaders } from "./runtime.ts";
import type {
  PostCodexResponsesCompactOptions,
  PostCodexResponsesOptions,
} from "./runtime.ts";

export function resolveResponseTransport(
  options: PostCodexResponsesOptions | PostCodexResponsesCompactOptions,
) {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId?.trim();
  const sessionId =
    typeof options.sessionId === "string" && options.sessionId.trim()
      ? options.sessionId.trim()
      : globalThis.crypto.randomUUID();
  const version = options.version.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }
  if (!version) {
    throw new Error("Missing version");
  }

  return {
    accessToken,
    accountId,
    sessionId,
    version,
    transportHeaders: buildCodexTransportHeaders({
      accessToken,
      accountId,
      sessionId,
      version,
      userAgent: options.userAgent,
      originator: options.originator,
      requestHeaders: options.requestHeaders,
    }),
  };
}

export async function postCodexResponsesCompact(
  options: PostCodexResponsesCompactOptions,
): Promise<Response> {
  const { transportHeaders } = resolveResponseTransport(options);
  const payload =
    typeof options.payload === "object" && options.payload !== null
      ? (options.payload as Record<string, unknown>)
      : {};
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = new Headers(transportHeaders);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.delete("content-encoding");

  return fetch("https://chatgpt.com/backend-api/codex/responses/compact", {
    method: "POST",
    headers,
    body: Uint8Array.from(body),
    signal: options.signal,
  });
}
