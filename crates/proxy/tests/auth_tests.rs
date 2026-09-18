use cocodex_proxy::auth::session::{
    create_pkce_pair, generate_user_code, verify_pkce, CodexClientSessionStore, PollDeviceResult,
};
use cocodex_proxy::ipc::ApiKeyRecord;

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

#[test]
fn test_device_auth_flow() {
    let store = CodexClientSessionStore::new();

    // 1. Client requests device code
    let device_resp = store.create_device_code();
    assert_eq!(device_resp.user_code.len(), 9);

    // 2. Poll before approval -> Pending
    match store.poll_device_token(&device_resp.device_auth_id, &device_resp.user_code) {
        PollDeviceResult::Pending => {}
        other => panic!("Expected Pending, got {:?}", other),
    }

    // 3. User approves in web frontend
    let mock_api_key = ApiKeyRecord {
        id: "key-1".to_string(),
        owner_user_id: Some("user-123".to_string()),
        name: "Codex client".to_string(),
        api_key: "sk-cocodex-secret-test-token".to_string(),
        quota: None,
        used: "0".to_string(),
    };

    let approve_res = store.approve_device(
        &device_resp.user_code,
        mock_api_key.clone(),
        "admin@cocodex.local",
    );
    assert!(approve_res.is_ok());

    // 4. Poll after approval -> Complete
    let (auth_code, code_challenge, code_verifier) = match store
        .poll_device_token(&device_resp.device_auth_id, &device_resp.user_code)
    {
        PollDeviceResult::Complete {
            authorization_code,
            code_challenge,
            code_verifier,
        } => (authorization_code, code_challenge, code_verifier),
        other => panic!("Expected Complete, got {:?}", other),
    };

    assert!(verify_pkce(&code_verifier, &code_challenge));

    // 5. Exchange auth code for tokens
    let tokens = store
        .exchange_authorization_code(&auth_code, "/deviceauth/callback", &code_verifier)
        .expect("Exchange authorization code should succeed");

    assert_eq!(tokens.access_token, "sk-cocodex-secret-test-token");
    assert!(!tokens.id_token.is_empty());
    assert!(!tokens.refresh_token.is_empty());

    // Verify token was cached in memory
    assert!(store
        .get_cached_api_key("sk-cocodex-secret-test-token")
        .is_some());

    // 6. Refresh tokens
    let refreshed = store
        .refresh(&tokens.refresh_token)
        .expect("Refresh should succeed");
    assert_eq!(refreshed.access_token, "sk-cocodex-secret-test-token");

    // 7. Revoke
    store.revoke(&tokens.access_token);
    assert!(store
        .get_cached_api_key("sk-cocodex-secret-test-token")
        .is_none());
}

#[test]
fn test_browser_oauth_flow() {
    let store = CodexClientSessionStore::new();
    let (verifier, challenge) = create_pkce_pair();

    let mock_api_key = ApiKeyRecord {
        id: "key-browser".to_string(),
        owner_user_id: Some("user-456".to_string()),
        name: "Codex client".to_string(),
        api_key: "sk-browser-test".to_string(),
        quota: None,
        used: "0".to_string(),
    };

    let redirect_uri = "http://127.0.0.1:14555/auth/callback";
    let code = store.create_browser_authorization(
        mock_api_key,
        "user@cocodex.local",
        &challenge,
        redirect_uri,
    );

    let tokens = store
        .exchange_authorization_code(&code, redirect_uri, &verifier)
        .expect("Code exchange should succeed");

    assert_eq!(tokens.access_token, "sk-browser-test");
}

