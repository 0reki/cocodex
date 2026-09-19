// Handlers bail out early with a ready-made `Response` as the error value;
// boxing it would only add noise to every call site.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use super::portal::{PortalTokenKind, verify_portal_token};
use super::session::PollDeviceResult;
use crate::AppState;
use crate::db;
use crate::db::users::PortalUser;
use crate::runtime::{NotReady, Ready};

pub fn create_auth_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/accounts/deviceauth/usercode",
            post(handle_device_usercode),
        )
        .route("/deviceauth/usercode", post(handle_device_usercode))
        .route("/api/accounts/deviceauth/token", post(handle_device_token))
        .route("/deviceauth/token", post(handle_device_token))
        .route("/oauth/authorize", get(handle_oauth_authorize))
        .route("/codex/device", get(handle_codex_device))
        .route("/oauth/token", post(handle_oauth_token))
        .route("/oauth/revoke", post(handle_oauth_revoke))
        .route("/deviceauth/callback", get(handle_deviceauth_callback))
        .route(
            "/api/codex-client/authorize",
            post(handle_codex_client_authorize),
        )
        .route(
            "/api/codex-client/device/approve",
            post(handle_codex_client_device_approve),
        )
}

/// `{"error": {"message", "code"}}`, the shape the portal frontend expects.
fn portal_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message, "code": code } })),
    )
        .into_response()
}

/// `{"error": "<code>"}`, the OAuth shape Codex expects.
fn oauth_error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}

async fn ready(state: &AppState) -> Result<Arc<Ready>, Response> {
    state.runtime.ready().await.map_err(|error| {
        warn!(%error, "client auth unavailable");
        match error {
            NotReady::SetupRequired => portal_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "setup_required",
                "Gateway setup has not been completed",
            ),
            NotReady::Database(_) => portal_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "Database is unavailable",
            ),
        }
    })
}

fn frontend_login_redirect(public_app_url: &str, next_path: &str) -> String {
    let base = if public_app_url.is_empty() {
        "http://localhost:53332".to_string()
    } else {
        public_app_url.trim_end_matches('/').to_string()
    };
    format!("{base}/login?next={}", urlencoding_encode(next_path))
}

fn urlencoding_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn extract_portal_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && let Some(token) = auth.strip_prefix("Bearer ")
    {
        return Some(token.trim().to_string());
    }
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok())?;
    cookie.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        matches!(name.trim(), "cocodex.access_token" | "access_token")
            .then(|| value.trim().to_string())
    })
}

/// Resolves the enabled portal user behind the request's portal access token.
async fn portal_user(ready: &Ready, headers: &HeaderMap) -> Result<PortalUser, Response> {
    let unauthorized = || {
        portal_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Unauthorized or inactive user",
        )
    };
    let token = extract_portal_token(headers).ok_or_else(unauthorized)?;
    let claims = verify_portal_token(&ready.portal_secret, &token, PortalTokenKind::Access)
        .ok_or_else(unauthorized)?;
    match db::users::find_by_id(&ready.db, &claims.sub).await {
        Ok(Some(user)) if user.enabled => Ok(user),
        Ok(_) => Err(unauthorized()),
        Err(error) => {
            warn!(%error, "portal user lookup failed");
            Err(portal_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database_unavailable",
                "Database is unavailable",
            ))
        }
    }
}

fn gateway_email(user: &PortalUser) -> String {
    format!("{}@openai.com", user.username)
}

// POST /api/accounts/deviceauth/usercode
async fn handle_device_usercode(State(state): State<AppState>) -> Response {
    match ready(&state).await {
        Ok(ready) => Json(ready.sessions.create_device_code()).into_response(),
        Err(response) => response,
    }
}

// POST /api/accounts/deviceauth/token
#[derive(Deserialize)]
struct DeviceTokenPollReq {
    device_auth_id: Option<String>,
    user_code: Option<String>,
}

async fn handle_device_token(
    State(state): State<AppState>,
    Json(payload): Json<DeviceTokenPollReq>,
) -> Response {
    let ready = match ready(&state).await {
        Ok(ready) => ready,
        Err(response) => return response,
    };
    let device_auth_id = payload.device_auth_id.unwrap_or_default();
    let user_code = payload.user_code.unwrap_or_default();

    match ready
        .sessions
        .poll_device_token(&device_auth_id, &user_code)
    {
        PollDeviceResult::Complete {
            authorization_code,
            code_challenge,
            code_verifier,
        } => Json(json!({
            "authorization_code": authorization_code,
            "code_challenge": code_challenge,
            "code_verifier": code_verifier,
        }))
        .into_response(),
        PollDeviceResult::Pending => oauth_error(StatusCode::FORBIDDEN, "authorization_pending"),
        PollDeviceResult::Unknown => oauth_error(StatusCode::NOT_FOUND, "invalid_device_code"),
    }
}

// GET /oauth/authorize
async fn handle_oauth_authorize(State(state): State<AppState>, uri: axum::http::Uri) -> Redirect {
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let next = format!("/oauth/complete{query}");
    Redirect::temporary(&frontend_login_redirect(&state.public_app_url, &next))
}

