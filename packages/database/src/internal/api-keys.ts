import { query } from "../core/db.ts"
import type { ApiKeyRecord } from "./types.ts"

function mapApiKeyRow(row: {
  id: string
  owner_user_id: string | null
  name: string
  api_key: string
  quota: number | string | null
  used: number | string
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}): ApiKeyRecord {
  const quota =
    typeof row.quota === "number"
      ? row.quota
      : typeof row.quota === "string"
        ? Number(row.quota)
        : null
  const used =
    typeof row.used === "number"
      ? row.used
      : typeof row.used === "string"
        ? Number(row.used)
        : 0
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    apiKey: row.api_key,
    quota: Number.isFinite(quota ?? NaN) ? quota : null,
    used: Number.isFinite(used) ? used : 0,
    expiresAt: row.expires_at?.toISOString() ?? null,
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
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, owner_user_id, name, api_key, quota, used, expires_at, created_at, updated_at
      FROM api_keys
      ${ownerUserId ? "WHERE owner_user_id = $1::uuid" : ""}
      ORDER BY updated_at DESC
    `,
    ownerUserId ? [ownerUserId] : [],
  )
  return res.rows.map(mapApiKeyRow)
}

export async function createApiKey(input: {
  ownerUserId?: string | null
  name: string
  apiKey: string
  quota?: number | null
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

  const quota =
    typeof input.quota === "number" && Number.isFinite(input.quota)
      ? Math.max(0, input.quota)
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
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO api_keys (owner_user_id, name, api_key, quota, used, expires_at)
      VALUES ($1::uuid, $2, $3, $4, 0, $5::timestamptz)
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, created_at, updated_at
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
): Promise<boolean> {
  const ownerUserId = filters?.ownerUserId?.trim() ?? null
  const res = await query<{ id: string }>(
    `
      DELETE FROM api_keys
      WHERE id = $1::uuid
      ${ownerUserId ? "AND owner_user_id = $2::uuid" : ""}
      RETURNING id
    `,
    ownerUserId ? [id, ownerUserId] : [id],
  )
  return Boolean(res.rows[0])
}

export async function updateApiKeyById(input: {
  id: string
  name: string
  ownerUserId?: string | null
  quota?: number | null
  expiresAt?: string | Date | null
}): Promise<ApiKeyRecord | null> {
  const name = input.name.trim()
  if (!name) {
    throw new Error("name is required")
  }
  const quota =
    typeof input.quota === "number" && Number.isFinite(input.quota)
      ? Math.max(0, input.quota)
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
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE api_keys
      SET name = $2,
          quota = $3,
          expires_at = $4::timestamptz
      WHERE id = $1::uuid
      ${ownerUserId ? "AND owner_user_id = $5::uuid" : ""}
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, created_at, updated_at
    `,
    ownerUserId
      ? [input.id, name, quota, expiresAt, ownerUserId]
      : [input.id, name, quota, expiresAt],
  )
  if (!res.rows[0]) return null
  return mapApiKeyRow(res.rows[0])
}

export async function incrementApiKeyUsed(
  id: string,
  delta: number,
): Promise<ApiKeyRecord | null> {
  const safeDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0
  const res = await query<{
    id: string
    owner_user_id: string | null
    name: string
    api_key: string
    quota: number | string | null
    used: number | string
    expires_at: Date | null
    created_at: Date
    updated_at: Date
  }>(
    `
      UPDATE api_keys
      SET used = GREATEST(0, COALESCE(used, 0) + $2::numeric)
      WHERE id = $1::uuid
      RETURNING id, owner_user_id, name, api_key, quota, used, expires_at, created_at, updated_at
    `,
    [id, safeDelta],
  )
  if (!res.rows[0]) return null
  return mapApiKeyRow(res.rows[0])
}

