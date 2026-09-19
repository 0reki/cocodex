//! The WebSocket path presents the upstream login the way a real Codex
//! client would: it offers permessage-deflate, rewrites `response.create`
//! identity, and relays the upstream handshake's response markers.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const WINDOWS_UA: &str = "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal";

#[derive(Clone, Default)]
struct Captured {
    handshake_extensions: Arc<Mutex<Option<String>>>,
    handshake_header_order: Arc<Mutex<Vec<String>>>,
    create_frames: Arc<Mutex<Vec<Value>>>,
}

async fn responses_ws(
    State(state): State<Captured>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    *state.handshake_header_order.lock().unwrap() =
        headers.keys().map(|name| name.to_string()).collect();
    *state.handshake_extensions.lock().unwrap() = headers
        .get("sec-websocket-extensions")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let mut response = ws.on_upgrade(move |mut socket: WebSocket| async move {
        while let Some(Ok(Message::Text(text))) = socket.recv().await {
            let request: Value = serde_json::from_str(&text).unwrap_or_default();
            if request["type"] != "response.create" {
                continue;
            }
            state.create_frames.lock().unwrap().push(request);
            let _ = socket
                .send(Message::Text(
                    json!({
                        "type": "response.completed",
                        "response": { "safety_identifier": "user-UPSTREAM" }
                    })
                    .to_string()
                    .into(),
                ))
                .await;
        }
    });
    // Codex reads these off the handshake response; the gateway must relay them.
    response
        .headers_mut()
        .insert("openai-model", "gpt-5.4".parse().unwrap());
    response
        .headers_mut()
        .insert("x-codex-primary-used-percent", "12.5".parse().unwrap());
    response
        .headers_mut()
        .insert("x-oai-request-id", "req-1".parse().unwrap());
    response
}

async fn mock_upstream() -> (String, Captured) {
    let captured = Captured::default();
    let app = Router::new()
        .route(
            "/backend-api/codex/responses",
            axum::routing::any(responses_ws),
        )
        .with_state(captured.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, captured)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn websocket_offers_deflate_rewrites_identity_and_relays_markers() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    db.set_upstream_user_id("acct-1", "user-UPSTREAM").await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;

    let (app, _runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut request = format!("ws://{addr}/backend-api/codex/responses")
        .into_client_request()
        .unwrap();
    // The order Codex 0.155.1 sends its handshake headers in. Placed before
    // tungstenite's own five so this test client puts them on the wire as is.
    // `client_bearer` already includes the `Bearer ` prefix.
    let client_headers = [
        ("chatgpt-account-id", "gateway-account"),
        ("authorization", bearer.as_str()),
        ("user-agent", WINDOWS_UA),
        ("originator", "codex-tui"),
        ("openai-beta", "responses_websockets=2026-02-06"),
        ("version", "0.154.0"),
        ("session-id", "sess"),
        ("thread-id", "sess"),
        ("x-codex-window-id", "sess:0"),
        ("x-codex-turn-metadata", r#"{"turn_id":""}"#),
        ("x-codex-routing-hint", "model=gpt-5.4"),
    ];
    let generated = std::mem::take(request.headers_mut());
    for (name, value) in client_headers {
        request.headers_mut().insert(name, value.parse().unwrap());
    }
    for (name, value) in generated.iter() {
        request.headers_mut().insert(name.clone(), value.clone());
    }
    let (mut socket, handshake) = connect_async(request).await.unwrap();

    // The upstream handshake markers reached the client's 101.
    assert_eq!(handshake.headers()["openai-model"], "gpt-5.4");
    assert_eq!(handshake.headers()["x-codex-primary-used-percent"], "12.5");
    // Everything else upstream answered with is relayed too.
    assert_eq!(handshake.headers()["x-oai-request-id"], "req-1");

    use futures_util::{SinkExt, StreamExt};
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "response.create",
                "model": "gpt-5.4",
                "client_metadata": {
                    "x-codex-installation-id": "client-install",
                    "x-codex-turn-metadata":
                        r#"{"installation_id":"client-install","turn_id":"t","workspaces":{"/r":{}}}"#
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let completed = loop {
        let message = socket.next().await.unwrap().unwrap();
        if message.to_text().unwrap().contains("response.completed") {
            break message.into_text().unwrap().to_string();
        }
    };
    // The login's user id upstream reported becomes the client's own.
    let client_user_id = cocodex_proxy::auth::jwt::ClientJwt::from_secret(common::TEST_SECRET)
        .verify_access_token(bearer.trim_start_matches("Bearer "))
        .unwrap()
        .openai_auth
        .chatgpt_user_id;
    let completed: Value = serde_json::from_str(&completed).unwrap();
    assert_eq!(
        completed["response"]["safety_identifier"],
        client_user_id.as_str()
    );

    let extensions = captured.handshake_extensions.lock().unwrap().clone();
    assert!(
        extensions
            .as_deref()
            .is_some_and(|value| value.contains("permessage-deflate")),
        "gateway should offer permessage-deflate upstream, got {extensions:?}"
    );

    // The client's headers reach upstream in the order it sent them.
    let order = captured.handshake_header_order.lock().unwrap().clone();
    let expected: Vec<&str> = client_headers.iter().map(|(name, _)| *name).collect();
    let relayed: Vec<&str> = order
        .iter()
        .map(String::as_str)
        .filter(|name| expected.contains(name))
        .collect();
    assert_eq!(relayed, expected);

    let frames = captured.create_frames.lock().unwrap();
    let metadata = &frames[0]["client_metadata"];
    let install = cocodex_proxy::client_identity::gateway_installation_id("acct-1", "windows");
    assert_eq!(metadata["x-codex-installation-id"], install);
    let turn: Value =
        serde_json::from_str(metadata["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
    assert_eq!(turn["installation_id"], install);
    // The client's workspaces pass through unchanged.
    assert!(turn["workspaces"]["/r"].is_object());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_upstream_handshake_reaches_the_client_as_is() {
    common::pin_codex_version();
    let db = common::test_db().await;
    // chatgpt.com refuses the upgrade when the usage limit is reached.
    let app = Router::new().route(
        "/backend-api/codex/responses",
        axum::routing::any(|| async {
            (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                [
                    ("content-type", "application/json"),
                    ("x-codex-primary-used-percent", "100.0"),
                    ("x-oai-request-id", "req-429"),
                ],
                json!({ "error": {
                    "type": "usage_limit_reached",
                    "plan_type": "plus",
                    "resets_in_seconds": 600,
                    "user_id": "user-UPSTREAM"
                }})
                .to_string(),
            )
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    db.set_upstream_user_id("acct-1", "user-UPSTREAM").await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (gateway, _runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });

    let mut request = format!("ws://{addr}/backend-api/codex/responses")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", bearer.parse().unwrap());
    request
        .headers_mut()
        .insert("user-agent", WINDOWS_UA.parse().unwrap());
    let error = connect_async(request).await.unwrap_err();
    let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
        panic!("expected an HTTP refusal, got {error:?}");
    };
    assert_eq!(response.status(), 429);
    assert_eq!(response.headers()["x-codex-primary-used-percent"], "100.0");
    assert_eq!(response.headers()["x-oai-request-id"], "req-429");
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
    assert_eq!(body["error"]["type"], "usage_limit_reached");
    assert_eq!(body["error"]["resets_in_seconds"], 600);
    assert_ne!(body["error"]["user_id"], "user-UPSTREAM");
}
