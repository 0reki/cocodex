import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  ensureBootstrapAdminUser,
} from "@/lib/backend/portal-users";
import {
  createSessionTokens,
  setAdminSessionCookies,
  hashPassword,
} from "@/lib/auth/admin-auth";
import {
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  GOOGLE_LOGIN_STATE_COOKIE,
  parseGoogleLoginState,
} from "@/lib/auth/google-auth";
import { resolveExternalOrigin } from "@/lib/http/request-utils";
import { LOCALE_COOKIE } from "@/lib/i18n/i18n-shared";
import { getLocaleFromCountry } from "@/lib/i18n/locale-map";
import {
  createPortalUser,
  getPortalUserByEmail,
  getPortalUserById,
  getPortalUserIdentity,
  getPortalUserByUsername,
  upsertPortalUserIdentity,
} from "@workspace/database";

export const runtime = "nodejs";

function buildErrorRedirect(req: Request, code: string, nextPath = "/dashboard") {
  const redirectUrl = new URL("/login", resolveExternalOrigin(req));
  redirectUrl.searchParams.set("error", code);
  if (nextPath.startsWith("/")) {
    redirectUrl.searchParams.set("next", nextPath);
  }
  return NextResponse.redirect(redirectUrl, { status: 303 });
}

function buildUsernameBase(email: string) {
  const localPart = email.split("@", 1)[0] ?? "user";
  const slug = localPart
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 24);
  return slug || "user";
}

async function allocateUsername(email: string) {
  const base = buildUsernameBase(email);
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`;
    const existing = await getPortalUserByUsername(candidate);
    if (!existing) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  const cookieStore = await cookies();
  const rawCookieState = cookieStore.get(GOOGLE_LOGIN_STATE_COOKIE)?.value;
  const cookieState = parseGoogleLoginState(rawCookieState);
  const nextPath = cookieState?.nextPath ?? "/dashboard";

  if (!code || !state || !rawCookieState || !cookieState || state !== rawCookieState) {
    return buildErrorRedirect(req, "google_state", nextPath);
  }

  try {
    await ensureBootstrapAdminUser();
    const googleAccessToken = await exchangeGoogleCode(req, code);
    const profile = await fetchGoogleUserInfo(googleAccessToken);
    const email = profile.email?.trim().toLowerCase() ?? "";
    if (!profile.sub || !email) {
      return buildErrorRedirect(req, "google_failed", nextPath);
    }
    if (profile.email_verified !== true) {
      return buildErrorRedirect(req, "google_unverified", nextPath);
    }

    const identity = await getPortalUserIdentity("google", profile.sub);
    let user =
      (identity ? await getPortalUserById(identity.userId) : null) ??
      (await getPortalUserByEmail(email));
    const isNewUser = !user;
    if (!user) {
      user = await createPortalUser({
        username: await allocateUsername(email),
        email,
        passwordHash: hashPassword(crypto.randomUUID()),
        avatarUrl: profile.picture ?? null,
        role: "user",
        enabled: true,
        mustSetup: true,
      });
    }
    if (!user.enabled) {
      return buildErrorRedirect(req, "google_disabled", nextPath);
    }

    await upsertPortalUserIdentity({
      userId: user.id,
      provider: "google",
      providerUserId: profile.sub,
      providerUsername: email,
      providerName: profile.name ?? null,
      avatarUrl: profile.picture ?? null,
    });

    const tokens = await createSessionTokens({
      userId: user.id,
      username: user.username,
      role: user.role,
      mustSetup: user.mustSetup,
    });

    const targetPath = isNewUser ? "/api/admin/setup/finish" : nextPath;
    const res = NextResponse.redirect(new URL(targetPath, resolveExternalOrigin(req)), {
      status: 303,
    });
    res.cookies.set({
      name: GOOGLE_LOGIN_STATE_COOKIE,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    setAdminSessionCookies(res.cookies, {
      accessToken: tokens.accessToken.token,
      refreshToken: tokens.refreshToken.token,
    });
    res.cookies.set({
      name: LOCALE_COOKIE,
      value: encodeURIComponent(getLocaleFromCountry(user.country)),
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  } catch {
    return buildErrorRedirect(req, "google_failed", nextPath);
  }
}
