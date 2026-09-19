//! Upstream (OpenAI) login management for admins.

use std::collections::HashMap;
use std::time::Instant;

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::{Body, Db, Principal, fail, internal};
use crate::AppState;
use crate::billing::usage;
use crate::db;
use crate::db::accounts::{Account, UpsertInput, normalize_platform, normalize_status};
use crate::upstream::client::{Credentials, DevicePoll};
use crate::upstream::sse;
use crate::upstream::usage_summary;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/openai-accounts", get(list).post(upsert))
        .route("/api/openai-accounts/bulk-remove", post(bulk_remove))
        .route("/api/openai-accounts/bulk-disable", post(bulk_disable))
        .route("/api/openai-accounts/device-auth/start", post(device_start))
        .route("/api/openai-accounts/device-auth/poll", post(device_poll))
        .route("/api/openai-accounts/{email}", get(detail).delete(remove))
        .route("/api/openai-accounts/{email}/disable", post(disable))
        .route("/api/openai-accounts/{email}/activate", post(activate))
        .route("/api/openai-accounts/{email}/usage", get(account_usage))
        .route("/api/openai-accounts/{email}/test", post(test))
}

fn public_account(account: &Account) -> Value {
    json!({
        "id": account.id,
        "email": account.email,
        "accountId": account.account_id,
        "status": account.status(),
        "platform": account.platform(),
        "createdAt": db::iso(account.created_at),
        "updatedAt": db::iso(account.updated_at),
    })
}

fn failure(status: StatusCode, error: &str, detail: impl std::fmt::Display) -> Response {
    (
        status,
        Json(json!({ "error": error, "detail": detail.to_string() })),
    )
        .into_response()
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

/// `platform` from a body: absent is `Ok(None)`, unknown is an error.
fn parse_platform(body: &Body) -> Result<Option<&'static str>, Response> {
    let raw = body.str("platform");
    if raw.is_empty() {
        return Ok(None);
    }
    normalize_platform(&raw)
        .map(Some)
        .ok_or_else(|| bad_request("platform is invalid"))
}

fn emails(body: &Body) -> Vec<String> {
    body.0
        .get("emails")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

async fn list(Db(ready): Db, Query(query): Query<HashMap<String, String>>) -> Response {
    let number = |key: &str| {
        query
            .get(key)
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let page = number("page")
        .map(|v| v.floor().max(1.0) as i64)
        .unwrap_or(1);
    let page_size = number("pageSize")
        .or_else(|| number("limit"))
        .map(|v| v.floor().clamp(1.0, 500.0) as i64)
        .unwrap_or(50);
    let status = query.get("status").cloned().unwrap_or_default();
    let keyword = query.get("q").cloned().unwrap_or_default();
    match db::accounts::list_page(&ready.db, page, page_size, &status, &keyword).await {
        Ok(data) => Json(json!({
            "items": data.items.iter().map(public_account).collect::<Vec<_>>(),
            "count": data.total,
            "page": data.page,
            "pageSize": data.page_size,
            "totalPages": ((data.total + data.page_size - 1) / data.page_size).max(1),
        }))
        .into_response(),
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to list accounts",
            error,
        ),
    }
}

async fn detail(Db(ready): Db, Path(email): Path<String>) -> Response {
    match db::accounts::get_by_email(&ready.db, &email).await {
        Ok(Some(account)) => Json(public_account(&account)).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Account not found" })),
        )
            .into_response(),
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to fetch account",
            error,
        ),
    }
}

async fn remove(Db(ready): Db, Path(email): Path<String>) -> Response {
    match db::accounts::delete_by_email(&ready.db, email.trim()).await {
        Ok(true) => {
            ready.accounts.invalidate_rows().await;
            Json(json!({ "ok": true, "deleted": 1 })).into_response()
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, "Account not found"),
        Err(error) => internal(error),
    }
}

async fn bulk_remove(Db(ready): Db, body: Body) -> Response {
    let emails = emails(&body);
    if emails.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "emails is required");
    }
    match db::accounts::delete_many(&ready.db, &emails).await {
        Ok(deleted) => {
            ready.accounts.invalidate_rows().await;
            Json(json!({ "ok": true, "deleted": deleted, "requested": emails.len() }))
                .into_response()
        }
        Err(error) => internal(error),
    }
}

