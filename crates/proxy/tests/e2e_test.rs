//! End to end: a real gateway on a TCP port against a mock OpenAI, driven
//! the way the console and the Codex CLI drive it.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const WINDOWS_UA: &str = "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal";
const LINUX_UA: &str = "codex_cli_rs/0.154.0 (Debian 12; x86_64) unknown";
const ACCOUNT: &str = "acct-e2e";

#[derive(Clone, Default)]
struct Upstream {
    /// Weekly window used percent, in hundredths.
    weekly_used: Arc<AtomicU64>,
    refreshes: Arc<AtomicUsize>,
    responses: Arc<AtomicUsize>,
}

/// A ten-character opaque turn state, so `turnStateLen` is a known 10.
const TURN_STATE: &str = "abcdefghij";

fn sse_turn(text: &str) -> String {
    let metadata = json!({
        "type": "response.metadata",
        "headers": { "x-codex-turn-state": TURN_STATE }
    });
    let completed = json!({
        "type": "response.completed",
        "response": {
            "model": "gpt-5.4",
            "usage": { "input_tokens": 1000, "output_tokens": 500, "total_tokens": 1500 }
        }
    });
    format!(
        "event: response.metadata\ndata: {metadata}\n\n\
         event: response.output_text.delta\ndata: {}\n\n\
         event: response.completed\ndata: {completed}\n\n",
        json!({ "type": "response.output_text.delta", "delta": text })
    )
}

async fn responses_http(State(up): State<Upstream>, headers: HeaderMap) -> Response {
    if headers["authorization"] == "Bearer stale-token" {
        return (StatusCode::UNAUTHORIZED, "token expired").into_response();
    }
    up.responses.fetch_add(1, Ordering::SeqCst);
    ([("content-type", "text/event-stream")], sse_turn("pong")).into_response()
}

async fn responses_ws(State(up): State<Upstream>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        while let Some(Ok(Message::Text(text))) = socket.recv().await {
            let request: Value = serde_json::from_str(&text).unwrap_or_default();
            if request["type"] != "response.create" {
                continue;
            }
            up.responses.fetch_add(1, Ordering::SeqCst);
            for block in sse_turn("ws-pong").split("\n\n").filter(|b| !b.is_empty()) {
                let data = block
                    .lines()
                    .find_map(|l| l.strip_prefix("data: "))
                    .unwrap();
                if socket
                    .send(Message::Text(data.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    })
}

async fn usage(State(up): State<Upstream>) -> Response {
    let now = cocodex_proxy::auth::jwt::now_secs();
    axum::Json(json!({
        "plan_type": "pro",
        "rate_limit": {
            "allowed": true,
            "limit_reached": false,
            "primary_window": { "used_percent": 1, "limit_window_seconds": 18000, "reset_at": now + 3600 },
            "secondary_window": {
                "used_percent": up.weekly_used.load(Ordering::SeqCst) as f64 / 100.0,
                "limit_window_seconds": 604800,
                "reset_at": now + 5 * 86400
            }
        }
    }))
    .into_response()
}

fn fake_id_token(email: &str) -> String {
    let payload = json!({
        "email": email,
        "https://api.openai.com/auth": { "chatgpt_account_id": ACCOUNT }
    });
    format!("h.{}.s", URL_SAFE_NO_PAD.encode(payload.to_string()))
}

async fn oauth_token(State(up): State<Upstream>, body: String) -> Response {
    if body.contains("refresh_token") && body.contains("grant_type\":\"refresh_token") {
        up.refreshes.fetch_add(1, Ordering::SeqCst);
        return axum::Json(json!({ "access_token": "fresh-token", "refresh_token": "refresh-2" }))
            .into_response();
    }
    axum::Json(json!({
        "id_token": fake_id_token("win@e2e"),
        "access_token": "win-token",
        "refresh_token": "win-refresh",
    }))
    .into_response()
}

async fn mock_openai(state: Upstream) -> String {
    let app = Router::new()
        .route(
            "/backend-api/codex/responses",
            get(responses_ws).post(responses_http),
        )
        .route("/backend-api/wham/usage", get(usage))
        .route(
            "/backend-api/wham/analytics/daily-workspace-usage-counts",
            get(|| async { axum::Json(json!({ "data": [] })) }),
        )
        .route("/oauth/token", post(oauth_token))
        .with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    origin
}

struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    async fn call(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.base));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
        let text = response.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }
}

