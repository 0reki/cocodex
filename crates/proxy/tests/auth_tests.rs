use cocodex_proxy::auth::jwt::{
    ACCESS_TTL_SECS, ClientJwt, ID_TTL_SECS, JwtError, chatgpt_user_id_for,
};
use cocodex_proxy::auth::session::{
    CodexClientSessionStore, PollDeviceResult, create_pkce_pair, generate_user_code,
    is_allowed_browser_redirect_uri, verify_pkce,
};

#[test]
fn test_pkce_verification() {
    let (verifier, challenge) = create_pkce_pair();
    assert!(verify_pkce(&verifier, &challenge));
    assert!(!verify_pkce("wrong-verifier", &challenge));
}

#[test]
fn test_user_code_format() {
    let code = generate_user_code();
    assert_eq!(code.len(), 9);
    assert_eq!(&code[4..5], "-");
}

#[tokio::test]
async fn test_device_auth_flow() {
    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    let store = CodexClientSessionStore::with_jwt(jwt.clone());

    let device_resp = store.create_device_code();
    assert_eq!(device_resp.user_code.len(), 9);

    match store.poll_device_token(&device_resp.device_auth_id, &device_resp.user_code) {
        PollDeviceResult::Pending => {}
        other => panic!("Expected Pending, got {:?}", other),
    }

    let approve_res = store.approve_device(
        &device_resp.user_code,
        "user-123".to_string(),
        "admin@openai.com",
    );
    assert!(approve_res.is_ok());

    let (auth_code, code_challenge, code_verifier) =
        match store.poll_device_token(&device_resp.device_auth_id, &device_resp.user_code) {
            PollDeviceResult::Complete {
                authorization_code,
                code_challenge,
                code_verifier,
            } => (authorization_code, code_challenge, code_verifier),
            other => panic!("Expected Complete, got {:?}", other),
        };

    assert!(verify_pkce(&code_verifier, &code_challenge));

    let tokens = store
        .exchange_authorization_code(
            &auth_code,
            "https://gateway.example.com/deviceauth/callback",
            &code_verifier,
        )
        .await
        .expect("Exchange authorization code should succeed");

    assert_ne!(tokens.access_token, "user-123");
    assert_eq!(tokens.token_type, "Bearer");
    assert_eq!(tokens.expires_in, ACCESS_TTL_SECS);
    assert_eq!(tokens.account_id, "user-123");
    assert!(tokens.refresh_token.starts_with("rt.1."));
    assert_eq!(tokens.access_token.split('.').count(), 3);
    assert_eq!(tokens.id_token.split('.').count(), 3);

    let access_claims = jwt
        .verify_access_token(&tokens.access_token)
        .expect("access token should verify");
    assert_eq!(access_claims.openai_auth.chatgpt_account_id, "user-123");
    assert_eq!(
        access_claims.openai_auth.chatgpt_user_id,
        chatgpt_user_id_for("user-123")
    );
    assert_eq!(
        access_claims.aud,
        serde_json::json!(["https://api.openai.com/v1"])
    );
    assert!(access_claims.openai_profile.is_some());

    let access_payload = ClientJwt::decode_payload(&tokens.access_token).expect("access payload");
    assert!(access_payload.get("api_key_id").is_none());
    assert!(access_payload.get("owner_user_id").is_none());

    let id_payload = ClientJwt::decode_payload(&tokens.id_token).expect("id payload");
    assert_eq!(id_payload["email"], "admin@openai.com");
    assert_eq!(
        id_payload["https://api.openai.com/auth"]["chatgpt_account_id"],
        "user-123"
    );
    assert_eq!(
        id_payload["https://api.openai.com/auth"]["chatgpt_plan_type"],
        "pro"
    );
    assert!(id_payload.get("api_key_id").is_none());
    let id_exp = id_payload["exp"].as_u64().unwrap();
    let id_iat = id_payload["iat"].as_u64().unwrap();
    assert_eq!(id_exp - id_iat, ID_TTL_SECS);
    let access_exp = access_payload["exp"].as_u64().unwrap();
    let access_iat = access_payload["iat"].as_u64().unwrap();
    assert_eq!(access_exp - access_iat, ACCESS_TTL_SECS);

    let refreshed = store
        .refresh(&tokens.refresh_token)
        .await
        .expect("Refresh should succeed");
    assert_ne!(refreshed.access_token, tokens.access_token);
    assert_eq!(refreshed.account_id, "user-123");
    jwt.verify_access_token(&refreshed.access_token)
        .expect("refreshed access token should verify");

    store.revoke(&tokens.refresh_token).await;
    assert!(store.refresh(&tokens.refresh_token).await.is_none());
}

