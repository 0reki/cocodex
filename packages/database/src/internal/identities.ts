import { query } from "../core/db.ts"
import type { PortalUserIdentityRecord } from "./types.ts"

function mapPortalUserIdentityRow(row: {
  id: string
  user_id: string
  provider: string
  provider_user_id: string
  provider_username: string | null
  provider_name: string | null
  avatar_url: string | null
  created_at: Date
  updated_at: Date
}): PortalUserIdentityRecord {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerUsername: row.provider_username,
    providerName: row.provider_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function getPortalUserIdentity(
  provider: string,
  providerUserId: string,
): Promise<PortalUserIdentityRecord | null> {
  const normalizedProvider = provider.trim().toLowerCase()
  const normalizedProviderUserId = providerUserId.trim()
  if (!normalizedProvider || !normalizedProviderUserId) return null
  const res = await query<{
    id: string
    user_id: string
    provider: string
    provider_user_id: string
    provider_username: string | null
    provider_name: string | null
    avatar_url: string | null
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, user_id, provider, provider_user_id, provider_username, provider_name,
        avatar_url, created_at, updated_at
      FROM portal_user_identities
      WHERE provider = $1 AND provider_user_id = $2
      LIMIT 1
    `,
    [normalizedProvider, normalizedProviderUserId],
  )
  const row = res.rows[0]
  return row ? mapPortalUserIdentityRow(row) : null
}

export async function upsertPortalUserIdentity(input: {
  userId: string
  provider: string
  providerUserId: string
  providerUsername?: string | null
  providerName?: string | null
  avatarUrl?: string | null
}): Promise<PortalUserIdentityRecord> {
  const userId = input.userId.trim()
  const provider = input.provider.trim().toLowerCase()
  const providerUserId = input.providerUserId.trim()
  if (!userId) throw new Error("userId is required")
  if (!provider) throw new Error("provider is required")
  if (!providerUserId) throw new Error("providerUserId is required")

  const providerUsername =
    typeof input.providerUsername === "string" && input.providerUsername.trim()
      ? input.providerUsername.trim()
      : null
  const providerName =
    typeof input.providerName === "string" && input.providerName.trim()
      ? input.providerName.trim()
      : null
  const avatarUrl =
    typeof input.avatarUrl === "string" && input.avatarUrl.trim()
      ? input.avatarUrl.trim()
      : null

  const res = await query<{
    id: string
    user_id: string
    provider: string
    provider_user_id: string
    provider_username: string | null
    provider_name: string | null
    avatar_url: string | null
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO portal_user_identities (
        user_id, provider, provider_user_id, provider_username, provider_name, avatar_url
      )
      VALUES ($1::uuid, $2, $3, $4, $5, $6)
      ON CONFLICT (provider, provider_user_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        provider_username = EXCLUDED.provider_username,
        provider_name = EXCLUDED.provider_name,
        avatar_url = EXCLUDED.avatar_url
      RETURNING
        id, user_id, provider, provider_user_id, provider_username, provider_name,
        avatar_url, created_at, updated_at
    `,
    [userId, provider, providerUserId, providerUsername, providerName, avatarUrl],
  )
  const row = res.rows[0]
  if (!row) throw new Error("Failed to upsert portal user identity")
  return mapPortalUserIdentityRow(row)
}

