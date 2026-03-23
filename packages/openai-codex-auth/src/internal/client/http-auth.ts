import {
  AUTH_BASE_URL,
  CHATGPT_BASE_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
} from "../shared/runtime.ts";
import type {
  CallbackResult,
  ContinueResponse,
  OAuthTokenResponse,
  RefreshTokenRequest,
} from "../shared/types.ts";
import { fetchWithCookies, readJsonOrThrow, type FetchContext } from "./http-shared.ts";

export async function initializeAuthorizeSession(
  ctx: FetchContext,
  authorizationUrl: string,
  options: { maxRedirects?: number } = {},
): Promise<string> {
  let currentUrl = authorizationUrl;
  const maxRedirects = options.maxRedirects ?? 12;

  for (let i = 0; i < maxRedirects; i += 1) {
    const res = await fetchWithCookies(ctx, currentUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Origin: new URL(currentUrl).origin,
        Referer: `${AUTH_BASE_URL}/`,
      },
      redirect: "manual",
    });

    const location = res.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect && !res.ok) {
      const body = await res.text();
      throw new Error(
        `initializeAuthorizeSession failed at ${currentUrl} with HTTP ${res.status}: ${body.slice(0, 1000)}`,
      );
    }
    if (!isRedirect || !location) {
      return currentUrl;
    }

    currentUrl = new URL(location, currentUrl).toString();
    const next = new URL(currentUrl);
    if (next.protocol === "http:" && next.hostname === "localhost") {
      return currentUrl;
    }
  }

  throw new Error(
    `Too many redirects while initializing authorize session (> ${maxRedirects})`,
  );
}

export async function authorizeContinue(
  ctx: FetchContext,
  params: { email: string; sentinelToken?: string },
): Promise<ContinueResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (params.sentinelToken?.trim()) {
    headers["openai-sentinel-token"] = params.sentinelToken.trim();
  }

  const res = await fetchWithCookies(ctx, "/api/accounts/authorize/continue", {
    method: "POST",
    headers,
    body: JSON.stringify({
      username: {
        kind: "email",
        value: params.email,
      },
    }),
  });

  return readJsonOrThrow<ContinueResponse>(res);
}

export async function verifyPassword(
  ctx: FetchContext,
  password: string,
  options: { referer?: string; sentinelToken?: string } = {},
): Promise<ContinueResponse> {
  const pwd = password.trim();
  if (!pwd) throw new Error("password is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Referer: options.referer ?? `${AUTH_BASE_URL}/`,
  };
  if (options.sentinelToken?.trim()) {
    headers["openai-sentinel-token"] = options.sentinelToken.trim();
  }

  const res = await fetchWithCookies(ctx, "/api/accounts/password/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ password: pwd }),
  });

  return readJsonOrThrow<ContinueResponse>(res);
}

export async function visitPage(ctx: FetchContext, urlOrPath: string): Promise<void> {
  const url = new URL(urlOrPath, ctx.baseUrl).toString();
  await fetchWithCookies(ctx, url, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "manual",
  });
}

export async function sendPasswordlessOtp(
  ctx: FetchContext,
  options: { referer?: string } = {},
): Promise<ContinueResponse> {
  const res = await fetchWithCookies(ctx, "/api/accounts/passwordless/send-otp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: options.referer ?? `${AUTH_BASE_URL}/`,
    },
  });
  return readJsonOrThrow<ContinueResponse>(res);
}

export async function validateEmailOtp(
  ctx: FetchContext,
  code: string,
  options: { referer?: string } = {},
): Promise<ContinueResponse> {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    throw new Error("OTP code must be a 6-digit string");
  }

  const res = await fetchWithCookies(ctx, "/api/accounts/email-otp/validate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: options.referer ?? `${AUTH_BASE_URL}/`,
    },
    body: JSON.stringify({ code: trimmed }),
  });

  return readJsonOrThrow<ContinueResponse>(res);
}

export async function selectWorkspace(
  ctx: FetchContext,
  workspaceId: string,
): Promise<ContinueResponse> {
  const value = workspaceId.trim();
  if (!value) {
    throw new Error("workspaceId is required");
  }

  const res = await fetchWithCookies(ctx, "/api/accounts/workspace/select", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ workspace_id: value }),
  });

  return readJsonOrThrow<ContinueResponse>(res);
}

export async function resolveCallbackFromExternalUrl(
  ctx: FetchContext,
  externalUrl: string,
  options: { expectedState?: string; maxRedirects?: number } = {},
): Promise<CallbackResult> {
  let currentUrl = externalUrl;
  const maxRedirects = options.maxRedirects ?? 12;

  for (let i = 0; i < maxRedirects; i += 1) {
    const res = await fetchWithCookies(ctx, currentUrl, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "manual",
    });

    const location = res.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);

    if (!isRedirect || !location) {
      const body = await res.text();
      throw new Error(
        `Expected redirect while resolving callback, got HTTP ${res.status}: ${body.slice(0, 500)}`,
      );
    }

    const nextUrl = new URL(location, currentUrl).toString();
    const next = new URL(nextUrl);
    if (
      next.protocol === "http:" &&
      next.hostname === "localhost" &&
      next.pathname === "/auth/callback"
    ) {
      const code = next.searchParams.get("code");
      const scope = next.searchParams.get("scope");
      const state = next.searchParams.get("state");

      if (!code) {
        throw new Error(`Callback URL missing code: ${nextUrl}`);
      }
      if (options.expectedState && state !== options.expectedState) {
        throw new Error(
          `State mismatch: expected=${options.expectedState} actual=${state ?? ""}`,
        );
      }

      return {
        callbackUrl: nextUrl,
        code,
        scope,
        state,
      };
    }

    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects while resolving callback (> ${maxRedirects})`);
}

export async function exchangeToken(
  ctx: FetchContext,
  params: {
    code: string;
    codeVerifier: string;
    clientId?: string;
    redirectUri?: string;
  },
): Promise<OAuthTokenResponse> {
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", params.code);
  form.set("redirect_uri", params.redirectUri ?? DEFAULT_REDIRECT_URI);
  form.set("client_id", params.clientId ?? DEFAULT_CLIENT_ID);
  form.set("code_verifier", params.codeVerifier);

  const res = await fetchWithCookies(ctx, "/oauth/token", {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  return readJsonOrThrow<OAuthTokenResponse>(res);
}

export async function refreshAccessToken(
  ctx: FetchContext,
  params: RefreshTokenRequest,
): Promise<OAuthTokenResponse> {
  const refreshToken = params.refreshToken.trim();
  if (!refreshToken) {
    throw new Error("refreshToken is required");
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", params.clientId ?? DEFAULT_CLIENT_ID);
  if (params.scope?.trim()) {
    form.set("scope", params.scope.trim());
  }

  const res = await fetchWithCookies(ctx, "/oauth/token", {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  return readJsonOrThrow<OAuthTokenResponse>(res);
}
