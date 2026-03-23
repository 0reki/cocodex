import { isIP } from "node:net"
import { query, withTransaction } from "../../core/db.ts"
import type { SignupProxyRecord, SignupTaskRecord } from "../types.ts"

function mapSignupProxyRow(row: {
  id: string
  proxy_url: string
  enabled: boolean
  created_at: Date
  updated_at: Date
}): SignupProxyRecord {
  return {
    id: row.id,
    proxyUrl: row.proxy_url,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapSignupTaskRow(row: {
  id: string
  kind: string
  status: string
  count: number
  concurrency: number
  cpu_max_concurrency: number
  proxy_pool_size: number
  saved_count: number
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
  duration_ms: number | null
  error: string | null
  result: Record<string, unknown> | null
  updated_at: Date
}): SignupTaskRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    count: row.count,
    concurrency: row.concurrency,
    cpuMaxConcurrency: row.cpu_max_concurrency,
    proxyPoolSize: row.proxy_pool_size,
    savedCount: row.saved_count,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    error: row.error,
    result: row.result,
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function listSignupProxies(enabledOnly = false) {
  const res = await query<{
    id: string
    proxy_url: string
    enabled: boolean
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, proxy_url, enabled, created_at, updated_at
      FROM signup_proxies
      WHERE ($1::boolean = false OR enabled = true)
      ORDER BY updated_at DESC
    `,
    [enabledOnly],
  )
  return res.rows.map(mapSignupProxyRow)
}

export async function replaceSignupProxies(proxyUrls: string[]) {
  function normalizeProxyUrl(value: string) {
    const raw = value.trim()
    if (!raw) return null
    // Support lines like:
    // https://81.34.40.20:443#[Telefonica ...]
    // 103.156.15.122:8087 [tag]
    const withoutComment = raw.split("#")[0]?.trim() ?? ""
    const firstToken = withoutComment.split(/\s+/)[0]?.trim() ?? ""
    if (!firstToken) return null

    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(firstToken)
      ? firstToken
      : `http://${firstToken}`

    try {
      const parsed = new URL(withScheme)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null
      }
      if (!parsed.hostname) return null
      if (parsed.protocol === "https:" && isIP(parsed.hostname)) {
        // For IP-based proxies, undici+Node TLS can reject SNI on IP hostnames.
        // Use HTTP CONNECT to the proxy endpoint instead.
        parsed.protocol = "http:"
      }
      return parsed.toString()
    } catch {
      return null
    }
  }

  const normalized = Array.from(
    new Set(
      proxyUrls
        .map((item) => normalizeProxyUrl(item))
        .filter((item): item is string => Boolean(item))
        .filter((item) => item.length > 0),
    ),
  )

  return withTransaction(async (client) => {
    await client.query(`DELETE FROM signup_proxies`)
    if (normalized.length > 0) {
      await client.query(
        `
          INSERT INTO signup_proxies (proxy_url, enabled)
          SELECT UNNEST($1::text[]), true
        `,
        [normalized],
      )
    }

    const res = await client.query<{
      id: string
      proxy_url: string
      enabled: boolean
      created_at: Date
      updated_at: Date
    }>(
      `
        SELECT id, proxy_url, enabled, created_at, updated_at
        FROM signup_proxies
        ORDER BY updated_at DESC
      `,
    )
    return res.rows.map(mapSignupProxyRow)
  })
}

export async function upsertSignupTask(input: {
  id: string
  kind: string
  status: string
  count: number
  concurrency: number
  cpuMaxConcurrency: number
  proxyPoolSize: number
  savedCount: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  error: string | null
  result: Record<string, unknown> | null
}) {
  const res = await query<{
    id: string
    kind: string
    status: string
    count: number
    concurrency: number
    cpu_max_concurrency: number
    proxy_pool_size: number
    saved_count: number
    created_at: Date
    started_at: Date | null
    finished_at: Date | null
    duration_ms: number | null
    error: string | null
    result: Record<string, unknown> | null
    updated_at: Date
  }>(
    `
      INSERT INTO signup_tasks (
        id,
        kind,
        status,
        count,
        concurrency,
        cpu_max_concurrency,
        proxy_pool_size,
        saved_count,
        created_at,
        started_at,
        finished_at,
        duration_ms,
        error,
        result
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::timestamptz,
        $10::timestamptz,
        $11,
        $12,
        $13,
        $14::jsonb
      )
      ON CONFLICT (id)
      DO UPDATE SET
        kind = EXCLUDED.kind,
        status = EXCLUDED.status,
        count = EXCLUDED.count,
        concurrency = EXCLUDED.concurrency,
        cpu_max_concurrency = EXCLUDED.cpu_max_concurrency,
        proxy_pool_size = EXCLUDED.proxy_pool_size,
        saved_count = EXCLUDED.saved_count,
        created_at = EXCLUDED.created_at,
        started_at = EXCLUDED.started_at,
        finished_at = EXCLUDED.finished_at,
        duration_ms = EXCLUDED.duration_ms,
        error = EXCLUDED.error,
        result = EXCLUDED.result
      RETURNING
        id,
        kind,
        status,
        count,
        concurrency,
        cpu_max_concurrency,
        proxy_pool_size,
        saved_count,
        created_at,
        started_at,
        finished_at,
        duration_ms,
        error,
        result,
        updated_at
    `,
    [
      input.id,
      input.kind,
      input.status,
      input.count,
      input.concurrency,
      input.cpuMaxConcurrency,
      input.proxyPoolSize,
      input.savedCount,
      input.createdAt,
      input.startedAt,
      input.finishedAt,
      input.durationMs,
      input.error,
      JSON.stringify(input.result),
    ],
  )

  if (!res.rows[0]) {
    throw new Error("Failed to upsert signup task")
  }
  return mapSignupTaskRow(res.rows[0])
}

export async function getSignupTaskById(taskId: string): Promise<SignupTaskRecord | null> {
  const res = await query<{
    id: string
    kind: string
    status: string
    count: number
    concurrency: number
    cpu_max_concurrency: number
    proxy_pool_size: number
    saved_count: number
    created_at: Date
    started_at: Date | null
    finished_at: Date | null
    duration_ms: number | null
    error: string | null
    result: Record<string, unknown> | null
    updated_at: Date
  }>(
    `
      SELECT
        id,
        kind,
        status,
        count,
        concurrency,
        cpu_max_concurrency,
        proxy_pool_size,
        saved_count,
        created_at,
        started_at,
        finished_at,
        duration_ms,
        error,
        result,
        updated_at
      FROM signup_tasks
      WHERE id = $1::uuid
      LIMIT 1
    `,
    [taskId],
  )

  return res.rows[0] ? mapSignupTaskRow(res.rows[0]) : null
}

export async function listSignupTasks(limit = 50): Promise<SignupTaskRecord[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const res = await query<{
    id: string
    kind: string
    status: string
    count: number
    concurrency: number
    cpu_max_concurrency: number
    proxy_pool_size: number
    saved_count: number
    created_at: Date
    started_at: Date | null
    finished_at: Date | null
    duration_ms: number | null
    error: string | null
    result: Record<string, unknown> | null
    updated_at: Date
  }>(
    `
      SELECT
        id,
        kind,
        status,
        count,
        concurrency,
        cpu_max_concurrency,
        proxy_pool_size,
        saved_count,
        created_at,
        started_at,
        finished_at,
        duration_ms,
        error,
        result,
        updated_at
      FROM signup_tasks
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [safeLimit],
  )

  return res.rows.map(mapSignupTaskRow)
}

export async function deleteSignupTaskById(taskId: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `
      DELETE FROM signup_tasks
      WHERE id = $1::uuid
      RETURNING id
    `,
    [taskId],
  )
  return Boolean(res.rows[0])
}

export async function recoverOrphanedSignupTasks(): Promise<number> {
  const res = await query<{ id: string }>(
    `
      UPDATE signup_tasks
      SET
        status = 'failed',
        finished_at = COALESCE(finished_at, now()),
        duration_ms = CASE
          WHEN duration_ms IS NOT NULL THEN duration_ms
          WHEN started_at IS NOT NULL THEN GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (now() - started_at)) * 1000)
          )::bigint
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) * 1000)
          )::bigint
        END,
        error = COALESCE(
          NULLIF(error, ''),
          'Task interrupted by server restart'
        )
      WHERE status IN ('running', 'stopping')
      RETURNING id
    `,
  )
  return res.rowCount ?? res.rows.length
}
