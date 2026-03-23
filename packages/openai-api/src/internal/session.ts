import {
  CHATGPT_ACCOUNTS_CHECK_V4_URL,
  CHATGPT_SESSION_URL,
  DEFAULT_USER_AGENT,
} from "./runtime-constants.ts"
import {
  buildCookieHeader,
  extractSessionTokenCookies,
  extractSetCookies,
} from "./runtime-stream.ts"
import { fetchWithOptionalProxy } from "./runtime-proxy.ts"
import type {
  AccountsCheckV4Response,
  ChatgptSessionResponse,
  ChatgptSessionWithCookies,
  GetAccountsCheckV4Options,
  GetChatgptSessionOptions,
  PrimaryAccountInfo,
} from "./runtime-types.ts"

export async function getChatgptSessionWithCookies(
  options: GetChatgptSessionOptions,
): Promise<ChatgptSessionWithCookies> {
  const cookie = buildCookieHeader(options);

  const res = await fetchWithOptionalProxy(
    CHATGPT_SESSION_URL,
    {
      method: "GET",
      headers: {
        "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
        Accept: "application/json",
        Cookie: cookie,
      },
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  const setCookies = extractSetCookies(res.headers);
  if (!res.ok) {
    throw new Error(
      `chatgpt session HTTP ${res.status}: ${text.slice(0, 500)}`,
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

export async function getAccountsCheckV4(
  options: GetAccountsCheckV4Options,
): Promise<AccountsCheckV4Response> {
  const accessToken = options.accessToken.trim();
  if (!accessToken) {
    throw new Error("Missing accessToken");
  }

  const timezoneOffsetMin = Number.isFinite(options.timezoneOffsetMin)
    ? Math.trunc(options.timezoneOffsetMin as number)
    : -480;
  const url = `${CHATGPT_ACCOUNTS_CHECK_V4_URL}?timezone_offset_min=${timezoneOffsetMin}`;
  const target = new URL(url);
  const requestHeaders = {
    "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
    Accept: "*/*",
    Authorization: `Bearer ${accessToken}`,
    Host: target.host,
    Connection: "keep-alive",
  };

  console.info(`[openai-api] accounts/check request url=${url}`);
  console.info(
    `[openai-api] accounts/check request_headers=${JSON.stringify(requestHeaders)}`,
  );

  const res = await fetchWithOptionalProxy(
    url,
    {
      method: "GET",
      headers: requestHeaders,
      signal: options.signal,
    },
    options.proxyUrl,
  );

  const text = await res.text();
  console.info(`[openai-api] accounts/check response_status=${res.status}`);
  if (!res.ok) {
    throw new Error(
      `accounts/check/v4 HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as AccountsCheckV4Response;
  } catch {
    throw new Error(
      `Invalid JSON from accounts/check/v4: ${text.slice(0, 500)}`,
    );
  }
}

export function extractPrimaryAccountInfo(
  data: AccountsCheckV4Response,
): PrimaryAccountInfo | null {
  const accounts = data.accounts;
  if (!accounts || typeof accounts !== "object") return null;

  const ordered = Array.isArray(data.account_ordering)
    ? data.account_ordering
    : [];
  const firstKey = ordered.find((k) => typeof k === "string" && k in accounts);
  const fallbackKey =
    "default" in accounts ? "default" : Object.keys(accounts)[0];
  const accountKey = firstKey ?? fallbackKey;
  if (!accountKey) return null;

  const node = accounts[accountKey];
  if (!node || typeof node !== "object") return null;
  const account = node.account ?? {};
  const entitlement = node.entitlement ?? {};

  return {
    accountKey,
    accountId: account.account_id ?? null,
    accountUserRole: account.account_user_role ?? null,
    accountUserId: account.account_user_id ?? null,
    accountOwnerId: account.account_owner_id ?? null,
    name: account.name ?? null,
    picture: account.profile_picture_url ?? null,
    planType: account.plan_type ?? null,
    structure: account.structure ?? null,
    workspaceIsDeactivated: Boolean(account.is_deactivated),
    canAccessWithSession: Boolean(node.can_access_with_session),
    isDelinquent:
      typeof entitlement.is_delinquent === "boolean"
        ? entitlement.is_delinquent
        : null,
    subscriptionPlan: entitlement.subscription_plan ?? null,
    expiresAt: entitlement.expires_at ?? null,
    renewsAt: entitlement.renews_at ?? null,
    cancelsAt: entitlement.cancels_at ?? null,
  };
}
