//! The gateway owns `x-codex-turn-state`: it keeps the state upstream issues
//! for each login and model, presents it on the requests it relays, and never
//! lets a client's own state through on a managed model.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

const LINUX_UA: &str =
    "codex-tui/0.155.1 (Ubuntu 24.4.0; x86_64) xterm-256color (codex-tui; 0.155.1)";
const MANAGED_MODEL: &str = "gpt-6-astra";
const OTHER_MODEL: &str = "gpt-5.6-luna";
const CLIENT_STATE: &str = "a-state-from-another-login";

/// A Fernet token shaped like the one upstream issues: version, issue time,
/// IV, `blocks` AES blocks of ciphertext and the HMAC.
fn upstream_state_with(seed: u8, blocks: usize) -> String {
    upstream_state_at(seed, blocks, 0)
}

/// The same, issued `seconds_ago` seconds ago: upstream stamps every state
/// it issues, and the gateway keeps the newest one it has seen.
fn upstream_state_at(seed: u8, blocks: usize, seconds_ago: i64) -> String {
    let mut raw = vec![0x80u8];
    raw.extend_from_slice(&((chrono::Utc::now().timestamp() - seconds_ago) as u64).to_be_bytes());
    raw.extend_from_slice(&[0x11; 16]);
    raw.extend(std::iter::repeat_n(seed, blocks * 16));
    raw.extend_from_slice(&[0x33; 32]);
    // Upstream pads its tokens, which is how an 11-block state measures 312
    // characters rather than 311.
    URL_SAFE.encode(raw)
}

/// What a Pro account was measured issuing: 11 blocks, 312 characters.
fn upstream_state(seed: u8) -> String {
    let state = upstream_state_with(seed, 11);
    assert_eq!(state.len(), 312);
    state
}

#[derive(Clone, Default)]
struct Upstream {
    /// The `x-codex-turn-state` of each relayed HTTP request, if any.
    http_states: Arc<Mutex<Vec<Option<String>>>>,
    /// The `client_metadata` of each relayed `response.create` frame.
    ws_metadata: Arc<Mutex<Vec<Value>>>,
    /// The state the mock issues next.
    issued: Arc<Mutex<String>>,
}

