import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import {
  DEFAULT_CODEX_ORIGINATOR,
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_CODEX_SENTRY_ENVIRONMENT,
  DEFAULT_CODEX_SENTRY_PUBLIC_KEY,
  DEFAULT_CODEX_SENTRY_RELEASE,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts";

export function normalizeCodexVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) return trimmed;
  if (/-((alpha|beta|rc)([.-]|$))/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}-alpha.10`;
}

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
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.accessToken}`,
    originator: args.originator?.trim() || DEFAULT_CODEX_ORIGINATOR,
    session_id: args.sessionId,
    version: normalizeCodexVersion(args.version),
    "x-codex-turn-metadata": buildCodexTurnMetadataHeader(),
    "User-Agent": args.userAgent ?? DEFAULT_USER_AGENT,
  };
  const accountId = args.accountId?.trim();
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
  }
  return headers;
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

export function buildCodexSentryHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return {
    baggage: [
      `sentry-environment=${DEFAULT_CODEX_SENTRY_ENVIRONMENT}`,
      `sentry-release=${DEFAULT_CODEX_SENTRY_RELEASE}`,
      `sentry-public_key=${DEFAULT_CODEX_SENTRY_PUBLIC_KEY}`,
      `sentry-trace_id=${traceId}`,
    ].join(","),
    "sentry-trace": `${traceId}-${spanId}`,
  };
}
