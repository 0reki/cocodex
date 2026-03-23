import { query } from "../core/db.ts"
import type {
  ApiKeyHourlyStatsSeries,
  ApiKeyModelUsage,
  ApiKeyUsageStats,
  ModelHourlyStatsSeries,
  ModelHourlyTokenSeries,
  OpenAIAccountStats,
  PortalUserAccountStats,
  PortalUserUsageStats,
} from "./types.ts"

export async function getOpenAIAccountStats(): Promise<OpenAIAccountStats> {
  const res = await query<{
    total: string
    active: string
    cooling_down: string
    disabled: string
    daily_request_count: string
    total_request_count: string
    daily_request_tokens: string
    total_tokens: string
    daily_request_cost: string
    total_cost: string
    rpm_5m: string
    tpm_5m: string
  }>(
    `
      WITH account_stats AS (
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (
            WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
              AND (cooldown_until IS NULL OR cooldown_until <= now())
          )::text AS active,
          COUNT(*) FILTER (
            WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
              AND cooldown_until IS NOT NULL
              AND cooldown_until > now()
          )::text AS cooling_down,
          COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status, ''))) = 'disabled')::text AS disabled
        FROM team_accounts
        WHERE LOWER(TRIM(COALESCE(type, ''))) = 'openai'
      ),
      log_totals AS (
        SELECT
          COUNT(*)::text AS total_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS total_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS total_cost
        FROM model_response_logs
      ),
      log_today AS (
        SELECT
          COUNT(*)::text AS daily_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS daily_request_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS daily_request_cost
        FROM model_response_logs
        WHERE request_time >= date_trunc('day', now())
      ),
      log_5m AS (
        SELECT
          ROUND((COUNT(*)::numeric / 5), 2)::text AS rpm_5m,
          ROUND((COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::numeric / 5), 2)::text AS tpm_5m
        FROM model_response_logs
        WHERE request_time >= (now() - interval '5 minutes')
      )
      SELECT
        account_stats.total,
        account_stats.active,
        account_stats.cooling_down,
        account_stats.disabled,
        log_today.daily_request_count,
        log_totals.total_request_count,
        log_today.daily_request_tokens,
        log_totals.total_tokens,
        log_today.daily_request_cost,
        log_totals.total_cost,
        log_5m.rpm_5m,
        log_5m.tpm_5m
      FROM account_stats
      CROSS JOIN log_totals
      CROSS JOIN log_today
      CROSS JOIN log_5m
    `,
  )
  return {
    total: Number(res.rows[0]?.total ?? "0"),
    active: Number(res.rows[0]?.active ?? "0"),
    coolingDown: Number(res.rows[0]?.cooling_down ?? "0"),
    disabled: Number(res.rows[0]?.disabled ?? "0"),
    dailyRequestCount: Number(res.rows[0]?.daily_request_count ?? "0"),
    totalRequestCount: Number(res.rows[0]?.total_request_count ?? "0"),
    dailyRequestTokens: Number(res.rows[0]?.daily_request_tokens ?? "0"),
    totalTokens: Number(res.rows[0]?.total_tokens ?? "0"),
    dailyRequestCost: Number(res.rows[0]?.daily_request_cost ?? "0"),
    totalCost: Number(res.rows[0]?.total_cost ?? "0"),
    rpm5m: Number(res.rows[0]?.rpm_5m ?? "0"),
    tpm5m: Number(res.rows[0]?.tpm_5m ?? "0"),
  }
}