fn sse_turn(model: &str, metadata_state: Option<&str>) -> String {
    let metadata = json!({
        "type": "response.metadata",
        "headers": { "x-codex-turn-state": metadata_state.unwrap_or_default() }
    });
    let completed = json!({
        "type": "response.completed",
        "response": { "model": model, "status": "completed",
                      "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 } }
    });
    let metadata_block = match metadata_state {
        Some(_) => format!("event: response.metadata\ndata: {metadata}\n\n"),
        None => String::new(),
    };
    format!("{metadata_block}event: response.completed\ndata: {completed}\n\n")
}

async fn responses_http(State(up): State<Upstream>, headers: HeaderMap) -> Response {
    up.http_states.lock().unwrap().push(
        headers
            .get("x-codex-turn-state")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
    );
    let issued = up.issued.lock().unwrap().clone();
    (
        [
            ("content-type", "text/event-stream"),
            ("x-codex-turn-state", issued.as_str()),
        ],
        sse_turn(MANAGED_MODEL, None),
    )
        .into_response()
}

/// The Responses WebSocket as upstream answers it: the turn state is issued
/// on the handshake, before any frame has named a model.
async fn responses_ws_handshake_state(
    State(up): State<Upstream>,
    ws: WebSocketUpgrade,
) -> Response {
    let issued = up.issued.lock().unwrap().clone();
    let mut response = responses_ws(State(up), ws).await;
    if let Ok(value) = issued.parse() {
        response.headers_mut().insert("x-codex-turn-state", value);
    }
    response
}

async fn responses_ws(State(up): State<Upstream>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |mut socket: WebSocket| async move {
        while let Some(Ok(Message::Text(text))) = socket.recv().await {
            let request: Value = serde_json::from_str(&text).unwrap_or_default();
            if request["type"] != "response.create" {
                continue;
            }
            up.ws_metadata
                .lock()
                .unwrap()
                .push(request["client_metadata"].clone());
            let issued = up.issued.lock().unwrap().clone();
            // The turn state reaches a WebSocket client in the metadata event.
            for event in [
                json!({ "type": "codex.response.metadata",
                        "headers": { "x-codex-turn-state": issued } }),
                json!({ "type": "response.completed",
                        "response": { "model": MANAGED_MODEL, "status": "completed" } }),
            ] {
                if socket
                    .send(Message::Text(event.to_string().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    })
}

async fn mock_upstream() -> (String, Upstream) {
    let state = Upstream {
        issued: Arc::new(Mutex::new(upstream_state(0x22))),
        ..Upstream::default()
    };
    let app = Router::new()
        .route(
            "/backend-api/codex/responses",
            get(responses_ws).post(responses_http),
        )
        .route(
            "/backend-api/wham/usage",
            get(|| async { axum::Json(json!({ "plan_type": "pro" })) }),
        )
        .fallback(post(|| async { "ok" }))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, state)
}

fn turn(bearer: &str, model: &str, client_state: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .uri("/backend-api/codex/responses")
        .method("POST")
        .header("user-agent", LINUX_UA)
        .header("authorization", bearer)
        .header("content-type", "application/json")
        .header("x-codex-routing-hint", format!("model={model}"));
    if let Some(state) = client_state {
        request = request.header("x-codex-turn-state", state);
    }
    request
        .body(Body::from(
            json!({ "model": model, "input": "ping", "stream": true }).to_string(),
        ))
        .unwrap()
}

/// Reads the whole response so the streamed body reaches the interceptor.
async fn drain(response: Response) -> String {
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    String::from_utf8_lossy(&body).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_gateway_presents_its_own_turn_state_on_managed_models() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());

    // 1. Nothing held yet: the client's own state is dropped rather than
    // handed to a login it was not issued for.
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drain(response).await;
    assert_eq!(upstream.http_states.lock().unwrap()[0], None);

    // 2. The state that came back with it is now the login's, and the next
    // turn carries it instead of whatever the client sent.
    let issued = upstream.issued.lock().unwrap().clone();
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[1].as_deref(),
        Some(issued.as_str())
    );

    // 3. A model the gateway does not manage is left exactly as it was.
    let response = app
        .clone()
        .oneshot(turn(&bearer, OTHER_MODEL, Some(CLIENT_STATE)))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[2].as_deref(),
        Some(CLIENT_STATE)
    );

    // 4. The console sees the held state described, never its value.
    let status = store.status();
    let entry = &status["entries"][0];
    assert_eq!(entry["accountId"], "acct-1");
    assert_eq!(entry["platform"], "linux");
    assert_eq!(entry["model"], MANAGED_MODEL);
    assert_eq!(entry["blocks"], 11);
    assert_eq!(entry["live"], true);
    assert!(!status.to_string().contains(&issued));
    // Only the turn that had a held state to put in its place counts as a
    // replacement; the first turn simply dropped an unusable value.
    assert_eq!(status["counters"]["replaced"], 1);

    // 5. A state that is not one is not taken over the one held.
    *upstream.issued.lock().unwrap() = "not-a-fernet-token".to_string();
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[4].as_deref(),
        Some(issued.as_str()),
        "a malformed state never replaces a good one"
    );

    // 6. Turned off in the console, the client's state travels as before.
    let ready = runtime.ready().await.unwrap();
    let mut settings = store.settings();
    settings.enabled = false;
    ready.turn_state.save(&ready.db, settings).await.unwrap();
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[5].as_deref(),
        Some(CLIENT_STATE)
    );

    // The setting outlives the process: a fresh store reads it back.
    let reloaded = cocodex_proxy::turn_state::TurnStateStore::default();
    reloaded.load(&ready.db).await;
    assert!(!reloaded.settings().enabled);
    runtime.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_websocket_turn_carries_the_state_in_its_client_metadata() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let mut request = format!("ws://{addr}/backend-api/codex/responses")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", bearer.parse().unwrap());
    request
        .headers_mut()
        .insert("user-agent", LINUX_UA.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    let create = |model: &str| {
        tokio_tungstenite::tungstenite::Message::Text(
            json!({
                "type": "response.create",
                "model": model,
                "client_metadata": { "x-codex-turn-state": CLIENT_STATE }
            })
            .to_string()
            .into(),
        )
    };
    use futures_util::{SinkExt, StreamExt};
    for model in [MANAGED_MODEL, MANAGED_MODEL, OTHER_MODEL] {
        socket.send(create(model)).await.unwrap();
        loop {
            let message = socket.next().await.unwrap().unwrap();
            if message.to_text().unwrap().contains("response.completed") {
                break;
            }
        }
    }

    let issued = upstream.issued.lock().unwrap().clone();
    let metadata = upstream.ws_metadata.lock().unwrap().clone();
    // The first turn has no state to present, so the client's is dropped…
    assert_eq!(metadata[0]["x-codex-turn-state"], Value::Null);
    // …the metadata event of that turn supplies one for the next…
    assert_eq!(metadata[1]["x-codex-turn-state"], issued.as_str());
    // …and an unmanaged model keeps the client's own.
    assert_eq!(metadata[2]["x-codex-turn-state"], CLIENT_STATE);
    runtime.shutdown().await;
}

