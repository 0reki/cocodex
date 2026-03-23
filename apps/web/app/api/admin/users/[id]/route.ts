import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  countPortalAdmins,
  deletePortalUserById,
  ensureDatabaseSchema,
  getPortalUserById,
  updatePortalUserById,
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

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await context.params
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const input: Record<string, unknown> =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const password =
    typeof input.password === "string"
      ? input.password
      : undefined
  const roleRaw =
    typeof input.role === "string"
      ? input.role
      : undefined
  const role = roleRaw === "admin" || roleRaw === "user" ? roleRaw : undefined
  const enabledRaw = input.enabled
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : undefined
  const userRpmLimitRaw = input.userRpmLimit
  const userMaxInFlightRaw = input.userMaxInFlight
  const userRpmLimit =
    userRpmLimitRaw === null || userRpmLimitRaw === undefined || userRpmLimitRaw === ""
      ? userRpmLimitRaw === undefined
        ? undefined
        : null
      : Number(userRpmLimitRaw)
  const userMaxInFlight =
    userMaxInFlightRaw === null ||
    userMaxInFlightRaw === undefined ||
    userMaxInFlightRaw === ""
      ? userMaxInFlightRaw === undefined
        ? undefined
        : null
      : Number(userMaxInFlightRaw)

  if (
    userRpmLimit !== undefined &&
    userRpmLimit !== null &&
    (!Number.isFinite(userRpmLimit) || userRpmLimit < 0)
  ) {
    return NextResponse.json({ error: "userRpmLimit must be >= 0" }, { status: 400 })
  }
  if (
    userMaxInFlight !== undefined &&
    userMaxInFlight !== null &&
    (!Number.isFinite(userMaxInFlight) || userMaxInFlight < 0)
  ) {
    return NextResponse.json(
      { error: "userMaxInFlight must be >= 0" },
      { status: 400 },
    )
  }

  await ensureDatabaseSchema()
  const existing = await getPortalUserById(id)
  if (!existing) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  if (
    existing.role === "admin" &&
    ((role === "user") || enabled === false)
  ) {
    const adminCount = await countPortalAdmins()
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "At least one enabled admin user is required" },
        { status: 400 },
      )
    }
  }

  const updated = await updatePortalUserById(id, {
    role,
    enabled,
    passwordHash: password && password.length >= 8 ? hashPassword(password) : undefined,
    userRpmLimit,
    userMaxInFlight,
  })
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  return NextResponse.json({
    user: {
      id: updated.id,
      username: updated.username,
      avatarUrl: updated.avatarUrl,
      role: updated.role,
      enabled: updated.enabled,
      userRpmLimit: updated.userRpmLimit,
      userMaxInFlight: updated.userMaxInFlight,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  })
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await context.params
  await ensureDatabaseSchema()
  const existing = await getPortalUserById(id)
  if (!existing) {
    return NextResponse.json({ ok: true, deleted: false })
  }

  if (existing.id === session.sub) {
    return NextResponse.json({ error: "Cannot delete current user" }, { status: 400 })
  }

  if (existing.role === "admin") {
    const adminCount = await countPortalAdmins()
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "At least one enabled admin user is required" },
        { status: 400 },
      )
    }
  }

  const deleted = await deletePortalUserById(id)
  return NextResponse.json({ ok: true, deleted })
}
