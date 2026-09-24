//! Request log listing and hourly statistics for the console.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use super::iso;

#[derive(Debug, Default, Clone)]
pub struct LogFilters {
    pub key_id: String,
    pub model_id: String,
    pub request_status: String,
    pub request_date: String,
    pub request_date_from: String,
    pub request_date_to: String,
}

#[derive(sqlx::FromRow)]
struct LogRow {
    id: Uuid,
    intent_id: Option<String>,
    is_final: Option<bool>,
    stream_end_reason: Option<String>,
    path: String,
    model_id: Option<String>,
    requested_model: Option<String>,
    used_model: Option<String>,
    turn_state_len: Option<i32>,
    key_id: Option<String>,
    service_tier: Option<String>,
    status_code: Option<i32>,
    ttfb_ms: Option<i32>,
    ttft_ms: Option<i32>,
    latency_ms: Option<i32>,
    tokens_info: Option<Value>,
    total_tokens: Option<i32>,
    cost: Option<f64>,
    error_code: Option<String>,
    error_message: Option<String>,
    request_time: DateTime<Utc>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl LogRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "intentId": self.intent_id,
            "isFinal": self.is_final,
            "streamEndReason": self.stream_end_reason,
            "path": self.path,
            "modelId": self.model_id,
            "requestedModel": self.requested_model,
            "usedModel": self.used_model,
            "turnStateLen": self.turn_state_len,
            "keyId": self.key_id,
            "serviceTier": self.service_tier,
            "statusCode": self.status_code,
            "ttfbMs": self.ttfb_ms,
            "ttftMs": self.ttft_ms,
            "latencyMs": self.latency_ms,
            "tokensInfo": self.tokens_info,
            "totalTokens": self.total_tokens,
            "cost": self.cost.filter(|cost| cost.is_finite()),
            "errorCode": self.error_code,
            "errorMessage": self.error_message,
            "requestTime": iso(self.request_time),
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    request_time: String,
    id: String,
}

#[derive(Debug)]
pub struct InvalidCursor;

fn decode_cursor(raw: &str) -> Result<Option<(DateTime<Utc>, Uuid)>, InvalidCursor> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| InvalidCursor)?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| InvalidCursor)?;
    let time = DateTime::parse_from_rfc3339(&cursor.request_time)
        .map_err(|_| InvalidCursor)?
        .with_timezone(&Utc);
    let id = Uuid::parse_str(&cursor.id).map_err(|_| InvalidCursor)?;
    Ok(Some((time, id)))
}

fn encode_cursor(row: &LogRow) -> String {
    // Microseconds, the column's precision, so rows sharing a millisecond
    // are not skipped. Millisecond cursors from older clients still parse.
    let cursor = Cursor {
        request_time: row
            .request_time
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        id: row.id.to_string(),
    };
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap_or_default())
}

/// Status buckets as the console defines them.
fn status_sql(status: &str) -> Option<&'static str> {
    Some(match status {
        "success" => "logs.status_code >= 200 AND logs.status_code < 300 AND logs.is_final = TRUE",
        "aborted" => {
            "logs.status_code >= 200 AND logs.status_code < 300 \
             AND COALESCE(logs.stream_end_reason, '') LIKE 'client_aborted%'"
        }
        "incomplete" => {
            "logs.status_code >= 200 AND logs.status_code < 300 \
             AND COALESCE(logs.is_final, FALSE) = FALSE \
             AND COALESCE(logs.error_code, '') = '' \
             AND (logs.stream_end_reason IS NULL OR logs.stream_end_reason = '')"
        }
        "failed" => {
            "((logs.status_code IS NOT NULL AND (logs.status_code < 200 OR logs.status_code >= 300)) \
             OR (logs.status_code >= 200 AND logs.status_code < 300 \
               AND COALESCE(logs.is_final, FALSE) = FALSE \
               AND (COALESCE(logs.error_code, '') <> '' \
                 OR (COALESCE(logs.stream_end_reason, '') <> '' \
                   AND COALESCE(logs.stream_end_reason, '') NOT LIKE 'client_aborted%'))))"
        }
        _ => return None,
    })
}

pub struct LogPage {
    pub items: Vec<Value>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub limit: i64,
}

