import { query } from "../core/db.ts"
import type { ModelResponseLogRecord } from "./types.ts"

type ModelResponseLogFilters = {
  keyId?: string | null
  modelId?: string | null
  requestStatus?: string | null
  requestDate?: string | null
  requestDateFrom?: string | null
  requestDateTo?: string | null
}

function normalizeModelResponseLogFilters(
  filters?: ModelResponseLogFilters,
): {
  keyId: string
  modelId: string
  requestStatus: string
  requestDate: string
  requestDateFrom: string
  requestDateTo: string
} {
  return {
    keyId: filters?.keyId?.trim() ?? "",
    modelId: filters?.modelId?.trim() ?? "",
    requestStatus: filters?.requestStatus?.trim() ?? "",
    requestDate: filters?.requestDate?.trim() ?? "",
    requestDateFrom: filters?.requestDateFrom?.trim() ?? "",
    requestDateTo: filters?.requestDateTo?.trim() ?? "",
  }
}

function buildModelResponseLogsFilterSql(
  filters?: ModelResponseLogFilters,
  ownerUserId?: string | null,
): {
  whereSql: string
  params: Array<string | number>
} {
  const normalized = normalizeModelResponseLogFilters(filters)
  const whereParts: string[] = []
  const params: Array<string | number> = []

  if (ownerUserId?.trim()) {
    params.push(ownerUserId.trim())
    whereParts.push(`keys.owner_user_id = $${params.length}::uuid`)
  }
  if (normalized.keyId) {
    params.push(`%${normalized.keyId}%`)
    whereParts.push(`COALESCE(keys.api_key, '') ILIKE $${params.length}`)
  }
  if (normalized.modelId) {
    params.push(`%${normalized.modelId}%`)
    whereParts.push(`COALESCE(logs.model_id, '') ILIKE $${params.length}`)
  }
  if (normalized.requestStatus) {
    switch (normalized.requestStatus) {
      case "success":
        whereParts.push(
          `logs.status_code >= 200 AND logs.status_code < 300 AND logs.is_final = TRUE`,
        )
        break
      case "aborted":
        whereParts.push(
          `logs.status_code >= 200 AND logs.status_code < 300 AND COALESCE(logs.stream_end_reason, '') LIKE 'client_aborted%'`,
        )
        break
      case "incomplete":
        whereParts.push(
          `logs.status_code >= 200 AND logs.status_code < 300
           AND COALESCE(logs.is_final, FALSE) = FALSE
           AND COALESCE(logs.error_code, '') = ''
           AND (
             logs.stream_end_reason IS NULL
             OR logs.stream_end_reason = ''
           )`,
        )
        break
      case "failed":
        whereParts.push(
          `(
             (logs.status_code IS NOT NULL AND (logs.status_code < 200 OR logs.status_code >= 300))
             OR (
               logs.status_code >= 200
               AND logs.status_code < 300
               AND COALESCE(logs.is_final, FALSE) = FALSE
               AND (
                 COALESCE(logs.error_code, '') <> ''
                 OR (
                   COALESCE(logs.stream_end_reason, '') <> ''
                   AND COALESCE(logs.stream_end_reason, '') NOT LIKE 'client_aborted%'
                 )
               )
             )
           )`,
        )
        break
      default:
        break
    }
  }
  const dateFrom = normalized.requestDateFrom || normalized.requestDate
  const dateTo = normalized.requestDateTo || normalized.requestDate
  if (dateFrom) {
    params.push(dateFrom)
    whereParts.push(`logs.request_time >= $${params.length}::date`)
  }
  if (dateTo) {
    params.push(dateTo)
    whereParts.push(
      `logs.request_time < ($${params.length}::date + INTERVAL '1 day')`,
    )
  }

  return {
    whereSql: whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
    params,
  }
}

