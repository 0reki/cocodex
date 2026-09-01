import {
  CHATGPT_CODEX_MODELS_URL,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts";
import type {
  CodexModelsResponse,
  GetCodexModelsOptions,
} from "./runtime-types.ts";

export async function getCodexModels(
  options: GetCodexModelsOptions,
): Promise<CodexModelsResponse> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId?.trim() ?? "";
  const clientVersion = options.clientVersion.trim();
  if (!accessToken) throw new Error("Missing accessToken");
  if (!clientVersion) throw new Error("Missing clientVersion");

  const headers: Record<string, string> = {
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    version: clientVersion,
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const timeoutSignal = AbortSignal.timeout(5_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(
    `${CHATGPT_CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`,
    {
      method: "GET",
      headers,
      signal,
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `/backend-api/codex/models HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(text) as CodexModelsResponse;
  } catch {
    throw new Error(
      `Invalid JSON from /backend-api/codex/models: ${text.slice(0, 500)}`,
    );
  }
}
