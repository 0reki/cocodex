mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use cocodex_proxy::create_router;
use tokio::net::TcpListener;
use tower::ServiceExt;

// What clients send (Codex 0.155.1 format, each with its own machine)…
const WINDOWS_UA: &str =
    "codex-tui/0.155.1 (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; 0.155.1)";
const LINUX_UA: &str =
    "codex-tui/0.155.1 (Ubuntu 24.4.0; x86_64) xterm-256color (codex-tui; 0.155.1)";
const DARWIN_UA: &str =
    "codex-tui/0.155.1 (Mac OS 14.1.0; arm64) iTerm.app/3.5.10 (codex-tui; 0.155.1)";
// …and what the gateway presents for each platform at the pinned version:
// the login's OS, the client's own terminal.
const UPSTREAM_WINDOWS_UA: &str =
    "codex-tui/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal (codex-tui; 0.154.0)";
const UPSTREAM_LINUX_UA: &str =
    "codex-tui/0.154.0 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.154.0)";
const UPSTREAM_DARWIN_UA: &str =
    "codex-tui/0.154.0 (Mac OS 15.5.0; arm64) iTerm.app/3.5.10 (codex-tui; 0.154.0)";

#[derive(Clone, Default)]
struct Captured {
    headers: Arc<Mutex<Vec<HeaderMap>>>,
    /// Device-independent requests: path, headers and body.
    other: Arc<Mutex<Vec<(String, HeaderMap, Bytes)>>>,
}

async fn mock_upstream() -> (String, Captured) {
    let captured = Captured::default();
    let app = Router::new()
        .fallback(axum::routing::any(
            |State(state): State<Captured>,
             uri: axum::http::Uri,
             headers: HeaderMap,
             body: Bytes| async move {
                // Only gateway traffic; background quota syncs hit /wham/usage.
                match uri.path() {
                    "/backend-api/codex/models" => state.headers.lock().unwrap().push(headers),
                    "/backend-api/accounts/verified_access" | "/backend-api/ps/mcp" => state
                        .other
                        .lock()
                        .unwrap()
                        .push((uri.path().to_string(), headers, body)),
                    _ => {}
                }
                "upstream-ok"
            },
        ))
        .with_state(captured.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, captured)
}

fn get(bearer: &str, user_agent: &str) -> axum::http::request::Builder {
    Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .header("user-agent", user_agent)
        .header("authorization", bearer)
}

/// One ChatGPT account logged in once per platform: each client platform
/// must reach its own login with that platform's identity.
#[tokio::test]
async fn routes_each_platform_to_its_login_of_the_assigned_account() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    for platform in ["windows", "linux", "darwin"] {
        db.insert_account(
            &format!("{platform}@x"),
            "acct-1",
            platform,
            &format!("{platform}-token"),
        )
        .await;
    }
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let app = create_router(common::config(db.settings(), &origin), None);

    let request = get(&bearer, WINDOWS_UA)
        .header("originator", "codex_vscode")
        .header("chatgpt-account-id", "gateway-account")
        .header("version", "0.1.0-client")
        .header("session-id", "sess-keep")
        .header("x-codex-installation-id", "install-leak")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );

    let request = get(&bearer, LINUX_UA).body(Body::empty()).unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );

    // Unknown User-Agents are rejected instead of falling back to linux.
    let request = get(&bearer, "Apifox/1.0.0").body(Body::empty()).unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    let request = get(&bearer, DARWIN_UA).body(Body::empty()).unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );

    let headers = captured.headers.lock().unwrap();
    assert_eq!(headers.len(), 3);
    assert_eq!(headers[0]["authorization"], "Bearer windows-token");
    assert_eq!(headers[0]["user-agent"], UPSTREAM_WINDOWS_UA);
    // The client's type is kept; the machine and version are the login's.
    assert_eq!(headers[0]["originator"], "codex_vscode");
    assert_eq!(headers[0]["version"], "0.154.0");
    assert_eq!(headers[0]["session-id"], "sess-keep");
    assert_eq!(headers[0]["chatgpt-account-id"], "acct-1");
    assert_eq!(
        headers[0]["x-codex-installation-id"],
        cocodex_proxy::client_identity::gateway_installation_id("acct-1", "windows").as_str()
    );
    assert_eq!(headers[1]["authorization"], "Bearer linux-token");
    assert_eq!(headers[1]["user-agent"], UPSTREAM_LINUX_UA);
    // Headers the client did not send are not added.
    assert!(headers[1].get("originator").is_none());
    assert!(headers[1].get("version").is_none());
    assert_eq!(headers[2]["authorization"], "Bearer darwin-token");
    assert_eq!(headers[2]["user-agent"], UPSTREAM_DARWIN_UA);
}

