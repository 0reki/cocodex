import { NextResponse } from "next/server";
import {
  buildGoogleLoginUrl,
  createGoogleLoginState,
  GOOGLE_LOGIN_STATE_COOKIE,
  isGoogleLoginConfigured,
} from "@/lib/auth/google-auth";
import { sanitizeNextPath } from "@/lib/http/request-utils";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const nextPath = sanitizeNextPath(
    new URL(req.url).searchParams.get("next") ?? "/dashboard",
  );
  const origin = new URL(req.url).origin;

  if (!isGoogleLoginConfigured()) {
    const redirectUrl = new URL("/login", origin);
    redirectUrl.searchParams.set("error", "google_config");
    redirectUrl.searchParams.set("next", nextPath);
    return NextResponse.redirect(redirectUrl, { status: 303 });
  }

  const state = createGoogleLoginState(nextPath);
  const res = NextResponse.redirect(buildGoogleLoginUrl(req, state), {
    status: 303,
  });
  res.cookies.set({
    name: GOOGLE_LOGIN_STATE_COOKIE,
    value: state,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return res;
}
