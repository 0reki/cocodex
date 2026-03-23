import type { PoolClient } from "pg"
import { query, withTransaction } from "../../core/db.ts"
import { getSystemSettings } from "../system.ts"
import type {
  PortalUserAddonAllowanceRecord,
  PortalUserAddonItemRecord,
} from "../types.ts"

function normalizeQuota(value: unknown): number {
  const amount =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(amount)) return 0
  return Math.max(0, amount)
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function getCurrentPeriodKeys(now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const weekDate = new Date(now)
  weekDate.setHours(0, 0, 0, 0)
  weekDate.setDate(weekDate.getDate() - ((weekDate.getDay() + 6) % 7))
  const week = weekDate.toISOString().slice(0, 10)
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  return { day, week, month }
}

export function computeAddonRemaining(input: {
  dailyQuota: number
  dailyUsed: number
  weeklyCap: number
  weeklyUsed: number
  monthlyCap: number
  monthlyUsed: number
}) {
  const dailyRemaining = Math.max(0, input.dailyQuota - input.dailyUsed)
  const weeklyRemaining = Math.max(0, input.weeklyCap - input.weeklyUsed)
  const monthlyRemaining = Math.max(0, input.monthlyCap - input.monthlyUsed)
  return Math.max(0, Math.min(dailyRemaining, weeklyRemaining, monthlyRemaining))
}

async function syncPortalUserAddonStatuses(
  userId: string,
  client?: PoolClient,
) {
  const executor = client ?? getDbExecutor()
  await executor.query(
    `
      UPDATE portal_user_addons addons
      SET
        status = CASE
          WHEN accounts.id IS NULL THEN 'suspend'
          WHEN accounts.workspace_is_deactivated = true THEN 'suspend'
          WHEN addons.expires_at IS NOT NULL AND addons.expires_at <= now() THEN 'expired'
          ELSE addons.status
        END,
        disable_reason = CASE
          WHEN accounts.id IS NULL THEN COALESCE(addons.disable_reason, 'account_removed')
          WHEN accounts.workspace_is_deactivated = true THEN COALESCE(addons.disable_reason, 'account_unauthorized')
          WHEN addons.expires_at IS NOT NULL AND addons.expires_at <= now() THEN 'account_expired'
          ELSE addons.disable_reason
        END,
        source_account_plan_expires_at = accounts.team_expires_at,
        last_validated_at = now()
      FROM team_accounts accounts
      WHERE addons.user_id = $1::uuid
        AND addons.source_account_id = accounts.id
        AND addons.status = 'active'
    `,
    [userId],
  )

  await executor.query(
    `
      UPDATE portal_user_addons
      SET
        status = 'suspend',
        disable_reason = COALESCE(disable_reason, 'account_removed'),
        last_validated_at = now()
      WHERE user_id = $1::uuid
        AND status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM team_accounts accounts
          WHERE accounts.id = portal_user_addons.source_account_id
        )
    `,
    [userId],
  )
}

function getDbExecutor() {
  return {
    query,
  }
}