function mapModelResponseLogRow(row: {
  id: string
  intent_id: string | null
  attempt_no: number | null
  is_final: boolean | null
  retry_reason: string | null
  heartbeat_count?: number | null
  stream_end_reason?: string | null
  path: string
  model_id: string | null
  key_id: string | null
  service_tier?: string | null
  status_code: number | null
  ttfb_ms: number | null
  latency_ms: number | null
  tokens_info: Record<string, unknown> | null
  total_tokens: number | null
  cost: number | string | null
  error_code: string | null
  error_message: string | null
  request_time: Date
  created_at: Date
  updated_at: Date
}): ModelResponseLogRecord {
  const numericCost =
    typeof row.cost === "number"
      ? row.cost
      : typeof row.cost === "string"
        ? Number(row.cost)
        : null
  return {
    id: row.id,
    intentId: row.intent_id,
    attemptNo: row.attempt_no,
    isFinal: row.is_final,
    retryReason: row.retry_reason,
    heartbeatCount: row.heartbeat_count ?? null,
    streamEndReason: row.stream_end_reason ?? null,
    path: row.path,
    modelId: row.model_id,
    keyId: row.key_id,
    serviceTier: row.service_tier ?? null,
    statusCode: row.status_code,
    ttfbMs: row.ttfb_ms,
    latencyMs: row.latency_ms,
    tokensInfo: row.tokens_info ?? null,
    totalTokens: row.total_tokens,
    cost: Number.isFinite(numericCost ?? NaN) ? numericCost : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestTime: row.request_time.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export async function createModelResponseLog(input: {
  intentId?: string | null
  attemptNo?: number | null
  isFinal?: boolean | null
  retryReason?: string | null
  heartbeatCount?: number | null
  streamEndReason?: string | null
  path: string
  modelId?: string | null
  keyId?: string | null
  serviceTier?: string | null
  statusCode?: number | null
  ttfbMs?: number | null
  latencyMs?: number | null
  tokensInfo?: Record<string, unknown> | null
  totalTokens?: number | null
  cost?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  internalErrorDetails?: Record<string, unknown> | null
  requestTime?: string | Date | null
}): Promise<ModelResponseLogRecord> {
  const safePath = input.path.trim()
  if (!safePath) {
    throw new Error("path is required")
  }
  const res = await query<{
    id: string
    intent_id: string | null
    attempt_no: number | null
    is_final: boolean | null
    retry_reason: string | null
    heartbeat_count: number | null
    stream_end_reason: string | null
    path: string
    model_id: string | null
    key_id: string | null
    service_tier: string | null
    status_code: number | null
    ttfb_ms: number | null
    latency_ms: number | null
    tokens_info: Record<string, unknown> | null
    total_tokens: number | null
    cost: number | string | null
    error_code: string | null
    error_message: string | null
    request_time: Date
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO model_response_logs (
        intent_id,
        attempt_no,
        is_final,
        retry_reason,
        heartbeat_count,
        stream_end_reason,
        path,
        model_id,
        key_id,
        service_tier,
        status_code,
        ttfb_ms,
        latency_ms,
        tokens_info,
        total_tokens,
        cost,
        error_code,
        error_message,
        internal_error_details,
        request_time
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::uuid,
        $10,
        $11,
        $12,
        $13,
        $14::jsonb,
        $15,
        $16,
        $17,
        $18,
        $19::jsonb,
        COALESCE($20::timestamptz, now())
      )
      RETURNING
        id, intent_id, attempt_no, is_final, retry_reason, heartbeat_count, stream_end_reason, path, model_id, key_id, service_tier,
        status_code, ttfb_ms, latency_ms, tokens_info, total_tokens, cost,
        error_code, error_message, request_time, created_at, updated_at
    `,
    [
      input.intentId ?? null,
      input.attemptNo ?? null,
      input.isFinal ?? null,
      input.retryReason ?? null,
      input.heartbeatCount ?? null,
      input.streamEndReason ?? null,
      safePath,
      input.modelId ?? null,
      input.keyId ?? null,
      input.serviceTier ?? null,
      input.statusCode ?? null,
      input.ttfbMs ?? null,
      input.latencyMs ?? null,
      input.tokensInfo ? JSON.stringify(input.tokensInfo) : null,
      input.totalTokens ?? null,
      input.cost ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.internalErrorDetails ?? null,
      input.requestTime ?? null,
    ],
  )
  if (!res.rows[0]) {
    throw new Error("Failed to create model response log")
  }
  return mapModelResponseLogRow(res.rows[0])
}

export async function hasSuccessfulFinalChargeLog(input: {
  intentId: string
  keyId: string
  path: string
}): Promise<boolean> {
  const intentId = input.intentId.trim()
  const keyId = input.keyId.trim()
  const path = input.path.trim()
  if (!intentId || !keyId || !path) return false
  const res = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM model_response_logs
        WHERE intent_id = $1
          AND key_id = $2::uuid
          AND path = $3
          AND is_final = TRUE
          AND status_code >= 200
          AND status_code < 300
          AND COALESCE(cost, 0) > 0
      ) AS exists
    `,
    [intentId, keyId, path],
  )
  return Boolean(res.rows[0]?.exists)
}

export async function listModelResponseLogs(limit = 200): Promise<ModelResponseLogRecord[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
  const res = await query<{
    id: string
    intent_id: string | null
    attempt_no: number | null
    is_final: boolean | null
    retry_reason: string | null
    heartbeat_count: number | null
    stream_end_reason: string | null
    path: string
    model_id: string | null
    key_id: string | null
    service_tier: string | null
    status_code: number | null
    ttfb_ms: number | null
    latency_ms: number | null
    tokens_info: Record<string, unknown> | null
    total_tokens: number | null
    cost: number | string | null
    error_code: string | null
    error_message: string | null
    request_time: Date
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, intent_id, attempt_no, is_final, retry_reason, heartbeat_count, stream_end_reason, path, model_id, key_id, service_tier,
        status_code, ttfb_ms, latency_ms, tokens_info, total_tokens, cost,
        error_code, error_message, request_time, created_at, updated_at
      FROM model_response_logs
      ORDER BY request_time DESC, created_at DESC
      LIMIT $1
    `,
    [safeLimit],
  )
  return res.rows.map(mapModelResponseLogRow)
}

export async function listModelResponseLogsPage(
  page = 1,
  pageSize = 50,
  filters?: ModelResponseLogFilters,
): Promise<{
  items: ModelResponseLogRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(500, Math.floor(pageSize)))
  const filterSql = buildModelResponseLogsFilterSql(filters)

  const countRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM model_response_logs logs
      LEFT JOIN api_keys keys ON keys.id = logs.key_id
      ${filterSql.whereSql}
    `,
    filterSql.params,
  )
  const total = Number(countRes.rows[0]?.count ?? "0")
  const totalPages = Math.max(1, Math.ceil(total / safePageSize))
  const normalizedPage = Math.min(safePage, totalPages)
  const normalizedOffset = (normalizedPage - 1) * safePageSize

  const rowsRes = await query<{
    id: string
    intent_id: string | null
    attempt_no: number | null
    is_final: boolean | null
    retry_reason: string | null
    heartbeat_count: number | null
    stream_end_reason: string | null
    path: string
    model_id: string | null
    key_id: string | null
    service_tier: string | null
    status_code: number | null
    ttfb_ms: number | null
    latency_ms: number | null
    tokens_info: Record<string, unknown> | null
    total_tokens: number | null
    cost: number | string | null
    error_code: string | null
    error_message: string | null
    request_time: Date
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        logs.id, logs.intent_id, logs.attempt_no, logs.is_final, logs.retry_reason,
        logs.heartbeat_count, logs.stream_end_reason, logs.path, logs.model_id, logs.key_id, logs.service_tier,
        logs.status_code, logs.ttfb_ms, logs.latency_ms, logs.tokens_info, logs.total_tokens, logs.cost,
        logs.error_code, logs.error_message, logs.request_time, logs.created_at, logs.updated_at
      FROM model_response_logs logs
      LEFT JOIN api_keys keys ON keys.id = logs.key_id
      ${filterSql.whereSql}
      ORDER BY logs.request_time DESC, logs.created_at DESC
      LIMIT $${filterSql.params.length + 1}
      OFFSET $${filterSql.params.length + 2}
    `,
    [...filterSql.params, safePageSize, normalizedOffset],
  )

  return {
    items: rowsRes.rows.map(mapModelResponseLogRow),
    total,
    page: normalizedPage,
    pageSize: safePageSize,
    totalPages,
  }
}

export async function listModelResponseLogsPageByOwnerUserId(
  ownerUserId: string,
  page = 1,
  pageSize = 50,
  filters?: ModelResponseLogFilters,
): Promise<{
  items: ModelResponseLogRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const ownerId = ownerUserId.trim()
  if (!ownerId) {
    return { items: [], total: 0, page: 1, pageSize: 50, totalPages: 1 }
  }
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(500, Math.floor(pageSize)))
  const filterSql = buildModelResponseLogsFilterSql(filters, ownerId)

  const countRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM model_response_logs logs
      JOIN api_keys keys ON keys.id = logs.key_id
      ${filterSql.whereSql}
    `,
    filterSql.params,
  )
  const total = Number(countRes.rows[0]?.count ?? "0")
  const totalPages = Math.max(1, Math.ceil(total / safePageSize))
  const normalizedPage = Math.min(safePage, totalPages)
  const normalizedOffset = (normalizedPage - 1) * safePageSize

  const rowsRes = await query<{
    id: string
    intent_id: string | null
    attempt_no: number | null
    is_final: boolean | null
    retry_reason: string | null
    heartbeat_count: number | null
    stream_end_reason: string | null
    path: string
    model_id: string | null
    key_id: string | null
    service_tier: string | null
    status_code: number | null
    ttfb_ms: number | null
    latency_ms: number | null
    tokens_info: Record<string, unknown> | null
    total_tokens: number | null
    cost: number | string | null
    error_code: string | null
    error_message: string | null
    request_time: Date
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        logs.id, logs.intent_id, logs.attempt_no, logs.is_final, logs.retry_reason,
        logs.heartbeat_count, logs.stream_end_reason, logs.path, logs.model_id, logs.key_id, logs.service_tier, logs.status_code, logs.ttfb_ms,
        logs.latency_ms, logs.tokens_info, logs.total_tokens, logs.cost,
        logs.error_code, logs.error_message, logs.request_time, logs.created_at, logs.updated_at
      FROM model_response_logs logs
      JOIN api_keys keys ON keys.id = logs.key_id
      ${filterSql.whereSql}
      ORDER BY logs.request_time DESC, logs.created_at DESC
      LIMIT $${filterSql.params.length + 1}
      OFFSET $${filterSql.params.length + 2}
    `,
    [...filterSql.params, safePageSize, normalizedOffset],
  )

  return {
    items: rowsRes.rows.map(mapModelResponseLogRow),
    total,
    page: normalizedPage,
    pageSize: safePageSize,
    totalPages,
  }
}

export async function listModelResponseLogsByKeyIdPage(
  keyId: string,
  page = 1,
  pageSize = 50,
): Promise<{
  items: ModelResponseLogRecord[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.max(1, Math.min(500, Math.floor(pageSize)))

  const countRes = await query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM model_response_logs
      WHERE key_id = $1::uuid
    `,
    [keyId],
  )
  const total = Number(countRes.rows[0]?.count ?? "0")
  const totalPages = Math.max(1, Math.ceil(total / safePageSize))
  const normalizedPage = Math.min(safePage, totalPages)
  const normalizedOffset = (normalizedPage - 1) * safePageSize

  const rowsRes = await query<{
    id: string
    intent_id: string | null
    attempt_no: number | null
    is_final: boolean | null
    retry_reason: string | null
    heartbeat_count: number | null
    stream_end_reason: string | null
    path: string
    model_id: string | null
    key_id: string | null
    service_tier: string | null
    status_code: number | null
    ttfb_ms: number | null
    latency_ms: number | null
    tokens_info: Record<string, unknown> | null
    total_tokens: number | null
    cost: number | string | null
    error_code: string | null
    error_message: string | null
    request_time: Date
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id, intent_id, attempt_no, is_final, retry_reason, heartbeat_count, stream_end_reason, path, model_id, key_id, service_tier,
        status_code, ttfb_ms, latency_ms, tokens_info, total_tokens, cost,
        error_code, error_message, request_time, created_at, updated_at
      FROM model_response_logs
      WHERE key_id = $1::uuid
      ORDER BY request_time DESC, created_at DESC
      LIMIT $2
      OFFSET $3
    `,
    [keyId, safePageSize, normalizedOffset],
  )

  return {
    items: rowsRes.rows.map(mapModelResponseLogRow),
    total,
    page: normalizedPage,
    pageSize: safePageSize,
    totalPages,
  }
}