#[tokio::test]
async fn test_browser_oauth_flow() {
    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    let store = CodexClientSessionStore::with_jwt(jwt.clone());
    let (verifier, challenge) = create_pkce_pair();

    let redirect_uri = "http://127.0.0.1:14555/auth/callback";
    let code = store
        .create_browser_authorization(
            "user-456".to_string(),
            "user@openai.com",
            &challenge,
            redirect_uri,
        )
        .expect("loopback callback should be accepted");

    let tokens = store
        .exchange_authorization_code(&code, redirect_uri, &verifier)
        .await
        .expect("Code exchange should succeed");

    assert_ne!(tokens.access_token, "sk-browser-test");
    assert_eq!(tokens.account_id, "user-456");
    let claims = jwt
        .verify_access_token(&tokens.access_token)
        .expect("browser access token should verify");
    assert_eq!(claims.openai_auth.chatgpt_account_id, "user-456");
}

#[test]
fn test_access_token_rejects_api_key_and_unsigned_jwt() {
    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    assert!(
        jwt.verify_access_token("sk-cocodex-secret-test-token")
            .is_err()
    );

    let unsigned = "eyJhbGciOiJub25lIiwidHlwIoiSldUIn0.eyJzdWIiOiJ1c2VyIn0.";
    assert!(jwt.verify_access_token(unsigned).is_err());
}

#[test]
fn test_expired_access_token() {
    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    let signed = jwt.sign_session_tokens_at("user-123", "a@b.c", 1);
    assert!(matches!(
        jwt.verify_access_token(&signed.access_token),
        Err(JwtError::Expired)
    ));
}

#[test]
fn test_browser_redirect_uri_allow_list() {
    for allowed in [
        "http://localhost:1455/auth/callback",
        "http://localhost:1457/auth/callback",
        "http://127.0.0.1:14555/auth/callback",
        "http://[::1]:1455/auth/callback",
    ] {
        assert!(is_allowed_browser_redirect_uri(allowed), "{allowed}");
    }
    for rejected in [
        "https://evil.example.com/auth/callback",
        "http://evil.example.com:1455/auth/callback",
        "http://localhost.evil.com:1455/auth/callback",
        "http://user@localhost:1455/auth/callback",
        "http://localhost:1455/other",
        "http://localhost/auth/callback",
        "https://localhost:1455/auth/callback",
        "/auth/callback",
    ] {
        assert!(!is_allowed_browser_redirect_uri(rejected), "{rejected}");
    }

    let store = CodexClientSessionStore::with_jwt(ClientJwt::from_secret("s"));
    let (_, challenge) = create_pkce_pair();
    assert!(
        store
            .create_browser_authorization(
                "user-1".to_string(),
                "u@openai.com",
                &challenge,
                "https://evil.example.com/auth/callback",
            )
            .is_err()
    );
}

#[tokio::test]
async fn test_session_lifecycle_follows_refresh_token() {
    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    let store = CodexClientSessionStore::with_jwt(jwt.clone());
    let (verifier, challenge) = create_pkce_pair();
    let redirect_uri = "http://localhost:1455/auth/callback";
    let code = store
        .create_browser_authorization(
            "user-7".to_string(),
            "u@openai.com",
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
    assert!(store.is_session_live(&session_id));

    // Rotation keeps the session and invalidates the old refresh token.
    let refreshed = store.refresh(&tokens.refresh_token).await.unwrap();
    let refreshed_session = jwt
        .verify_access_token(&refreshed.access_token)
        .unwrap()
        .session_id;
    assert_eq!(refreshed_session, session_id);
    assert!(store.refresh(&tokens.refresh_token).await.is_none());
    assert!(store.is_session_live(&session_id));

    // Revoking with an access token ends the whole session.
    store.revoke(&tokens.access_token).await;
    assert!(!store.is_session_live(&session_id));
    assert!(store.refresh(&refreshed.refresh_token).await.is_none());
}
