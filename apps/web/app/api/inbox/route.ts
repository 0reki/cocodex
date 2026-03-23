import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import {
  countPortalInboxUnreadByUserId,
  deletePortalInboxMessagesByUserId,
  ensureDatabaseSchema,
  getPortalInboxMessageById,
  listPortalInboxMessagesByUserId,
  markPortalInboxMessagesReadByUserId,
} from "@workspace/database"
import { resolvePortalSessionFromCookieStore } from "@/lib/auth/admin-auth"

async function requireSessionForApi() {
  const cookieStore = await cookies()
  const resolved = await resolvePortalSessionFromCookieStore(cookieStore)
  return resolved?.session ?? null
}

export async function GET(req: Request) {
  const session = await requireSessionForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = new URL(req.url)
  const limitRaw = Number(url.searchParams.get("limit") ?? 12)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
    : 12
  const unreadOnly = url.searchParams.get("unread") === "1"
  const detailId = url.searchParams.get("detail")?.trim() ?? ""

  await ensureDatabaseSchema()
  const unreadCountPromise = countPortalInboxUnreadByUserId(session.sub)

  if (detailId) {
    const [detail, unreadCount] = await Promise.all([
      getPortalInboxMessageById(session.sub, detailId),
      unreadCountPromise,
    ])
    return NextResponse.json({ detail, unreadCount })
  }

  const [items, unreadCount] = await Promise.all([
    listPortalInboxMessagesByUserId(session.sub, { limit, unreadOnly }),
    unreadCountPromise,
  ])

  return NextResponse.json({ items, unreadCount })
}

export async function PATCH(req: Request) {
  const session = await requireSessionForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const rawIds = input["ids"]
  const hasIds = Array.isArray(rawIds)
  const ids = hasIds
    ? rawIds.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined

  if (hasIds && (!ids || ids.length === 0)) {
    return NextResponse.json(
      { error: "ids must be a non-empty string array" },
      { status: 400 },
    )
  }

  await ensureDatabaseSchema()
  const updated = await markPortalInboxMessagesReadByUserId(session.sub, ids)
  const unreadCount = await countPortalInboxUnreadByUserId(session.sub)

  return NextResponse.json({ ok: true, updated, unreadCount })
}

export async function DELETE(req: Request) {
  const session = await requireSessionForApi()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const rawIds = input["ids"]
  const ids = Array.isArray(rawIds)
    ? rawIds.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : []

  if (ids.length === 0) {
    return NextResponse.json(
      { error: "ids must be a non-empty string array" },
      { status: 400 },
    )
  }

  await ensureDatabaseSchema()
  const deleted = await deletePortalInboxMessagesByUserId(session.sub, ids)
  const unreadCount = await countPortalInboxUnreadByUserId(session.sub)

  return NextResponse.json({ ok: true, deleted, unreadCount })
}