export async function getPortalUserAccountStats(
  userId: string,
): Promise<PortalUserAccountStats> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) {
    return { total: 0, active: 0, coolingDown: 0, disabled: 0 }
  }

  const res = await query<{
    total: string
    active: string
    cooling_down: string
    disabled: string
  }>(
    `
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
            AND (cooldown_until IS NULL OR cooldown_until <= now())
        )::text AS active,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
            AND cooldown_until IS NOT NULL
            AND cooldown_until > now()
        )::text AS cooling_down,
        COUNT(*) FILTER (
          WHERE LOWER(TRIM(COALESCE(status, ''))) = 'disabled'
        )::text AS disabled
      FROM team_accounts
      WHERE LOWER(TRIM(COALESCE(type, ''))) = 'openai'
        AND portal_user_id = $1::uuid
    `,
    [normalizedUserId],
  )

  return {
    total: Number(res.rows[0]?.total ?? "0"),
    active: Number(res.rows[0]?.active ?? "0"),
    coolingDown: Number(res.rows[0]?.cooling_down ?? "0"),
    disabled: Number(res.rows[0]?.disabled ?? "0"),
  }
}

export async function getApiKeyUsageStats(
  keyId: string,
): Promise<ApiKeyUsageStats> {
  const res = await query<{
    daily_request_count: string
    total_request_count: string
    daily_request_tokens: string
    total_tokens: string
    daily_request_cost: string
    total_cost: string
    quota: string | null
    used: string
    remaining: string | null
    rpm_5m: string
    tpm_5m: string
  }>(
    `
      WITH log_totals AS (
        SELECT
          COUNT(*)::text AS total_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS total_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS total_cost
        FROM model_response_logs
        WHERE key_id = $1::uuid
      ),
      log_today AS (
        SELECT
          COUNT(*)::text AS daily_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS daily_request_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS daily_request_cost
        FROM model_response_logs
        WHERE key_id = $1::uuid
          AND request_time >= date_trunc('day', now())
      ),
      log_5m AS (
        SELECT
          ROUND((COUNT(*)::numeric / 5), 2)::text AS rpm_5m,
          ROUND((COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::numeric / 5), 2)::text AS tpm_5m
        FROM model_response_logs
        WHERE key_id = $1::uuid
          AND request_time >= now() - interval '5 minutes'
      )
      SELECT
        COALESCE(keys.quota, NULL)::text AS quota,
        COALESCE(keys.used, 0)::text AS used,
        CASE
          WHEN keys.quota IS NULL THEN NULL
          ELSE GREATEST(keys.quota - COALESCE(keys.used, 0), 0)::text
        END AS remaining,
        log_today.daily_request_count,
        log_totals.total_request_count,
        log_today.daily_request_tokens,
        log_totals.total_tokens,
        log_today.daily_request_cost,
        log_totals.total_cost,
        log_5m.rpm_5m,
        log_5m.tpm_5m
      FROM api_keys keys
      CROSS JOIN log_totals
      CROSS JOIN log_today
      CROSS JOIN log_5m
      WHERE keys.id = $1::uuid
    `,
    [keyId],
  )

  return {
    dailyRequestCount: Number(res.rows[0]?.daily_request_count ?? "0"),
    totalRequestCount: Number(res.rows[0]?.total_request_count ?? "0"),
    dailyRequestTokens: Number(res.rows[0]?.daily_request_tokens ?? "0"),
    totalTokens: Number(res.rows[0]?.total_tokens ?? "0"),
    dailyRequestCost: Number(res.rows[0]?.daily_request_cost ?? "0"),
    totalCost: Number(res.rows[0]?.total_cost ?? "0"),
    quota:
      res.rows[0]?.quota == null ? null : Number(res.rows[0]?.quota ?? "0"),
    used: Number(res.rows[0]?.used ?? "0"),
    remaining:
      res.rows[0]?.remaining == null
        ? null
        : Number(res.rows[0]?.remaining ?? "0"),
    rpm5m: Number(res.rows[0]?.rpm_5m ?? "0"),
    tpm5m: Number(res.rows[0]?.tpm_5m ?? "0"),
  }
}

