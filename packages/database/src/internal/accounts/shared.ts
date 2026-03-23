import type { OpenAIAccountRecord, TeamAccountRecord } from "../types.ts"

export function mapOpenAIAccountRow(row: {
  id: string
  user_id: string | null
  portal_user_id: string | null
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
}): OpenAIAccountRecord {
  const rawStatus = (row.status ?? "").trim().toLowerCase()
  const isCoolingDown = Boolean(
    row.cooldown_until && row.cooldown_until.getTime() > Date.now(),
  )
  const normalizedStatus =
    rawStatus === "disabled"
      ? "disabled"
      : isCoolingDown
        ? "Cooling down"
        : "Active"

  return {
    id: row.id,
    userId: row.user_id,
    portalUserId: row.portal_user_id,
    name: row.name,
    email: row.email,
    picture: row.picture,
    accountId: row.account_id,
    accountUserRole: row.account_user_role,
    workspaceName: row.workspace_name,
    planType: row.plan_type,
    teamExpiresAt: row.team_expires_at?.toISOString() ?? null,
    workspaceIsDeactivated: row.workspace_is_deactivated,
    workspaceCancelledAt: row.workspace_cancelled_at?.toISOString() ?? null,
    status: normalizedStatus,
    isShared: row.is_shared,
    systemCreated: row.system_created,
    proxyId: row.proxy_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    sessionToken: row.session_token,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    cooldownUntil: row.cooldown_until?.toISOString() ?? null,
    rateLimit: row.rate_limit ?? null,
  }
}

export function mapTeamAccountRow(row: {
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
  workspace_is_deactivated: boolean
  workspace_cancelled_at: Date | null
  system_created: boolean
  proxy_id: string | null
  access_token: string | null
  refresh_token: string | null
  type: string | null
  created_at: Date
  updated_at: Date
  cooldown_until: Date | null
  rate_limit: Record<string, unknown> | null
}): TeamAccountRecord {
  return {
    id: row.id,
    userId: row.user_id,
    portalUserId: row.portal_user_id,
    ownerId: row.owner_id,
    name: row.name,
    email: row.email,
    accountId: row.account_id,
    accountUserRole: row.account_user_role,
    workspaceName: row.workspace_name,
    planType: row.plan_type,
    teamMemberCount:
      typeof row.team_member_count === "number"
        ? row.team_member_count
        : row.team_member_count ?? null,
    teamExpiresAt: row.team_expires_at?.toISOString() ?? null,
    workspaceIsDeactivated: row.workspace_is_deactivated,
    workspaceCancelledAt: row.workspace_cancelled_at?.toISOString() ?? null,
    systemCreated: row.system_created,
    proxyId: row.proxy_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    cooldownUntil: row.cooldown_until?.toISOString() ?? null,
    rateLimit: row.rate_limit ?? null,
  }
}
