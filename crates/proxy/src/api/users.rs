//! Console user management and the signed-in user's own quota view.

use std::collections::HashMap;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde_json::{Value, json};

use super::{Body, Db, Principal, fail, internal, no_store};
use crate::AppState;
use crate::auth::password;
use crate::billing::usd::Usd;
use crate::db;
use crate::db::assignments::SetOutcome;
use crate::db::invitations::CreateError;
use crate::db::users::{PortalUserRecord, UserWriteError};
use crate::runtime::Ready;

pub fn self_routes() -> Router<AppState> {
    Router::new().route("/api/my-usage", get(my_usage))
}

pub fn admin_routes() -> Router<AppState> {
    Router::new()
        .route("/api/user-invitations", post(create_invitation))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{id}/upstream", put(set_upstream))
        .route("/api/users/{id}/username", put(set_username))
        .route("/api/users/{id}/quota", put(set_quota))
        .route("/api/users/{id}/password", put(set_password))
        .route("/api/users/{id}/enable", post(enable))
        .route("/api/users/{id}/disable", post(disable))
}

/// Upstream assignment of a user: the ChatGPT account and one of its logins
/// (`sourceAccountId`, kept for clients that still address logins by id).
#[derive(Clone)]
struct AssignmentView {
    account_id: String,
    source_account_id: Option<String>,
}

fn public_user(user: &PortalUserRecord, assignment: Option<Option<&AssignmentView>>) -> Value {
    let mut value = json!({
        "id": user.id,
        "username": user.username,
        "role": user.role(),
        "enabled": user.enabled,
        "quota": user.quota,
        "used": user.used,
    });
    if let Some(assignment) = assignment {
        value["sourceAccountId"] = json!(assignment.and_then(|a| a.source_account_id.clone()));
        value["accountId"] = json!(assignment.map(|a| a.account_id.clone()));
    }
    value["createdAt"] = json!(db::iso(user.created_at));
    value["updatedAt"] = json!(db::iso(user.updated_at));
    value
}

async fn assignment_views(ready: &Ready) -> Result<HashMap<String, AssignmentView>, sqlx::Error> {
    let assignments = db::assignments::list(&ready.db).await?;
    let mut representatives: HashMap<String, Option<String>> = HashMap::new();
    let mut views = HashMap::new();
    for assignment in assignments {
        if !representatives.contains_key(&assignment.account_id) {
            let row = db::accounts::representative(&ready.db, &assignment.account_id).await?;
            representatives.insert(assignment.account_id.clone(), row.map(|row| row.id));
        }
        views.insert(
            assignment.owner_user_id,
            AssignmentView {
                source_account_id: representatives[&assignment.account_id].clone(),
                account_id: assignment.account_id,
            },
        );
    }
    Ok(views)
}

fn user_write_error(error: UserWriteError) -> Response {
    match error {
        UserWriteError::UsernameTaken => fail(StatusCode::CONFLICT, "Username already exists"),
        UserWriteError::SeatLimitReached => fail(StatusCode::CONFLICT, "user_limit_reached"),
        UserWriteError::Database(error) => internal(error),
    }
}

fn updated(
    result: Result<Option<PortalUserRecord>, UserWriteError>,
) -> Result<PortalUserRecord, Response> {
    match result {
        Ok(Some(user)) => Ok(user),
        Ok(None) => Err(fail(StatusCode::NOT_FOUND, "User not found")),
        Err(error) => Err(user_write_error(error)),
    }
}

async fn my_usage(Db(ready): Db, principal: Principal) -> Response {
    let unassigned = || {
        no_store(
            (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": {
                        "message": "尚未分配上游账号",
                        "type": "invalid_request_error",
                        "code": "upstream_account_unassigned",
                    }
                })),
            )
                .into_response(),
        )
    };
    let account_id = match ready.accounts.assigned_account(&principal.id).await {
        Ok(Some(account_id)) => account_id,
        Ok(None) => return unassigned(),
        Err(error) => return no_store(internal(error)),
    };
    let summary = match ready.quota.summary(&account_id, &principal.id).await {
        Ok(summary) => summary,
        Err(error) if error == "upstream_account_unassigned" => return unassigned(),
        Err(detail) => {
            return no_store(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "ok": false, "error": "upstream_usage_unavailable", "detail": detail })),
                )
                    .into_response(),
            );
        }
    };
    let (users, views) =
        match tokio::try_join!(db::users::list(&ready.db), assignment_views(&ready)) {
            Ok(result) => result,
            Err(error) => return no_store(internal(error)),
        };
    let mut body = json!({ "ok": true });
    if let (Value::Object(target), Value::Object(fields)) = (&mut body, summary) {
        target.extend(fields);
    }
    body["users"] = users
        .iter()
        .filter(|user| {
            views
                .get(&user.id)
                .is_some_and(|v| v.account_id == account_id)
        })
        .map(|user| public_user(user, None))
        .collect();
    no_store(Json(body).into_response())
}

