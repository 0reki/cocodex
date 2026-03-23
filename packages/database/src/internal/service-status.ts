import { query, withTransaction } from "../core/db.ts"
import type {
  DatabaseSelfCheckIssue,
  DatabaseSelfCheckReport,
  ServiceStatusLevel,
  ServiceStatusMonitorRecord,
  ServiceStatusMonitorSnapshot,
  ServiceStatusOverview,
  ServiceStatusSampleRecord,
} from "./types.ts"

function mapServiceStatusMonitorRow(row: {
  id: string
  slug: string
  name: string
  endpoint: string
  method: string
  enabled: boolean
  interval_seconds: number
  timeout_ms: number
  created_at: Date
  updated_at: Date
}): ServiceStatusMonitorRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    endpoint: row.endpoint,
    method: row.method,
    enabled: row.enabled,
    intervalSeconds: Number(row.interval_seconds),
    timeoutMs: Number(row.timeout_ms),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapServiceStatusSampleRow(row: {
  id: string
  monitor_id: string
  checked_at: Date
  ok: boolean
  status_code: number | null
  latency_ms: number | null
  error_message: string | null
  created_at: Date
}): ServiceStatusSampleRecord {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    checkedAt: row.checked_at.toISOString(),
    ok: row.ok,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
  }
}

export async function listServiceStatusMonitors(input?: {
  enabledOnly?: boolean
}): Promise<ServiceStatusMonitorRecord[]> {
  const where = input?.enabledOnly ? "WHERE enabled = true" : ""
  const res = await query<{
    id: string
    slug: string
    name: string
    endpoint: string
    method: string
    enabled: boolean
    interval_seconds: number
    timeout_ms: number
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, slug, name, endpoint, method, enabled, interval_seconds, timeout_ms,
        created_at, updated_at
      FROM service_status_monitors
      ${where}
      ORDER BY name ASC, slug ASC
    `,
  )
  return res.rows.map(mapServiceStatusMonitorRow)
}

export async function upsertServiceStatusMonitor(input: {
  slug: string
  name: string
  endpoint: string
  method?: string
  enabled?: boolean
  intervalSeconds?: number
  timeoutMs?: number
}): Promise<ServiceStatusMonitorRecord> {
  const slug = input.slug.trim().toLowerCase()
  const name = input.name.trim()
  const endpoint = input.endpoint.trim()
  if (!slug) throw new Error("slug is required")
  if (!name) throw new Error("name is required")
  if (!endpoint) throw new Error("endpoint is required")

  const method = (input.method ?? "GET").trim().toUpperCase() || "GET"
  const intervalSeconds = Math.max(
    30,
    Math.trunc(Number(input.intervalSeconds ?? 300)),
  )
  const timeoutMs = Math.max(500, Math.trunc(Number(input.timeoutMs ?? 10_000)))

  const res = await query<{
    id: string
    slug: string
    name: string
    endpoint: string
    method: string
    enabled: boolean
    interval_seconds: number
    timeout_ms: number
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO service_status_monitors (
        slug, name, endpoint, method, enabled, interval_seconds, timeout_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (slug)
      DO UPDATE SET
        name = EXCLUDED.name,
        endpoint = EXCLUDED.endpoint,
        method = EXCLUDED.method,
        enabled = EXCLUDED.enabled,
        interval_seconds = EXCLUDED.interval_seconds,
        timeout_ms = EXCLUDED.timeout_ms
      RETURNING
        id, slug, name, endpoint, method, enabled, interval_seconds, timeout_ms,
        created_at, updated_at
    `,
    [
      slug,
      name,
      endpoint,
      method,
      input.enabled ?? true,
      intervalSeconds,
      timeoutMs,
    ],
  )
  const row = res.rows[0]
  if (!row) throw new Error("Failed to upsert service status monitor")
  return mapServiceStatusMonitorRow(row)
}

export async function insertServiceStatusSample(input: {
  monitorId: string
  checkedAt?: string | Date
  ok: boolean
  statusCode?: number | null
  latencyMs?: number | null
  errorMessage?: string | null
  retainPerMonitor?: number
}): Promise<ServiceStatusSampleRecord> {
  const monitorId = input.monitorId.trim()
  if (!monitorId) throw new Error("monitorId is required")
  const retainPerMonitor = Math.max(
    1,
    Math.trunc(Number(input.retainPerMonitor ?? 100)),
  )
  return withTransaction(async (client) => {
    const inserted = await client.query<{
      id: string
      monitor_id: string
      checked_at: Date
      ok: boolean
      status_code: number | null
      latency_ms: number | null
      error_message: string | null
      created_at: Date
    }>(
      `
        INSERT INTO service_status_samples (
          monitor_id, checked_at, ok, status_code, latency_ms, error_message
        )
        VALUES ($1::uuid, COALESCE($2::timestamptz, now()), $3, $4, $5, $6)
        RETURNING
          id, monitor_id, checked_at, ok, status_code, latency_ms, error_message, created_at
      `,
      [
        monitorId,
        input.checkedAt ?? null,
        input.ok,
        input.statusCode ?? null,
        input.latencyMs ?? null,
        input.errorMessage ?? null,
      ],
    )

    await client.query(
      `
        DELETE FROM service_status_samples
        WHERE id IN (
          SELECT id
          FROM service_status_samples
          WHERE monitor_id = $1::uuid
          ORDER BY checked_at DESC, id DESC
          OFFSET $2
        )
      `,
      [monitorId, retainPerMonitor],
    )

    const row = inserted.rows[0]
    if (!row) {
      throw new Error("Failed to insert service status sample")
    }
    return mapServiceStatusSampleRow(row)
  })
}

