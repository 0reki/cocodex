import {
  DEFAULT_USER_AGENT,
  buildCodexTransportHeaders,
  createUpstreamHttpError,
  fetchWithOptionalProxy,
} from "./runtime.ts";
import type {
  PostAudioTranscriptionOptions,
  PostCodexResponsesCompactOptions,
  PostCodexResponsesOptions,
} from "./runtime.ts";

export function resolveResponseTransport(
  options:
    | PostCodexResponsesOptions
    | PostCodexResponsesCompactOptions,
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
    }),
  };
}

export async function postAudioTranscription(
  options: PostAudioTranscriptionOptions,
): Promise<Response> {
  const accessToken = options.accessToken?.trim();
  if (!accessToken) {
    throw new Error("accessToken is required");
  }
  const accountId = options.accountId?.trim();
  if (!accountId) {
    throw new Error("accountId is required");
  }
  const contentType = options.contentType?.trim();
  if (!contentType) {
    throw new Error("contentType is required");
  }

  const isStreamLikeBody =
    typeof options.body === "object" &&
    options.body !== null &&
    "pipe" in (options.body as object);

  const res = await fetchWithOptionalProxy(
    "https://chatgpt.com/backend-api/transcribe",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: options.body,
      ...(isStreamLikeBody
        ? ({ duplex: "half" } as unknown as RequestInit)
        : {}),
      signal: options.signal,
    },
    options.proxyUrl,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `/backend-api/transcribe HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return res;
}

export async function postCodexResponsesCompact(
  options: PostCodexResponsesCompactOptions,
): Promise<Response> {
  const { transportHeaders } = resolveResponseTransport(options);
  const payload =
    typeof options.payload === "object" && options.payload !== null
      ? (options.payload as Record<string, unknown>)
      : {};

  const res = await fetchWithOptionalProxy(
    "https://chatgpt.com/backend-api/codex/responses/compact",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...transportHeaders,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    },
    options.proxyUrl,
  );

  if (!res.ok) {
    const text = await res.text();
    throw createUpstreamHttpError({
      label: "/backend-api/codex/responses/compact",
      status: res.status,
      responseText: text,
      responseUrl: "https://chatgpt.com/backend-api/codex/responses/compact",
      responseContentType: res.headers.get("content-type"),
    });
  }

  return res;
}
