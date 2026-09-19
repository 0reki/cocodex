import { query, withTransaction } from "../core/db.ts"

export type CodexClientRefreshRecord = {
  email: string
  ownerUserId: string
  sessionId: string
}

export async function storeCodexClientRefreshToken(input: {
  tokenHash: string
  ownerUserId: string
  email: string
  sessionId: string
  expiresAt: Date | string
}): Promise<void> {
  const tokenHash = input.tokenHash.trim()
  const ownerUserId = input.ownerUserId.trim()
  const email = input.email.trim()
  const sessionId = input.sessionId.trim()
  if (!tokenHash || !ownerUserId || !email || !sessionId) {
    throw new Error("refresh token fields are required")
  }
  await query(
    `
      INSERT INTO codex_client_refresh_tokens (
        token_hash, owner_user_id, email, session_id, expires_at
      )
      VALUES ($1, $2::uuid, $3, $4, $5::timestamptz)
      ON CONFLICT (token_hash) DO UPDATE SET
        owner_user_id = EXCLUDED.owner_user_id,
        email = EXCLUDED.email,
        session_id = EXCLUDED.session_id,
        expires_at = EXCLUDED.expires_at,
        api_key_id = NULL
    `,
    [tokenHash, ownerUserId, email, sessionId, input.expiresAt],
  )
}

/**
 * Consumes a refresh token and stores its replacement in one transaction,
 * so a failed write never leaves the client without a usable refresh token.
 * Legacy rows without a session adopt `fallbackSessionId`.
 */
export async function rotateCodexClientRefreshToken(input: {
  tokenHash: string
  newTokenHash: string
  fallbackSessionId: string
  expiresAt: Date | string
}): Promise<CodexClientRefreshRecord | null> {
  const tokenHash = input.tokenHash.trim()
  const newTokenHash = input.newTokenHash.trim()
  const fallbackSessionId = input.fallbackSessionId.trim()
  if (!tokenHash || !newTokenHash || !fallbackSessionId) return null
  return withTransaction(async (client) => {
    const res = await client.query<{
      owner_user_id: string
      email: string
      session_id: string | null
    }>(
      `
        DELETE FROM codex_client_refresh_tokens
        WHERE token_hash = $1
          AND expires_at > now()
        RETURNING owner_user_id, email, session_id
      `,
      [tokenHash],
    )
    const row = res.rows[0]
    if (!row) return null
    const sessionId = row.session_id || fallbackSessionId
    await client.query(
      `
        INSERT INTO codex_client_refresh_tokens (
          token_hash, owner_user_id, email, session_id, expires_at
        )
        VALUES ($1, $2::uuid, $3, $4, $5::timestamptz)
      `,
      [newTokenHash, row.owner_user_id, row.email, sessionId, input.expiresAt],
    )
    return {
      email: row.email,
      ownerUserId: row.owner_user_id,
      sessionId,
    }
  })
}

/** Latest refresh-token expiry of a live session, or null when it has none. */
export async function getCodexClientSessionExpiry(
  sessionId: string,
): Promise<Date | null> {
  const id = sessionId.trim()
  if (!id) return null
  const res = await query<{ expires_at: Date | null }>(
    `
      SELECT max(expires_at) AS expires_at
      FROM codex_client_refresh_tokens
      WHERE session_id = $1
        AND expires_at > now()
    `,
    [id],
  )
  return res.rows[0]?.expires_at ?? null
}

/** Deletes matching refresh tokens and returns the sessions they belonged to. */
export async function revokeCodexClientRefreshTokens(input: {
  tokenHash?: string | null
  sessionId?: string | null
  ownerUserId?: string | null
}): Promise<string[]> {
  const tokenHash = input.tokenHash?.trim() || null
  const sessionId = input.sessionId?.trim() || null
  const ownerUserId = input.ownerUserId?.trim() || null
  if (!tokenHash && !sessionId && !ownerUserId) return []
  const res = await query<{ session_id: string | null }>(
    `
      DELETE FROM codex_client_refresh_tokens
      WHERE ($1::text IS NOT NULL AND token_hash = $1)
         OR ($2::text IS NOT NULL AND session_id = $2)
         OR ($3::uuid IS NOT NULL AND owner_user_id = $3::uuid)
      RETURNING session_id
    `,
    [tokenHash, sessionId, ownerUserId],
  )
  return [
    ...new Set(
      res.rows
        .map((row) => row.session_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
}
