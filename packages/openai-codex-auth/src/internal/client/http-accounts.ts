import { AUTH_BASE_URL, CHATGPT_BASE_URL } from "../shared/runtime.ts";
import type { AccountsCheckResponse } from "../shared/types.ts";
import { fetchWithCookies, readJsonOrThrow, type FetchContext } from "./http-shared.ts";

export async function getChatgptSession(
  ctx: FetchContext,
): Promise<Record<string, unknown>> {
  const res = await fetchWithCookies(ctx, `${CHATGPT_BASE_URL}/api/auth/session`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Referer: `${AUTH_BASE_URL}/`,
    },
  });
  return readJsonOrThrow<Record<string, unknown>>(res);
}

export async function getAccountsCheckV4RawText(
  ctx: FetchContext,
  getAccessToken: () => Promise<string>,
  options: { accessToken?: string; timezoneOffsetMin?: number } = {},
): Promise<{ status: number; body: string }> {
  const timezoneOffsetMin = Number.isFinite(options.timezoneOffsetMin)
    ? Math.trunc(options.timezoneOffsetMin as number)
    : -480;
  const accessToken = options.accessToken?.trim() || (await getAccessToken());
  const url = `${CHATGPT_BASE_URL}/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${timezoneOffsetMin}`;

  const res = await fetchWithCookies(ctx, url, {
    method: "GET",
    headers: {
      Accept: "*/*",
      Authorization: `Bearer ${accessToken}`,
    },
    skipOriginHeader: true,
    skipAcceptLanguageHeader: true,
    skipAcceptEncodingHeader: true,
    skipSecFetchHeaders: true,
    skipSecChHeaders: true,
    skipCookieHeader: true,
  });

  const body = await res.text();
  return { status: res.status, body };
}

export async function getAccountsCheckV4Raw(
  ctx: FetchContext,
  getAccessToken: () => Promise<string>,
  options: { accessToken?: string; timezoneOffsetMin?: number } = {},
): Promise<AccountsCheckResponse> {
  const raw = await getAccountsCheckV4RawText(ctx, getAccessToken, options);
  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(
      `accounts/check failed with HTTP ${raw.status}: ${raw.body.slice(0, 2000)}`,
    );
  }
  try {
    return JSON.parse(raw.body) as AccountsCheckResponse;
  } catch (error) {
    throw new Error(
      `accounts/check returned non-JSON payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function getMeRaw(
  ctx: FetchContext,
  options: { accessToken: string; accountId: string },
): Promise<Record<string, unknown>> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  if (!accessToken) throw new Error("accessToken is required");
  if (!accountId) throw new Error("accountId is required");

  const res = await fetchWithCookies(ctx, `${CHATGPT_BASE_URL}/backend-api/me`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      Referer: `${AUTH_BASE_URL}/`,
      "chatgpt-account-id": accountId,
    },
  });
  return readJsonOrThrow<Record<string, unknown>>(res);
}

export async function getSubscriptionRaw(
  ctx: FetchContext,
  options: { accessToken: string; accountId: string },
): Promise<Record<string, unknown>> {
  const accessToken = options.accessToken.trim();
  const accountId = options.accountId.trim();
  if (!accessToken) throw new Error("accessToken is required");
  if (!accountId) throw new Error("accountId is required");

  const url = `${CHATGPT_BASE_URL}/backend-api/subscriptions?account_id=${encodeURIComponent(accountId)}`;
  const res = await fetchWithCookies(ctx, url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      Referer: `${AUTH_BASE_URL}/`,
    },
  });
  return readJsonOrThrow<Record<string, unknown>>(res);
}