export async function getPortalUserAddonAllowance(
  userId: string,
): Promise<PortalUserAddonAllowanceRecord> {
  const normalizedUserId = userId.trim()
  const now = new Date().toISOString()
  if (!normalizedUserId) {
    return {
      userId: "",
      submittedAccounts: 0,
      dailyQuota: 0,
      dailyUsed: 0,
      weeklyCap: 0,
      weeklyUsed: 0,
      monthlyCap: 0,
      monthlyUsed: 0,
      dailyRemaining: 0,
      weeklyRemaining: 0,
      monthlyRemaining: 0,
      createdAt: now,
      updatedAt: now,
    }
  }

  await syncPortalUserAddonStatuses(normalizedUserId)
  const periods = getCurrentPeriodKeys()
  const res = await query<{
    user_id: string
    submitted_accounts: string
    daily_quota: string
    daily_used: string
    weekly_cap: string
    weekly_used: string
    monthly_cap: string
    monthly_used: string
    created_at: Date
    updated_at: Date
  }>(
    `
      WITH active_addons AS (
        SELECT *
        FROM portal_user_addons
        WHERE user_id = $1::uuid
          AND status = 'active'
          AND effective_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
      ),
      usage_agg AS (
        SELECT
          SUM(CASE WHEN period_type = 'day' AND period_key = $2 THEN used_amount ELSE 0 END)::text AS daily_used,
          SUM(CASE WHEN period_type = 'week' AND period_key = $3 THEN used_amount ELSE 0 END)::text AS weekly_used,
          SUM(CASE WHEN period_type = 'month' AND period_key = $4 THEN used_amount ELSE 0 END)::text AS monthly_used
        FROM portal_user_addon_usage
        WHERE user_id = $1::uuid
      )
      SELECT
        $1::text AS user_id,
        COUNT(*)::text AS submitted_accounts,
        COALESCE(SUM(active_addons.daily_quota), 0)::text AS daily_quota,
        COALESCE((SELECT daily_used FROM usage_agg), '0') AS daily_used,
        COALESCE(SUM(active_addons.weekly_cap), 0)::text AS weekly_cap,
        COALESCE((SELECT weekly_used FROM usage_agg), '0') AS weekly_used,
        COALESCE(SUM(active_addons.monthly_cap), 0)::text AS monthly_cap,
        COALESCE((SELECT monthly_used FROM usage_agg), '0') AS monthly_used,
        COALESCE(MIN(active_addons.created_at), now()) AS created_at,
        COALESCE(MAX(active_addons.updated_at), now()) AS updated_at
      FROM active_addons
    `,
    [normalizedUserId, periods.day, periods.week, periods.month],
  )

  const row = res.rows[0]
  const dailyQuota = Number(row?.daily_quota ?? "0")
  const dailyUsed = Number(row?.daily_used ?? "0")
  const weeklyCap = Number(row?.weekly_cap ?? "0")
  const weeklyUsed = Number(row?.weekly_used ?? "0")
  const monthlyCap = Number(row?.monthly_cap ?? "0")
  const monthlyUsed = Number(row?.monthly_used ?? "0")

  return {
    userId: normalizedUserId,
    submittedAccounts: Number(row?.submitted_accounts ?? "0"),
    dailyQuota,
    dailyUsed,
    weeklyCap,
    weeklyUsed,
    monthlyCap,
    monthlyUsed,
    dailyRemaining: Math.max(0, dailyQuota - dailyUsed),
    weeklyRemaining: Math.max(0, weeklyCap - weeklyUsed),
    monthlyRemaining: Math.max(0, monthlyCap - monthlyUsed),
    createdAt: row?.created_at?.toISOString() ?? now,
    updatedAt: row?.updated_at?.toISOString() ?? now,
  }
}

