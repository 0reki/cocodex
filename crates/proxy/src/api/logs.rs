//! Request logs and hourly statistics. Admins see everything, users their own.

use std::collections::HashMap;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use super::{Db, Principal};
use crate::AppState;
use crate::db;
use crate::db::logs::LogFilters;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/request-logs", get(list))
        .route("/api/request-logs/hourly", get(hourly))
}

const STATUSES: [&str; 4] = ["success", "failed", "aborted", "incomplete"];

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn query_error(error: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Failed to query request logs", "detail": error.to_string() })),
    )
        .into_response()
}

fn bounded(query: &HashMap<String, String>, key: &str, fallback: i64, maximum: i64) -> i64 {
    query
        .get(key)
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .map(|v| (v.floor() as i64).clamp(1, maximum))
        .unwrap_or(fallback)
}

fn is_date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok() && value.len() == 10
}

async fn list(
    Db(ready): Db,
    principal: Principal,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let get = |key: &str| {
        query
            .get(key)
            .map(|v| v.trim().to_string())
            .unwrap_or_default()
    };
    let status = Some(get("status"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| get("requestStatus"));
    if !status.is_empty() && !STATUSES.contains(&status.as_str()) {
        return error(StatusCode::BAD_REQUEST, "status is invalid");
    }
    let key_id = get("keyId");
    if !key_id.is_empty() && uuid::Uuid::parse_str(&key_id).is_err() {
        return error(StatusCode::BAD_REQUEST, "keyId is invalid");
    }
    let filters = LogFilters {
        key_id,
        model_id: get("modelId"),
        request_status: status,
        request_date: get("date"),
        request_date_from: get("dateFrom"),
        request_date_to: get("dateTo"),
    };
    if [
        &filters.request_date,
        &filters.request_date_from,
        &filters.request_date_to,
    ]
    .iter()
    .any(|d| !d.is_empty() && !is_date(d))
    {
        return error(StatusCode::BAD_REQUEST, "date filter is invalid");
    }
    let owner = (!principal.is_admin()).then_some(principal.id.as_str());
    let limit = bounded(&query, "limit", 50, 500);
    match db::logs::list(&ready.db, owner, limit, &get("cursor"), &filters).await {
        Ok(Ok(page)) => Json(json!({
            "items": page.items,
            "nextCursor": page.next_cursor,
            "hasMore": page.has_more,
            "limit": page.limit,
        }))
        .into_response(),
        Ok(Err(_)) => error(StatusCode::BAD_REQUEST, "Invalid request log cursor"),
        Err(e) => query_error(e),
    }
}

async fn hourly(
    Db(ready): Db,
    principal: Principal,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let lookback = bounded(&query, "lookbackHours", 24 * 30, 24 * 90);
    let max_models = bounded(&query, "maxModels", 6, 12);
    let owner = (!principal.is_admin()).then_some(principal.id.as_str());
    let result = tokio::try_join!(
        db::logs::hourly_series(&ready.db, owner, lookback, max_models),
        db::logs::request_rates(&ready.db, owner),
    );
    match result {
        Ok((mut series, (rpm, tpm))) => {
            if let Value::Object(map) = &mut series {
                map.insert("rpm5m".into(), json!(rpm));
                map.insert("tpm5m".into(), json!(tpm));
            }
            Json(series).into_response()
        }
        Err(e) => query_error(e),
    }
}
