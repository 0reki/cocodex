import { NextResponse } from "next/server"

import { clearAdminSessionCookies } from "@/lib/auth/admin-auth"
import { isSameOriginRequest, resolveExternalOrigin } from "@/lib/http/request-utils"

export async function POST(req: Request) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 })
  }

  const origin = resolveExternalOrigin(req)
  const res = NextResponse.redirect(new URL("/login", origin), {
    status: 303,
  })
  clearAdminSessionCookies(res.cookies)
  return res
}
