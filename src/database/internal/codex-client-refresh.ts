import { query } from "../core/db.ts"

export type CodexClientRefreshRecord = {
  email: string
  ownerUserId: string
}

export async function storeCodexClientRefreshToken(input: {
  tokenHash: string
  ownerUserId: string
  email: string
  expiresAt: Date | string
}): Promise<void> {
  const tokenHash = input.tokenHash.trim()
  const ownerUserId = input.ownerUserId.trim()
  const email = input.email.trim()
  if (!tokenHash || !ownerUserId || !email) {
    throw new Error("refresh token fields are required")
  }
  await query(
    `
      INSERT INTO codex_client_refresh_tokens (
        token_hash, owner_user_id, email, expires_at
      )
      VALUES ($1, $2::uuid, $3, $4::timestamptz)
      ON CONFLICT (token_hash) DO UPDATE SET
        owner_user_id = EXCLUDED.owner_user_id,
        email = EXCLUDED.email,
        expires_at = EXCLUDED.expires_at,
        api_key_id = NULL
    `,
    [tokenHash, ownerUserId, email, input.expiresAt],
  )
}

export async function consumeCodexClientRefreshToken(
  tokenHash: string,
): Promise<CodexClientRefreshRecord | null> {
  const hash = tokenHash.trim()
  if (!hash) return null
  const res = await query<{
    owner_user_id: string
    email: string
  }>(
    `
      DELETE FROM codex_client_refresh_tokens
      WHERE token_hash = $1
        AND expires_at > now()
      RETURNING owner_user_id, email
    `,
    [hash],
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    email: row.email,
    ownerUserId: row.owner_user_id,
  }
}

export async function revokeCodexClientRefreshTokens(input: {
  tokenHash?: string | null
  ownerUserId?: string | null
}): Promise<void> {
  const tokenHash = input.tokenHash?.trim() || null
  const ownerUserId = input.ownerUserId?.trim() || null
  if (!tokenHash && !ownerUserId) return
  await query(
    `
      DELETE FROM codex_client_refresh_tokens
      WHERE ($1::text IS NOT NULL AND token_hash = $1)
         OR ($2::uuid IS NOT NULL AND owner_user_id = $2::uuid)
    `,
    [tokenHash, ownerUserId],
  )
}