export async function listPortalUserAddonItems(
  userId: string,
): Promise<PortalUserAddonItemRecord[]> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return []

  await syncPortalUserAddonStatuses(normalizedUserId)
  const periods = getCurrentPeriodKeys()
  const res = await query<{
    id: string
    source_account_id: string
    source_account_email: string
    source_account_type: string
    status: string
    disable_reason: string | null
    granted_at: Date
    effective_at: Date
    expires_at: Date | null
    source_account_plan_expires_at: Date | null
    last_validated_at: Date | null
    daily_quota: string
    daily_used: string
    weekly_cap: string
    weekly_used: string
    monthly_cap: string
    monthly_used: string
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        addons.id,
        addons.source_account_id,
        addons.source_account_email,
        addons.source_account_type,
        addons.status,
        addons.disable_reason,
        addons.granted_at,
        addons.effective_at,
        addons.expires_at,
        addons.source_account_plan_expires_at,
        addons.last_validated_at,
        addons.daily_quota::text AS daily_quota,
        COALESCE(SUM(CASE WHEN usage.period_type = 'day' AND usage.period_key = $2 THEN usage.used_amount ELSE 0 END), 0)::text AS daily_used,
        addons.weekly_cap::text AS weekly_cap,
        COALESCE(SUM(CASE WHEN usage.period_type = 'week' AND usage.period_key = $3 THEN usage.used_amount ELSE 0 END), 0)::text AS weekly_used,
        addons.monthly_cap::text AS monthly_cap,
        COALESCE(SUM(CASE WHEN usage.period_type = 'month' AND usage.period_key = $4 THEN usage.used_amount ELSE 0 END), 0)::text AS monthly_used,
        addons.created_at,
        addons.updated_at
      FROM portal_user_addons addons
      LEFT JOIN portal_user_addon_usage usage
        ON usage.addon_id = addons.id
      WHERE addons.user_id = $1::uuid
      GROUP BY
        addons.id,
        addons.source_account_id,
        addons.source_account_email,
        addons.source_account_type,
        addons.status,
        addons.disable_reason,
        addons.granted_at,
        addons.effective_at,
        addons.expires_at,
        addons.source_account_plan_expires_at,
        addons.last_validated_at,
        addons.daily_quota,
        addons.weekly_cap,
        addons.monthly_cap,
        addons.created_at,
        addons.updated_at
      ORDER BY addons.granted_at DESC, addons.created_at DESC, addons.id DESC
    `,
    [normalizedUserId, periods.day, periods.week, periods.month],
  )

  return res.rows.map((row) => {
    const dailyQuota = Number(row.daily_quota ?? "0")
    const dailyUsed = Number(row.daily_used ?? "0")
    const weeklyCap = Number(row.weekly_cap ?? "0")
    const weeklyUsed = Number(row.weekly_used ?? "0")
    const monthlyCap = Number(row.monthly_cap ?? "0")
    const monthlyUsed = Number(row.monthly_used ?? "0")
    return {
      id: row.id,
      sourceAccountId: row.source_account_id,
      sourceAccountEmail: row.source_account_email,
      sourceAccountType: row.source_account_type,
      status: row.status,
      disableReason: row.disable_reason,
      grantedAt: row.granted_at.toISOString(),
      effectiveAt: row.effective_at.toISOString(),
      expiresAt: row.expires_at?.toISOString() ?? null,
      sourceAccountPlanExpiresAt: row.source_account_plan_expires_at?.toISOString() ?? null,
      lastValidatedAt: row.last_validated_at?.toISOString() ?? null,
      dailyQuota,
      dailyUsed,
      dailyRemaining: Math.max(0, dailyQuota - dailyUsed),
      weeklyCap,
      weeklyUsed,
      weeklyRemaining: Math.max(0, weeklyCap - weeklyUsed),
      monthlyCap,
      monthlyUsed,
      monthlyRemaining: Math.max(0, monthlyCap - monthlyUsed),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }
  })
}

export async function consumePortalUserAddonQuota(
  userId: string,
  amount: number,
): Promise<void> {
  const normalizedUserId = userId.trim()
  const safeAmount = Number.isFinite(amount) ? amount : NaN
  if (!normalizedUserId || !Number.isFinite(safeAmount) || safeAmount <= 0) return

  await withTransaction(async (client) => {
    await syncPortalUserAddonStatuses(normalizedUserId, client)
    const periods = getCurrentPeriodKeys()
    const addonsRes = await client.query<{
      id: string
      daily_quota: string
      weekly_cap: string
      monthly_cap: string
      expires_at: Date | null
      granted_at: Date
    }>(
      `
        SELECT id, daily_quota, weekly_cap, monthly_cap, expires_at, granted_at
        FROM portal_user_addons
        WHERE user_id = $1::uuid
          AND status = 'active'
          AND effective_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY expires_at ASC NULLS LAST, granted_at ASC, id ASC
      `,
      [normalizedUserId],
    )

    let remaining = safeAmount
    for (const addon of addonsRes.rows) {
      if (remaining <= 0) break

      const usageRes = await client.query<{
        daily_used: string
        weekly_used: string
        monthly_used: string
      }>(
        `
          SELECT
            COALESCE(SUM(CASE WHEN period_type = 'day' AND period_key = $2 THEN used_amount ELSE 0 END), 0)::text AS daily_used,
            COALESCE(SUM(CASE WHEN period_type = 'week' AND period_key = $3 THEN used_amount ELSE 0 END), 0)::text AS weekly_used,
            COALESCE(SUM(CASE WHEN period_type = 'month' AND period_key = $4 THEN used_amount ELSE 0 END), 0)::text AS monthly_used
          FROM portal_user_addon_usage
          WHERE addon_id = $1::uuid
        `,
        [addon.id, periods.day, periods.week, periods.month],
      )

      const dailyRemaining = Math.max(
        0,
        Number(addon.daily_quota ?? "0") - Number(usageRes.rows[0]?.daily_used ?? "0"),
      )
      const weeklyRemaining = Math.max(
        0,
        Number(addon.weekly_cap ?? "0") - Number(usageRes.rows[0]?.weekly_used ?? "0"),
      )
      const monthlyRemaining = Math.max(
        0,
        Number(addon.monthly_cap ?? "0") - Number(usageRes.rows[0]?.monthly_used ?? "0"),
      )
      const allocatable = Math.max(
        0,
        Math.min(remaining, dailyRemaining, weeklyRemaining, monthlyRemaining),
      )
      if (allocatable <= 0) continue

      await client.query(
        `
          INSERT INTO portal_user_addon_usage (
            addon_id,
            user_id,
            period_type,
            period_key,
            used_amount,
            last_used_at
          )
          VALUES
            ($1::uuid, $2::uuid, 'day', $3, $6::numeric, now()),
            ($1::uuid, $2::uuid, 'week', $4, $6::numeric, now()),
            ($1::uuid, $2::uuid, 'month', $5, $6::numeric, now())
          ON CONFLICT (addon_id, period_type, period_key)
          DO UPDATE SET
            used_amount = portal_user_addon_usage.used_amount + EXCLUDED.used_amount,
            last_used_at = now()
        `,
        [addon.id, normalizedUserId, periods.day, periods.week, periods.month, allocatable],
      )

      remaining -= allocatable
    }
  })
}

export async function grantPortalUserAddonsForAccountSubmission(input: {
  userId: string | null | undefined
  accountKind: "openai" | "team-owner" | "team-member"
  accountEmail: string
  sourceAccountId?: string | null
  sourceAccountExpiresAt?: string | Date | null
  client?: PoolClient
}) {
  const userId = input.userId?.trim() ?? ""
  const accountEmail = normalizeEmail(input.accountEmail)
  const sourceAccountId = input.sourceAccountId?.trim() ?? ""
  if (!userId || !accountEmail || !sourceAccountId) {
    return { granted: false as const, reason: "invalid_input" as const }
  }

  const settings = await getSystemSettings()
  const dailyQuota = normalizeQuota(settings?.accountSubmissionAddonDailyQuota)
  const weeklyCap = normalizeQuota(settings?.accountSubmissionAddonWeeklyCap)
  const monthlyCap = normalizeQuota(settings?.accountSubmissionAddonMonthlyCap)
  if (dailyQuota <= 0 && weeklyCap <= 0 && monthlyCap <= 0) {
    return { granted: false as const, reason: "disabled" as const }
  }

  const executeGrant = async (client: PoolClient) => {
    const addonRes = await client.query<{ id: string }>(
      `
        INSERT INTO portal_user_addons (
          user_id,
          source_account_id,
          source_account_email,
          source_account_type,
          status,
          granted_at,
          effective_at,
          expires_at,
          source_account_plan_expires_at,
          last_validated_at,
          daily_quota,
          weekly_cap,
          monthly_cap
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          CASE WHEN $5::timestamptz IS NOT NULL AND $5::timestamptz <= now() THEN 'expired' ELSE 'active' END,
          now(),
          now(),
          $5::timestamptz,
          $5::timestamptz,
          now(),
          $6::numeric,
          $7::numeric,
          $8::numeric
        )
        ON CONFLICT (source_account_id) DO NOTHING
        RETURNING id
      `,
      [
        userId,
        sourceAccountId,
        accountEmail,
        input.accountKind,
        input.sourceAccountExpiresAt ?? null,
        dailyQuota,
        weeklyCap,
        monthlyCap,
      ],
    )

    if (!addonRes.rows[0]) {
      return { granted: false as const, reason: "already_granted" as const }
    }

    return {
      granted: true as const,
      reward: {
        dailyQuota,
        weeklyCap,
        monthlyCap,
      },
    }
  }

  if (input.client) return executeGrant(input.client)
  return withTransaction(executeGrant)
}

export async function disablePortalUserAddonsBySourceAccountId(
  sourceAccountId: string,
  reason: "account_expired" | "account_unauthorized" | "account_removed" | "manual",
) {
  const normalizedAccountId = sourceAccountId.trim()
  if (!normalizedAccountId) return 0
  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE portal_user_addons
        SET
          status = 'suspend',
          disable_reason = $2,
          last_validated_at = now()
        WHERE source_account_id = $1::uuid
          AND status = 'active'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
    [normalizedAccountId, reason],
  )
  return Number(res.rows[0]?.count ?? "0")
}

export async function disablePortalUserAddonsBySourceAccountEmail(
  sourceAccountEmail: string,
  reason: "account_expired" | "account_unauthorized" | "account_removed" | "manual",
) {
  const normalizedEmail = normalizeEmail(sourceAccountEmail)
  if (!normalizedEmail) return 0
  const res = await query<{ count: string }>(
    `
      WITH updated AS (
        UPDATE portal_user_addons
        SET
          status = 'suspend',
          disable_reason = $2,
          last_validated_at = now()
        WHERE source_account_email = $1
          AND status = 'active'
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `,
    [normalizedEmail, reason],
  )
  return Number(res.rows[0]?.count ?? "0")
}
