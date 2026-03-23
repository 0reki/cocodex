import { query } from "../core/db.ts"
import type { PortalUserBillingProfileRecord } from "./types.ts"

function mapPortalUserBillingProfileRow(row: {
  id: string
  balance: number | string | null
  currency: string | null
  created_at: Date
  updated_at: Date
}): PortalUserBillingProfileRecord {
  return {
    userId: row.id,
    balance: Number(row.balance ?? "0"),
    currency: row.currency?.trim() || "USD",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function getOrCreatePortalUserBillingProfile(
  userId: string,
): Promise<PortalUserBillingProfileRecord> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) throw new Error("userId is required")
  const res = await query<{
    id: string
    balance: number | string | null
    currency: string | null
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, balance, currency, created_at, updated_at
      FROM portal_users
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [normalizedUserId],
  )
  const row = res.rows[0]
  if (!row) throw new Error("Failed to load billing profile")
  return mapPortalUserBillingProfileRow(row)
}

export async function adjustPortalUserBalance(
  userId: string,
  delta: number,
): Promise<PortalUserBillingProfileRecord> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) throw new Error("userId is required")
  const safeDelta = Number.isFinite(delta) ? delta : 0
  const res = await query<{
    id: string
    balance: number | string | null
    currency: string | null
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE portal_users
      SET balance = GREATEST(0, COALESCE(balance, 0) + $2::numeric)
      WHERE id = $1::uuid
      RETURNING id, balance, currency, created_at, updated_at
    `,
    [normalizedUserId, safeDelta],
  )
  const row = res.rows[0]
  if (!row) throw new Error("Failed to adjust user balance")
  return mapPortalUserBillingProfileRow(row)
}
