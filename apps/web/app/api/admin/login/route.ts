import { NextResponse } from "next/server"

import { getPortalUserByUsername } from "@workspace/database"
import {
  createSessionTokens,
  setAdminSessionCookies,
  verifyPassword,
} from "@/lib/auth/admin-auth"
import {
  isSameOriginRequest,
  resolveExternalOrigin,
  sanitizeNextPath,
} from "@/lib/http/request-utils"
import { getLocaleFromCountry } from "@/lib/i18n/locale-map"
import { ensureBootstrapAdminUser } from "@/lib/backend/portal-users"
import { LOCALE_COOKIE } from "@/lib/i18n/i18n-shared"

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  }

  const formData = await req.formData()
  const username = String(formData.get("username") ?? "").trim().toLowerCase()
  const password = String(formData.get("password") ?? "")
  const nextPath = sanitizeNextPath(String(formData.get("next") ?? "/dashboard"))
  const origin = resolveExternalOrigin(req)

  try {
    await ensureBootstrapAdminUser()
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Bootstrap user initialization failed",
      },
      { status: 500 },
    )
  }

  const user = await getPortalUserByUsername(username)
  const authed =
    user && user.enabled ? verifyPassword(password, user.passwordHash) : false

  if (!authed || !user) {
    const redirectUrl = new URL("/login", origin)
    redirectUrl.searchParams.set("error", "1")
    if (nextPath.startsWith("/")) {
      redirectUrl.searchParams.set("next", nextPath)
    }
    return NextResponse.redirect(redirectUrl, { status: 303 })
  }

  let tokens: Awaited<ReturnType<typeof createSessionTokens>>
  try {
    tokens = await createSessionTokens({
      userId: user.id,
      username: user.username,
      role: user.role,
      mustSetup: user.mustSetup,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create admin access token",
      },
      { status: 500 },
    )
  }

  const redirectUrl = new URL(nextPath, origin)

  const res = NextResponse.redirect(redirectUrl, { status: 303 })
  setAdminSessionCookies(res.cookies, {
    accessToken: tokens.accessToken.token,
    refreshToken: tokens.refreshToken.token,
  })
  res.cookies.set({
    name: LOCALE_COOKIE,
    value: encodeURIComponent(getLocaleFromCountry(user.country)),
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })

  return res
}
