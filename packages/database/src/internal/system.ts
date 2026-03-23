import { query } from "../core/db.ts"
import type {
  SystemSettingsRecord,
  UpsertSystemSettingsInput,
} from "./types.ts"

function mapSystemSettingsRow(row: {
  openai_api_user_agent: string | null
  openai_client_version: string | null
  inbox_translation_model?: string | null
  cloud_mail_domains: string[] | null
  owner_mail_domains: string[] | null
  account_submission_addon_daily_quota: number | string | null
  account_submission_addon_weekly_cap: number | string | null
  account_submission_addon_monthly_cap: number | string | null
  account_cache_size: number | null
  account_cache_refresh_seconds: number | null
  max_attempt_count: number | null
  user_rpm_limit: number | null
  user_max_in_flight: number | null
  check_in_reward_min: number | string | null
  check_in_reward_max: number | string | null
  openai_models: Array<Record<string, unknown>> | null
  openai_models_updated_at: Date | null
  created_at: Date
  updated_at: Date
}): SystemSettingsRecord {
  const parseNumber = (value: number | string | null | undefined) => {
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    openaiApiUserAgent: row.openai_api_user_agent,
    openaiClientVersion: row.openai_client_version,
    inboxTranslationModel: row.inbox_translation_model?.trim() || null,
    cloudMailDomains: Array.isArray(row.cloud_mail_domains)
      ? row.cloud_mail_domains.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : null,
    ownerMailDomains: Array.isArray(row.owner_mail_domains)
      ? row.owner_mail_domains.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : null,
    accountSubmissionAddonDailyQuota: parseNumber(
      row.account_submission_addon_daily_quota,
    ),
    accountSubmissionAddonWeeklyCap: parseNumber(
      row.account_submission_addon_weekly_cap,
    ),
    accountSubmissionAddonMonthlyCap: parseNumber(
      row.account_submission_addon_monthly_cap,
    ),
    accountCacheSize: row.account_cache_size,
    accountCacheRefreshSeconds: row.account_cache_refresh_seconds,
    maxAttemptCount: row.max_attempt_count,
    userRpmLimit: row.user_rpm_limit,
    userMaxInFlight: row.user_max_in_flight,
    checkInRewardMin: parseNumber(row.check_in_reward_min),
    checkInRewardMax: parseNumber(row.check_in_reward_max),
    openaiModels: row.openai_models,
    openaiModelsUpdatedAt: row.openai_models_updated_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

type SystemSettingsRow = {
  openai_api_user_agent: string | null
  openai_client_version: string | null
  inbox_translation_model: string | null
  cloud_mail_domains: string[] | null
  owner_mail_domains: string[] | null
  account_submission_addon_daily_quota: number | string | null
  account_submission_addon_weekly_cap: number | string | null
  account_submission_addon_monthly_cap: number | string | null
  account_cache_size: number | null
  account_cache_refresh_seconds: number | null
  max_attempt_count: number | null
  user_rpm_limit: number | null
  user_max_in_flight: number | null
  check_in_reward_min: number | string | null
  check_in_reward_max: number | string | null
  openai_models: Array<Record<string, unknown>> | null
  openai_models_updated_at: Date | null
  created_at: Date
  updated_at: Date
}

export async function getSystemSettings(): Promise<SystemSettingsRecord | null> {
  const res = await query<SystemSettingsRow>(
    `
      SELECT
        openai_api_user_agent,
        openai_client_version,
        inbox_translation_model,
        cloud_mail_domains,
        owner_mail_domains,
        account_submission_addon_daily_quota,
        account_submission_addon_weekly_cap,
        account_submission_addon_monthly_cap,
        account_cache_size,
        account_cache_refresh_seconds,
        max_attempt_count,
        user_rpm_limit,
        user_max_in_flight,
        check_in_reward_min,
        check_in_reward_max,
        openai_models,
        openai_models_updated_at,
        created_at,
        updated_at
      FROM system_settings
      WHERE id = 1
      LIMIT 1
    `,
  )

  return res.rows[0] ? mapSystemSettingsRow(res.rows[0]) : null
}

export async function upsertSystemSettings(input: UpsertSystemSettingsInput) {
  const res = await query<SystemSettingsRow>(
    `
      INSERT INTO system_settings (
        id,
        openai_api_user_agent,
        openai_client_version,
        inbox_translation_model,
        cloud_mail_domains,
        owner_mail_domains,
        account_submission_addon_daily_quota,
        account_submission_addon_weekly_cap,
        account_submission_addon_monthly_cap,
        account_cache_size,
        account_cache_refresh_seconds,
        max_attempt_count,
        user_rpm_limit,
        user_max_in_flight,
        check_in_reward_min,
        check_in_reward_max
      )
      VALUES (
        1, $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15
      )
      ON CONFLICT (id)
      DO UPDATE SET
        openai_api_user_agent = EXCLUDED.openai_api_user_agent,
        openai_client_version = EXCLUDED.openai_client_version,
        inbox_translation_model = EXCLUDED.inbox_translation_model,
        cloud_mail_domains = EXCLUDED.cloud_mail_domains,
        owner_mail_domains = EXCLUDED.owner_mail_domains,
        account_submission_addon_daily_quota = EXCLUDED.account_submission_addon_daily_quota,
        account_submission_addon_weekly_cap = EXCLUDED.account_submission_addon_weekly_cap,
        account_submission_addon_monthly_cap = EXCLUDED.account_submission_addon_monthly_cap,
        account_cache_size = EXCLUDED.account_cache_size,
        account_cache_refresh_seconds = EXCLUDED.account_cache_refresh_seconds,
        max_attempt_count = EXCLUDED.max_attempt_count,
        user_rpm_limit = EXCLUDED.user_rpm_limit,
        user_max_in_flight = EXCLUDED.user_max_in_flight,
        check_in_reward_min = EXCLUDED.check_in_reward_min,
        check_in_reward_max = EXCLUDED.check_in_reward_max
      RETURNING
        openai_api_user_agent,
        openai_client_version,
        inbox_translation_model,
        cloud_mail_domains,
        owner_mail_domains,
        account_submission_addon_daily_quota,
        account_submission_addon_weekly_cap,
        account_submission_addon_monthly_cap,
        account_cache_size,
        account_cache_refresh_seconds,
        max_attempt_count,
        user_rpm_limit,
        user_max_in_flight,
        check_in_reward_min,
        check_in_reward_max,
        openai_models,
        openai_models_updated_at,
        created_at,
        updated_at
    `,
    [
      input.openaiApiUserAgent,
      input.openaiClientVersion,
      input.inboxTranslationModel ?? null,
      JSON.stringify(input.cloudMailDomains ?? []),
      JSON.stringify(input.ownerMailDomains ?? []),
      input.accountSubmissionAddonDailyQuota ?? null,
      input.accountSubmissionAddonWeeklyCap ?? null,
      input.accountSubmissionAddonMonthlyCap ?? null,
      input.accountCacheSize,
      input.accountCacheRefreshSeconds,
      input.maxAttemptCount,
      input.userRpmLimit,
      input.userMaxInFlight,
      input.checkInRewardMin,
      input.checkInRewardMax,
    ],
  )

  if (!res.rows[0]) {
    throw new Error("Failed to upsert system settings")
  }

  return mapSystemSettingsRow(res.rows[0])
}

export async function updateSystemSettingsOpenAIModels(
  models: Array<Record<string, unknown>>,
) {
  const res = await query<SystemSettingsRow>(
    `
      INSERT INTO system_settings (
        id,
        openai_api_user_agent,
        openai_client_version,
        openai_models,
        openai_models_updated_at
      )
      VALUES (1, null, null, $1::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET
        openai_models = EXCLUDED.openai_models,
        openai_models_updated_at = EXCLUDED.openai_models_updated_at
      RETURNING
        openai_api_user_agent,
        openai_client_version,
        inbox_translation_model,
        cloud_mail_domains,
        owner_mail_domains,
        account_submission_addon_daily_quota,
        account_submission_addon_weekly_cap,
        account_submission_addon_monthly_cap,
        account_cache_size,
        account_cache_refresh_seconds,
        max_attempt_count,
        user_rpm_limit,
        user_max_in_flight,
        check_in_reward_min,
        check_in_reward_max,
        openai_models,
        openai_models_updated_at,
        created_at,
        updated_at
    `,
    [JSON.stringify(models)],
  )

  if (!res.rows[0]) {
    throw new Error("Failed to update system settings openai models")
  }

  return mapSystemSettingsRow(res.rows[0])
}