/// With the probe on, a login keeps a live state even when no one is
/// talking to it: the gateway fetches one of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_probe_fetches_a_state_without_any_traffic() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());

    // One turn tells the gateway which login and model to keep fresh.
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(store.status()["entries"][0]["source"], "response");

    // The probe leaves through the pool; this gateway has none configured,
    // so the test lets it use the gateway's own egress.
    let ready = runtime.ready().await.unwrap();
    let mut settings = store.settings();
    settings.probe.enabled = true;
    settings.probe.allow_direct = true;
    ready.turn_state.save(&ready.db, settings).await.unwrap();

    // The held state goes away and upstream starts issuing another one.
    *upstream.issued.lock().unwrap() = upstream_state(0x44);
    assert_eq!(
        store.clear(
            &cocodex_proxy::turn_state::RefreshSelector::default(),
            /*only_expired*/ false
        ),
        1
    );
    for _ in 0..120 {
        if store.status()["entries"][0]["source"] == "probe" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let entry = store.status()["entries"][0].clone();
    assert_eq!(entry["source"], "probe", "the probe never fetched a state");
    assert_eq!(entry["live"], true);
    assert_eq!(entry["lastProbeOutcome"], "ok");
    // The next relayed turn carries what the probe fetched.
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
        .await
        .unwrap();
    drain(response).await;
    let probed = upstream.issued.lock().unwrap().clone();
    assert_eq!(
        upstream
            .http_states
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .as_deref(),
        Some(probed.as_str())
    );
    runtime.shutdown().await;
}

/// A minimal forward proxy: it answers the absolute-URI requests an HTTP
/// client sends through a proxy, relays them to `origin`, and counts them.
async fn forward_proxy(origin: String, hits: Arc<std::sync::atomic::AtomicUsize>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let target = origin.trim_start_matches("http://").to_string();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let target = target.clone();
            let hits = Arc::clone(&hits);
            tokio::spawn(async move {
                // Read the request head, which carries the absolute URI.
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    match client.read(&mut byte).await {
                        Ok(1) => head.push(byte[0]),
                        _ => return,
                    }
                }
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let head = String::from_utf8_lossy(&head)
                    .replace(&format!("http://{target}"), "")
                    .into_bytes();
                let Ok(mut upstream) = tokio::net::TcpStream::connect(&target).await else {
                    return;
                };
                if upstream.write_all(&head).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    format!("http://{addr}")
}

/// Everything the probe fetches must leave through the configured pool, and
/// a file of exits is one pool that is re-read as it changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_probe_leaves_through_the_proxy_pool() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let proxy = forward_proxy(origin.clone(), Arc::clone(&hits)).await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());

    // A file listing the pool, as the console configures it.
    let dir = common::scratch_dir();
    let pool = dir.join("proxy-pool.txt");
    std::fs::write(&pool, format!("# exits\n\n{proxy}\n")).unwrap();

    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;

    let ready = runtime.ready().await.unwrap();
    let mut settings = store.settings();
    settings.probe.enabled = true;
    settings.probe.proxy_pool = vec![cocodex_proxy::turn_state::settings::ProxyEndpoint {
        url_file: pool.to_string_lossy().to_string(),
        ..Default::default()
    }];
    ready.turn_state.save(&ready.db, settings).await.unwrap();

    *upstream.issued.lock().unwrap() = upstream_state(0x55);
    store.clear(
        &cocodex_proxy::turn_state::RefreshSelector::default(),
        /*only_expired*/ false,
    );
    for _ in 0..120 {
        if store.status()["entries"][0]["source"] == "probe" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        store.status()["entries"][0]["source"],
        "probe",
        "the probe never fetched a state through the pool"
    );
    assert!(
        hits.load(std::sync::atomic::Ordering::SeqCst) > 0,
        "the probe did not go through the configured exit"
    );
    std::fs::remove_dir_all(&dir).unwrap();
    runtime.shutdown().await;
}

/// Upstream decides what a state looks like. A Pro account was measured
/// issuing 11-block (312 character) states, so a gateway that only keeps
/// states of some expected shape holds nothing, strips what the client had
/// and sends the turn out with no state at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_state_of_an_unexpected_shape_is_still_the_one_presented() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());

    for (round, blocks) in [11usize, 10, 12, 14].into_iter().enumerate() {
        // Each round's state is newer than the last, as upstream's are.
        *upstream.issued.lock().unwrap() =
            upstream_state_at(0x20 + blocks as u8, blocks, 10 - round as i64);
        let response = app
            .clone()
            .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
            .await
            .unwrap();
        drain(response).await;
        let issued = upstream.issued.lock().unwrap().clone();
        let response = app
            .clone()
            .oneshot(turn(&bearer, MANAGED_MODEL, Some(CLIENT_STATE)))
            .await
            .unwrap();
        drain(response).await;
        assert_eq!(
            upstream
                .http_states
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .as_deref(),
            Some(issued.as_str()),
            "a {blocks}-block state must be held and presented"
        );
        assert_eq!(store.status()["entries"][0]["blocks"], blocks);
    }
    runtime.shutdown().await;
}

