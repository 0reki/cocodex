import { query } from "../core/db.ts"
import type {
  PortalUserRecord,
  PortalUserRole,
  PortalUserWithBalanceRecord,
} from "./types.ts"

type PortalUserRow = {
  id: string
  username: string
  password_hash: string
  role: string
  enabled: boolean
  balance: number | string | null
  created_at: Date
  updated_at: Date
}

const PORTAL_USER_COLUMNS = `
  id, username, password_hash, role, enabled, balance, created_at, updated_at
`

function mapPortalUserRow(row: PortalUserRow): PortalUserRecord {
  const role: PortalUserRole = row.role === "admin" ? "admin" : "user"
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapPortalUserWithBalanceRow(
  row: PortalUserRow,
): PortalUserWithBalanceRecord {
  return {
    ...mapPortalUserRow(row),
    balance: Number(row.balance ?? "0"),
  }
}

export async function countPortalUsers(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM portal_users`,
  )
  return Number(result.rows[0]?.count ?? "0")
}

export async function listPortalUsers(): Promise<PortalUserWithBalanceRecord[]> {
  const result = await query<PortalUserRow>(
    `
      SELECT ${PORTAL_USER_COLUMNS}
      FROM portal_users
      ORDER BY created_at ASC
    `,
  )
  return result.rows.map(mapPortalUserWithBalanceRow)
}

export async function getPortalUserByUsername(
  username: string,
): Promise<PortalUserRecord | null> {
  const normalized = username.trim().toLowerCase()
  if (!normalized) return null
  const result = await query<PortalUserRow>(
    `
      SELECT ${PORTAL_USER_COLUMNS}
      FROM portal_users
      WHERE LOWER(username) = $1
      LIMIT 1
    `,
    [normalized],
  )
  const row = result.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function getPortalUserById(
  id: string,
): Promise<PortalUserRecord | null> {
  const normalized = id.trim()
  if (!normalized) return null
  const result = await query<PortalUserRow>(
    `
      SELECT ${PORTAL_USER_COLUMNS}
      FROM portal_users
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [normalized],
  )
  const row = result.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function createPortalUser(input: {
  username: string
  passwordHash: string
  role?: PortalUserRole
  enabled?: boolean
  balance?: number
}): Promise<PortalUserWithBalanceRecord> {
  const username = input.username.trim().toLowerCase()
  const passwordHash = input.passwordHash.trim()
  if (!username) throw new Error("username is required")
  if (!passwordHash) throw new Error("passwordHash is required")
  const role: PortalUserRole = input.role === "admin" ? "admin" : "user"
  const enabled = input.enabled ?? true
  const balance =
    typeof input.balance === "number" && Number.isFinite(input.balance)
      ? Math.max(0, input.balance)
      : 0
  const result = await query<PortalUserRow>(
    `
      INSERT INTO portal_users (
        username, password_hash, role, enabled, balance
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING ${PORTAL_USER_COLUMNS}
    `,
    [username, passwordHash, role, enabled, balance],
  )
  const row = result.rows[0]
  if (!row) throw new Error("Failed to create portal user")
  return mapPortalUserWithBalanceRow(row)
}

export async function updatePortalUsernameById(
  id: string,
  username: string,
): Promise<PortalUserRecord | null> {
  const normalizedId = id.trim()
  const normalizedUsername = username.trim().toLowerCase()
  if (!normalizedId || !normalizedUsername) return null
  const result = await query<PortalUserRow>(
    `
      UPDATE portal_users
      SET username = $2
      WHERE id = $1::uuid
      RETURNING ${PORTAL_USER_COLUMNS}
    `,
    [normalizedId, normalizedUsername],
  )
  const row = result.rows[0]
  return row ? mapPortalUserRow(row) : null
}

export async function updatePortalUserPasswordById(
  id: string,
  passwordHash: string,
): Promise<boolean> {
  const normalizedId = id.trim()
  const normalizedPasswordHash = passwordHash.trim()
  if (!normalizedId || !normalizedPasswordHash) return false
  const result = await query(
    `
      UPDATE portal_users
      SET password_hash = $2
      WHERE id = $1::uuid
    `,
    [normalizedId, normalizedPasswordHash],
  )
  return (result.rowCount ?? 0) > 0
}

export async function setPortalUserEnabledById(
  id: string,
  enabled: boolean,
): Promise<PortalUserRecord | null> {
  const normalizedId = id.trim()
  if (!normalizedId) return null
  const result = await query<PortalUserRow>(
    `
      UPDATE portal_users
      SET enabled = $2
      WHERE id = $1::uuid
      RETURNING ${PORTAL_USER_COLUMNS}
    `,
    [normalizedId, enabled],
  )
  const row = result.rows[0]
  return row ? mapPortalUserRow(row) : null
}
