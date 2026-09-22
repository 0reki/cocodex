//! The management API used by the web console.

// Handlers bail out early with a ready-made `Response` as the error value.
#![allow(clippy::result_large_err)]

pub mod accounts;
pub mod health;
pub mod install;
pub mod logs;
pub mod portal_auth;
pub mod setup;
pub mod turn_state;
pub mod users;

use std::sync::Arc;

use axum::Router;
use axum::extract::{FromRequest, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use tracing::{debug, error};

use crate::AppState;
use crate::auth::portal::{PortalTokenKind, verify_portal_token};
use crate::runtime::{NotReady, Ready};

/// `{"error": {"message", "type", "code"}}`.
pub fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    let kind = if status.is_server_error() {
        "server_error"
    } else {
        "invalid_request_error"
    };
    if status.is_server_error() {
        error!(status = status.as_u16(), %code, %message, "request failed");
    } else {
        debug!(status = status.as_u16(), %code, %message, "request refused");
    }
    (
        status,
        axum::Json(json!({ "error": { "message": message, "type": kind, "code": code } })),
    )
        .into_response()
}

/// `{"ok": false, "error": "<message>"}`, the shape most console routes use.
///
/// Every failure is logged as well as answered: the admin reading the console
/// and whoever reads the server are rarely the same person, and a message that
/// lives only in the response leaves nothing to debug with once the page is
/// closed. A server error is worth a line of its own; a refused or missing
/// request is routine and stays at debug.
pub fn fail(status: StatusCode, error: impl Into<String>) -> Response {
    let error = error.into();
    if status.is_server_error() {
        error!(status = status.as_u16(), %error, "console request failed");
    } else {
        debug!(status = status.as_u16(), %error, "console request refused");
    }
    (status, axum::Json(json!({ "ok": false, "error": error }))).into_response()
}

pub fn internal(error: impl std::fmt::Display) -> Response {
    fail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

pub fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn not_ready(error: &NotReady) -> Response {
    match error {
        NotReady::SetupRequired => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "setup_required",
            "Setup has not been completed",
        ),
        NotReady::Database(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "database_unavailable",
            "Database is unavailable",
        ),
    }
}

/// The database-backed runtime, or a 503.
pub struct Db(pub Arc<Ready>);

impl FromRequestParts<AppState> for Db {
    type Rejection = Response;

    async fn from_request_parts(_parts: &mut Parts, state: &AppState) -> Result<Self, Response> {
        state
            .runtime
            .ready()
            .await
            .map(Db)
            .map_err(|e| not_ready(&e))
    }
}

/// A JSON object body. Missing or empty bodies read as `{}`, like Express.
pub struct Body(pub Map<String, Value>);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Response> {
        let bytes = axum::body::Bytes::from_request(req, state)
            .await
            .map_err(|_| {
                api_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "Request payload too large",
                )
            })?;
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Body(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Ok(Body(map)),
            Ok(_) => Ok(Body(Map::new())),
            Err(_) => Err(api_error(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "Invalid JSON payload",
            )),
        }
    }
}

impl Body {
    /// A trimmed string field, or `""`.
    pub fn str(&self, key: &str) -> String {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    }

    /// A string field kept verbatim (passwords), or `""`.
    pub fn raw(&self, key: &str) -> String {
        self.0
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }
}

/// The signed-in console user.
#[derive(Debug, Clone)]
pub struct Principal {
    pub id: String,
    pub username: String,
    pub role: String,
}

impl Principal {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Principal {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Response> {
        parts.extensions.get::<Principal>().cloned().ok_or_else(|| {
            api_error(
                StatusCode::UNAUTHORIZED,
                "missing_access_token",
                "Access token is required",
            )
        })
    }
}

async fn authenticate(state: &AppState, parts: &Parts) -> Result<Principal, Response> {
    let unauthorized =
        |code: &str, message: &str| api_error(StatusCode::UNAUTHORIZED, code, message);
    let auth = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if auth.is_empty() {
        return Err(unauthorized(
            "missing_access_token",
            "Access token is required",
        ));
    }
    if auth.len() < 7 || !auth[..7].eq_ignore_ascii_case("bearer ") {
        return Err(unauthorized(
            "unsupported_authorization_scheme",
            "Authorization header must use Bearer scheme",
        ));
    }
    let token = auth[7..].trim();
    if token.is_empty() {
        return Err(unauthorized("empty_bearer_token", "Bearer token is empty"));
    }
    let ready = state.runtime.ready().await.map_err(|e| not_ready(&e))?;
    let claims = verify_portal_token(&ready.portal_secret, token, PortalTokenKind::Access)
        .ok_or_else(|| unauthorized("invalid_access_token", "Invalid access token"))?;
    let user = crate::db::users::find_by_id(&ready.db, &claims.sub)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "access_token_validation_failed",
                "Failed to validate access token scope",
            )
        })?
        .filter(|user| user.enabled)
        .ok_or_else(|| unauthorized("user_unavailable", "User is disabled or unavailable"))?;
    Ok(Principal {
        id: user.id,
        username: user.username,
        role: if user.role == "admin" {
            "admin"
        } else {
            "user"
        }
        .to_string(),
    })
}

async fn require_user(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let (mut parts, body) = req.into_parts();
    match authenticate(&state, &parts).await {
        Ok(principal) => {
            parts.extensions.insert(principal);
            next.run(Request::from_parts(parts, body)).await
        }
        Err(response) => response,
    }
}

async fn require_admin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let (mut parts, body) = req.into_parts();
    match authenticate(&state, &parts).await {
        Ok(principal) if principal.is_admin() => {
            parts.extensions.insert(principal);
            next.run(Request::from_parts(parts, body)).await
        }
        Ok(_) => api_error(StatusCode::FORBIDDEN, "forbidden", "Forbidden"),
        Err(response) => response,
    }
}

pub fn router(state: AppState) -> Router<AppState> {
    let public = Router::new()
        .merge(health::routes())
        .merge(setup::routes())
        .merge(install::routes())
        .merge(portal_auth::routes());
    let signed_in = Router::new()
        .merge(logs::routes())
        .merge(users::self_routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_user));
    let admin = Router::new()
        .merge(users::admin_routes())
        .merge(accounts::routes())
        .merge(turn_state::routes())
        .route_layer(middleware::from_fn_with_state(state, require_admin));
    public
        .merge(signed_in)
        .merge(admin)
        .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024))
}
