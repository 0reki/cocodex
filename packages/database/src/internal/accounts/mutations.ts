import { query } from "../../core/db.ts"
import { disablePortalUserAddonsBySourceAccountEmail } from "../orders/addons.ts"

export async function deleteTeamAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      DELETE FROM team_accounts
      WHERE email = $1
      RETURNING id
    `,
    [email],
  )
  return Boolean(res.rows[0])
}

export async function deleteTeamAccountsByEmails(emails: string[]) {
  const normalized = Array.from(
    new Set(
      emails
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  )
  if (normalized.length === 0) return 0

  const res = await query<{ count: string }>(
    `
      WITH deleted AS (
        DELETE FROM team_accounts
        WHERE email = ANY($1::text[])
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `,
    [normalized],
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function disableTeamAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET workspace_is_deactivated = true
      WHERE email = $1
      RETURNING id
    `,
    [email],
  )
  if (res.rows[0]) {
    await disablePortalUserAddonsBySourceAccountEmail(email, "account_unauthorized")
  }
  return Boolean(res.rows[0])
}

export async function disableTeamAccountsByEmails(emails: string[]) {
  const normalized = Array.from(
    new Set(
      emails
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  )
  if (normalized.length === 0) return 0

  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE team_accounts
        SET workspace_is_deactivated = true
        WHERE email = ANY($1::text[])
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
    [normalized],
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function enableTeamAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET workspace_is_deactivated = false
      WHERE email = $1
      RETURNING id
    `,
    [email],
  )
  return Boolean(res.rows[0])
}

export async function updateTeamAccountRateLimitById(
  id: string,
  rateLimit: Record<string, unknown> | null,
) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET rate_limit = $2::jsonb
      WHERE id = $1
      RETURNING id
    `,
    [id, rateLimit === null ? null : JSON.stringify(rateLimit)],
  )
  return (res.rowCount ?? 0) > 0
}

export async function updateTeamAccountTokensById(input: {
  id: string
  accessToken?: string | null
  refreshToken?: string | null
}) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET access_token = COALESCE($2, access_token),
          refresh_token = COALESCE($3, refresh_token)
      WHERE id = $1
      RETURNING id
    `,
    [input.id, input.accessToken ?? null, input.refreshToken ?? null],
  )
  return (res.rowCount ?? 0) > 0
}

export async function deleteOpenAIAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      DELETE FROM team_accounts
      WHERE email = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [email],
  )
  return Boolean(res.rows[0])
}

export async function deleteOpenAIAccountsByEmails(emails: string[]) {
  const normalized = Array.from(
    new Set(
      emails
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  )
  if (normalized.length === 0) return 0

  const res = await query<{ count: string }>(
    `
      WITH deleted AS (
        DELETE FROM team_accounts
        WHERE email = ANY($1::text[])
          AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `,
    [normalized],
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function disableOpenAIAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET status = 'disabled'
      WHERE email = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [email],
  )
  if (res.rows[0]) {
    await disablePortalUserAddonsBySourceAccountEmail(email, "account_unauthorized")
  }
  return Boolean(res.rows[0])
}

export async function disableOpenAIAccountsByEmails(emails: string[]) {
  const normalized = Array.from(
    new Set(
      emails
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  )
  if (normalized.length === 0) return 0

  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE team_accounts
        SET status = 'disabled'
        WHERE email = ANY($1::text[])
          AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
    [normalized],
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function enableOpenAIAccountByEmail(email: string) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET status = 'Active',
          cooldown_until = NULL
      WHERE email = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [email],
  )
  return Boolean(res.rows[0])
}

export async function updateOpenAIAccountRateLimitById(
  id: string,
  rateLimit: Record<string, unknown> | null,
) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET rate_limit = $2::jsonb
      WHERE id = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [id, rateLimit === null ? null : JSON.stringify(rateLimit)],
  )
  return (res.rowCount ?? 0) > 0
}

export async function updateOpenAIAccountAccessTokenById(
  id: string,
  accessToken: string | null,
) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET access_token = $2
      WHERE id = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [id, accessToken],
  )
  return (res.rowCount ?? 0) > 0
}

export async function setOpenAIAccountCooldownById(input: {
  id: string
  cooldownUntil: string | Date
  rateLimit?: Record<string, unknown> | null
}) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET status = 'Cooling down',
          cooldown_until = $2::timestamptz,
          rate_limit = COALESCE($3::jsonb, rate_limit)
      WHERE id = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      RETURNING id
    `,
    [
      input.id,
      input.cooldownUntil,
      input.rateLimit === undefined ? null : JSON.stringify(input.rateLimit),
    ],
  )
  return (res.rowCount ?? 0) > 0
}

export async function setTeamAccountCooldownById(input: {
  id: string
  cooldownUntil: string | Date
  rateLimit?: Record<string, unknown> | null
}) {
  const res = await query<{ id: string }>(
    `
      UPDATE team_accounts
      SET cooldown_until = $2::timestamptz,
          rate_limit = COALESCE($3::jsonb, rate_limit)
      WHERE id = $1
      RETURNING id
    `,
    [
      input.id,
      input.cooldownUntil,
      input.rateLimit === undefined ? null : JSON.stringify(input.rateLimit),
    ],
  )
  return (res.rowCount ?? 0) > 0
}

export async function recoverExpiredOpenAIAccountCooldowns() {
  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE team_accounts
        SET status = 'Active',
            cooldown_until = NULL
        WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
          AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
          AND cooldown_until IS NOT NULL
          AND cooldown_until <= now()
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function recoverExpiredTeamAccountCooldowns() {
  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE team_accounts
        SET cooldown_until = NULL
        WHERE cooldown_until IS NOT NULL
          AND cooldown_until <= now()
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
  )
  return Number(res.rows[0]?.count ?? "0")
}
