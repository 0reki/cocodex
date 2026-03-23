import { resolveExternalOrigin, sanitizeNextPath } from "@/lib/http/request-utils";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_LOGIN_STATE_COOKIE = "admin_google_login_state";

export function getGoogleClientId() {
  return process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
}

export function getGoogleClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
}

export function getGoogleCallbackUrl(req: Request) {
  return `${resolveExternalOrigin(req)}/api/admin/login/google/callback`;
}

export function isGoogleLoginConfigured() {
  return Boolean(getGoogleClientId() && getGoogleClientSecret());
}

export function createGoogleLoginState(nextPath: string) {
  return Buffer.from(
    JSON.stringify({
      nonce: crypto.randomUUID(),
      nextPath: sanitizeNextPath(nextPath),
    }),
    "utf8",
  ).toString("base64url");
}

export function parseGoogleLoginState(raw: string | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { nonce?: string; nextPath?: string };
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.nextPath !== "string"
    ) {
      return null;
    }
    return {
      nonce: parsed.nonce,
      nextPath: sanitizeNextPath(parsed.nextPath),
    };
  } catch {
    return null;
  }
}

export function buildGoogleLoginUrl(req: Request, state: string) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", getGoogleClientId());
  url.searchParams.set("redirect_uri", getGoogleCallbackUrl(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoogleCode(req: Request, code: string) {
  const body = new URLSearchParams({
    code,
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    redirect_uri: getGoogleCallbackUrl(req),
    grant_type: "authorization_code",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Google token exchange did not return access_token");
  }
  return data.access_token;
}

export async function fetchGoogleUserInfo(accessToken: string) {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed: HTTP ${res.status}`);
  }
  return (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
}