fn invitation_ttl() -> chrono::Duration {
    let seconds = std::env::var("PORTAL_INVITATION_TTL_SECONDS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.floor() as i64)
        .unwrap_or(7 * 24 * 60 * 60);
    chrono::Duration::seconds(seconds)
}

fn public_base_url(headers: &HeaderMap) -> String {
    if let Ok(configured) = std::env::var("PUBLIC_APP_URL")
        && !configured.trim().is_empty()
    {
        return configured.trim().to_string();
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !origin.trim().is_empty()
    {
        return origin.trim().to_string();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    format!("http://{host}")
}

async fn create_invitation(Db(ready): Db, principal: Principal, headers: HeaderMap) -> Response {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let expires_at = chrono::Utc::now() + invitation_ttl();
    let hash = super::portal_auth::hash_invitation_token(&token);
    let invitation =
        match db::invitations::create(&ready.db, &hash, &principal.id, expires_at).await {
            Ok(invitation) => invitation,
            Err(CreateError::UserLimitReached) => {
                return no_store(fail(StatusCode::CONFLICT, "user_limit_reached"));
            }
            Err(CreateError::Database(error)) => return no_store(internal(error)),
        };
    let path = format!(
        "/register?invite={}",
        url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
    );
    let url = url::Url::parse(&public_base_url(&headers))
        .and_then(|base| base.join(&path))
        .map(|url| url.to_string())
        .unwrap_or_else(|_| path.clone());
    no_store(
        (
            StatusCode::CREATED,
            Json(json!({
                "ok": true,
                "invitation": {
                    "id": invitation.id,
                    "invitedByUserId": invitation.invited_by_user_id,
                    "registeredUserId": invitation.registered_user_id,
                    "expiresAt": db::iso(invitation.expires_at),
                    "usedAt": invitation.used_at.map(db::iso),
                    "createdAt": db::iso(invitation.created_at),
                },
                "registrationPath": path,
                "registrationUrl": url,
            })),
        )
            .into_response(),
    )
}

async fn list_users(Db(ready): Db) -> Response {
    let (users, views) =
        match tokio::try_join!(db::users::list(&ready.db), assignment_views(&ready)) {
            Ok(result) => result,
            Err(error) => return internal(error),
        };
    Json(json!({
        "items": users.iter().map(|user| public_user(user, Some(views.get(&user.id)))).collect::<Vec<_>>(),
        "count": users.len(),
    }))
    .into_response()
}

/// Accepts `accountId` (a ChatGPT account id) or, for older clients,
/// `sourceAccountId` (the id of one of its logins); `null` clears.
async fn set_upstream(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    let key = if body.0.contains_key("accountId") {
        "accountId"
    } else {
        "sourceAccountId"
    };
    let requested = match body.0.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.trim().to_string()).filter(|v| !v.is_empty()),
        Some(_) => {
            return fail(
                StatusCode::BAD_REQUEST,
                format!("{key} must be a string or null"),
            );
        }
    };
    if id.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id param is required");
    }
    let account_id = match (key, requested) {
        (_, None) => None,
        ("accountId", Some(account_id)) => Some(account_id),
        (_, Some(row_id)) => match db::accounts::get_by_id(&ready.db, &row_id).await {
            Ok(Some(row)) => Some(row.account_id),
            Ok(None) => return fail(StatusCode::NOT_FOUND, "upstream_account_unavailable"),
            Err(error) => return internal(error),
        },
    };
    let outcome = match db::assignments::set(&ready.db, &id, account_id.as_deref()).await {
        Ok(outcome) => outcome,
        Err(error) => return internal(error),
    };
    ready.accounts.invalidate_assignments().await;
    let assignment = match outcome {
        SetOutcome::Unavailable => {
            return fail(StatusCode::NOT_FOUND, "upstream_account_unavailable");
        }
        SetOutcome::Cleared => {
            json!({ "assigned": false, "accountId": null, "sourceAccountId": null })
        }
        SetOutcome::Assigned => {
            let account_id = account_id.unwrap_or_default();
            let representative = db::accounts::representative(&ready.db, &account_id)
                .await
                .ok()
                .flatten()
                .map(|row| row.id);
            let quota = ready.quota.clone();
            let sync_id = account_id.clone();
            tokio::spawn(async move {
                let _ = quota.sync(&sync_id).await;
            });
            json!({ "assigned": true, "accountId": account_id, "sourceAccountId": representative })
        }
    };
    Json(json!({ "ok": true, "assignment": assignment })).into_response()
}