#[tokio::test]
async fn generic_login_serves_platforms_without_their_own() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("all@x", "acct-2", "all", "generic-token")
        .await;
    let user = db.create_user("user-2").await;
    db.assign(&user, "acct-2").await;
    let bearer = db.client_bearer(&user).await;
    let app = create_router(common::config(db.settings(), &origin), None);

    let request = get(&bearer, DARWIN_UA).body(Body::empty()).unwrap();
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
    let headers = captured.headers.lock().unwrap();
    assert_eq!(headers[0]["authorization"], "Bearer generic-token");
    // A generic login presents the client's own platform.
    assert_eq!(headers[0]["user-agent"], UPSTREAM_DARWIN_UA);
}

#[tokio::test]
async fn unassigned_users_and_missing_platforms_are_refused() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("win@x", "acct-3", "windows", "win-token")
        .await;
    let assigned = db.create_user("assigned").await;
    db.assign(&assigned, "acct-3").await;
    let unassigned = db.create_user("unassigned").await;
    let app = create_router(common::config(db.settings(), &origin), None);

    let bearer = db.client_bearer(&unassigned).await;
    let response = app
        .clone()
        .oneshot(get(&bearer, WINDOWS_UA).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // acct-3 has no linux (or generic) login.
    let bearer = db.client_bearer(&assigned).await;
    let response = app
        .oneshot(get(&bearer, LINUX_UA).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(captured.headers.lock().unwrap().is_empty());
}

#[tokio::test]
async fn requests_without_a_user_agent_use_any_login_of_the_account() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("win@x", "acct-4", "windows", "win-token")
        .await;
    let user = db.create_user("user-4").await;
    db.assign(&user, "acct-4").await;
    let bearer = db.client_bearer(&user).await;
    let app = create_router(common::config(db.settings(), &origin), None);

    // Codex 0.155.1 checks trusted access with only its credentials.
    let request = Request::builder()
        .uri("/backend-api/accounts/verified_access")
        .header("authorization", &bearer)
        .header("chatgpt-account-id", "gateway-account")
        .header("accept", "*/*")
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);

    let other = captured.other.lock().unwrap();
    let (_, headers, _) = &other[0];
    assert_eq!(headers["authorization"], "Bearer win-token");
    assert_eq!(headers["chatgpt-account-id"], "acct-4");
    for name in ["user-agent", "originator", "version"] {
        assert!(headers.get(name).is_none(), "{name} was added");
    }
}

#[tokio::test]
async fn unauthenticated_mcp_requests_pass_through() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    let app = create_router(common::config(db.settings(), &origin), None);

    // Codex opens the ChatGPT MCP session like this (captured from 0.155.1).
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "codex-mcp-client", "title": "Codex", "version": "0.155.1" }
        }
    });
    let request = Request::builder()
        .uri("/backend-api/ps/mcp")
        .method("POST")
        .header("user-agent", "codex-mcp-client/0.155.1")
        .header("originator", "codex-tui")
        .header("x-openai-product-sku", "codex")
        .header("accept", "text/event-stream, application/json")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);

    let other = captured.other.lock().unwrap();
    let (_, headers, body) = &other[0];
    assert!(headers.get("authorization").is_none());
    assert!(headers.get("chatgpt-account-id").is_none());
    assert_eq!(headers["user-agent"], "codex-mcp-client/0.154.0");
    assert_eq!(headers["originator"], "codex-tui");
    assert_eq!(headers["x-openai-product-sku"], "codex");
    let body: serde_json::Value = serde_json::from_slice(body).unwrap();
    assert_eq!(body["params"]["clientInfo"]["version"], "0.154.0");
}
