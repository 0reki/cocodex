import zlib from "node:zlib";
import {
  DEFAULT_CODEX_ORIGINATOR,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts";

export function buildCodexTurnMetadataHeader(
  sandbox = DEFAULT_CODEX_SANDBOX,
): string {
  return JSON.stringify({
    turn_id: globalThis.crypto.randomUUID(),
    sandbox,
  });
}

export function buildCodexTransportHeaders(args: {
  accessToken: string;
  accountId?: string;
  sessionId: string;
  version: string;
  userAgent?: string;
  originator?: string;
  requestHeaders?: HeadersInit;
}): Record<string, string> {
  const forwarded = new Headers(args.requestHeaders);
  const isProxyRequest = args.requestHeaders !== undefined;
  forwarded.delete("host");
  forwarded.delete("content-length");
  forwarded.delete("connection");
  forwarded.delete("transfer-encoding");
  forwarded.delete("upgrade");
  forwarded.set("authorization", `Bearer ${args.accessToken}`);
  if (!isProxyRequest && !forwarded.has("originator")) {
    forwarded.set("originator", args.originator?.trim() || DEFAULT_CODEX_ORIGINATOR);
  }
  if (!isProxyRequest && !forwarded.has("session-id")) {
    forwarded.set("session-id", args.sessionId);
  }
  if (!forwarded.has("version")) {
    forwarded.set("version", args.version.trim());
  }
  if (!isProxyRequest && !forwarded.has("x-codex-turn-metadata")) {
    forwarded.set("x-codex-turn-metadata", buildCodexTurnMetadataHeader());
  }
  if (!isProxyRequest && !forwarded.has("user-agent")) {
    forwarded.set("user-agent", args.userAgent ?? DEFAULT_USER_AGENT);
  }
  const accountId = args.accountId?.trim();
  if (accountId) {
    forwarded.set("chatgpt-account-id", accountId);
  } else {
    forwarded.delete("chatgpt-account-id");
  }
  return Object.fromEntries(forwarded.entries());
}

export function zstdCompressBuffer(buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    zlib.zstdCompress(buffer, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.isBuffer(result) ? result : Buffer.from(result));
    });
  });
}
