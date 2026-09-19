//! Console sign-in: login, refresh (HTTP-only cookie), logout and
//! invitation-based registration.

use axum::extract::Path;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{Body, Db, fail, internal, no_store};
use crate::AppState;
use crate::auth::password;
use crate::auth::portal::{PortalTokenKind, issue_portal_token, verify_portal_token};
use crate::db;
use crate::db::invitations::{InvitationError, RegisterError};
use crate::db::users::PortalUserRecord;
use crate::runtime::Ready;

const REFRESH_COOKIE: &str = "cocodex.refresh_token";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/invitations/{token}", get(inspect_invitation))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
}

pub fn hash_invitation_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn public_user(user: &PortalUserRecord) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "role": user.role(),
        "enabled": user.enabled,
    })
}

fn cookie_suffix() -> &'static str {
    if std::env::var("NODE_ENV").is_ok_and(|v| v == "production") {
        "; Path=/api/auth; HttpOnly; Secure; SameSite=Strict"
    } else {
        "; Path=/api/auth; HttpOnly; SameSite=Strict"
    }
}

fn http_date(secs: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(secs as i64, 0)
        .unwrap_or_default()
        .format("%a, %d %b %Y %H:%M:%S GMT")
        .to_string()
}

fn set_cookie(response: &mut Response, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
}

fn clear_refresh_cookie(response: &mut Response) {
    set_cookie(
        response,
        format!(
            "{REFRESH_COOKIE}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT{}",
            cookie_suffix()
        ),
    );
}

/// `{ ok, user, accessToken }` plus a fresh refresh-token cookie.
fn signed_in(ready: &Ready, user: &PortalUserRecord, status: StatusCode) -> Response {
    let access = issue_portal_token(&ready.portal_secret, &user.id, PortalTokenKind::Access);
    let refresh = issue_portal_token(&ready.portal_secret, &user.id, PortalTokenKind::Refresh);
    let mut response = (
        status,
        Json(json!({
            "ok": true,
            "user": public_user(user),
            "accessToken": { "token": access.token, "expiresAt": access.expires_at },
        })),
    )
        .into_response();
    set_cookie(
        &mut response,
        format!(
            "{REFRESH_COOKIE}={}; Expires={}{}",
            refresh.token,
            http_date(refresh.expires_at),
            cookie_suffix()
        ),
    );
    no_store(response)
}

fn read_cookie(headers: &HeaderMap, name: &str) -> String {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|part| {
            let (key, value) = part.split_once('=')?;
            (key.trim() == name).then(|| {
                url::form_urlencoded::parse(format!("v={}", value.trim()).as_bytes())
                    .next()
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default()
            })
        })
        .unwrap_or_default()
}

async fn inspect_invitation(Db(ready): Db, Path(token): Path<String>) -> Response {
    let token = token.trim();
    if token.is_empty() {
        return no_store(fail(
            StatusCode::BAD_REQUEST,
            "Invitation token is required",
        ));
    }
    no_store(
        match db::invitations::inspect(&ready.db, &hash_invitation_token(token)).await {
            Ok(Ok(invitation)) => {
                Json(json!({ "ok": true, "expiresAt": db::iso(invitation.expires_at) }))
                    .into_response()
            }
            Ok(Err(reason)) => fail(StatusCode::GONE, reason.code()),
            Err(error) => internal(error),
        },
    )
}

async fn register(Db(ready): Db, body: Body) -> Response {
    let invite = body.str("inviteToken");
    let username = body.str("username");
    let secret = body.raw("password");
    if invite.is_empty() || username.is_empty() || secret.is_empty() {
        return no_store(fail(
            StatusCode::BAD_REQUEST,
            "inviteToken, username and password are required",
        ));
    }
    let token_hash = hash_invitation_token(&invite);
    match db::invitations::inspect(&ready.db, &token_hash).await {
        Ok(Ok(_)) => {}
        Ok(Err(reason)) => return no_store(fail(StatusCode::GONE, reason.code())),
        Err(error) => return no_store(internal(error)),
    }
    if let Some(error) = password::validation_error(&secret) {
        return no_store(fail(StatusCode::BAD_REQUEST, error));
    }
    let hash = password::hash(secret).await;
    match db::invitations::register(&ready.db, &token_hash, &username, &hash).await {
        Ok(user) => signed_in(&ready, &user, StatusCode::CREATED),
        Err(RegisterError::Invitation(error)) => no_store(fail(
            if error == InvitationError::UserLimitReached {
                StatusCode::CONFLICT
            } else {
                StatusCode::GONE
            },
            error.code(),
        )),
        Err(RegisterError::UsernameTaken) => {
            no_store(fail(StatusCode::CONFLICT, "Username already exists"))
        }
        Err(RegisterError::Database(error)) => no_store(internal(error)),
    }
}

async fn login(Db(ready): Db, body: Body) -> Response {
    if let Err(error) = db::users::ensure_bootstrap_admin(&ready.db).await {
        return no_store(internal(error));
    }
    let username = body.str("username").to_lowercase();
    let secret = body.raw("password");
    let invalid = || no_store(fail(StatusCode::UNAUTHORIZED, "Invalid credentials"));
    if password::validation_error(&secret).is_some() || username.is_empty() {
        return invalid();
    }
    let user = match db::users::get_by_username(&ready.db, &username).await {
        Ok(Some(user)) if user.enabled => user,
        Ok(_) => return invalid(),
        Err(error) => return no_store(internal(error)),
    };
    if !password::verify(secret, user.password_hash.clone()).await {
        return invalid();
    }
    signed_in(&ready, &user, StatusCode::OK)
}

async fn refresh(Db(ready): Db, headers: HeaderMap) -> Response {
    let token = read_cookie(&headers, REFRESH_COOKIE);
    let rejected = |message: &str| {
        let mut response = no_store(fail(StatusCode::UNAUTHORIZED, message));
        clear_refresh_cookie(&mut response);
        response
    };
    let Some(claims) = verify_portal_token(&ready.portal_secret, &token, PortalTokenKind::Refresh)
    else {
        return rejected("Invalid refresh token");
    };
    match db::users::get_record(&ready.db, &claims.sub).await {
        Ok(Some(user)) if user.enabled => signed_in(&ready, &user, StatusCode::OK),
        Ok(_) => rejected("User is unavailable"),
        Err(error) => no_store(internal(error)),
    }
}

async fn logout() -> Response {
    let mut response = no_store(Json(json!({ "ok": true })).into_response());
    clear_refresh_cookie(&mut response);
    response
}
