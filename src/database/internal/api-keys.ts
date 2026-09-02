import { query } from "../core/db.ts"
import type { ApiKeyRecord } from "./types.ts"
import { formatUsdAmount, parseUsdAmount } from "../../shared/usd.ts"

function mapApiKeyRow(row: {
  id: string
  owner_user_id: string | null
  name: string
  api_key: string
  quota: number | string | null
  used: number | string
  expires_at: Date | null
  revoked_at: Date | null
  created_at: Date
  updated_at: Date
}): ApiKeyRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    apiKey: row.api_key,
    quota: row.quota === null ? null : String(row.quota),
    used: String(row.used ?? "0"),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}


export async function listApiKeys(filters?: {
  ownerUserId?: string | null
}): Promise<ApiKeyRecord[]> {
  const ownerUserId = filters?.ownerUserId?.trim() ?? null
  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    revoked_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, owner_user_id, name, api_key, quota, used, expires_at, revoked_at, created_at, updated_at
      FROM api_keys
      WHERE revoked_at IS NULL
      ${ownerUserId ? "AND owner_user_id = $1::uuid" : ""}
      ORDER BY updated_at DESC
    `,
    ownerUserId ? [ownerUserId] : [],
  )
  return res.rows.map(mapApiKeyRow)
}

export async function getApiKeyByToken(
  apiKey: string,
): Promise<ApiKeyRecord | null> {
  const token = apiKey.trim()
  if (!token) return null
  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    revoked_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        keys.id, keys.owner_user_id, keys.name, keys.api_key, keys.quota,
        keys.used, keys.expires_at, keys.revoked_at,
        keys.created_at, keys.updated_at
      FROM api_keys keys
      JOIN portal_users users ON users.id = keys.owner_user_id
      WHERE keys.api_key = $1
        AND keys.revoked_at IS NULL
        AND users.enabled = TRUE
      LIMIT 1
    `,
    [token],
  )
  const row = res.rows[0]
  return row ? mapApiKeyRow(row) : null
}

export async function createApiKey(input: {
  ownerUserId?: string | null
  name: string
  apiKey: string
  quota?: number | string | null
  expiresAt?: string | Date | null
}): Promise<ApiKeyRecord> {
  const name = input.name.trim()
  const apiKey = input.apiKey.trim()
  if (!name) {
    throw new Error("name is required")
  }
  if (!apiKey) {
    throw new Error("apiKey is required")
  }

  const parsedQuota = parseUsdAmount(input.quota)
  const quota =
    parsedQuota !== null && parsedQuota >= 0n
      ? formatUsdAmount(parsedQuota)
      : null
  const ownerUserId = input.ownerUserId?.trim() ?? null
  const expiresAt = input.expiresAt ?? null

  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    revoked_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO api_keys (owner_user_id, name, api_key, quota, used, expires_at)
      VALUES ($1::uuid, $2, $3, $4, 0, $5::timestamptz)
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, revoked_at, created_at, updated_at
    `,
    [ownerUserId, name, apiKey, quota, expiresAt],
  )

  if (!res.rows[0]) {
    throw new Error("Failed to create api key")
  }
  return mapApiKeyRow(res.rows[0])
}

export async function deleteApiKeyById(
  id: string,
  filters?: { ownerUserId?: string | null },
): Promise<ApiKeyRecord | null> {
  const ownerUserId = filters?.ownerUserId?.trim() ?? null
  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    revoked_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE api_keys
      SET revoked_at = now()
      WHERE id = $1::uuid
        AND revoked_at IS NULL
      ${ownerUserId ? "AND owner_user_id = $2::uuid" : ""}
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, revoked_at, created_at, updated_at
    `,
    ownerUserId ? [id, ownerUserId] : [id],
  )
  return res.rows[0] ? mapApiKeyRow(res.rows[0]) : null
}

export async function updateApiKeyById(input: {
  id: string
  name: string
  ownerUserId?: string | null
  quota?: number | string | null
  expiresAt?: string | Date | null
}): Promise<ApiKeyRecord | null> {
  const name = input.name.trim()
  if (!name) {
    throw new Error("name is required")
  }
  const parsedQuota = parseUsdAmount(input.quota)
  const quota =
    parsedQuota !== null && parsedQuota >= 0n
      ? formatUsdAmount(parsedQuota)
      : null
  const ownerUserId = input.ownerUserId?.trim() ?? null
  const expiresAt = input.expiresAt ?? null

  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    revoked_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE api_keys
      SET name = $2,
          quota = $3,
          expires_at = $4::timestamptz
      WHERE id = $1::uuid
        AND revoked_at IS NULL
      ${ownerUserId ? "AND owner_user_id = $5::uuid" : ""}
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, revoked_at, created_at, updated_at
    `,
    ownerUserId
      ? [input.id, name, quota, expiresAt, ownerUserId]
      : [input.id, name, quota, expiresAt],
  )
  if (!res.rows[0]) return null
  return mapApiKeyRow(res.rows[0])
}
