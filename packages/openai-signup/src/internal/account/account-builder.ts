import {
  extractPrimaryAccountInfo,
  getAccessToken,
  getAccountsCheckV4,
  getMe,
  getSubscription,
  type SessionTokenCookieMap,
} from "@workspace/openai-api";
import { getActiveProxyUrl, USER_AGENT } from "../shared/runtime.ts";
import type { SignupAccountRecord, SignupSessionResult } from "../shared/types.ts";

function getSessionTokenInput(sessionResult: SignupSessionResult) {
  const cookies = sessionResult.session_cookies ?? {};
  const direct = cookies["__Secure-next-auth.session-token"];
  if (typeof direct === "string" && direct.length > 0) {
    return { sessionToken: direct };
  }

  const chunkEntries = Object.entries(cookies)
    .map(([name, value]) => {
      const match = name.match(/^__Secure-next-auth\.session-token\.(\d+)$/);
      if (!match || typeof value !== "string") return null;
      return { index: Number(match[1]), value };
    })
    .filter((item): item is { index: number; value: string } => Boolean(item))
    .sort((a, b) => a.index - b.index);

  if (chunkEntries.length === 0) {
    throw new Error("No session token cookie found from signup result");
  }

  return { sessionTokenChunks: chunkEntries.map((item) => item.value) };
}

function getLatestSessionToken(
  original: SignupSessionResult,
  cookies: SessionTokenCookieMap,
) {
  if (cookies["__Secure-next-auth.session-token"]) {
    return cookies["__Secure-next-auth.session-token"];
  }
  if (original.session_cookies["__Secure-next-auth.session-token"]) {
    return original.session_cookies["__Secure-next-auth.session-token"];
  }
  return null;
}

export async function buildAccountRecordFromSession(
  sessionResult: SignupSessionResult,
  password: string,
): Promise<SignupAccountRecord> {
  const tokenInput = getSessionTokenInput(sessionResult);
  const access = await getAccessToken({
    ...tokenInput,
    proxyUrl: getActiveProxyUrl() ?? undefined,
    userAgent: USER_AGENT,
  });

  if (!access.accessToken) {
    throw new Error("AccessToken is empty from /api/auth/session");
  }

  return buildAccountRecordFromTokens({
    email: sessionResult.email,
    password,
    accessToken: access.accessToken,
    refreshToken: null,
    sessionToken: getLatestSessionToken(sessionResult, access.sessionTokenCookies),
    sessionTokenCookies: access.sessionTokenCookies,
  });
}

export async function buildAccountRecordFromTokens(args: {
  email: string;
  password: string;
  accessToken: string;
  refreshToken?: string | null;
  sessionToken?: string | null;
  sessionTokenCookies?: SessionTokenCookieMap;
}): Promise<SignupAccountRecord> {
  const workspace = await getAccountsCheckV4({
    accessToken: args.accessToken,
    timezoneOffsetMin: -480,
    proxyUrl: getActiveProxyUrl() ?? undefined,
    userAgent: USER_AGENT,
  });
  const primary = extractPrimaryAccountInfo(workspace);

  const accountId = primary?.accountId ?? null;
  const me = accountId
    ? await getMe({
        accessToken: args.accessToken,
        accountId,
        proxyUrl: getActiveProxyUrl() ?? undefined,
        userAgent: USER_AGENT,
      })
    : null;
  await (accountId
    ? getSubscription({
        accessToken: args.accessToken,
        accountId,
        proxyUrl: getActiveProxyUrl() ?? undefined,
        userAgent: USER_AGENT,
      }).catch(() => null)
    : Promise.resolve(null));

  const defaultOrg = me?.orgs?.data?.find((org) => org?.is_default);
  const workspaceName =
    primary?.name ??
    primary?.accountKey ??
    defaultOrg?.title ??
    defaultOrg?.name ??
    null;

  return {
    email: me?.email ?? args.email,
    userId: me?.id ?? null,
    name: me?.name ?? null,
    picture: me?.picture ?? null,
    accountId,
    accountUserRole: primary?.accountUserRole ?? null,
    workspaceName,
    planType: primary?.planType ?? null,
    workspaceIsDeactivated: Boolean(primary?.workspaceIsDeactivated),
    workspaceCancelledAt: primary?.cancelsAt ?? null,
    status: primary?.canAccessWithSession === false ? "inactive" : "active",
    isShared: false,
    password: args.password,
    accessToken: args.accessToken,
    sessionToken: args.sessionToken ?? null,
    refreshToken: args.refreshToken ?? null,
    type: "openai",
    sessionTokenCookies: args.sessionTokenCookies ?? {},
  };
}
