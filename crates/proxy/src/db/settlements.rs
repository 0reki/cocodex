//! Writes finished requests: a log row, the owner's spend, and the hourly
//! rollup, all in one statement per batch and idempotent by settlement id.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::billing::usd::Usd;

/// One finished request. Serialized field-for-field like the Node backend's
/// write-ahead log, whose amounts are integers in 1e-8 USD.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settlement {
    pub settlement_id: String,
    pub intent_id: Option<String>,
    pub owner_user_id: Option<String>,
    #[serde(default)]
    pub api_key_id: Option<String>,
    #[serde(with = "scaled_usd")]
    pub charge: Usd,
    pub is_final: Option<bool>,
    pub stream_end_reason: Option<String>,
    pub path: String,
    pub model_id: Option<String>,
    /// The model the client asked for. Skipped when absent so a legacy WAL
    /// record round-trips byte for byte.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_model: Option<String>,
    /// The model the upstream completed event reports as used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_model: Option<String>,
    /// Length of the upstream turn state, when the response carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_state_len: Option<i64>,
    pub service_tier: Option<String>,
    pub status_code: Option<i64>,
    pub ttfb_ms: Option<i64>,
    /// Time to the first generated token; see `ResponseObservation::ttft_ms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<i64>,
    pub latency_ms: Option<i64>,
    pub tokens_info: Option<serde_json::Value>,
    pub total_tokens: Option<i64>,
    #[serde(with = "scaled_usd_opt")]
    pub cost: Option<Usd>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub request_time: String,
}

mod scaled_usd {
    use super::Usd;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Usd, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&value.0.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Usd, D::Error> {
        let raw = String::deserialize(d)?;
        raw.parse::<i128>()
            .map(Usd)
            .map_err(serde::de::Error::custom)
    }
}

mod scaled_usd_opt {
    use super::Usd;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<Usd>, s: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => s.serialize_str(&value.0.to_string()),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Usd>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|raw| {
                raw.parse::<i128>()
                    .map(Usd)
                    .map_err(serde::de::Error::custom)
            })
            .transpose()
    }
}

pub struct FlushResult {
    pub accepted: Vec<String>,
    /// Owners whose spend reached their quota with this batch.
    pub owners_over_quota: Vec<String>,
}

pub async fn flush(pool: &PgPool, batch: &[Settlement]) -> Result<FlushResult, sqlx::Error> {
    if batch.is_empty() {
        return Ok(FlushResult {
            accepted: Vec::new(),
            owners_over_quota: Vec::new(),
        });
    }
    let payload: Vec<serde_json::Value> = batch
        .iter()
        .map(|item| {
            serde_json::json!({
                "settlement_id": item.settlement_id,
                "intent_id": item.intent_id,
                "owner_user_id": item.owner_user_id,
                "key_id": item.api_key_id,
                "charge": item.charge.to_string(),
                "is_final": item.is_final,
                "stream_end_reason": item.stream_end_reason,
                "path": item.path,
                "model_id": item.model_id,
                "requested_model": item.requested_model,
                "used_model": item.used_model,
                "turn_state_len": item.turn_state_len,
                "service_tier": item.service_tier,
                "status_code": item.status_code,
                "ttfb_ms": item.ttfb_ms,
                "ttft_ms": item.ttft_ms,
                "latency_ms": item.latency_ms,
                "tokens_info": item.tokens_info,
                "total_tokens": item.total_tokens,
                "cost": item.cost.map(|cost| cost.to_string()),
                "error_code": item.error_code,
                "error_message": item.error_message,
                "request_time": item.request_time,
            })
        })
        .collect();

    let (accepted, owners_over_quota): (serde_json::Value, serde_json::Value) = sqlx::query_as(
        r#"
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
            requested_model text,
            used_model text,
            turn_state_len integer,
            service_tier text,
            status_code integer,
            ttfb_ms integer,
            ttft_ms integer,
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
            stream_end_reason, path, model_id, requested_model, used_model,
            turn_state_len, service_tier, status_code,
            ttfb_ms, ttft_ms, latency_ms, tokens_info, total_tokens, cost,
            error_code, error_message, request_time
          )
          SELECT
            input.settlement_id, input.intent_id,
            users.id, input.key_id, input.is_final,
            input.stream_end_reason, input.path, input.model_id,
            input.requested_model, input.used_model, input.turn_state_len,
            input.service_tier,
            input.status_code, input.ttfb_ms, input.ttft_ms, input.latency_ms, input.tokens_info,
            input.total_tokens, input.cost, input.error_code, input.error_message,
            input.request_time
          FROM input
          LEFT JOIN portal_users AS users ON users.id = input.owner_user_id
          ON CONFLICT (settlement_id) DO NOTHING
          RETURNING settlement_id, owner_user_id, model_id, request_time, total_tokens, cost
        ),
        accepted AS (
          SELECT input.*
          FROM input
          JOIN inserted_logs USING (settlement_id)
        ),
        user_charges AS (
          SELECT owner_user_id, SUM(charge) AS amount
          FROM accepted
          WHERE owner_user_id IS NOT NULL AND charge > 0
          GROUP BY owner_user_id
        ),
        updated_users AS (
          UPDATE portal_users users
          SET used = GREATEST(0, COALESCE(users.used, 0) + charges.amount)
          FROM user_charges charges
          WHERE users.id = charges.owner_user_id
          RETURNING users.id, users.used, users.quota
        ),
        rollup_values AS (
          SELECT
            date_trunc('hour', request_time) AS hour_bucket,
            owner_user_id,
            COALESCE(NULLIF(BTRIM(model_id), ''), 'unknown') AS model_id,
            COUNT(*)::bigint AS request_count,
            SUM(COALESCE(total_tokens, 0))::bigint AS total_tokens,
            SUM(COALESCE(cost, 0))::numeric AS total_cost
          FROM inserted_logs
          WHERE owner_user_id IS NOT NULL
          GROUP BY 1, 2, 3
        ),
        updated_rollups AS (
          INSERT INTO model_response_log_owner_hourly_rollups (
            hour_bucket, owner_user_id, model_id, request_count, total_tokens, total_cost
          )
          SELECT hour_bucket, owner_user_id, model_id, request_count, total_tokens, total_cost
          FROM rollup_values
          ON CONFLICT (hour_bucket, owner_user_id, model_id)
          DO UPDATE SET
            request_count = model_response_log_owner_hourly_rollups.request_count
              + EXCLUDED.request_count,
            total_tokens = model_response_log_owner_hourly_rollups.total_tokens
              + EXCLUDED.total_tokens,
            total_cost = model_response_log_owner_hourly_rollups.total_cost
              + EXCLUDED.total_cost,
            updated_at = now()
          RETURNING 1
        )
        SELECT
          COALESCE((SELECT jsonb_agg(settlement_id) FROM inserted_logs), '[]'::jsonb),
          COALESCE(
            (SELECT jsonb_agg(id::text) FROM updated_users
              WHERE quota IS NOT NULL AND used >= quota),
            '[]'::jsonb
          )
        "#,
    )
    .bind(serde_json::Value::Array(payload))
    .fetch_one(pool)
    .await?;

    let strings = |value: serde_json::Value| -> Vec<String> {
        serde_json::from_value(value).unwrap_or_default()
    };
    Ok(FlushResult {
        accepted: strings(accepted),
        owners_over_quota: strings(owners_over_quota),
    })
}