export async function getPortalUserUsageStats(
  ownerUserId: string,
): Promise<PortalUserUsageStats> {
  const ownerId = ownerUserId.trim()
  if (!ownerId) {
    return {
      dailyRequestCount: 0,
      totalRequestCount: 0,
      dailyRequestTokens: 0,
      totalTokens: 0,
      dailyRequestCost: 0,
      totalCost: 0,
      rpm5m: 0,
      tpm5m: 0,
    }
  }

  const res = await query<{
    daily_request_count: string
    total_request_count: string
    daily_request_tokens: string
    total_tokens: string
    daily_request_cost: string
    total_cost: string
    rpm_5m: string
    tpm_5m: string
  }>(
    `
      WITH owner_logs AS (
        SELECT logs.*
        FROM model_response_logs logs
        JOIN api_keys keys ON keys.id = logs.key_id
        WHERE keys.owner_user_id = $1::uuid
      ),
      log_totals AS (
        SELECT
          COUNT(*)::text AS total_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS total_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS total_cost
        FROM owner_logs
      ),
      log_today AS (
        SELECT
          COUNT(*)::text AS daily_request_count,
          COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS daily_request_tokens,
          COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS daily_request_cost
        FROM owner_logs
        WHERE request_time >= date_trunc('day', now())
      ),
      log_5m AS (
        SELECT
          ROUND((COUNT(*)::numeric / 5), 2)::text AS rpm_5m,
          ROUND((COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::numeric / 5), 2)::text AS tpm_5m
        FROM owner_logs
        WHERE request_time >= now() - interval '5 minutes'
      )
      SELECT
        log_today.daily_request_count,
        log_totals.total_request_count,
        log_today.daily_request_tokens,
        log_totals.total_tokens,
        log_today.daily_request_cost,
        log_totals.total_cost,
        log_5m.rpm_5m,
        log_5m.tpm_5m
      FROM log_totals
      CROSS JOIN log_today
      CROSS JOIN log_5m
    `,
    [ownerId],
  )

  return {
    dailyRequestCount: Number(res.rows[0]?.daily_request_count ?? "0"),
    totalRequestCount: Number(res.rows[0]?.total_request_count ?? "0"),
    dailyRequestTokens: Number(res.rows[0]?.daily_request_tokens ?? "0"),
    totalTokens: Number(res.rows[0]?.total_tokens ?? "0"),
    dailyRequestCost: Number(res.rows[0]?.daily_request_cost ?? "0"),
    totalCost: Number(res.rows[0]?.total_cost ?? "0"),
    rpm5m: Number(res.rows[0]?.rpm_5m ?? "0"),
    tpm5m: Number(res.rows[0]?.tpm_5m ?? "0"),
  }
}

export async function listApiKeyModelUsage(
  keyId: string,
  limit = 100,
): Promise<ApiKeyModelUsage[]> {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(500, Math.trunc(limit)))
    : 100

  const res = await query<{
    model_id: string
    request_count: string
    total_tokens: string
    total_cost: string
    last_request_time: Date | null
  }>(
    `
      SELECT
        COALESCE(NULLIF(TRIM(model_id), ''), 'unknown') AS model_id,
        COUNT(*)::text AS request_count,
        COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::text AS total_tokens,
        COALESCE(SUM(COALESCE(cost, 0)), 0)::text AS total_cost,
        MAX(request_time) AS last_request_time
      FROM model_response_logs
      WHERE key_id = $1::uuid
      GROUP BY 1
      ORDER BY COUNT(*) DESC, SUM(COALESCE(total_tokens, 0)) DESC, model_id ASC
      LIMIT $2
    `,
    [keyId, safeLimit],
  )

  return res.rows.map((row) => ({
    modelId: row.model_id || "unknown",
    requestCount: Number(row.request_count ?? "0"),
    totalTokens: Number(row.total_tokens ?? "0"),
    totalCost: Number(row.total_cost ?? "0"),
    lastRequestTime: row.last_request_time
      ? row.last_request_time.toISOString()
      : null,
  }))
}

