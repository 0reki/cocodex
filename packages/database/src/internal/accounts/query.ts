import { query } from "../../core/db.ts"
import type {
  TeamAccountLoginRecord,
} from "../types.ts"
import { mapOpenAIAccountRow, mapTeamAccountRow } from "./shared.ts"

export async function listOpenAIAccountsPage(
  page = 1,
  pageSize = 50,
  filters?: {
    status?: string | null
    keyword?: string | null
  },
) {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(Math.floor(pageSize), 500))
  const offset = (safePage - 1) * safePageSize
  const normalizedStatus = filters?.status?.trim().toLowerCase() ?? ""
  const normalizedKeyword = filters?.keyword?.trim() ?? ""
  const whereClauses: string[] = []
  const whereValues: unknown[] = []

  if (normalizedStatus) {
    whereValues.push(normalizedStatus)
    whereClauses.push(
      `LOWER(TRIM(COALESCE(status, ''))) = $${whereValues.length}`,
    )
  }
  if (normalizedKeyword) {
    whereValues.push(`%${normalizedKeyword}%`)
    whereClauses.push(
      `(email ILIKE $${whereValues.length} OR COALESCE(name, '') ILIKE $${whereValues.length} OR COALESCE(workspace_name, '') ILIKE $${whereValues.length})`,
    )
  }
  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""

  const totalRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM team_accounts
      ${whereSql}${whereSql ? " AND" : " WHERE"} LOWER(TRIM(COALESCE(type, ''))) = $${whereValues.length + 1}
    `,
    [...whereValues, "openai"],
  )
  const total = Number(totalRes.rows[0]?.count ?? "0")

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
        id, user_id, portal_user_id, name, email, picture, account_id, account_user_role,
        workspace_name, plan_type, team_expires_at, workspace_is_deactivated, workspace_cancelled_at,
        status, is_shared, system_created, proxy_id, access_token, refresh_token, session_token,
        type, created_at, updated_at, cooldown_until, rate_limit
      FROM team_accounts
      ${whereSql}${whereSql ? " AND" : " WHERE"} LOWER(TRIM(COALESCE(type, ''))) = $${whereValues.length + 1}
      ORDER BY updated_at DESC
      LIMIT $${whereValues.length + 2}
      OFFSET $${whereValues.length + 3}
    `,
    [...whereValues, "openai", safePageSize, offset],
  )

  return {
    items: res.rows.map(mapOpenAIAccountRow),
    total,
    page: safePage,
    pageSize: safePageSize,
  }
}

export async function listOpenAIAccountsByUserId(userId: string) {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return []

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
        id, user_id, portal_user_id, name, email, picture, account_id, account_user_role,
        workspace_name, plan_type, team_expires_at, workspace_is_deactivated, workspace_cancelled_at,
        status, is_shared, system_created, proxy_id, access_token, refresh_token, session_token,
        type, created_at, updated_at, cooldown_until, rate_limit
      FROM team_accounts
      WHERE portal_user_id = $1::uuid
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      ORDER BY updated_at DESC
    `,
    [normalizedUserId],
  )

  return res.rows.map(mapOpenAIAccountRow)
}

async function listTeamAccountsPage(
  page = 1,
  pageSize = 50,
  filters?: {
    accountUserRole?: string | null
    keyword?: string | null
  },
) {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(Math.floor(pageSize), 500))
  const offset = (safePage - 1) * safePageSize
  const normalizedRole = filters?.accountUserRole?.trim() ?? ""
  const normalizedKeyword = filters?.keyword?.trim() ?? ""
  const whereClauses: string[] = []
  const whereValues: unknown[] = []

  if (normalizedRole) {
    whereValues.push(normalizedRole)
    whereClauses.push(`account_user_role = $${whereValues.length}`)
  }
  if (normalizedKeyword) {
    whereValues.push(`%${normalizedKeyword}%`)
    whereClauses.push(
      `(email ILIKE $${whereValues.length} OR COALESCE(name, '') ILIKE $${whereValues.length} OR COALESCE(workspace_name, '') ILIKE $${whereValues.length})`,
    )
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : ""

  const totalRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM team_accounts
      ${whereSql}
    `,
    whereValues,
  )
  const total = Number(totalRes.rows[0]?.count ?? "0")

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
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT $${whereValues.length + 1}
      OFFSET $${whereValues.length + 2}
    `,
    [...whereValues, safePageSize, offset],
  )

  return {
    items: res.rows.map(mapTeamAccountRow),
    total,
    page: safePage,
    pageSize: safePageSize,
  }
}

export async function listTeamAccountsByUserId(userId: string) {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return []

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
      WHERE portal_user_id = $1::uuid
        AND LOWER(TRIM(COALESCE(type, ''))) <> 'openai'
      ORDER BY updated_at DESC
    `,
    [normalizedUserId],
  )

  return res.rows.map(mapTeamAccountRow)
}

export async function listTeamMemberAccountsPage(
  page = 1,
  pageSize = 50,
  filters?: {
    keyword?: string | null
  },
) {
  return listTeamAccountsPage(page, pageSize, {
    ...filters,
    accountUserRole: "standard-user",
  })
}

export async function listTeamOwnerAccountsPage(
  page = 1,
  pageSize = 50,
  filters?: {
    keyword?: string | null
  },
) {
  return listTeamAccountsPage(page, pageSize, {
    ...filters,
    accountUserRole: "account-owner",
  })
}


export async function getOpenAIAccountByEmail(email: string) {
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
        id, user_id, portal_user_id, name, email, picture, account_id, account_user_role,
        workspace_name, plan_type, team_expires_at, workspace_is_deactivated, workspace_cancelled_at,
        status, is_shared, system_created, proxy_id, access_token, refresh_token, session_token,
        type, created_at, updated_at, cooldown_until, rate_limit
      FROM team_accounts
      WHERE email = $1
        AND LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      LIMIT 1
    `,
    [email],
  )

  return res.rows[0] ? mapOpenAIAccountRow(res.rows[0]) : null
}

async function getTeamAccountByEmail(email: string, accountUserRole?: string | null) {
  const normalizedRole = accountUserRole?.trim() ?? ""
  const whereSql = normalizedRole
    ? "WHERE email = $1 AND account_user_role = $2"
    : "WHERE email = $1"
  const values = normalizedRole ? [email, normalizedRole] : [email]
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
      ${whereSql}
      LIMIT 1
    `,
    values,
  )

  return res.rows[0] ? mapTeamAccountRow(res.rows[0]) : null
}

export async function getTeamMemberAccountByEmail(email: string) {
  return getTeamAccountByEmail(email, "standard-user")
}

export async function getTeamOwnerAccountByEmail(email: string) {
  return getTeamAccountByEmail(email, "account-owner")
}

export async function getTeamAccountLoginByEmail(email: string) {
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
    password: string | null
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
        access_token, refresh_token, password, type, created_at, updated_at,
        cooldown_until, rate_limit
      FROM team_accounts
      WHERE email = $1
      LIMIT 1
    `,
    [email],
  )

  const row = res.rows[0]
  if (!row) return null
  return {
    ...mapTeamAccountRow(row),
    password: row.password,
  } satisfies TeamAccountLoginRecord
}
