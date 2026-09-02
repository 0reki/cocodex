import { query } from "../core/db.ts"
import type {
  PortalUserBillingProfileRecord,
  PortalUserSpendAllowance,
} from "./types.ts"
import { parseUsdAmount } from "../../shared/usd.ts"

function mapPortalUserBillingProfileRow(row: {
  id: string
  balance: number | string | null
  created_at: Date
  updated_at: Date
}): PortalUserBillingProfileRecord {
  return {
    userId: row.id,
    balanceUsd: String(row.balance ?? "0"),
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
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, balance, created_at, updated_at
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

export async function getPortalUserSpendAllowance(
  userId: string,
): Promise<PortalUserSpendAllowance> {
  const profile = await getOrCreatePortalUserBillingProfile(userId)
  const balance = parseUsdAmount(profile.balanceUsd) ?? 0n
  return {
    balance,
    totalAvailable: balance,
  }
}