export async function getApiKeyHourlyStatsSeries(
  keyId: string,
  lookbackHours = 24 * 7,
): Promise<ApiKeyHourlyStatsSeries> {
  const safeLookbackHours = Number.isFinite(lookbackHours)
    ? Math.max(1, Math.min(24 * 90, Math.trunc(lookbackHours)))
    : 24 * 7

  const res = await query<{
    hour_bucket: Date
    requests: string
    tokens: string
    cost: string
  }>(
    `
      WITH bounds AS (
        SELECT
          date_trunc('hour', now()) AS end_hour,
          date_trunc('hour', now()) - (($2::int - 1) * interval '1 hour') AS start_hour
      ),
      hourly AS (
        SELECT
          hour_bucket,
          SUM(request_count) AS requests,
          SUM(total_tokens) AS tokens,
          SUM(total_cost) AS cost
        FROM model_response_log_hourly_rollups, bounds
        WHERE key_id = $1::uuid
          AND hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
        GROUP BY 1
      ),
      series AS (
        SELECT generate_series(
          (SELECT start_hour FROM bounds),
          (SELECT end_hour FROM bounds),
          interval '1 hour'
        ) AS hour_bucket
      )
      SELECT
        series.hour_bucket,
        COALESCE(hourly.requests, 0)::text AS requests,
        COALESCE(hourly.tokens, 0)::text AS tokens,
        COALESCE(hourly.cost, 0)::text AS cost
      FROM series
      LEFT JOIN hourly ON hourly.hour_bucket = series.hour_bucket
      ORDER BY series.hour_bucket ASC
    `,
    [keyId, safeLookbackHours],
  )

  return {
    points: res.rows.map((row) => ({
      hour: row.hour_bucket.toISOString(),
      requests: Number(row.requests ?? "0"),
      tokens: Number(row.tokens ?? "0"),
      cost: Number(row.cost ?? "0"),
    })),
  }
}

export async function getApiKeyModelHourlyStatsSeries(
  keyId: string,
  lookbackHours = 24 * 30,
  maxModels = 6,
): Promise<ModelHourlyStatsSeries> {
  const safeLookbackHours = Number.isFinite(lookbackHours)
    ? Math.max(1, Math.min(24 * 90, Math.trunc(lookbackHours)))
    : 24 * 30
  const safeMaxModels = Number.isFinite(maxModels)
    ? Math.max(1, Math.min(12, Math.trunc(maxModels)))
    : 6

  const res = await query<{
    hour_bucket: Date
    model_id: string
    tokens: string
    cost: string
    requests: string
  }>(
    `
      WITH bounds AS (
        SELECT
          date_trunc('hour', now()) AS end_hour,
          date_trunc('hour', now()) - (($2::int - 1) * interval '1 hour') AS start_hour
      ),
      top_models AS (
        SELECT
          model_id,
          SUM(total_tokens) AS total_tokens
        FROM model_response_log_hourly_rollups, bounds
        WHERE key_id = $1::uuid
          AND hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
        GROUP BY 1
        ORDER BY total_tokens DESC, model_id ASC
        LIMIT $3
      ),
      hourly AS (
        SELECT
          hour_bucket,
          model_id,
          SUM(total_tokens) AS tokens,
          SUM(total_cost) AS cost,
          SUM(request_count) AS requests
        FROM model_response_log_hourly_rollups, bounds
        WHERE key_id = $1::uuid
          AND hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
          AND model_id IN (
            SELECT model_id FROM top_models
          )
        GROUP BY 1, 2
      ),
      hourly_series AS (
        SELECT generate_series(
          (SELECT start_hour FROM bounds),
          (SELECT end_hour FROM bounds),
          interval '1 hour'
        ) AS hour_bucket
      )
      SELECT
        hourly_series.hour_bucket,
        top_models.model_id,
        COALESCE(hourly.tokens, 0)::text AS tokens,
        COALESCE(hourly.cost, 0)::text AS cost,
        COALESCE(hourly.requests, 0)::text AS requests
      FROM hourly_series
      CROSS JOIN top_models
      LEFT JOIN hourly
        ON hourly.hour_bucket = hourly_series.hour_bucket
       AND hourly.model_id = top_models.model_id
      ORDER BY hourly_series.hour_bucket ASC, top_models.model_id ASC
    `,
    [keyId, safeLookbackHours, safeMaxModels],
  )

  const modelSet = new Set<string>()
  const pointsMap = new Map<
    string,
    Record<string, { tokens: number; cost: number; requests: number }>
  >()

  for (const row of res.rows) {
    const hour = row.hour_bucket.toISOString()
    const modelId = row.model_id || "unknown"
    const tokens = Number(row.tokens ?? "0")
    const cost = Number(row.cost ?? "0")
    const requests = Number(row.requests ?? "0")
    modelSet.add(modelId)
    const current = pointsMap.get(hour) ?? {}
    current[modelId] = {
      tokens: Number.isFinite(tokens) ? tokens : 0,
      cost: Number.isFinite(cost) ? cost : 0,
      requests: Number.isFinite(requests) ? requests : 0,
    }
    pointsMap.set(hour, current)
  }

  const models = Array.from(modelSet)
  const points = Array.from(pointsMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, values]) => ({
      hour,
      values: models.reduce<
        Record<string, { tokens: number; cost: number; requests: number }>
      >((acc, modelId) => {
        acc[modelId] = values[modelId] ?? { tokens: 0, cost: 0, requests: 0 }
        return acc
      }, {}),
    }))

  return { models, points }
}

