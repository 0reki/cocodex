import { query, withTransaction } from "../../core/db.ts"

function normalizeEmails(emails: string[]) {
  return Array.from(new Set(emails.map((email) => email.trim()).filter(Boolean)))
}

export async function deleteOpenAIAccountByEmail(email: string) {
  const result = await query<{ id: string }>(
    `DELETE FROM openai_accounts WHERE email = $1 RETURNING id`,
    [email],
  )
  return Boolean(result.rows[0])
}

export async function deleteOpenAIAccountsByEmails(emails: string[]) {
  const normalized = normalizeEmails(emails)
  if (!normalized.length) return 0

  const result = await query<{ count: string }>(
    `
      WITH deleted AS (
        DELETE FROM openai_accounts
        WHERE email = ANY($1::text[])
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `,
    [normalized],
  )
  return Number(result.rows[0]?.count ?? "0")
}

export async function disableOpenAIAccountByEmail(email: string) {
  const result = await query<{ id: string }>(
    `
      UPDATE openai_accounts
      SET status = 'disabled'
      WHERE email = $1
      RETURNING id
    `,
    [email],
  )
  return Boolean(result.rows[0])
}

export async function disableOpenAIAccountsByEmails(emails: string[]) {
  const normalized = normalizeEmails(emails)
  if (!normalized.length) return 0

  const result = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE openai_accounts
        SET status = 'disabled'
        WHERE email = ANY($1::text[])
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
    [normalized],
  )
  return Number(result.rows[0]?.count ?? "0")
}

export async function activateOpenAIAccountByEmail(email: string) {
  return withTransaction(async (client) => {
    const target = await client.query<{ id: string }>(
      `SELECT id FROM openai_accounts WHERE email = $1 FOR UPDATE`,
      [email],
    )
    if (!target.rows[0]) return false

    await client.query(
      `
        UPDATE openai_accounts
        SET status = 'inactive'
        WHERE LOWER(TRIM(status)) = 'active'
          AND email <> $1
      `,
      [email],
    )
    await client.query(
      `
        UPDATE openai_accounts
        SET status = 'active'
        WHERE email = $1
      `,
      [email],
    )
    return true
  })
}

export async function updateOpenAIAccountTokensById(
  id: string,
  tokens: {
    idToken?: string | null
    accessToken: string
    refreshToken?: string | null
  },
) {
  const result = await query<{ id: string }>(
    `
      UPDATE openai_accounts
      SET id_token = COALESCE($2, id_token),
          access_token = $3,
          refresh_token = COALESCE($4, refresh_token)
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      tokens.idToken?.trim() || null,
      tokens.accessToken.trim(),
      tokens.refreshToken?.trim() || null,
    ],
  )
  return (result.rowCount ?? 0) > 0
}
