use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::session::PollDeviceResult;
use crate::AppState;

pub fn create_auth_router() -> Router<AppState> {
    Router::new()
        .route("/api/accounts/deviceauth/usercode", post(handle_device_usercode))
        .route("/deviceauth/usercode", post(handle_device_usercode))
        .route("/api/accounts/deviceauth/token", post(handle_device_token))
        .route("/deviceauth/token", post(handle_device_token))
        .route("/oauth/authorize", get(handle_oauth_authorize))
        .route("/codex/device", get(handle_codex_device))
        .route("/oauth/token", post(handle_oauth_token))
        .route("/oauth/revoke", post(handle_oauth_revoke))
        .route("/deviceauth/callback", get(handle_deviceauth_callback))
        .route("/api/codex-client/authorize", post(handle_codex_client_authorize))
        .route("/api/codex-client/device/approve", post(handle_codex_client_device_approve))
}

fn frontend_login_redirect(public_app_url: &str, next_path: &str) -> String {
    let base = if public_app_url.is_empty() {
        "http://localhost:53332".to_string()
    } else {
        public_app_url.trim_end_matches('/').to_string()
    };
    let encoded_next = urlencoding_encode(next_path);
    format!("{base}/login?next={encoded_next}")
}

fn urlencoding_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn extract_portal_token(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            return Some(token.trim().to_string());
        }
    }
    if let Some(cookie) = headers.get(axum::http::header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in cookie.split(';') {
            let part = part.trim();
            if let Some((name, val)) = part.split_once('=') {
                let name = name.trim();
                if name == "cocodex.access_token" || name == "access_token" {
                    return Some(val.trim().to_string());
                }
            }
        }
    }
    None
}

// 1. POST /api/accounts/deviceauth/usercode
async fn handle_device_usercode(State(state): State<AppState>) -> Response {
    let resp = state.sessions.create_device_code();
    Json(resp).into_response()
}

// 2. POST /api/accounts/deviceauth/token
#[derive(Deserialize)]
struct DeviceTokenPollReq {
    device_auth_id: Option<String>,
    user_code: Option<String>,
}

async fn handle_device_token(
    State(state): State<AppState>,
    Json(payload): Json<DeviceTokenPollReq>,
) -> Response {
    let device_auth_id = payload.device_auth_id.unwrap_or_default();
    let user_code = payload.user_code.unwrap_or_default();

    match state.sessions.poll_device_token(&device_auth_id, &user_code) {
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
        PollDeviceResult::Pending => (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "authorization_pending" })),
        )
            .into_response(),
        PollDeviceResult::Unknown => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "invalid_device_code" })),
        )
            .into_response(),
    }
}

// 3. GET /oauth/authorize
async fn handle_oauth_authorize(
    State(state): State<AppState>,
    uri: axum::http::Uri,
) -> Redirect {
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let next = format!("/oauth/complete{query}");
    let dest = frontend_login_redirect(&state.public_app_url, &next);
    Redirect::temporary(&dest)
}

// 4. GET /codex/device
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
    let dest = frontend_login_redirect(&state.public_app_url, &next);
    Redirect::temporary(&dest)
}

// 5. POST /oauth/token
#[derive(Deserialize)]
struct OAuthTokenReq {
    grant_type: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
}

async fn handle_oauth_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: axum::body::Bytes,
) -> Response {
    // Can be JSON or application/x-www-form-urlencoded
    let is_form = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("application/x-www-form-urlencoded"));

    let req_data: OAuthTokenReq = if is_form {
        let mut data = OAuthTokenReq {
            grant_type: None,
            code: None,
            redirect_uri: None,
            code_verifier: None,
            refresh_token: None,
        };
        for (k, v) in url::form_urlencoded::parse(&body_bytes) {
            match k.as_ref() {
                "grant_type" => data.grant_type = Some(v.into_owned()),
                "code" => data.code = Some(v.into_owned()),
                "redirect_uri" => data.redirect_uri = Some(v.into_owned()),
                "code_verifier" => data.code_verifier = Some(v.into_owned()),
                "refresh_token" => data.refresh_token = Some(v.into_owned()),
                _ => {}
            }
        }
        data
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "invalid_request" })),
                )
                    .into_response()
            }
        }
    };

    let grant_type = req_data.grant_type.unwrap_or_default();
    if grant_type == "refresh_token" {
        let refresh_token = req_data.refresh_token.unwrap_or_default();
        if let Some(tokens) = state.sessions.refresh(&refresh_token).await {
            return Json(tokens).into_response();
        }
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_grant" })),
        )
            .into_response();
    }

    let code = req_data.code.unwrap_or_default();
    let redirect_uri = req_data.redirect_uri.unwrap_or_default();
    let code_verifier = req_data.code_verifier.unwrap_or_default();

    if let Some(tokens) = state
        .sessions
        .exchange_authorization_code(&code, &redirect_uri, &code_verifier)
        .await
    {
        return Json(tokens).into_response();
    }

    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid_grant" })),
    )
        .into_response()
}

