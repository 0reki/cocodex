use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use cocodex_proxy::auth::jwt::ClientJwt;
use cocodex_proxy::config::ProxyConfig;
use cocodex_proxy::create_router;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener};
use tower::ServiceExt;

const WINDOWS_UA: &str = "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal";
const LINUX_UA: &str = "codex_cli_rs/0.154.0 (Debian 12; x86_64) unknown";
const DARWIN_UA: &str = "codex_cli_rs/0.154.0 (Mac OS 14.5.0; arm64) Apple_Terminal";

#[derive(Clone, Default)]
struct CapturedUpstreamRequests {
    headers: Arc<Mutex<Vec<HeaderMap>>>,
}

#[tokio::test]
async fn test_platform_account_routing_end_to_end() {
    let socket_path = std::env::temp_dir().join(format!(
        "cocodex-platform-routing-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&socket_path);

    // 1. Mock upstream ChatGPT server capturing forwarded headers.
    let captured = CapturedUpstreamRequests::default();
    let captured_for_handler = captured.clone();
    let upstream_app = Router::new()
        .fallback(axum::routing::any(
            move |State(state): State<CapturedUpstreamRequests>, headers: HeaderMap| {
                state.headers.lock().unwrap().push(headers);
                async { "upstream-ok" }
            },
        ))
        .with_state(captured_for_handler);
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = upstream_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(upstream_listener, upstream_app).await.unwrap();
    });

    // 2. Mock Node UDS backend that resolves platform-tagged accounts.
    let uds_listener = UnixListener::bind(&socket_path).unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = uds_listener.accept().await else {
                continue;
            };
            tokio::spawn(async move {
                let (reader, mut writer) = stream.into_split();
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    let Some(method) = request["method"].as_str() else {
                        continue;
                    };
                    let result = if method == "upstream.resolve_account" {
                        let platform = request["params"]["platform"].as_str().unwrap_or("");
                        let (account_id, token, user_agent) = match platform {
                            "windows" => ("windows-account", "windows-token", WINDOWS_UA),
                            "linux" => ("linux-account", "linux-token", LINUX_UA),
                            "darwin" => ("darwin-account", "darwin-token", DARWIN_UA),
                            _ => ("all-account", "all-token", LINUX_UA),
                        };
                        serde_json::json!({
                            "account_id": account_id,
                            "access_token": token,
                            "platform": platform,
                            "user_agent": user_agent,
                        })
                    } else if method == "auth.verify_session" {
                        serde_json::json!({ "valid": true, "expires_at_secs": u64::MAX / 2 })
                    } else if method == "auth.verify_api_key" {
                        serde_json::json!({
                            "valid": true,
                            "user": {
                                "id": "user-1",
                                "username": "user-1",
                                "role": "user",
                                "enabled": true,
                                "quota": null,
                                "used": "0"
                            }
                        })
                    } else {
                        serde_json::json!({})
                    };
                    let response = serde_json::json!({
                        "id": request["id"],
                        "result": result,
                        "error": null,
                    });
                    if writer
                        .write_all(format!("{response}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });
        }
    });

    // 3. Build the proxy router with the default platform-aware interceptor.
    let config = ProxyConfig {
        bind_addr: "127.0.0.1:53141".parse().unwrap(),
        node_backend_url: "http://127.0.0.1:53142".to_string(),
        upstream_chatgpt_origin: format!("http://127.0.0.1:{upstream_port}"),
        ipc_socket_path: socket_path.to_string_lossy().to_string(),
        public_app_url: "http://localhost:53332".to_string(),
        client_jwt_secret: "test-client-jwt-secret".to_string(),
    };
    let app = create_router(config, None);

    let jwt = ClientJwt::from_secret("test-client-jwt-secret");
    let client_tokens = jwt.sign_session_tokens("user-1", "user-1@openai.com");
    let bearer = format!("Bearer {}", client_tokens.access_token);

    // 4. A Windows-UA request must be routed to the Windows account with an
    //    aligned upstream User-Agent.
    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .header("user-agent", WINDOWS_UA)
        .header("authorization", &bearer)
        .header("originator", "codex_vscode")
        .header("version", "0.1.0-client")
        .header("session-id", "sess-keep")
        .header("x-codex-installation-id", "install-leak")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // 5. A Linux-UA request must be routed to the Linux account.
    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .header("user-agent", LINUX_UA)
        .header("authorization", &bearer)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Unknown User-Agents are rejected instead of falling back to linux.
    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .header("user-agent", "Apifox/1.0.0")
        .header("authorization", &bearer)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 6. The explicit X-Cocodex-Platform header overrides the User-Agent and
    //    must not leak to the upstream.
    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .header("user-agent", "Apifox/1.0.0")
        .header("x-cocodex-platform", "darwin")
        .header("authorization", &bearer)
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // 7. Verify upstream headers per platform.
    let headers = captured.headers.lock().unwrap();
    assert_eq!(headers.len(), 3);

    assert_eq!(
        headers[0].get("authorization").unwrap(),
        "Bearer windows-token"
    );
    assert_eq!(headers[0].get("user-agent").unwrap(), WINDOWS_UA);
    assert_eq!(headers[0].get("originator").unwrap(), "codex_cli_rs");
    assert_eq!(headers[0].get("version").unwrap(), "0.154.0");
    assert_eq!(headers[0].get("session-id").unwrap(), "sess-keep");
    assert_eq!(
        headers[0].get("x-codex-installation-id").unwrap(),
        cocodex_proxy::forwarder::gateway_installation_id("windows-account", "windows").as_str()
    );
    assert_eq!(
        headers[0].get("chatgpt-account-id").unwrap(),
        "windows-account"
    );

    assert_eq!(
        headers[1].get("authorization").unwrap(),
        "Bearer linux-token"
    );
    assert_eq!(headers[1].get("user-agent").unwrap(), LINUX_UA);
    assert_eq!(
        headers[1].get("chatgpt-account-id").unwrap(),
        "linux-account"
    );

    assert_eq!(
        headers[2].get("authorization").unwrap(),
        "Bearer darwin-token"
    );
    assert_eq!(headers[2].get("user-agent").unwrap(), DARWIN_UA);
    assert!(
        headers[2].get("x-cocodex-platform").is_none(),
        "internal platform header must not leak upstream"
    );

    let _ = std::fs::remove_file(&socket_path);
}