export async function getModelHourlyTokenSeries(
  lookbackHours = 24 * 30,
  maxModels = 6,
): Promise<ModelHourlyTokenSeries> {
  const safeLookbackHours = Number.isFinite(lookbackHours)
    ? Math.max(1, Math.min(24 * 90, Math.trunc(lookbackHours)))
    : 24 * 30
  const safeMaxModels = Number.isFinite(maxModels)
    ? Math.max(1, Math.min(12, Math.trunc(maxModels)))
    : 6

  const res = await query<{
    hour_bucket: Date
    model_id: string
    tokens: string
  }>(
    `
      WITH bounds AS (
        SELECT
          date_trunc('hour', now()) AS end_hour,
          date_trunc('hour', now()) - (($1::int - 1) * interval '1 hour') AS start_hour
      ),
      top_models AS (
        SELECT
          model_id,
          SUM(total_tokens) AS total_tokens
        FROM model_response_log_hourly_rollups, bounds
        WHERE hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
        GROUP BY 1
        ORDER BY total_tokens DESC, model_id ASC
        LIMIT $2
      ),
      hourly AS (
        SELECT
          hour_bucket,
          model_id,
          SUM(total_tokens) AS tokens
        FROM model_response_log_hourly_rollups, bounds
        WHERE hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
          AND model_id IN (
            SELECT model_id FROM top_models
          )
        GROUP BY 1, 2
      ),
      hourly_series AS (
        SELECT generate_series(
          (SELECT start_hour FROM bounds),
          (SELECT end_hour FROM bounds),
          interval '1 hour'
        ) AS hour_bucket
      )
      SELECT
        hourly_series.hour_bucket,
        top_models.model_id,
        COALESCE(hourly.tokens, 0)::text AS tokens
      FROM hourly_series
      CROSS JOIN top_models
      LEFT JOIN hourly
        ON hourly.hour_bucket = hourly_series.hour_bucket
       AND hourly.model_id = top_models.model_id
      ORDER BY hourly_series.hour_bucket ASC, top_models.model_id ASC
    `,
    [safeLookbackHours, safeMaxModels],
  )

  const modelSet = new Set<string>()
  const pointsMap = new Map<string, Record<string, number>>()

  for (const row of res.rows) {
    const hour = row.hour_bucket.toISOString()
    const modelId = row.model_id || "unknown"
    const tokenCount = Number(row.tokens ?? "0")
    modelSet.add(modelId)
    const current = pointsMap.get(hour) ?? {}
    current[modelId] = Number.isFinite(tokenCount) ? tokenCount : 0
    pointsMap.set(hour, current)
  }

  const models = Array.from(modelSet)
  const points = Array.from(pointsMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, values]) => ({
      hour,
      values: models.reduce<Record<string, number>>((acc, modelId) => {
        acc[modelId] = values[modelId] ?? 0
        return acc
      }, {}),
    }))

  return { models, points }
}