/// A client that already holds a good state must keep it. Upstream only
/// issues a state when it wants to change the routing, so a turn the gateway
/// sends without one starts cold — which is how a client that had earned a
/// state ends up served by a cheaper model.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_valid_client_state_is_carried_and_learned() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    // Upstream issues nothing back, as it does on a turn it serves normally.
    *upstream.issued.lock().unwrap() = String::new();
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());

    let earned = upstream_state(0x66);
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(&earned)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drain(response).await;

    assert_eq!(
        upstream.http_states.lock().unwrap()[0].as_deref(),
        Some(earned.as_str()),
        "the client's own state must reach upstream when the gateway holds none"
    );
    // And the gateway has learned it, so the next client routed to this
    // login carries it too.
    let entry = store.status()["entries"][0].clone();
    assert_eq!(entry["source"], "client");
    assert_eq!(entry["live"], true);
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[1].as_deref(),
        Some(earned.as_str())
    );
    runtime.shutdown().await;
}

/// A Responses WebSocket is given its turn state on the handshake. Reading it
/// only from the frames that follow loses it for the whole connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_handshake_turn_state_is_captured_and_presented() {
    use futures_util::{SinkExt, StreamExt};

    common::pin_codex_version();
    let db = common::test_db().await;
    let state = Upstream {
        issued: Arc::new(Mutex::new(upstream_state(0x77))),
        ..Upstream::default()
    };
    let app = Router::new()
        .route(
            "/backend-api/codex/responses",
            get(responses_ws_handshake_state).post(responses_http),
        )
        .fallback(post(|| async { "ok" }))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (gateway, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let store = Arc::clone(runtime.turn_state());
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
        .insert("user-agent", LINUX_UA.parse().unwrap());
    let (mut socket, handshake) = tokio_tungstenite::connect_async(request).await.unwrap();
    for _ in 0..2 {
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({ "type": "response.create", "model": MANAGED_MODEL })
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

    let issued = state.issued.lock().unwrap().clone();
    // The client must not pick the state up from the handshake: it is handed
    // the one the gateway settles on, per turn, in the metadata event.
    assert!(
        handshake.headers().get("x-codex-turn-state").is_none(),
        "the handshake response must not carry a turn state to the client"
    );
    let entry = store.status()["entries"][0].clone();
    assert_eq!(entry["source"], "handshake", "{entry}");
    assert_eq!(entry["live"], true);
    // The second turn carries it, which is what the connection was missing.
    let metadata = state.ws_metadata.lock().unwrap().clone();
    assert_eq!(metadata[1]["x-codex-turn-state"], issued.as_str());
    runtime.shutdown().await;
}

/// A state of the shape the gateway is hunting away from must not reach the
/// client. The client replays whatever it is handed, so passing one on pins
/// every later turn to the model that issued it — the loop this whole feature
/// exists to break.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_client_is_never_handed_a_state_of_the_wrong_shape() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, upstream) = mock_upstream().await;
    db.insert_account("linux@x", "acct-1", "linux", "linux-token")
        .await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let (app, runtime) = cocodex_proxy::build(common::config(db.settings(), &origin), None);
    let ready = runtime.ready().await.unwrap();
    let mut settings = ready.turn_state.settings();
    settings.preferred_blocks = vec![10];
    ready.turn_state.save(&ready.db, settings).await.unwrap();

    // Upstream issues the shape that routes elsewhere.
    let wrong_shape = upstream_state(0x11);
    *upstream.issued.lock().unwrap() = wrong_shape.clone();
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers().get("x-codex-turn-state").is_none(),
        "a state the gateway will not present must not reach the client"
    );
    drain(response).await;
    // It is still relayed onward without one rather than with the bad state.
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, Some(&wrong_shape)))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[1],
        None,
        "the client's copy of the wrong shape must not go upstream either"
    );

    // Once the wanted shape turns up, both ends get it.
    let wanted = upstream_state_with(0x22, 10);
    *upstream.issued.lock().unwrap() = wanted.clone();
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get("x-codex-turn-state")
            .and_then(|value| value.to_str().ok()),
        Some(wanted.as_str()),
        "the client should adopt the state the gateway settled on"
    );
    drain(response).await;
    let response = app
        .clone()
        .oneshot(turn(&bearer, MANAGED_MODEL, None))
        .await
        .unwrap();
    drain(response).await;
    assert_eq!(
        upstream.http_states.lock().unwrap()[3].as_deref(),
        Some(wanted.as_str())
    );
    runtime.shutdown().await;
}