// 6. POST /oauth/revoke
#[derive(Deserialize)]
struct OAuthRevokeReq {
    token: Option<String>,
    refresh_token: Option<String>,
}

async fn handle_oauth_revoke(
    State(state): State<AppState>,
    Json(payload): Json<OAuthRevokeReq>,
) -> Response {
    let token = payload
        .token
        .or(payload.refresh_token)
        .unwrap_or_default();
    state.sessions.revoke(&token).await;
    Json(json!({ "revoked": true })).into_response()
}

// 7. GET /deviceauth/callback
async fn handle_deviceauth_callback() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

// 8. POST /api/codex-client/authorize
#[derive(Deserialize)]
#[allow(non_snake_case)]
struct CodexClientAuthorizeReq {
    redirectUri: Option<String>,
    codeChallenge: Option<String>,
    state: Option<String>,
}

async fn handle_codex_client_authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CodexClientAuthorizeReq>,
) -> Response {
    let portal_token = match extract_portal_token(&headers) {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "message": "Unauthorized",
                        "code": "unauthorized"
                    }
                })),
            )
                .into_response()
        }
    };

    let redirect_uri = match payload.redirectUri {
        Some(r) if !r.trim().is_empty() => r.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Missing redirectUri",
                        "code": "invalid_request"
                    }
                })),
            )
                .into_response()
        }
    };

    let code_challenge = match payload.codeChallenge {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Missing codeChallenge",
                        "code": "invalid_request"
                    }
                })),
            )
                .into_response()
        }
    };

    // Verify portal user via UDS IPC
    let verify_res = match state.ipc_client.verify_portal_token(&portal_token).await {
        Ok(res) => res,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": {
                        "message": format!("IPC error: {e}"),
                        "code": "ipc_error"
                    }
                })),
            )
                .into_response()
        }
    };

    let user = match (verify_res.valid, verify_res.user) {
        (true, Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "message": "Unauthorized or inactive user",
                        "code": "unauthorized"
                    }
                })),
            )
                .into_response()
        }
    };

    // Bind the portal user via UDS IPC
    let email = format!("{}@openai.com", user.username);
    let code = state.sessions.create_browser_authorization(
        user.id,
        &email,
        &code_challenge,
        &redirect_uri,
    );

    let mut parsed_redirect = match url::Url::parse(&redirect_uri) {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Invalid redirectUri format",
                        "code": "invalid_request"
                    }
                })),
            )
                .into_response()
        }
    };

    parsed_redirect.query_pairs_mut().append_pair("code", &code);
    if let Some(s) = payload.state {
        if !s.is_empty() {
            parsed_redirect.query_pairs_mut().append_pair("state", &s);
        }
    }

    Json(json!({ "redirectTo": parsed_redirect.to_string() })).into_response()
}

// 9. POST /api/codex-client/device/approve
#[derive(Deserialize)]
#[allow(non_snake_case)]
struct CodexClientDeviceApproveReq {
    userCode: Option<String>,
}

// Portal browser callback. Device sessions live in this process; user
// lookup goes to Node over UDS RPC (`auth.verify_portal_token`).
async fn handle_codex_client_device_approve(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CodexClientDeviceApproveReq>,
) -> Response {
    let portal_token = match extract_portal_token(&headers) {
        Some(t) => t,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "message": "Unauthorized",
                        "code": "unauthorized"
                    }
                })),
            )
                .into_response()
        }
    };

    let user_code = match payload.userCode {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": {
                        "message": "Device code is required",
                        "code": "invalid_request"
                    }
                })),
            )
                .into_response()
        }
    };

    // Verify portal user via UDS IPC
    let verify_res = match state.ipc_client.verify_portal_token(&portal_token).await {
        Ok(res) => res,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": {
                        "message": format!("IPC error: {e}"),
                        "code": "ipc_error"
                    }
                })),
            )
                .into_response()
        }
    };

    let user = match (verify_res.valid, verify_res.user) {
        (true, Some(u)) => u,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": {
                        "message": "Unauthorized or inactive user",
                        "code": "unauthorized"
                    }
                })),
            )
                .into_response()
        }
    };

    let email = format!("{}@openai.com", user.username);
    match state.sessions.approve_device(&user_code, user.id, &email) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": {
                    "message": err,
                    "code": "device_approval_failed"
                }
            })),
        )
            .into_response(),
    }
}
