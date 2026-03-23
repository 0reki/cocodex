import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { ensureDatabaseSchema, getPortalUserById } from "@workspace/database"
import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth"

export async function GET() {
  const cookieStore = await cookies()
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore)
  const payload = resolved?.session ?? null
  let avatarUrl: string | null = null
  if (payload?.sub) {
    await ensureDatabaseSchema()
    const user = await getPortalUserById(payload.sub)
    avatarUrl = user?.avatarUrl ?? null
  }
  return NextResponse.json({
    authed: Boolean(payload),
    user: payload
      ? {
          id: payload.sub,
          username: payload.username,
          role: payload.role,
          avatarUrl,
          mustSetup: payload.mustSetup,
        }
      : null,
  })
}