async fn create_user(Db(ready): Db, body: Body) -> Response {
    let username = body.str("username");
    let secret = body.raw("password");
    if username.is_empty() || secret.is_empty() {
        return fail(
            StatusCode::BAD_REQUEST,
            "username and password are required",
        );
    }
    if let Some(error) = password::validation_error(&secret) {
        return fail(StatusCode::BAD_REQUEST, error);
    }
    let hash = password::hash(secret).await;
    match db::users::create_user(&ready.db, &username, &hash).await {
        Ok(user) => (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "user": public_user(&user, Some(None)) })),
        )
            .into_response(),
        Err(error) => user_write_error(error),
    }
}

async fn set_username(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    let username = body.str("username");
    if id.trim().is_empty() || username.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id and username are required");
    }
    match updated(db::users::update_username(&ready.db, &id, &username).await) {
        Ok(user) => Json(json!({ "ok": true, "user": public_user(&user, None) })).into_response(),
        Err(response) => response,
    }
}

async fn set_quota(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    if id.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id is required");
    }
    let quota = match body.0.get("quota") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(value) => match Usd::from_json(value) {
            Some(amount) if amount.0 >= 0 => Some(amount.to_string()),
            _ => return fail(StatusCode::BAD_REQUEST, "quota is invalid"),
        },
    };
    match updated(db::users::update_quota(&ready.db, &id, quota).await) {
        Ok(user) => {
            ready.evict_owner(&id).await;
            Json(json!({ "ok": true, "user": public_user(&user, None) })).into_response()
        }
        Err(response) => response,
    }
}

async fn set_password(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    let secret = body.raw("password");
    if id.trim().is_empty() || secret.is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id and password are required");
    }
    if let Some(error) = password::validation_error(&secret) {
        return fail(StatusCode::BAD_REQUEST, error);
    }
    let hash = password::hash(secret).await;
    match updated(db::users::update_password(&ready.db, &id, &hash).await) {
        Ok(user) => {
            // A new password signs every Codex client of the user out.
            if let Err(error) = ready.sessions.revoke_owner(&user.id).await {
                return internal(error);
            }
            Json(json!({ "ok": true })).into_response()
        }
        Err(response) => response,
    }
}

async fn enable(Db(ready): Db, Path(id): Path<String>) -> Response {
    if id.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id is required");
    }
    match updated(db::users::set_enabled(&ready.db, &id, true).await) {
        Ok(user) => {
            ready.evict_owner(&id).await;
            Json(json!({ "ok": true, "user": public_user(&user, None) })).into_response()
        }
        Err(response) => response,
    }
}

async fn disable(Db(ready): Db, principal: Principal, Path(id): Path<String>) -> Response {
    if id.trim().is_empty() {
        return fail(StatusCode::BAD_REQUEST, "id is required");
    }
    if principal.id.eq_ignore_ascii_case(id.trim()) {
        return fail(
            StatusCode::BAD_REQUEST,
            "The current user cannot disable itself",
        );
    }
    match updated(db::users::set_enabled(&ready.db, &id, false).await) {
        Ok(user) => {
            ready.evict_owner(&id).await;
            Json(json!({ "ok": true, "user": public_user(&user, None) })).into_response()
        }
        Err(response) => response,
    }
}