export async function getModelHourlyStatsSeries(
  lookbackHours = 24 * 30,
  maxModels = 6,
): Promise<ModelHourlyStatsSeries> {
  const safeLookbackHours = Number.isFinite(lookbackHours)
    ? Math.max(1, Math.min(24 * 90, Math.trunc(lookbackHours)))
    : 24 * 30
  const safeMaxModels = Number.isFinite(maxModels)
    ? Math.max(1, Math.min(12, Math.trunc(maxModels)))
    : 6

  const res = await query<{
    hour_bucket: Date
    model_id: string
    tokens: string
    cost: string
    requests: string
  }>(
    `
      WITH bounds AS (
        SELECT
          date_trunc('hour', now()) AS end_hour,
          date_trunc('hour', now()) - (($1::int - 1) * interval '1 hour') AS start_hour
      ),
      top_models AS (
        SELECT
          model_id,
          SUM(total_tokens) AS total_tokens
        FROM model_response_log_hourly_rollups, bounds
        WHERE hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
        GROUP BY 1
        ORDER BY total_tokens DESC, model_id ASC
        LIMIT $2
      ),
      hourly AS (
        SELECT
          hour_bucket,
          model_id,
          SUM(total_tokens) AS tokens,
          SUM(total_cost) AS cost,
          SUM(request_count) AS requests
        FROM model_response_log_hourly_rollups, bounds
        WHERE hour_bucket >= bounds.start_hour
          AND hour_bucket < (bounds.end_hour + interval '1 hour')
          AND model_id IN (
            SELECT model_id FROM top_models
          )
        GROUP BY 1, 2
      ),
      hourly_series AS (
        SELECT generate_series(
          (SELECT start_hour FROM bounds),
          (SELECT end_hour FROM bounds),
          interval '1 hour'
        ) AS hour_bucket
      )
      SELECT
        hourly_series.hour_bucket,
        top_models.model_id,
        COALESCE(hourly.tokens, 0)::text AS tokens,
        COALESCE(hourly.cost, 0)::text AS cost,
        COALESCE(hourly.requests, 0)::text AS requests
      FROM hourly_series
      CROSS JOIN top_models
      LEFT JOIN hourly
        ON hourly.hour_bucket = hourly_series.hour_bucket
       AND hourly.model_id = top_models.model_id
      ORDER BY hourly_series.hour_bucket ASC, top_models.model_id ASC
    `,
    [safeLookbackHours, safeMaxModels],
  )

  const modelSet = new Set<string>()
  const pointsMap = new Map<
    string,
    Record<string, { tokens: number; cost: number; requests: number }>
  >()

  for (const row of res.rows) {
    const hour = row.hour_bucket.toISOString()
    const modelId = row.model_id || "unknown"
    const tokens = Number(row.tokens ?? "0")
    const cost = Number(row.cost ?? "0")
    const requests = Number(row.requests ?? "0")
    modelSet.add(modelId)
    const current = pointsMap.get(hour) ?? {}
    current[modelId] = {
      tokens: Number.isFinite(tokens) ? tokens : 0,
      cost: Number.isFinite(cost) ? cost : 0,
      requests: Number.isFinite(requests) ? requests : 0,
    }
    pointsMap.set(hour, current)
  }

  const models = Array.from(modelSet)
  const points = Array.from(pointsMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, values]) => ({
      hour,
      values: models.reduce<
        Record<string, { tokens: number; cost: number; requests: number }>
      >((acc, modelId) => {
        acc[modelId] = values[modelId] ?? { tokens: 0, cost: 0, requests: 0 }
        return acc
      }, {}),
    }))

  return { models, points }
}