async fn disable(Db(ready): Db, Path(email): Path<String>) -> Response {
    match db::accounts::disable(&ready.db, email.trim()).await {
        Ok(true) => {
            ready.accounts.invalidate_rows().await;
            Json(json!({ "ok": true, "updated": 1, "status": "disabled" })).into_response()
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, "Account not found"),
        Err(error) => internal(error),
    }
}

async fn activate(Db(ready): Db, Path(email): Path<String>) -> Response {
    match db::accounts::activate(&ready.db, email.trim()).await {
        Ok(true) => {
            ready.accounts.invalidate_rows().await;
            Json(json!({ "ok": true, "updated": 1, "status": "active" })).into_response()
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, "Account not found"),
        Err(error) => internal(error),
    }
}

async fn bulk_disable(Db(ready): Db, body: Body) -> Response {
    let emails = emails(&body);
    if emails.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "emails is required");
    }
    match db::accounts::disable_many(&ready.db, &emails).await {
        Ok(updated) => {
            ready.accounts.invalidate_rows().await;
            Json(json!({
                "ok": true,
                "updated": updated,
                "requested": emails.len(),
                "status": "disabled",
            }))
            .into_response()
        }
        Err(error) => internal(error),
    }
}

async fn upsert(Db(ready): Db, body: Body) -> Response {
    let fields = [
        "email",
        "accountId",
        "idToken",
        "accessToken",
        "refreshToken",
    ];
    let missing: Vec<&str> = fields
        .iter()
        .copied()
        .filter(|f| body.str(f).is_empty())
        .collect();
    if !missing.is_empty() {
        return bad_request(&format!("Missing required fields: {}", missing.join(", ")));
    }
    let status_input = body.str("status");
    let status = if status_input.is_empty() {
        None
    } else {
        match normalize_status(&status_input) {
            Some(status) => Some(status),
            None => return bad_request("status is invalid"),
        }
    };
    let platform = match parse_platform(&body) {
        Ok(platform) => platform,
        Err(response) => return response,
    };
    let result = db::accounts::upsert(
        &ready.db,
        UpsertInput {
            email: body.str("email"),
            account_id: body.str("accountId"),
            status,
            platform,
            id_token: body.str("idToken"),
            access_token: body.str("accessToken"),
            refresh_token: body.str("refreshToken"),
        },
    )
    .await;
    match result {
        Ok(account) => {
            ready.accounts.invalidate_rows().await;
            (StatusCode::CREATED, Json(public_account(&account))).into_response()
        }
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to upsert account",
            error,
        ),
    }
}

async fn device_start(Db(ready): Db, body: Body) -> Response {
    let platform = match parse_platform(&body) {
        Ok(platform) => platform,
        Err(response) => return response,
    };
    match ready
        .accounts
        .client
        .request_device_code(platform.unwrap_or("all"))
        .await
    {
        Ok(code) => (
            StatusCode::CREATED,
            Json(json!({
                "deviceAuthId": code.device_auth_id,
                "userCode": code.user_code,
                "verificationUrl": code.verification_url,
                "intervalSeconds": code.interval_seconds,
                "expiresInSeconds": code.expires_in_seconds,
                "platform": platform,
                "expiresAt": db::iso(chrono::Utc::now() + chrono::Duration::seconds(code.expires_in_seconds as i64)),
            })),
        )
            .into_response(),
        Err(error) => failure(StatusCode::BAD_GATEWAY, "Failed to start OpenAI device authentication", error),
    }
}

async fn device_poll(Db(ready): Db, body: Body) -> Response {
    let device_auth_id = body.str("deviceAuthId");
    let user_code = body.str("userCode");
    if device_auth_id.is_empty() || user_code.is_empty() {
        return bad_request("deviceAuthId and userCode are required");
    }
    let platform = match parse_platform(&body) {
        Ok(platform) => platform,
        Err(response) => return response,
    };
    let result = ready
        .accounts
        .client
        .poll_device(&device_auth_id, &user_code, platform.unwrap_or("all"))
        .await;
    let (email, account_id, id_token, access_token, refresh_token) = match result {
        Ok(DevicePoll::Pending) => return Json(json!({ "status": "pending" })).into_response(),
        Ok(DevicePoll::Complete {
            email,
            account_id,
            id_token,
            access_token,
            refresh_token,
        }) => (email, account_id, id_token, access_token, refresh_token),
        Err(error) => {
            return failure(
                StatusCode::BAD_GATEWAY,
                "Failed to complete OpenAI device authentication",
                error,
            );
        }
    };
    let saved = db::accounts::upsert(
        &ready.db,
        UpsertInput {
            email,
            account_id,
            status: None,
            platform,
            id_token,
            access_token,
            refresh_token,
        },
    )
    .await;
    match saved {
        Ok(account) => {
            ready.accounts.invalidate_rows().await;
            (
                StatusCode::CREATED,
                Json(json!({ "status": "complete", "account": public_account(&account) })),
            )
                .into_response()
        }
        Err(error) => failure(
            StatusCode::BAD_GATEWAY,
            "Failed to complete OpenAI device authentication",
            error,
        ),
    }
}

