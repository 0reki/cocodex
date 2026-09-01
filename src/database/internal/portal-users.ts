import { query } from "../core/db.ts"
import type {
  PortalUserRecord,
  PortalUserRole,
  PortalUserWithBalanceRecord,
} from "./types.ts"

function mapPortalUserRow(row: {
  id: string
  username: string
  email: string | null
  password_hash: string
  avatar_url: string | null
  country: string | null
  role: string
  enabled: boolean
  must_setup: boolean
  created_at: Date
  updated_at: Date
}): PortalUserRecord {
  const normalizedRole: PortalUserRole = row.role === "admin" ? "admin" : "user"
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    passwordHash: row.password_hash,
    avatarUrl: row.avatar_url,
    country: row.country,
    role: normalizedRole,
    enabled: row.enabled,
    mustSetup: row.must_setup,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function countPortalUsers(): Promise<number> {
  const res = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM portal_users
    `,
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function listPortalUsers(): Promise<PortalUserRecord[]> {
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
      FROM portal_users
      ORDER BY created_at ASC
    `,
  )
  return res.rows.map(mapPortalUserRow)
}

type PortalUserListFilters = {
  search?: string | null
  role?: "all" | PortalUserRole | null
  status?: "all" | "enabled" | "disabled" | null
}

function normalizePortalUserListFilters(filters?: PortalUserListFilters): {
  search: string
  role: "all" | PortalUserRole
  status: "all" | "enabled" | "disabled"
} {
  return {
    search: filters?.search?.trim() ?? "",
    role: filters?.role === "admin" || filters?.role === "user" ? filters.role : "all",
    status:
      filters?.status === "enabled" || filters?.status === "disabled"
        ? filters.status
        : "all",
  }
}

function buildPortalUsersFilterSql(filters?: PortalUserListFilters): {
  whereSql: string
  params: string[]
} {
  const normalized = normalizePortalUserListFilters(filters)
  const whereParts: string[] = []
  const params: string[] = []

  if (normalized.search) {
    params.push(`%${normalized.search}%`)
    whereParts.push(
      `(
        portal_users.username ILIKE $${params.length}
        OR COALESCE(portal_users.email, '') ILIKE $${params.length}
        OR portal_users.role ILIKE $${params.length}
      )`,
    )
  }

  if (normalized.role !== "all") {
    params.push(normalized.role)
    whereParts.push(`portal_users.role = $${params.length}`)
  }

  if (normalized.status === "enabled") {
    whereParts.push(`portal_users.enabled = TRUE`)
  } else if (normalized.status === "disabled") {
    whereParts.push(`portal_users.enabled = FALSE`)
  }

  return {
    whereSql: whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
    params,
  }
}

export async function listPortalUsersPage(
  page = 1,
  pageSize = 20,
  filters?: PortalUserListFilters,
): Promise<{
  items: PortalUserWithBalanceRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(200, Math.floor(pageSize)))
  const filterSql = buildPortalUsersFilterSql(filters)

  const countRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM portal_users
      ${filterSql.whereSql}
    `,
    filterSql.params,
  )

  const total = Number(countRes.rows[0]?.count ?? "0")
  const totalPages = Math.max(1, Math.ceil(total / safePageSize))
  const normalizedPage = Math.min(safePage, totalPages)
  const offset = (normalizedPage - 1) * safePageSize

  const rowsRes = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    balance: number | string | null
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, balance,
        created_at, updated_at
      FROM portal_users
      ${filterSql.whereSql}
      ORDER BY created_at ASC
      LIMIT $${filterSql.params.length + 1}
      OFFSET $${filterSql.params.length + 2}
    `,
    [...filterSql.params, String(safePageSize), String(offset)],
  )

  return {
    items: rowsRes.rows.map((row) => ({
      ...mapPortalUserRow(row),
      balance: Number(row.balance ?? "0"),
    })),
    total,
    page: normalizedPage,
    pageSize: safePageSize,
    totalPages,
  }
}