/// Newest-first page of logs; `owner` restricts to one user.
pub async fn list(
    pool: &PgPool,
    owner: Option<&str>,
    limit: i64,
    cursor: &str,
    filters: &LogFilters,
) -> Result<Result<LogPage, InvalidCursor>, sqlx::Error> {
    let limit = limit.clamp(1, 500);
    let cursor = match decode_cursor(cursor) {
        Ok(cursor) => cursor,
        Err(error) => return Ok(Err(error)),
    };
    let date_from = [&filters.request_date_from, &filters.request_date]
        .into_iter()
        .find(|value| !value.is_empty())
        .cloned();
    let date_to = [&filters.request_date_to, &filters.request_date]
        .into_iter()
        .find(|value| !value.is_empty())
        .cloned();
    let nonempty = |value: &String| (!value.is_empty()).then(|| value.clone());

    let mut where_parts = vec![
        "($1::uuid IS NULL OR logs.owner_user_id = $1)".to_string(),
        "($2::uuid IS NULL OR logs.key_id = $2)".to_string(),
        "($3::text IS NULL OR logs.model_id = $3)".to_string(),
        "($4::date IS NULL OR logs.request_time >= $4::date)".to_string(),
        "($5::date IS NULL OR logs.request_time < ($5::date + INTERVAL '1 day'))".to_string(),
        "($6::timestamptz IS NULL OR (logs.request_time, logs.id) < ($6, $7::uuid))".to_string(),
    ];
    if let Some(sql) = status_sql(&filters.request_status) {
        where_parts.push(sql.to_string());
    }
    let sql = format!(
        r#"
        SELECT
          logs.id, logs.intent_id, logs.is_final, logs.stream_end_reason,
          logs.path, logs.model_id, logs.requested_model, logs.used_model,
          logs.turn_state_len, logs.key_id::text AS key_id, logs.service_tier,
          logs.status_code, logs.ttfb_ms, logs.ttft_ms, logs.latency_ms, logs.tokens_info,
          logs.total_tokens, logs.cost::float8 AS cost, logs.error_code, logs.error_message,
          logs.request_time, logs.created_at, logs.updated_at
        FROM model_response_logs logs
        WHERE {}
        ORDER BY logs.request_time DESC, logs.id DESC
        LIMIT $8
        "#,
        where_parts.join(" AND ")
    );
    let parse_uuid = |value: &str| Uuid::parse_str(value.trim()).ok();
    let mut rows: Vec<LogRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(owner.and_then(parse_uuid))
        .bind(parse_uuid(&filters.key_id))
        .bind(nonempty(&filters.model_id))
        .bind(date_from)
        .bind(date_to)
        .bind(cursor.map(|(time, _)| time))
        .bind(cursor.map(|(_, id)| id))
        .bind(limit + 1)
        .fetch_all(pool)
        .await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(Ok(LogPage {
        next_cursor: if has_more {
            rows.last().map(encode_cursor)
        } else {
            None
        },
        items: rows.iter().map(LogRow::to_json).collect(),
        has_more,
        limit,
    }))
}

/// Hourly tokens/cost/requests of the top models, zero-filled per hour.
pub async fn hourly_series(
    pool: &PgPool,
    owner: Option<&str>,
    lookback_hours: i64,
    max_models: i64,
) -> Result<Value, sqlx::Error> {
    let owner = owner.and_then(|owner| Uuid::parse_str(owner).ok());
    let rows: Vec<(DateTime<Utc>, String, f64, f64, f64)> = sqlx::query_as(
        r#"
        WITH bounds AS (
          SELECT
            date_trunc('hour', now()) AS end_hour,
            date_trunc('hour', now()) - (($2::int - 1) * interval '1 hour') AS start_hour
        ),
        scoped AS (
          SELECT rollups.*
          FROM model_response_log_owner_hourly_rollups rollups, bounds
          WHERE ($1::uuid IS NULL OR rollups.owner_user_id = $1)
            AND rollups.hour_bucket >= bounds.start_hour
            AND rollups.hour_bucket < (bounds.end_hour + interval '1 hour')
        ),
        top_models AS (
          SELECT model_id, SUM(total_tokens) AS total_tokens
          FROM scoped
          GROUP BY 1
          ORDER BY total_tokens DESC, model_id ASC
          LIMIT $3
        ),
        hourly AS (
          SELECT hour_bucket, model_id,
            SUM(total_tokens) AS tokens, SUM(total_cost) AS cost, SUM(request_count) AS requests
          FROM scoped
          WHERE model_id IN (SELECT model_id FROM top_models)
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
          COALESCE(hourly.tokens, 0)::float8,
          COALESCE(hourly.cost, 0)::float8,
          COALESCE(hourly.requests, 0)::float8
        FROM hourly_series
        CROSS JOIN top_models
        LEFT JOIN hourly
          ON hourly.hour_bucket = hourly_series.hour_bucket
         AND hourly.model_id = top_models.model_id
        ORDER BY hourly_series.hour_bucket ASC, top_models.model_id ASC
        "#,
    )
    .bind(owner)
    .bind(lookback_hours.clamp(1, 24 * 90) as i32)
    .bind(max_models.clamp(1, 12))
    .fetch_all(pool)
    .await?;

    let mut models: Vec<String> = Vec::new();
    let mut points: Vec<(String, serde_json::Map<String, Value>)> = Vec::new();
    for (hour, model, tokens, cost, requests) in rows {
        let model = if model.is_empty() {
            "unknown".to_string()
        } else {
            model
        };
        if !models.contains(&model) {
            models.push(model.clone());
        }
        let hour = iso(hour);
        if points.last().is_none_or(|(last, _)| *last != hour) {
            points.push((hour, serde_json::Map::new()));
        }
        points.last_mut().expect("pushed above").1.insert(
            model,
            json!({ "tokens": tokens, "cost": cost, "requests": requests }),
        );
    }
    let points: Vec<Value> = points
        .into_iter()
        .map(|(hour, mut values)| {
            for model in &models {
                values
                    .entry(model.clone())
                    .or_insert_with(|| json!({ "tokens": 0, "cost": 0, "requests": 0 }));
            }
            json!({ "hour": hour, "values": values })
        })
        .collect();
    Ok(json!({ "models": models, "points": points }))
}

/// Requests and tokens per minute over the last five minutes.
pub async fn request_rates(pool: &PgPool, owner: Option<&str>) -> Result<(f64, f64), sqlx::Error> {
    let owner = owner.and_then(|owner| Uuid::parse_str(owner).ok());
    sqlx::query_as(
        r#"
        SELECT
          ROUND(COUNT(*)::numeric / 5, 2)::float8,
          ROUND(COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::numeric / 5, 2)::float8
        FROM model_response_logs
        WHERE request_time >= now() - interval '5 minutes'
          AND ($1::uuid IS NULL OR owner_user_id = $1)
        "#,
    )
    .bind(owner)
    .fetch_one(pool)
    .await
}
