import {
  CODEX_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
} from "./runtime-constants.ts";
import {
  getCodexUserAgent,
  getCodexUserAgentForPlatform,
  normalizeCodexClientPlatform,
} from "./client-identity.ts";
import type {
  CodexTokenRefreshResponse,
  RefreshCodexTokensOptions,
} from "./runtime-types.ts";

type OAuthTokenResponse = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
};

export async function refreshCodexTokens(
  options: RefreshCodexTokensOptions,
): Promise<CodexTokenRefreshResponse> {
  const refreshToken = options.refreshToken.trim();
  if (!refreshToken) throw new Error("Missing refreshToken");

  // Keep the User-Agent aligned with the platform the account was registered
  // on, so token refreshes never mutate the client identity seen by OpenAI.
  const platform = options.platform
    ? normalizeCodexClientPlatform(options.platform)
    : null;
  const userAgent = platform
    ? getCodexUserAgentForPlatform(platform)
    : getCodexUserAgent();

  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": userAgent,
    },
    body: JSON.stringify({
      client_id: options.clientId?.trim() || CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `/oauth/token HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  let payload: OAuthTokenResponse;
  try {
    payload = JSON.parse(text) as OAuthTokenResponse;
  } catch {
    throw new Error(`Invalid JSON from /oauth/token: ${text.slice(0, 500)}`);
  }

  return {
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
    accessToken:
      typeof payload.access_token === "string" ? payload.access_token : null,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : null,
  };
}