export async function getPortalUserModelHourlyStatsSeries(
  ownerUserId: string,
  lookbackHours = 24 * 30,
  maxModels = 6,
): Promise<ModelHourlyStatsSeries> {
  const ownerId = ownerUserId.trim()
  if (!ownerId) {
    return { models: [], points: [] }
  }

  const safeLookbackHours = Number.isFinite(lookbackHours)
    ? Math.max(1, Math.min(24 * 90, Math.trunc(lookbackHours)))
    : 24 * 30
  const safeMaxModels = Number.isFinite(maxModels)
    ? Math.max(1, Math.min(12, Math.trunc(maxModels)))
    : 6

  const res = await query<{
    hour_bucket: Date
    model_id: string
    tokens: string
    cost: string
    requests: string
  }>(
    `
      WITH bounds AS (
        SELECT
          date_trunc('hour', now()) AS end_hour,
          date_trunc('hour', now()) - (($2::int - 1) * interval '1 hour') AS start_hour
      ),
      owner_logs AS (
        SELECT rollups.*
        FROM model_response_log_hourly_rollups rollups
        JOIN api_keys keys ON keys.id = rollups.key_id
        JOIN bounds ON true
        WHERE keys.owner_user_id = $1::uuid
          AND rollups.hour_bucket >= bounds.start_hour
          AND rollups.hour_bucket < (bounds.end_hour + interval '1 hour')
      ),
      top_models AS (
        SELECT
          model_id,
          SUM(total_tokens) AS total_tokens
        FROM owner_logs
        GROUP BY 1
        ORDER BY total_tokens DESC, model_id ASC
        LIMIT $3
      ),
      hourly AS (
        SELECT
          hour_bucket,
          model_id,
          SUM(total_tokens) AS tokens,
          SUM(total_cost) AS cost,
          SUM(request_count) AS requests
        FROM owner_logs
        WHERE model_id IN (
          SELECT model_id FROM top_models
        )
        GROUP BY 1, 2
      ),
      hourly_series AS (
        SELECT generate_series(
          (SELECT start_hour FROM bounds),
          (SELECT end_hour FROM bounds),
          interval '1 hour'
        ) AS hour_bucket
      )
      SELECT
        hourly_series.hour_bucket,
        top_models.model_id,
        COALESCE(hourly.tokens, 0)::text AS tokens,
        COALESCE(hourly.cost, 0)::text AS cost,
        COALESCE(hourly.requests, 0)::text AS requests
      FROM hourly_series
      CROSS JOIN top_models
      LEFT JOIN hourly
        ON hourly.hour_bucket = hourly_series.hour_bucket
       AND hourly.model_id = top_models.model_id
      ORDER BY hourly_series.hour_bucket ASC, top_models.model_id ASC
    `,
    [ownerId, safeLookbackHours, safeMaxModels],
  )

  const modelSet = new Set<string>()
  const pointsMap = new Map<
    string,
    Record<string, { tokens: number; cost: number; requests: number }>
  >()

  for (const row of res.rows) {
    const hour = row.hour_bucket.toISOString()
    const modelId = row.model_id || "unknown"
    const tokens = Number(row.tokens ?? "0")
    const cost = Number(row.cost ?? "0")
    const requests = Number(row.requests ?? "0")
    modelSet.add(modelId)
    const current = pointsMap.get(hour) ?? {}
    current[modelId] = {
      tokens: Number.isFinite(tokens) ? tokens : 0,
      cost: Number.isFinite(cost) ? cost : 0,
      requests: Number.isFinite(requests) ? requests : 0,
    }
    pointsMap.set(hour, current)
  }

  const models = Array.from(modelSet)
  const points = Array.from(pointsMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([hour, values]) => ({
      hour,
      values: models.reduce<
        Record<string, { tokens: number; cost: number; requests: number }>
      >((acc, modelId) => {
        acc[modelId] = values[modelId] ?? { tokens: 0, cost: 0, requests: 0 }
        return acc
      }, {}),
    }))

  return { models, points }
}
