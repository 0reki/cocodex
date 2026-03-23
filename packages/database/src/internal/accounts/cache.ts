import { query } from "../../core/db.ts"
import { mapOpenAIAccountRow, mapTeamAccountRow } from "./shared.ts"

export async function listOpenAIAccountsForModelCache(limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const res = await query<{
    id: string
    user_id: string | null
    portal_user_id: string | null
    owner_id: string | null
    name: string | null
    email: string
    picture: string | null
    account_id: string | null
    account_user_role: string | null
    workspace_name: string | null
    plan_type: string | null
    team_expires_at: Date | null
    workspace_is_deactivated: boolean
    workspace_cancelled_at: Date | null
    status: string | null
    is_shared: boolean
    system_created: boolean
    proxy_id: string | null
    access_token: string | null
    refresh_token: string | null
    session_token: string | null
    type: string | null
    created_at: Date
    updated_at: Date
    cooldown_until: Date | null
    rate_limit: Record<string, unknown> | null
  }>(
    `
      SELECT
        id, user_id, portal_user_id, owner_id, name, email, picture, account_id, account_user_role,
        workspace_name, plan_type, team_expires_at, workspace_is_deactivated, workspace_cancelled_at,
        status, is_shared, system_created, proxy_id, access_token, refresh_token, session_token,
        type, created_at, updated_at, cooldown_until, rate_limit
      FROM team_accounts
      WHERE access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
        AND LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
        AND (cooldown_until IS NULL OR cooldown_until <= now())
      ORDER BY random()
      LIMIT $1
    `,
    [safeLimit],
  )
  return res.rows.map(mapOpenAIAccountRow)
}

export async function listTeamAccountsForModelCache(limit = 50) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const res = await query<{
    id: string
    user_id: string | null
    portal_user_id: string | null
    owner_id: string | null
    name: string | null
    email: string
    account_id: string | null
    account_user_role: string | null
    workspace_name: string | null
    plan_type: string | null
    team_member_count: number | null
    team_expires_at: Date | null
    system_created: boolean
    workspace_is_deactivated: boolean
    workspace_cancelled_at: Date | null
    proxy_id: string | null
    access_token: string | null
    refresh_token: string | null
    type: string | null
    created_at: Date
    updated_at: Date
    cooldown_until: Date | null
    rate_limit: Record<string, unknown> | null
  }>(
    `
      SELECT
        id, user_id, portal_user_id, owner_id, name, email, account_id, account_user_role,
        workspace_name, plan_type, team_member_count, team_expires_at,
        workspace_is_deactivated, workspace_cancelled_at, system_created, proxy_id,
        access_token, refresh_token, type, created_at, updated_at,
        cooldown_until, rate_limit
      FROM team_accounts
      WHERE access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
        AND LOWER(TRIM(COALESCE(plan_type, ''))) = 'team'
        AND workspace_is_deactivated = false
        AND (cooldown_until IS NULL OR cooldown_until <= now())
      ORDER BY random()
      LIMIT $1
    `,
    [safeLimit],
  )
  return res.rows.map(mapTeamAccountRow)
}

export async function getRandomOpenAIAccountAccessToken() {
  const res = await query<{
    id: string
    email: string
    access_token: string
  }>(
    `
      SELECT id, email, access_token
      FROM team_accounts
      WHERE access_token IS NOT NULL
        AND BTRIM(access_token) <> ''
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      ORDER BY random()
      LIMIT 1
    `,
  )

  if (!res.rows[0]) return null
  return {
    id: res.rows[0].id,
    email: res.rows[0].email,
    accessToken: res.rows[0].access_token,
  }
}
