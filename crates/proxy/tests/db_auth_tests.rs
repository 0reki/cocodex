mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use cocodex_proxy::auth::jwt::{ClientJwt, now_secs};
use cocodex_proxy::auth::portal::{PortalTokenKind, verify_portal_token};
use cocodex_proxy::auth::session::{CodexClientSessionStore, create_pkce_pair};
use cocodex_proxy::create_router;
use cocodex_proxy::runtime::OwnerStatus;
use http_body_util::BodyExt;
use tower::ServiceExt;

/// A portal token exactly as the Node backend minted it.
fn node_portal_token(secret: &str, sub: &str, typ: &str, exp: u64) -> String {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use sha2::Sha256;
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(format!(
        r#"{{"sub":"{sub}","typ":"{typ}","iat":{},"exp":{exp}}}"#,
        now_secs()
    ));
    let input = format!("{header}.{payload}");
    // HMAC-SHA256 via the `hmac` construction on top of sha2.
    let mut key = [0u8; 64];
    key[..secret.len()].copy_from_slice(secret.as_bytes());
    let digest = |pad: u8, data: &[u8]| {
        use sha2::Digest;
        let mut hasher = Sha256::new();
        hasher.update(key.map(|byte| byte ^ pad));
        hasher.update(data);
        hasher.finalize()
    };
    let signature = digest(0x5c, &digest(0x36, input.as_bytes()));
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
}

#[test]
fn portal_tokens_from_node_verify() {
    let secret = common::TEST_SECRET;
    let token = node_portal_token(secret, "user-1", "access", now_secs() + 60);
    let claims = verify_portal_token(secret.as_bytes(), &token, PortalTokenKind::Access).unwrap();
    assert_eq!(claims.sub, "user-1");

    assert!(verify_portal_token(secret.as_bytes(), &token, PortalTokenKind::Refresh).is_none());
    assert!(verify_portal_token(b"other-secret", &token, PortalTokenKind::Access).is_none());
    let expired = node_portal_token(secret, "user-1", "access", now_secs() - 1);
    assert!(verify_portal_token(secret.as_bytes(), &expired, PortalTokenKind::Access).is_none());
}

#[tokio::test]
async fn db_sessions_rotate_and_revoke() {
    let db = common::test_db().await;
    let user_id = db.create_user("alice").await;
    let jwt = ClientJwt::from_secret(common::TEST_SECRET);
    let store = CodexClientSessionStore::with_jwt_and_db(jwt.clone(), db.pool.clone());

    let (verifier, challenge) = create_pkce_pair();
    let redirect_uri = "http://localhost:1455/auth/callback";
    let code = store
        .create_browser_authorization(
            user_id.clone(),
            "alice@openai.com",
            &challenge,
            redirect_uri,
        )
        .unwrap();
    let tokens = store
        .exchange_authorization_code(&code, redirect_uri, &verifier)
        .await
        .unwrap();
    let session_id = jwt
        .verify_access_token(&tokens.access_token)
        .unwrap()
        .session_id;
    assert!(store.is_session_live(&session_id).await.unwrap());

    let refreshed = store.refresh(&tokens.refresh_token).await.unwrap();
    assert_eq!(
        jwt.verify_access_token(&refreshed.access_token)
            .unwrap()
            .session_id,
        session_id
    );
    assert!(store.refresh(&tokens.refresh_token).await.is_none());

    // Revoking with the refresh token evicts the cached live session too.
    store.revoke(&refreshed.refresh_token).await;
    assert!(!store.is_session_live(&session_id).await.unwrap());
}

#[tokio::test]
async fn owner_status_follows_user_row() {
    let db = common::test_db().await;
    let user_id = db.create_user("bob").await;
    let (_, runtime) =
        cocodex_proxy::build(common::config(db.settings(), "http://127.0.0.1:9"), None);
    let ready = runtime.ready().await.unwrap();

    assert!(matches!(
        ready.verify_owner(&user_id).await.unwrap(),
        OwnerStatus::Active(_)
    ));
    assert!(matches!(
        ready
            .verify_owner("00000000-0000-0000-0000-000000000000")
            .await
            .unwrap(),
        OwnerStatus::Unknown
    ));
    assert!(matches!(
        ready.verify_owner("not-a-uuid").await.unwrap(),
        OwnerStatus::Unknown
    ));

    let other = db.create_user("carol").await;
    sqlx::query("UPDATE portal_users SET quota = 1, used = 1 WHERE id = $1::uuid")
        .bind(&other)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        ready.verify_owner(&other).await.unwrap(),
        OwnerStatus::QuotaExceeded(_)
    ));
    sqlx::query("UPDATE portal_users SET enabled = false WHERE id = $1::uuid")
        .bind(&other)
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(
        ready.verify_owner(&other).await.unwrap(),
        OwnerStatus::Disabled(_)
    ));
}

#[tokio::test]
async fn browser_authorize_uses_portal_token() {
    let db = common::test_db().await;
    let user_id = db.create_user("dave").await;
    let app = create_router(common::config(db.settings(), "http://127.0.0.1:9"), None);
    let (_, challenge) = create_pkce_pair();
    let body = serde_json::json!({
        "redirectUri": "http://localhost:1455/auth/callback",
        "codeChallenge": challenge,
        "state": "xyz",
    })
    .to_string();
    let request = |token: Option<String>| {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/codex-client/authorize")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header("cookie", format!("cocodex.access_token={token}"));
        }
        builder.body(Body::from(body.clone())).unwrap()
    };

    let response = app.clone().oneshot(request(None)).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let token = node_portal_token(common::TEST_SECRET, &user_id, "access", now_secs() + 60);
    let response = app.oneshot(request(Some(token))).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let redirect = json["redirectTo"].as_str().unwrap();
    assert!(redirect.starts_with("http://localhost:1455/auth/callback?code="));
    assert!(redirect.ends_with("&state=xyz"));
}
