import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  refreshAdminAccessCookie,
  resolvePortalSessionFromTokens,
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
} from "@/lib/auth/admin-auth";

const PUBLIC_ROUTES = new Set([
  "/",
  "/login",
  "/api/admin/login",
  "/api/admin/login/google",
  "/api/admin/login/google/callback",
  "/api/admin/setup/finish",
  "/api/admin/session",
  "/status",
]);

function withNoIndexHeaders(res: NextResponse) {
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  );
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isStaticAsset = /\.[a-zA-Z0-9]+$/.test(pathname);
  const isApiPath = pathname.startsWith("/api/");

  if (
    isStaticAsset ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots.txt") ||
    pathname.startsWith("/sitemap")
  ) {
    return NextResponse.next();
  }

  if (process.env.NODE_ENV === "production") {
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (forwardedProto === "http") {
      const target = req.nextUrl.clone();
      target.protocol = "https:";
      return withNoIndexHeaders(NextResponse.redirect(target, 308));
    }
  }

  const isPublic = PUBLIC_ROUTES.has(pathname);
  const resolved = await resolvePortalSessionFromTokens({
    accessToken: req.cookies.get(ADMIN_ACCESS_COOKIE)?.value,
    refreshToken: req.cookies.get(ADMIN_REFRESH_COOKIE)?.value,
  });
  const session = resolved?.session ?? null;
  const isAuthed = Boolean(session);

  if (pathname === "/login" && isAuthed) {
    return withNoIndexHeaders(NextResponse.redirect(new URL("/dashboard", req.url)));
  }

  if (!isPublic && !isAuthed) {
    if (isApiPath) {
      return withNoIndexHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return withNoIndexHeaders(NextResponse.redirect(loginUrl));
  }

  if (session?.mustSetup) {
    const allowedWhileSetup =
      pathname === "/setup" ||
      pathname === "/api/admin/setup/finish" ||
      pathname === "/api/admin/profile" ||
      pathname === "/api/admin/session" ||
      pathname === "/api/admin/logout";
    if (!allowedWhileSetup) {
      if (pathname.startsWith("/api/")) {
        return withNoIndexHeaders(NextResponse.json(
          { error: "Profile setup required" },
          { status: 403 },
        ));
      }
      const setupUrl = new URL("/setup", req.url);
      setupUrl.searchParams.set("reason", "setup_required");
      return withNoIndexHeaders(NextResponse.redirect(setupUrl));
    }
  }

  const requiresAdmin =
    pathname.startsWith("/users") ||
    pathname.startsWith("/tasks") ||
    pathname.startsWith("/proxies") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/api/debug/openai-signup") ||
    pathname.startsWith("/api/signup-proxies") ||
    pathname.startsWith("/api/system-settings") ||
    pathname.startsWith("/api/admin/users");
  if (requiresAdmin && session?.role !== "admin") {
    if (isApiPath) {
      return withNoIndexHeaders(
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      );
    }
    return withNoIndexHeaders(NextResponse.redirect(new URL("/dashboard", req.url)));
  }

  const res = NextResponse.next();
  if (resolved?.refreshed) {
    refreshAdminAccessCookie(res.cookies, resolved.accessToken);
  }
  if (isApiPath || pathname === "/login" || pathname === "/setup") {
    return withNoIndexHeaders(res);
  }
  return res;
}

export const config = {
  matcher: ["/:path*"],
};
