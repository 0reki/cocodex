import { query } from "../core/db.ts"
import { formatUsdAmount, type UsdAmount } from "../../shared/usd.ts"

export type ResponseSettlement = {
  settlementId: string
  intentId: string | null
  ownerUserId: string | null
  apiKeyId: string | null
  charge: UsdAmount
  isFinal: boolean | null
  streamEndReason: string | null
  path: string
  modelId: string | null
  serviceTier: string | null
  statusCode: number | null
  ttfbMs: number | null
  latencyMs: number | null
  tokensInfo: Record<string, unknown> | null
  totalTokens: number | null
  cost: UsdAmount | null
  errorCode: string | null
  errorMessage: string | null
  requestTime: string
}

export async function flushResponseSettlements(
  settlements: ResponseSettlement[],
): Promise<{
  acceptedSettlementIds: string[]
  apiKeyUsedUsd: Record<string, string>
}> {
  if (settlements.length === 0) {
    return { acceptedSettlementIds: [], apiKeyUsedUsd: {} }
  }
  const payload = settlements.map((item) => ({
    settlement_id: item.settlementId,
    intent_id: item.intentId,
    owner_user_id: item.ownerUserId,
    key_id: item.apiKeyId,
    charge: formatUsdAmount(item.charge),
    is_final: item.isFinal,
    stream_end_reason: item.streamEndReason,
    path: item.path,
    model_id: item.modelId,
    service_tier: item.serviceTier,
    status_code: item.statusCode,
    ttfb_ms: item.ttfbMs,
    latency_ms: item.latencyMs,
    tokens_info: item.tokensInfo,
    total_tokens: item.totalTokens,
    cost: item.cost === null ? null : formatUsdAmount(item.cost),
    error_code: item.errorCode,
    error_message: item.errorMessage,
    request_time: item.requestTime,
  }))
  const result = await query<{
    accepted_settlement_ids: string[]
    api_key_used: Record<string, string>
  }>(
    `
      WITH raw_input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item(
          settlement_id text,
          intent_id text,
          owner_user_id uuid,
          key_id uuid,
          charge numeric,
          is_final boolean,
          stream_end_reason text,
          path text,
          model_id text,
          service_tier text,
          status_code integer,
          ttfb_ms integer,
          latency_ms integer,
          tokens_info jsonb,
          total_tokens integer,
          cost numeric,
          error_code text,
          error_message text,
          request_time timestamptz
        )
      ),
      input AS (
        SELECT DISTINCT ON (settlement_id) *
        FROM raw_input
        ORDER BY settlement_id
      ),
      inserted_logs AS (
        INSERT INTO model_response_logs (
          settlement_id, intent_id, owner_user_id, key_id, is_final,
          stream_end_reason, path, model_id, service_tier, status_code,
          ttfb_ms, latency_ms, tokens_info, total_tokens, cost,
          error_code, error_message, request_time
        )
        SELECT
          settlement_id, intent_id, owner_user_id, key_id, is_final,
          stream_end_reason, path, model_id, service_tier, status_code,
          ttfb_ms, latency_ms, tokens_info, total_tokens, cost,
          error_code, error_message, request_time
        FROM input
        ON CONFLICT (settlement_id) DO NOTHING
        RETURNING settlement_id, owner_user_id, key_id, model_id,
          request_time, total_tokens, cost
      ),
      accepted AS (
        SELECT input.*
        FROM input
        JOIN inserted_logs USING (settlement_id)
      ),
      key_charges AS (
        SELECT key_id, SUM(charge) AS amount
        FROM accepted
        WHERE key_id IS NOT NULL AND charge > 0
        GROUP BY key_id
      ),
      updated_keys AS (
        UPDATE api_keys keys
        SET used = GREATEST(0, COALESCE(keys.used, 0) + charges.amount)
        FROM key_charges charges
        WHERE keys.id = charges.key_id
        RETURNING keys.id, keys.used
      ),
      user_charges AS (
        SELECT owner_user_id, SUM(charge) AS amount
        FROM accepted
        WHERE owner_user_id IS NOT NULL AND charge > 0
        GROUP BY owner_user_id
      ),
      updated_users AS (
        UPDATE portal_users users
        SET balance = COALESCE(users.balance, 0) - charges.amount
        FROM user_charges charges
        WHERE users.id = charges.owner_user_id
        RETURNING users.id
      ),
      rollup_values AS (
        SELECT
          date_trunc('hour', request_time) AS hour_bucket,
          key_id,
          COALESCE(NULLIF(BTRIM(model_id), ''), 'unknown') AS model_id,
          COUNT(*)::bigint AS request_count,
          SUM(COALESCE(total_tokens, 0))::bigint AS total_tokens,
          SUM(COALESCE(cost, 0))::numeric AS total_cost
        FROM inserted_logs
        WHERE key_id IS NOT NULL
        GROUP BY 1, 2, 3
      ),
      updated_rollups AS (
        INSERT INTO model_response_log_hourly_rollups (
          hour_bucket, key_id, model_id, request_count, total_tokens, total_cost
        )
        SELECT
          hour_bucket, key_id, model_id, request_count, total_tokens, total_cost
        FROM rollup_values
        ON CONFLICT (hour_bucket, key_id, model_id)
        DO UPDATE SET
          request_count = model_response_log_hourly_rollups.request_count
            + EXCLUDED.request_count,
          total_tokens = model_response_log_hourly_rollups.total_tokens
            + EXCLUDED.total_tokens,
          total_cost = model_response_log_hourly_rollups.total_cost
            + EXCLUDED.total_cost,
          updated_at = now()
        RETURNING key_id
      )
      SELECT
        COALESCE(
          (SELECT jsonb_agg(settlement_id) FROM inserted_logs),
          '[]'::jsonb
        ) AS accepted_settlement_ids,
        COALESCE(
          (SELECT jsonb_object_agg(id::text, used::text) FROM updated_keys),
          '{}'::jsonb
        ) AS api_key_used
    `,
    [JSON.stringify(payload)],
  )
  return {
    acceptedSettlementIds: result.rows[0]?.accepted_settlement_ids ?? [],
    apiKeyUsedUsd: result.rows[0]?.api_key_used ?? {},
  }
}