export async function getServiceStatusOverview(input?: {
  limitPerMonitor?: number
  enabledOnly?: boolean
}): Promise<ServiceStatusOverview> {
  const limitPerMonitor = Math.max(
    1,
    Math.min(100, Math.trunc(Number(input?.limitPerMonitor ?? 100))),
  )
  const monitors = await listServiceStatusMonitors({
    enabledOnly: input?.enabledOnly ?? true,
  })

  if (monitors.length === 0) {
    return {
      level: "unknown",
      monitors: [],
      generatedAt: new Date().toISOString(),
    }
  }

  const monitorIds = monitors.map((item) => item.id)
  const sampleRes = await query<{
    id: string
    monitor_id: string
    checked_at: Date
    ok: boolean
    status_code: number | null
    latency_ms: number | null
    error_message: string | null
    created_at: Date
  }>(
    `
      WITH ranked AS (
        SELECT
          s.*,
          ROW_NUMBER() OVER (
            PARTITION BY s.monitor_id
            ORDER BY s.checked_at DESC, s.id DESC
          ) AS rn
        FROM service_status_samples s
        WHERE s.monitor_id = ANY($1::uuid[])
      )
      SELECT
        id, monitor_id, checked_at, ok, status_code, latency_ms, error_message, created_at
      FROM ranked
      WHERE rn <= $2
      ORDER BY monitor_id ASC, checked_at DESC, id DESC
    `,
    [monitorIds, limitPerMonitor],
  )

  const grouped = new Map<string, ServiceStatusSampleRecord[]>()
  for (const row of sampleRes.rows) {
    const mapped = mapServiceStatusSampleRow(row)
    const list = grouped.get(mapped.monitorId)
    if (list) list.push(mapped)
    else grouped.set(mapped.monitorId, [mapped])
  }

  const snapshots: ServiceStatusMonitorSnapshot[] = monitors.map((monitor) => {
    const samples = grouped.get(monitor.id) ?? []
    const latest = samples[0] ?? null
    const okCount = samples.reduce((acc, sample) => acc + (sample.ok ? 1 : 0), 0)
    const uptimePercent =
      samples.length > 0 ? Number(((okCount / samples.length) * 100).toFixed(2)) : 0
    const level: ServiceStatusLevel =
      !latest ? "unknown" : latest.ok ? "operational" : "degraded"

    return {
      ...monitor,
      level,
      uptimePercent,
      latestCheckedAt: latest?.checkedAt ?? null,
      latestStatusCode: latest?.statusCode ?? null,
      latestLatencyMs: latest?.latencyMs ?? null,
      latestErrorMessage: latest?.errorMessage ?? null,
      samples,
    }
  })

  const overallLevel: ServiceStatusLevel =
    snapshots.some((item) => item.level === "degraded")
      ? "degraded"
      : snapshots.some((item) => item.level === "operational")
        ? "operational"
        : "unknown"

  return {
    level: overallLevel,
    monitors: snapshots,
    generatedAt: new Date().toISOString(),
  }
}

export async function runDatabaseSelfCheck(): Promise<DatabaseSelfCheckReport> {
  const issues: DatabaseSelfCheckIssue[] = []

  const pushIssue = (issue: DatabaseSelfCheckIssue) => {
    issues.push(issue)
  }

  const pushQueryFailure = (id: string, error: unknown) => {
    pushIssue({
      id,
      level: "warning",
      message: "Self-check query failed",
      details: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const fkRes = await query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'api_keys'
            AND c.conname = 'fk_api_keys_owner_user'
        ) AS exists
      `,
    )
    if (!fkRes.rows[0]?.exists) {
      pushIssue({
        id: "api_keys_owner_fk_missing",
        level: "error",
        message: "Missing foreign key fk_api_keys_owner_user on api_keys.owner_user_id",
      })
    }
  } catch (error) {
    pushQueryFailure("api_keys_owner_fk_check_failed", error)
  }

  try {
    const orphanApiKeysRes = await query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM api_keys keys
        LEFT JOIN portal_users users ON users.id = keys.owner_user_id
        WHERE keys.owner_user_id IS NOT NULL
          AND users.id IS NULL
      `,
    )
    const count = Number(orphanApiKeysRes.rows[0]?.count ?? "0")
    if (count > 0) {
      pushIssue({
        id: "api_keys_orphan_owner",
        level: "error",
        message: "Found API keys with missing owner user",
        count,
      })
    }
  } catch (error) {
    pushQueryFailure("api_keys_orphan_owner_check_failed", error)
  }

  try {
    const duplicateIdentityRes = await query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM (
          SELECT provider, provider_user_id
          FROM portal_user_identities
          GROUP BY provider, provider_user_id
          HAVING COUNT(*) > 1
        ) dup
      `,
    )
    const count = Number(duplicateIdentityRes.rows[0]?.count ?? "0")
    if (count > 0) {
      pushIssue({
        id: "portal_user_identities_duplicate_provider_user",
        level: "error",
        message: "Found duplicate portal_user_identities (provider, provider_user_id)",
        count,
      })
    }
  } catch (error) {
    pushQueryFailure("portal_user_identities_duplicate_check_failed", error)
  }

  return {
    ok: issues.filter((item) => item.level === "error").length === 0,
    checkedAt: new Date().toISOString(),
    issues,
  }
}

export async function countPortalAdmins(): Promise<number> {
  const res = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM portal_users
      WHERE role = 'admin' AND enabled = true
    `,
  )
  return Number(res.rows[0]?.count ?? "0")
}
