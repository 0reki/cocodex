import {
  CHATGPT_SESSION_URL,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts";
import {
  buildCookieHeader,
  extractSessionTokenCookies,
  extractSetCookies,
} from "./runtime-stream.ts";
import type {
  ChatgptSessionResponse,
  ChatgptSessionWithCookies,
  GetChatgptSessionOptions,
} from "./runtime-types.ts";

export async function getChatgptSessionWithCookies(
  options: GetChatgptSessionOptions,
): Promise<ChatgptSessionWithCookies> {
  const response = await fetch(CHATGPT_SESSION_URL, {
    method: "GET",
    headers: {
      "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
      Accept: "application/json",
      Cookie: buildCookieHeader(options),
    },
    signal: options.signal,
  });
  const text = await response.text();
  const setCookies = extractSetCookies(response.headers);
  if (!response.ok) {
    throw new Error(
      `chatgpt session HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  try {
    const session = JSON.parse(text) as ChatgptSessionResponse;
    return {
      session,
      setCookies,
      sessionTokenCookies: extractSessionTokenCookies(setCookies),
    };
  } catch {
    throw new Error(
      `Invalid JSON from chatgpt session endpoint: ${text.slice(0, 500)}`,
    );
  }
}

export async function getChatgptSession(
  options: GetChatgptSessionOptions,
): Promise<ChatgptSessionResponse> {
  const { session } = await getChatgptSessionWithCookies(options);
  return session;
}

export async function getAccessToken(options: GetChatgptSessionOptions) {
  const result = await getChatgptSessionWithCookies(options);
  return {
    accessToken: result.session.accessToken ?? "",
    session: result.session,
    setCookies: result.setCookies,
    sessionTokenCookies: result.sessionTokenCookies,
  };
}