async fn wait_for<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..100 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn console_and_codex_client_end_to_end() {
    common::pin_codex_version();
    // SAFETY: set before the gateway starts; this binary has one test.
    unsafe { std::env::set_var("RESPONSE_SETTLEMENT_FLUSH_INTERVAL_MS", "100") };

    let db = common::test_db().await;
    let upstream = Upstream::default();
    upstream.weekly_used.store(1_000, Ordering::SeqCst);
    let origin = mock_openai(upstream.clone()).await;

    // Start in "setup required" state: no database URL, no secret.
    let mut settings = common::offline_settings();
    settings.admin_jwt_secret = None;
    let (app, runtime) = cocodex_proxy::build(common::config(settings, &origin), None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = Client {
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        base: format!("http://{addr}"),
    };

    // 1. Setup, then admin login.
    let (_, status) = client.call("GET", "/api/setup/status", None, None).await;
    assert_eq!(status["setupRequired"], true);
    assert_eq!(status["reason"], "missing_database");
    let (code, _) = client
        .call(
            "POST",
            "/api/setup/complete",
            None,
            Some(json!({
                "databaseUrl": db.url, "adminUsername": "Admin", "adminPassword": "admin-password"
            })),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED);
    // The gateway connects on the next request after the config appears.
    let mut admin = String::new();
    for _ in 0..50 {
        let (code, body) = client
            .call(
                "POST",
                "/api/auth/login",
                None,
                Some(json!({ "username": "admin", "password": "admin-password" })),
            )
            .await;
        if code == StatusCode::OK {
            admin = body["accessToken"]["token"].as_str().unwrap().to_string();
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!admin.is_empty(), "admin could not log in after setup");
    let admin = admin.as_str();

    // 2. Upstream logins: Windows via the browser OAuth flow, Linux imported
    // with a stale token.
    let (code, start) = client
        .call(
            "POST",
            "/api/openai-accounts/oauth/start",
            Some(admin),
            Some(json!({ "platform": "windows" })),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{start}");
    let authorize = url::Url::parse(start["authorizeUrl"].as_str().unwrap()).unwrap();
    assert_eq!(authorize.path(), "/oauth/authorize");
    // The admin pastes back the redirect the browser lands on.
    let callback = format!(
        "{}?code=auth-code&state={}",
        start["redirectUri"].as_str().unwrap(),
        start["state"].as_str().unwrap()
    );
    let (code, complete) = client
        .call(
            "POST",
            "/api/openai-accounts/oauth/exchange",
            Some(admin),
            Some(json!({
                "code": callback,
                "codeVerifier": start["codeVerifier"],
                "state": start["state"],
                "platform": "windows"
            })),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{complete}");
    assert_eq!(complete["account"]["accountId"], ACCOUNT);
    assert_eq!(complete["account"]["platform"], "windows");
    let (code, linux) = client
        .call(
            "POST",
            "/api/openai-accounts",
            Some(admin),
            Some(json!({
                "email": "linux@e2e", "accountId": ACCOUNT, "platform": "linux",
                "idToken": "id", "accessToken": "stale-token", "refreshToken": "linux-refresh"
            })),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{linux}");
    let (_, accounts) = client
        .call("GET", "/api/openai-accounts", Some(admin), None)
        .await;
    assert_eq!(accounts["count"], 2);

    // 3. Invite a user, let them register, assign the ChatGPT account.
    let (code, invite) = client
        .call("POST", "/api/user-invitations", Some(admin), None)
        .await;
    assert_eq!(code, StatusCode::CREATED, "{invite}");
    let invite_token = invite["registrationPath"]
        .as_str()
        .unwrap()
        .split("invite=")
        .nth(1)
        .unwrap()
        .to_string();
    let (code, registered) = client
        .call(
            "POST",
            "/api/auth/register",
            None,
            Some(json!({
                "inviteToken": invite_token, "username": "alice", "password": "alice-password"
            })),
        )
        .await;
    assert_eq!(code, StatusCode::CREATED, "{registered}");
    let alice_id = registered["user"]["id"].as_str().unwrap().to_string();
    let alice = registered["accessToken"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, _) = client
        .call(
            "PUT",
            &format!("/api/users/{alice_id}/upstream"),
            Some(admin),
            Some(json!({ "accountId": ACCOUNT })),
        )
        .await;
    assert_eq!(code, StatusCode::OK);
    let (code, _) = client.call("GET", "/api/users", Some(&alice), None).await;
    assert_eq!(code, StatusCode::FORBIDDEN, "users are not admins");

    // 4. Codex browser login for alice.
    let verifier = "e2e-verifier-0123456789012345678901234567890123";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let redirect_uri = "http://localhost:1455/auth/callback";
    let (code, authorized) = client
        .call(
            "POST",
            "/api/codex-client/authorize",
            Some(&alice),
            Some(json!({
                "redirectUri": redirect_uri, "codeChallenge": challenge
            })),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{authorized}");
    let redirect = url::Url::parse(authorized["redirectTo"].as_str().unwrap()).unwrap();
    let auth_code = redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .to_string();
    let tokens: Value = client
        .http
        .post(format!("{}/oauth/token", client.base))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", auth_code.as_str()),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let codex = tokens["access_token"].as_str().unwrap().to_string();

    // 5. Linux over SSE: the stale upstream token is refreshed and retried.
    let response = client
        .http
        .post(format!("{}/backend-api/codex/responses", client.base))
        .bearer_auth(&codex)
        .header("user-agent", LINUX_UA)
        .header("x-codex-routing-hint", "model=gpt-5.4")
        .json(&json!({ "model": "gpt-5.4", "input": "ping", "stream": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(response.text().await.unwrap().contains("pong"));
    assert_eq!(upstream.refreshes.load(Ordering::SeqCst), 1);

    // 6. Windows over WebSocket: two turns on one connection.
    let mut request = format!("ws://{addr}/backend-api/codex/responses")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {codex}").parse().unwrap());
    request
        .headers_mut()
        .insert("user-agent", WINDOWS_UA.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    for _ in 0..2 {
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({ "type": "response.create", "model": "gpt-5.4" })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if message.to_text().unwrap().contains("response.completed") {
                break;
            }
        }
    }

    // 7. Three settled responses: logs, stats and spend.
    wait_for("three settlements", || async {
        let (_, logs) = client
            .call("GET", "/api/request-logs?limit=10", Some(&alice), None)
            .await;
        logs["items"].as_array().is_some_and(|items| {
            items
                .iter()
                .filter(|item| {
                    item["path"] == "/backend-api/codex/responses" && item["isFinal"] == true
                })
                .count()
                == 3
        })
    })
    .await;
    let (_, logs) = client
        .call(
            "GET",
            "/api/request-logs?limit=10&status=success",
            Some(&alice),
            None,
        )
        .await;
    let item = &logs["items"][0];
    assert_eq!(item["modelId"], "gpt-5.4");
    // The completed event's model is the used one; the turn state length and
    // requested model are recorded too.
    assert_eq!(item["usedModel"], "gpt-5.4");
    assert_eq!(item["requestedModel"], "gpt-5.4");
    assert_eq!(item["turnStateLen"], 10);
    assert_eq!(item["totalTokens"], 1500);
    // 1000 input at $2.50/M + 500 output at $15/M.
    assert_eq!(item["cost"], 0.01);
    let (_, hourly) = client
        .call(
            "GET",
            "/api/request-logs/hourly?lookbackHours=2",
            Some(&alice),
            None,
        )
        .await;
    assert_eq!(hourly["models"], json!(["gpt-5.4"]));
    let (_, users) = client.call("GET", "/api/users", Some(admin), None).await;
    let alice_row = users["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == alice_id.as_str())
        .unwrap();
    assert_eq!(alice_row["used"], 0.03);
    assert_eq!(alice_row["accountId"], ACCOUNT);

    // 8. The weekly window fills up: alice's share is exhausted.
    upstream.weekly_used.store(9_000, Ordering::SeqCst);
    let (code, usage) = client
        .call("GET", "/api/my-usage", Some(&alice), None)
        .await;
    assert_eq!(code, StatusCode::OK, "{usage}");
    assert_eq!(
        usage["pools"]["standard"]["allocation"]["allocatedPercent"],
        90.0
    );
    let response = client
        .http
        .post(format!("{}/backend-api/codex/responses", client.base))
        .bearer_auth(&codex)
        .header("user-agent", LINUX_UA)
        .json(&json!({ "model": "gpt-5.4", "input": "ping" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 429);
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "response.create", "model": "gpt-5.4" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let refusal: Value =
        serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(refusal["type"], "error");
    assert_eq!(refusal["error"]["code"], "upstream_user_quota_exceeded");
    assert_eq!(
        upstream.responses.load(Ordering::SeqCst),
        3,
        "refused turns never reach upstream"
    );

    // 9. Signing the Codex client out invalidates its access token at once.
    let refresh = tokens["refresh_token"].as_str().unwrap();
    client
        .http
        .post(format!("{}/oauth/revoke", client.base))
        .json(&json!({ "token": refresh }))
        .send()
        .await
        .unwrap();
    let response = client
        .http
        .get(format!("{}/backend-api/codex/models", client.base))
        .bearer_auth(&codex)
        .header("user-agent", LINUX_UA)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);

    runtime.shutdown().await;
}
