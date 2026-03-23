import { query, withTransaction } from "../../core/db.ts"
import type { UpsertOpenAIAccountInput, UpsertTeamAccountInput } from "../types.ts"
import { mapOpenAIAccountRow, mapTeamAccountRow } from "./shared.ts"
import { grantPortalUserAddonsForAccountSubmission } from "../orders/addons.ts"

export async function upsertOpenAIAccount(input: UpsertOpenAIAccountInput) {
  return withTransaction(async (client) => {
    const res = await client.query<{
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
      team_member_count: number | null
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
      INSERT INTO team_accounts (
        user_id,
        portal_user_id,
        owner_id,
        name,
        email,
        picture,
        account_id,
        account_user_role,
        workspace_name,
        plan_type,
        team_member_count,
        team_expires_at,
        workspace_is_deactivated,
        workspace_cancelled_at,
        status,
        is_shared,
        system_created,
        proxy_id,
        access_token,
        refresh_token,
        session_token,
        password,
        type,
        cooldown_until,
        rate_limit
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )
      ON CONFLICT (email)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        portal_user_id = EXCLUDED.portal_user_id,
        name = EXCLUDED.name,
        picture = EXCLUDED.picture,
        account_id = EXCLUDED.account_id,
        account_user_role = EXCLUDED.account_user_role,
        workspace_name = EXCLUDED.workspace_name,
        plan_type = EXCLUDED.plan_type,
        team_member_count = EXCLUDED.team_member_count,
        team_expires_at = EXCLUDED.team_expires_at,
        workspace_is_deactivated = EXCLUDED.workspace_is_deactivated,
        workspace_cancelled_at = EXCLUDED.workspace_cancelled_at,
        status = EXCLUDED.status,
        is_shared = EXCLUDED.is_shared,
        system_created = EXCLUDED.system_created,
        proxy_id = EXCLUDED.proxy_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        session_token = EXCLUDED.session_token,
        password = EXCLUDED.password,
        type = EXCLUDED.type,
        cooldown_until = EXCLUDED.cooldown_until,
        rate_limit = EXCLUDED.rate_limit
      RETURNING
        id, user_id, portal_user_id, owner_id, name, email, picture, account_id, account_user_role,
        workspace_name, plan_type, team_member_count, team_expires_at, workspace_is_deactivated, workspace_cancelled_at,
        status, is_shared, system_created, proxy_id, access_token, refresh_token, session_token,
        type, created_at, updated_at, cooldown_until, rate_limit
    `,
      [
        input.userId ?? null,
        input.portalUserId ?? null,
        null,
        input.name ?? null,
        input.email,
        input.picture ?? null,
        input.accountId ?? null,
        input.accountUserRole ?? null,
        input.workspaceName ?? null,
        input.planType ?? null,
        input.teamMemberCount ?? null,
        input.teamExpiresAt ?? null,
        input.workspaceIsDeactivated ?? false,
        input.workspaceCancelledAt ?? null,
        input.status ?? null,
        input.isShared ?? false,
        input.systemCreated ?? false,
        input.proxyId ?? null,
        input.accessToken ?? null,
        input.refreshToken ?? null,
        input.sessionToken ?? null,
        input.password ?? null,
        input.type ?? "openai",
        input.cooldownUntil ?? null,
        input.rateLimit ?? null,
      ],
    )

    if (!res.rows[0]) {
      throw new Error("Failed to upsert openai account")
    }
    const addonUserId =
      typeof res.rows[0].portal_user_id === "string" && res.rows[0].portal_user_id.trim()
        ? res.rows[0].portal_user_id.trim()
        : input.portalUserId?.trim() ?? ""
    if (addonUserId) {
      await grantPortalUserAddonsForAccountSubmission({
        userId: addonUserId,
        accountKind: "openai",
        accountEmail: input.email,
        sourceAccountId: res.rows[0].id,
        client,
      })
    }

    return mapOpenAIAccountRow(res.rows[0])
  })
}

export async function upsertTeamAccount(input: UpsertTeamAccountInput) {
  return withTransaction(async (client) => {
    const res = await client.query<{
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
      status: string | null
      system_created: boolean
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
      INSERT INTO team_accounts (
        user_id,
        portal_user_id,
        owner_id,
        name,
        email,
        account_id,
        account_user_role,
        workspace_name,
        plan_type,
        team_member_count,
        team_expires_at,
        workspace_is_deactivated,
        workspace_cancelled_at,
        status,
        system_created,
        proxy_id,
        access_token,
        refresh_token,
        password,
        type,
        cooldown_until,
        rate_limit
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )
      ON CONFLICT (email)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        portal_user_id = EXCLUDED.portal_user_id,
        owner_id = EXCLUDED.owner_id,
        name = EXCLUDED.name,
        account_id = EXCLUDED.account_id,
        account_user_role = EXCLUDED.account_user_role,
        workspace_name = EXCLUDED.workspace_name,
        plan_type = EXCLUDED.plan_type,
        team_member_count = EXCLUDED.team_member_count,
        team_expires_at = EXCLUDED.team_expires_at,
        workspace_is_deactivated = EXCLUDED.workspace_is_deactivated,
        workspace_cancelled_at = EXCLUDED.workspace_cancelled_at,
        status = EXCLUDED.status,
        system_created = EXCLUDED.system_created,
        proxy_id = EXCLUDED.proxy_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        password = EXCLUDED.password,
        type = EXCLUDED.type,
        cooldown_until = EXCLUDED.cooldown_until,
        rate_limit = EXCLUDED.rate_limit
      RETURNING
        id, user_id, portal_user_id, owner_id, name, email, account_id, account_user_role,
        workspace_name, plan_type, team_member_count, team_expires_at,
        workspace_is_deactivated, workspace_cancelled_at, status, system_created, proxy_id,
        access_token, refresh_token, type, created_at, updated_at,
        cooldown_until, rate_limit
    `,
      [
        input.userId ?? null,
        input.portalUserId ?? null,
        input.ownerId ?? null,
        input.name ?? null,
        input.email,
        input.accountId ?? null,
        input.accountUserRole ?? null,
        input.workspaceName ?? null,
        input.planType ?? null,
        input.teamMemberCount ?? null,
        input.teamExpiresAt ?? null,
        input.workspaceIsDeactivated ?? false,
        input.workspaceCancelledAt ?? null,
        input.status ?? null,
        input.systemCreated ?? false,
        input.proxyId ?? null,
        input.accessToken ?? null,
        input.refreshToken ?? null,
        input.password ?? null,
        input.type ?? null,
        input.cooldownUntil ?? null,
        input.rateLimit ?? null,
      ],
    )

    if (!res.rows[0]) {
      throw new Error("Failed to upsert team account")
    }

    const addonUserId =
      typeof res.rows[0].portal_user_id === "string" && res.rows[0].portal_user_id.trim()
        ? res.rows[0].portal_user_id.trim()
        : input.portalUserId?.trim() ?? ""
    if (addonUserId) {
      await grantPortalUserAddonsForAccountSubmission({
        userId: addonUserId,
        accountKind:
          input.accountUserRole === "account-owner" ? "team-owner" : "team-member",
        accountEmail: input.email,
        sourceAccountId: res.rows[0].id,
        sourceAccountExpiresAt: res.rows[0].team_expires_at,
        client,
      })
    }

    return mapTeamAccountRow(res.rows[0])
  })
}

