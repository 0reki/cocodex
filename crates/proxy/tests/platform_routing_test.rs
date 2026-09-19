mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use cocodex_proxy::create_router;
use tokio::net::TcpListener;
use tower::ServiceExt;

const WINDOWS_UA: &str = "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal";
const LINUX_UA: &str = "codex_cli_rs/0.154.0 (Debian 12; x86_64) unknown";
const DARWIN_UA: &str = "codex_cli_rs/0.154.0 (Mac OS 14.5.0; arm64) Apple_Terminal";

#[derive(Clone, Default)]
struct Captured {
    headers: Arc<Mutex<Vec<HeaderMap>>>,
}

async fn mock_upstream() -> (String, Captured) {
    let captured = Captured::default();
    let app = Router::new()
        .fallback(axum::routing::any(
            |State(state): State<Captured>, uri: axum::http::Uri, headers: HeaderMap| async move {
                // Only gateway traffic; background quota syncs hit /wham/usage.
                if uri.path() == "/backend-api/codex/models" {
                    state.headers.lock().unwrap().push(headers);
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

    // The explicit header overrides the User-Agent and never leaks upstream.
    let request = get(&bearer, "Apifox/1.0.0")
        .header("x-cocodex-platform", "darwin")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );

    let headers = captured.headers.lock().unwrap();
    assert_eq!(headers.len(), 3);
    assert_eq!(headers[0]["authorization"], "Bearer windows-token");
    assert_eq!(headers[0]["user-agent"], WINDOWS_UA);
    assert_eq!(headers[0]["originator"], "codex_cli_rs");
    assert_eq!(headers[0]["version"], "0.154.0");
    assert_eq!(headers[0]["session-id"], "sess-keep");
    assert_eq!(headers[0]["chatgpt-account-id"], "acct-1");
    assert_eq!(
        headers[0]["x-codex-installation-id"],
        cocodex_proxy::forwarder::gateway_installation_id("acct-1", "windows").as_str()
    );
    assert_eq!(headers[1]["authorization"], "Bearer linux-token");
    assert_eq!(headers[1]["user-agent"], LINUX_UA);
    assert_eq!(headers[2]["authorization"], "Bearer darwin-token");
    assert_eq!(headers[2]["user-agent"], DARWIN_UA);
    assert!(headers[2].get("x-cocodex-platform").is_none());
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
    assert_eq!(headers[0]["user-agent"], DARWIN_UA);
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