async fn account_usage(Db(ready): Db, Path(email): Path<String>) -> Response {
    let account = match db::accounts::get_by_email(&ready.db, &email).await {
        Ok(Some(account)) if !account.access_token.trim().is_empty() => account,
        Ok(_) => return fail(StatusCode::NOT_FOUND, "Account not found"),
        Err(error) => return internal(error),
    };
    let captured_at = chrono::Utc::now();
    let result = async {
        let usage = ready.accounts.usage(&account).await?;
        let (start, end) = usage_summary::analytics_range(&usage, captured_at);
        let daily = ready
            .accounts
            .call_with_refresh(&account, |row| {
                let (start, end) = (start.clone(), end.clone());
                let client = ready.accounts.client.clone();
                async move {
                    client
                        .daily_usage(
                            &Credentials {
                                access_token: &row.access_token,
                                account_id: &row.account_id,
                                platform: row.platform(),
                            },
                            &start,
                            &end,
                        )
                        .await
                }
            })
            .await?;
        Ok::<_, crate::upstream::client::UpstreamError>(usage_summary::summarize(
            &usage,
            &daily,
            captured_at,
        ))
    }
    .await;
    match result {
        Ok(summary) => {
            let mut body = json!({ "ok": true });
            if let (Value::Object(target), Value::Object(fields)) = (&mut body, summary) {
                target.extend(fields);
            }
            Json(body).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": "Failed to fetch upstream usage", "detail": error.message })),
        )
            .into_response(),
    }
}

/// Sends a small request through the login and reports the reply. Counts
/// against the admin's upstream share like any other request.
async fn test(
    Db(ready): Db,
    principal: Principal,
    Path(email): Path<String>,
    body: Body,
) -> Response {
    let started = Instant::now();
    let account = match db::accounts::get_by_email(&ready.db, &email).await {
        Ok(Some(account)) if !account.access_token.trim().is_empty() => account,
        Ok(_) => return fail(StatusCode::NOT_FOUND, "Account not found"),
        Err(error) => return internal(error),
    };
    let model = Some(body.str("model"))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "gpt-5.6-luna".into());
    if !ready
        .quota
        .check(&account.account_id, &principal.id)
        .await
        .allowed
    {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "upstream_user_quota_exceeded",
        );
    }
    let text = Some(body.str("text"))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "test".into());
    let settlement_id = uuid::Uuid::new_v4().to_string();
    let payload = json!({
        "model": model,
        "instructions": "",
        "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] }],
        "tools": [],
        "store": false,
        "stream": true,
        "prompt_cache_key": settlement_id,
    });
    let result = ready
        .accounts
        .call_with_refresh(&account, |row| {
            let client = ready.accounts.client.clone();
            let payload = payload.clone();
            async move {
                client
                    .post_responses(
                        &Credentials {
                            access_token: &row.access_token,
                            account_id: &row.account_id,
                            platform: row.platform(),
                        },
                        &payload,
                    )
                    .await
            }
        })
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let (status, text) = match result {
        Ok(reply) => reply,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "durationMs": duration_ms, "error": error.message })),
            )
                .into_response();
        }
    };
    if let Some(usage) = sse::terminal_response(&text).and_then(|response| {
        response
            .get("usage")
            .and_then(Value::as_object)
            .map(usage::extract)
    }) && let Some(cost) = ready.pricing.estimate(Some(&model), &usage.tokens_info)
    {
        ready
            .quota
            .record(&settlement_id, &account.account_id, &principal.id, cost)
            .await;
    }
    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
    (
        status_code,
        Json(json!({
            "ok": status_code.is_success(),
            "durationMs": duration_ms,
            "upstreamStatus": status,
            "result": sse::output_text(&text),
        })),
    )
        .into_response()
}