// GET /codex/device
#[derive(Deserialize)]
struct CodexDeviceQuery {
    user_code: Option<String>,
}

async fn handle_codex_device(
    State(state): State<AppState>,
    Query(query): Query<CodexDeviceQuery>,
) -> Redirect {
    let next = match query.user_code {
        Some(code) if !code.is_empty() => {
            format!("/codex/device?user_code={}", urlencoding_encode(&code))
        }
        _ => "/codex/device".to_string(),
    };
    Redirect::temporary(&frontend_login_redirect(&state.public_app_url, &next))
}

// POST /oauth/token
#[derive(Deserialize, Default)]
struct OAuthTokenReq {
    grant_type: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

fn parse_token_request(headers: &HeaderMap, body: &[u8]) -> Option<OAuthTokenReq> {
    let is_form = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("application/x-www-form-urlencoded"));
    if !is_form {
        return serde_json::from_slice(body).ok();
    }
    let mut data = OAuthTokenReq::default();
    for (key, value) in url::form_urlencoded::parse(body) {
        let slot = match key.as_ref() {
            "grant_type" => &mut data.grant_type,
            "code" => &mut data.code,
            "redirect_uri" => &mut data.redirect_uri,
            "code_verifier" => &mut data.code_verifier,
            "refresh_token" => &mut data.refresh_token,
            _ => continue,
        };
        *slot = Some(value.into_owned());
    }
    Some(data)
}

async fn handle_oauth_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(request) = parse_token_request(&headers, &body) else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request");
    };
    let ready = match ready(&state).await {
        Ok(ready) => ready,
        Err(response) => return response,
    };

    let tokens = if request.grant_type.as_deref() == Some("refresh_token") {
        ready
            .sessions
            .refresh(&request.refresh_token.unwrap_or_default())
            .await
    } else {
        ready
            .sessions
            .exchange_authorization_code(
                &request.code.unwrap_or_default(),
                &request.redirect_uri.unwrap_or_default(),
                &request.code_verifier.unwrap_or_default(),
            )
            .await
    };
    match tokens {
        Some(tokens) => Json(tokens).into_response(),
        None => oauth_error(StatusCode::BAD_REQUEST, "invalid_grant"),
    }
}

// POST /oauth/revoke
#[derive(Deserialize)]
struct OAuthRevokeReq {
    token: Option<String>,
    refresh_token: Option<String>,
}

async fn handle_oauth_revoke(
    State(state): State<AppState>,
    Json(payload): Json<OAuthRevokeReq>,
) -> Response {
    let ready = match ready(&state).await {
        Ok(ready) => ready,
        Err(response) => return response,
    };
    let token = payload.token.or(payload.refresh_token).unwrap_or_default();
    ready.sessions.revoke(&token).await;
    Json(json!({ "revoked": true })).into_response()
}

// GET /deviceauth/callback
async fn handle_deviceauth_callback() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

// POST /api/codex-client/authorize
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexClientAuthorizeReq {
    redirect_uri: Option<String>,
    code_challenge: Option<String>,
    state: Option<String>,
}

fn required(value: Option<String>, message: &str) -> Result<String, Response> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| portal_error(StatusCode::BAD_REQUEST, "invalid_request", message))
}

async fn handle_codex_client_authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CodexClientAuthorizeReq>,
) -> Response {
    let result = async {
        let redirect_uri = required(payload.redirect_uri, "Missing redirectUri")?;
        let code_challenge = required(payload.code_challenge, "Missing codeChallenge")?;
        let ready = ready(&state).await?;
        let user = portal_user(&ready, &headers).await?;

        let code = ready
            .sessions
            .create_browser_authorization(
                user.id.clone(),
                &gateway_email(&user),
                &code_challenge,
                &redirect_uri,
            )
            .map_err(|message| {
                portal_error(StatusCode::BAD_REQUEST, "invalid_request", &message)
            })?;

        // Validated as a loopback callback above, so this parse cannot fail.
        let mut redirect =
            url::Url::parse(&redirect_uri).map_err(|_| StatusCode::BAD_REQUEST.into_response())?;
        redirect.query_pairs_mut().append_pair("code", &code);
        if let Some(value) = payload.state.filter(|value| !value.is_empty()) {
            redirect.query_pairs_mut().append_pair("state", &value);
        }
        Ok::<_, Response>(Json(json!({ "redirectTo": redirect.to_string() })).into_response())
    }
    .await;
    result.unwrap_or_else(|response| response)
}

// POST /api/codex-client/device/approve
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexClientDeviceApproveReq {
    user_code: Option<String>,
}

async fn handle_codex_client_device_approve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CodexClientDeviceApproveReq>,
) -> Response {
    let result = async {
        let user_code = required(payload.user_code, "Device code is required")?;
        let ready = ready(&state).await?;
        let user = portal_user(&ready, &headers).await?;
        ready
            .sessions
            .approve_device(&user_code, user.id.clone(), &gateway_email(&user))
            .map_err(|message| {
                portal_error(StatusCode::BAD_REQUEST, "device_approval_failed", &message)
            })?;
        Ok::<_, Response>(Json(json!({ "ok": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|response| response)
}
