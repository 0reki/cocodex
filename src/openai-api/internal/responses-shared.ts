import { buildCodexTransportHeaders } from "./runtime-codex.ts";
import type { PostCodexResponsesOptions } from "./runtime-types.ts";

export function resolveResponseTransport(
  options: PostCodexResponsesOptions,
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