export async function listPortalUsersByIds(userIds: string[]): Promise<PortalUserRecord[]> {
  const normalizedUserIds = Array.from(
    new Set(userIds.map((item) => item.trim()).filter((item) => item.length > 0)),
  )
  if (normalizedUserIds.length === 0) return []
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
      FROM portal_users
      WHERE id = ANY($1::uuid[])
      ORDER BY created_at ASC
    `,
    [normalizedUserIds],
  )
  return res.rows.map(mapPortalUserRow)
}

export async function getPortalUserByUsername(
  username: string,
): Promise<PortalUserRecord | null> {
  const normalized = username.trim().toLowerCase()
  if (!normalized) return null
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
      FROM portal_users
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1
    `,
    [normalized],
  )
  const row = res.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function getPortalUserByEmail(
  email: string,
): Promise<PortalUserRecord | null> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return null
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
      FROM portal_users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [normalized],
  )
  const row = res.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function getPortalUserById(id: string): Promise<PortalUserRecord | null> {
  const normalized = id.trim()
  if (!normalized) return null
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
      FROM portal_users
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [normalized],
  )
  const row = res.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function createPortalUser(input: {
  username: string
  email?: string | null
  passwordHash: string
  avatarUrl?: string | null
  country?: string | null
  role?: PortalUserRole
  enabled?: boolean
  mustSetup?: boolean
}): Promise<PortalUserRecord> {
  const username = input.username.trim().toLowerCase()
  const passwordHash = input.passwordHash.trim()
  const avatarUrl =
    typeof input.avatarUrl === "string" && input.avatarUrl.trim()
      ? input.avatarUrl.trim()
      : null
  const country =
    typeof input.country === "string" && input.country.trim()
      ? input.country.trim()
      : null
  const email =
    typeof input.email === "string" && input.email.trim()
      ? input.email.trim().toLowerCase()
      : null
  if (!username) throw new Error("username is required")
  if (!passwordHash) throw new Error("passwordHash is required")
  const role: PortalUserRole = input.role === "admin" ? "admin" : "user"
  const enabled = input.enabled ?? true
  const mustSetup = input.mustSetup ?? false
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO portal_users (
        username, email, password_hash, avatar_url, country, role, enabled, must_setup
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
    `,
    [
      username,
      email,
      passwordHash,
      avatarUrl,
      country,
      role,
      enabled,
      mustSetup,
    ],
  )
  const row = res.rows[0]
  if (!row) throw new Error("Failed to create portal user")
  return mapPortalUserRow(row)
}

export async function updatePortalUserById(
  id: string,
  updates: {
    email?: string | null
    passwordHash?: string
    avatarUrl?: string | null
    country?: string | null
    role?: PortalUserRole
    enabled?: boolean
    mustSetup?: boolean
  },
): Promise<PortalUserRecord | null> {
  const normalizedId = id.trim()
  if (!normalizedId) return null

  const sets: string[] = []
  const values: unknown[] = []

  if (typeof updates.passwordHash === "string") {
    sets.push(`password_hash = $${values.length + 1}`)
    values.push(updates.passwordHash.trim())
  }
  if (typeof updates.email === "string") {
    sets.push(`email = $${values.length + 1}`)
    values.push(updates.email.trim().toLowerCase() || null)
  } else if (updates.email === null) {
    sets.push(`email = $${values.length + 1}`)
    values.push(null)
  }
  if (typeof updates.avatarUrl === "string") {
    sets.push(`avatar_url = $${values.length + 1}`)
    values.push(updates.avatarUrl.trim() || null)
  } else if (updates.avatarUrl === null) {
    sets.push(`avatar_url = $${values.length + 1}`)
    values.push(null)
  }
  if (typeof updates.country === "string") {
    sets.push(`country = $${values.length + 1}`)
    values.push(updates.country.trim() || null)
  } else if (updates.country === null) {
    sets.push(`country = $${values.length + 1}`)
    values.push(null)
  }
  if (updates.role === "admin" || updates.role === "user") {
    sets.push(`role = $${values.length + 1}`)
    values.push(updates.role)
  }
  if (typeof updates.enabled === "boolean") {
    sets.push(`enabled = $${values.length + 1}`)
    values.push(updates.enabled)
  }
  if (typeof updates.mustSetup === "boolean") {
    sets.push(`must_setup = $${values.length + 1}`)
    values.push(updates.mustSetup)
  }
  if (sets.length === 0) {
    return getPortalUserById(normalizedId)
  }

  values.push(normalizedId)
  const res = await query<{
    id: string
    username: string
    email: string | null
    password_hash: string
    avatar_url: string | null
    country: string | null
    role: string
    enabled: boolean
    must_setup: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE portal_users
      SET ${sets.join(", ")}
      WHERE id = $${values.length}::uuid
      RETURNING
        id, username, email, password_hash, avatar_url, country,
        role, enabled, must_setup, created_at, updated_at
    `,
    values,
  )
  const row = res.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function deletePortalUserById(id: string): Promise<boolean> {
  const normalizedId = id.trim()
  if (!normalizedId) return false
  const result = await query(
    `DELETE FROM portal_users WHERE id = $1::uuid`,
    [normalizedId],
  )
  return (result.rowCount ?? 0) > 0
}
