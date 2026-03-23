import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  createPortalUser,
  ensureDatabaseSchema,
  listPortalUsers,
} from "@workspace/database"

import {
  hashPassword,
  resolvePortalSessionFromCookieStore,
} from "@/lib/auth/admin-auth"

async function requireAdminForApi() {
  const cookieStore = await cookies()
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore)
  const payload = resolved?.session ?? null
  return payload?.role === "admin" ? payload : null
}

export async function GET() {
  const session = await requireAdminForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureDatabaseSchema()
  const users = await listPortalUsers()
  return NextResponse.json({
    items: users.map((item) => ({
      id: item.id,
      username: item.username,
      avatarUrl: item.avatarUrl,
      role: item.role,
      enabled: item.enabled,
      userRpmLimit: item.userRpmLimit,
      userMaxInFlight: item.userMaxInFlight,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  })
}

export async function POST(req: Request) {
  const session = await requireAdminForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const input: Record<string, unknown> =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const username =
    typeof input.username === "string"
      ? input.username.trim().toLowerCase()
      : ""
  const password = typeof input.password === "string" ? input.password : ""
  const roleRaw = typeof input.role === "string" ? input.role : "user"
  const role = roleRaw === "admin" ? "admin" : "user"
  const userRpmLimitRaw = input.userRpmLimit
  const userMaxInFlightRaw = input.userMaxInFlight
  const userRpmLimit =
    userRpmLimitRaw === null || userRpmLimitRaw === undefined || userRpmLimitRaw === ""
      ? null
      : Number(userRpmLimitRaw)
  const userMaxInFlight =
    userMaxInFlightRaw === null ||
    userMaxInFlightRaw === undefined ||
    userMaxInFlightRaw === ""
      ? null
      : Number(userMaxInFlightRaw)

  if (!username || username.length < 3) {
    return NextResponse.json(
      { error: "username must be at least 3 characters" },
      { status: 400 },
    )
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 },
    )
  }
  if (userRpmLimit !== null && (!Number.isFinite(userRpmLimit) || userRpmLimit < 0)) {
    return NextResponse.json({ error: "userRpmLimit must be >= 0" }, { status: 400 })
  }
  if (
    userMaxInFlight !== null &&
    (!Number.isFinite(userMaxInFlight) || userMaxInFlight < 0)
  ) {
    return NextResponse.json(
      { error: "userMaxInFlight must be >= 0" },
      { status: 400 },
    )
  }

  try {
    await ensureDatabaseSchema()
    const created = await createPortalUser({
      username,
      passwordHash: hashPassword(password),
      role,
      enabled: true,
      userRpmLimit,
      userMaxInFlight,
    })
    return NextResponse.json({
      user: {
        id: created.id,
        username: created.username,
        avatarUrl: created.avatarUrl,
        role: created.role,
        enabled: created.enabled,
        userRpmLimit: created.userRpmLimit,
        userMaxInFlight: created.userMaxInFlight,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create user"
    if (message.toLowerCase().includes("duplicate")) {
      return NextResponse.json({ error: "username already exists" }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