export async function upsertTeamMemberAccount(input: UpsertTeamAccountInput) {
  return upsertTeamAccount({
    ...input,
    accountUserRole: "standard-user",
  })
}

export async function upsertTeamOwnerAccount(input: UpsertTeamAccountInput) {
  return upsertTeamAccount({
    ...input,
    accountUserRole: "account-owner",
  })
}

export async function updateTeamOwnerAccountSubscriptionState(input: {
  email: string
  userId?: string | null
  portalUserId?: string | null
  name?: string | null
  accountId?: string | null
  workspaceName?: string | null
  teamMemberCount?: number | null
  planType?: string | null
  teamExpiresAt?: string | Date | null
  workspaceIsDeactivated?: boolean
  workspaceCancelledAt?: string | Date | null
  accessToken?: string | null
  refreshToken?: string | null
}) {
  const normalizedEmail = input.email.trim()
  if (!normalizedEmail) throw new Error("email is required")

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
  }>(
    `
      UPDATE team_accounts
      SET
        user_id = COALESCE($1, user_id),
        portal_user_id = COALESCE($2::uuid, portal_user_id),
        name = COALESCE($3, name),
        account_id = COALESCE($4, account_id),
        workspace_name = COALESCE($5, workspace_name),
        team_member_count = COALESCE($6, team_member_count),
        plan_type = COALESCE($7, plan_type),
        team_expires_at = COALESCE($8, team_expires_at),
        workspace_is_deactivated = COALESCE($9, workspace_is_deactivated),
        workspace_cancelled_at = COALESCE($10, workspace_cancelled_at),
        access_token = COALESCE($11, access_token),
        refresh_token = COALESCE($12, refresh_token)
      WHERE email = $13
        AND account_user_role = 'account-owner'
      RETURNING
        id, user_id, portal_user_id, owner_id, name, email, account_id, account_user_role,
        workspace_name, plan_type, team_member_count, team_expires_at,
        workspace_is_deactivated, workspace_cancelled_at, system_created, proxy_id,
        access_token, refresh_token, type, created_at, updated_at,
        cooldown_until, rate_limit
    `,
    [
      input.userId ?? null,
      input.portalUserId ?? null,
      input.name ?? null,
      input.accountId ?? null,
      input.workspaceName ?? null,
      input.teamMemberCount ?? null,
      input.planType ?? null,
      input.teamExpiresAt ?? null,
      typeof input.workspaceIsDeactivated === "boolean"
        ? input.workspaceIsDeactivated
        : null,
      input.workspaceCancelledAt ?? null,
      input.accessToken ?? null,
      input.refreshToken ?? null,
      normalizedEmail,
    ],
  )

  if (!res.rows[0]) {
    throw new Error("Team owner account not found")
  }

  return mapTeamAccountRow(res.rows[0])
}
