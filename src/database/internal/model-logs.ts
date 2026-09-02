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

type ModelResponseLogRow = {
  id: string
  intent_id: string | null
  is_final: boolean | null
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
    whereParts.push(`logs.owner_user_id = $${params.length}::uuid`)
  }
  if (normalized.keyId) {
    params.push(normalized.keyId)
    whereParts.push(`logs.key_id = $${params.length}::uuid`)
  }
  if (normalized.modelId) {
    params.push(normalized.modelId)
    whereParts.push(`logs.model_id = $${params.length}`)
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

function mapModelResponseLogRow(row: ModelResponseLogRow): ModelResponseLogRecord {
  const numericCost =
    typeof row.cost === "number"
      ? row.cost
      : typeof row.cost === "string"
        ? Number(row.cost)
        : null
  return {
    id: row.id,
    intentId: row.intent_id,
    isFinal: row.is_final,
    streamEndReason: row.stream_end_reason,
    path: row.path,
    modelId: row.model_id,
    keyId: row.key_id,
    serviceTier: row.service_tier,
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

type ModelResponseLogCursor = {
  requestTime: string
  id: string
}

export class InvalidModelResponseLogCursorError extends Error {
  constructor() {
    super("Invalid request log cursor")
    this.name = "InvalidModelResponseLogCursorError"
  }
}

function encodeModelResponseLogCursor(row: ModelResponseLogRow): string {
  return Buffer.from(
    JSON.stringify({
      requestTime: row.request_time.toISOString(),
      id: row.id,
    } satisfies ModelResponseLogCursor),
  ).toString("base64url")
}

function decodeModelResponseLogCursor(value?: string | null): ModelResponseLogCursor | null {
  const normalized = value?.trim() ?? ""
  if (!normalized) return null
  try {
    const parsed = JSON.parse(
      Buffer.from(normalized, "base64url").toString("utf8"),
    ) as Partial<ModelResponseLogCursor>
    if (
      typeof parsed.requestTime !== "string" ||
      Number.isNaN(Date.parse(parsed.requestTime)) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new InvalidModelResponseLogCursorError()
    }
    return { requestTime: parsed.requestTime, id: parsed.id }
  } catch (error) {
    if (error instanceof InvalidModelResponseLogCursorError) throw error
    throw new InvalidModelResponseLogCursorError()
  }
}

async function listModelResponseLogsByCursor(
  ownerUserId: string | null,
  limit = 50,
  cursor?: string | null,
  filters?: ModelResponseLogFilters,
): Promise<{
  items: ModelResponseLogRecord[]
  nextCursor: string | null
  hasMore: boolean
  limit: number
}> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const decodedCursor = decodeModelResponseLogCursor(cursor)
  const filterSql = buildModelResponseLogsFilterSql(filters, ownerUserId)
  const params = [...filterSql.params]
  let cursorSql = ""
  if (decodedCursor) {
    params.push(decodedCursor.requestTime, decodedCursor.id)
    cursorSql = `${filterSql.whereSql ? "AND" : "WHERE"}
      (logs.request_time, logs.id) < (
        $${params.length - 1}::timestamptz,
        $${params.length}::uuid
      )`
  }
  params.push(safeLimit + 1)
  const rowsRes = await query<ModelResponseLogRow>(
    `
      SELECT
        logs.id, logs.intent_id, logs.is_final, logs.stream_end_reason,
        logs.path, logs.model_id, logs.key_id, logs.service_tier,
        logs.status_code, logs.ttfb_ms, logs.latency_ms, logs.tokens_info,
        logs.total_tokens, logs.cost, logs.error_code, logs.error_message,
        logs.request_time, logs.created_at, logs.updated_at
      FROM model_response_logs logs
      ${filterSql.whereSql}
      ${cursorSql}
      ORDER BY logs.request_time DESC, logs.id DESC
      LIMIT $${params.length}
    `,
    params,
  )
  const hasMore = rowsRes.rows.length > safeLimit
  const rows = hasMore ? rowsRes.rows.slice(0, safeLimit) : rowsRes.rows
  return {
    items: rows.map(mapModelResponseLogRow),
    nextCursor:
      hasMore && rows.length > 0
        ? encodeModelResponseLogCursor(rows[rows.length - 1]!)
        : null,
    hasMore,
    limit: safeLimit,
  }
}

export async function listModelResponseLogsCursor(
  limit = 50,
  cursor?: string | null,
  filters?: ModelResponseLogFilters,
) {
  return listModelResponseLogsByCursor(null, limit, cursor, filters)
}

export async function listModelResponseLogsCursorByOwnerUserId(
  ownerUserId: string,
  limit = 50,
  cursor?: string | null,
  filters?: ModelResponseLogFilters,
) {
  const ownerId = ownerUserId.trim()
  if (!ownerId) {
    return { items: [], nextCursor: null, hasMore: false, limit: 50 }
  }
  return listModelResponseLogsByCursor(ownerId, limit, cursor, filters)
}
