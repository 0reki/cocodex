//! The gateway replaces the Codex client's identity — in the request body,
//! the `/models` query and the cookie jar — with the upstream login's, the
//! same way it already does for request headers.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{CONTENT_ENCODING, CONTENT_TYPE, COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, Request, StatusCode};
use cocodex_proxy::create_router;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;

const WINDOWS_UA: &str = "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal";

#[derive(Clone, Default)]
struct Captured {
    responses: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    models_queries: Arc<Mutex<Vec<String>>>,
}

async fn mock_upstream() -> (String, Captured) {
    let captured = Captured::default();
    let responses = Router::new()
        .route(
            "/backend-api/codex/responses",
            axum::routing::post(
                |State(state): State<Captured>, headers: HeaderMap, body: Bytes| async move {
                    let decoded = match headers.get(CONTENT_ENCODING).and_then(|v| v.to_str().ok())
                    {
                        Some("zstd") => zstd::decode_all(body.as_ref()).unwrap(),
                        _ => body.to_vec(),
                    };
                    let value: Value = serde_json::from_slice(&decoded).unwrap();
                    state.responses.lock().unwrap().push((headers, value));
                    // Hand the client an infrastructure cookie to remember,
                    // and report the login's user the way Responses does.
                    (
                        [
                            (SET_COOKIE, "__cf_bm=cf-value; Path=/; Secure; HttpOnly"),
                            (CONTENT_TYPE, "text/event-stream"),
                        ],
                        concat!(
                            "event: response.created\n",
                            r#"data: {"type":"response.created","response":{"id":"resp_1","safety_identifier":"user-UPSTREAM"}}"#,
                            "\n\n"
                        ),
                    )
                },
            ),
        )
        .route(
            "/backend-api/wham/usage",
            // Shape of chatgpt.com's reply: the login's own identity.
            axum::routing::get(|| async {
                axum::Json(json!({
                    "user_id": "user-UPSTREAM",
                    "account_id": "acct-1",
                    "email": "win@x",
                    "plan_type": "plus",
                    "rate_limit": { "allowed": true }
                }))
            }),
        )
        .route(
            "/backend-api/codex/models",
            axum::routing::get(
                |State(state): State<Captured>, uri: axum::http::Uri| async move {
                    state
                        .models_queries
                        .lock()
                        .unwrap()
                        .push(uri.query().unwrap_or_default().to_string());
                    "ok"
                },
            ),
        )
        .with_state(captured.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, responses).await.unwrap() });
    (origin, captured)
}

async fn setup() -> (Router, Captured, String) {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    db.set_upstream_user_id("acct-1", "user-UPSTREAM").await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let app = create_router(common::config(db.settings(), &origin), None);
    (app, captured, bearer)
}

fn responses_request(bearer: &str, encoding: Option<&str>, body: Value) -> Request<Body> {
    let raw = serde_json::to_vec(&body).unwrap();
    let (payload, encoded) = match encoding {
        Some("zstd") => (zstd::encode_all(raw.as_slice(), 3).unwrap(), true),
        _ => (raw, false),
    };
    let mut builder = Request::builder()
        .uri("/backend-api/codex/responses")
        .method("POST")
        .header("authorization", bearer)
        .header("user-agent", WINDOWS_UA)
        .header(CONTENT_TYPE, "application/json");
    if encoded {
        builder = builder.header(CONTENT_ENCODING, "zstd");
    }
    builder.body(Body::from(payload)).unwrap()
}

fn body_with_client_identity() -> Value {
    json!({
        "model": "gpt-5.4",
        "input": "ping",
        "stream": true,
        "client_metadata": {
            "x-codex-installation-id": "client-install",
            "session_id": "sess-1",
            "x-codex-turn-metadata":
                r#"{"installation_id":"client-install","turn_id":"t1","workspaces":{"/home/alice/secret":{"associated_remote_urls":{"origin":"https://github.com/alice/secret.git"}}}}"#
        }
    })
}

fn gateway_install() -> String {
    cocodex_proxy::client_identity::gateway_installation_id("acct-1", "windows")
}

#[tokio::test]
async fn request_body_identity_is_rewritten_plain_and_zstd() {
    let (app, captured, bearer) = setup().await;

    for encoding in [None, Some("zstd")] {
        let response = app
            .clone()
            .oneshot(responses_request(
                &bearer,
                encoding,
                body_with_client_identity(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let responses = captured.responses.lock().unwrap();
    assert_eq!(responses.len(), 2);
    let install = gateway_install();
    for (_, body) in responses.iter() {
        let metadata = &body["client_metadata"];
        assert_eq!(metadata["x-codex-installation-id"], install);
        assert_eq!(metadata["session_id"], "sess-1");
        let turn: Value =
            serde_json::from_str(metadata["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
        assert_eq!(turn["installation_id"], install);
        assert_eq!(turn["turn_id"], "t1");
        // The client's workspaces are its own and pass through unchanged.
        assert_eq!(
            turn["workspaces"]["/home/alice/secret"]["associated_remote_urls"]["origin"],
            "https://github.com/alice/secret.git"
        );
    }
}

#[tokio::test]
async fn upstream_cookies_are_kept_and_replayed() {
    let (app, captured, bearer) = setup().await;

    // First turn: no cookie yet, upstream sets one.
    let response = app
        .clone()
        .oneshot(responses_request(
            &bearer,
            None,
            body_with_client_identity(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    // Second turn: the login's stored cookie rides along.
    let response = app
        .clone()
        .oneshot(responses_request(
            &bearer,
            None,
            body_with_client_identity(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let responses = captured.responses.lock().unwrap();
    assert!(responses[0].0.get(COOKIE).is_none());
    assert_eq!(responses[1].0[COOKIE], "__cf_bm=cf-value");
}

#[tokio::test]
async fn models_client_version_query_is_replaced() {
    let (app, captured, bearer) = setup().await;

    let request = Request::builder()
        .uri("/backend-api/codex/models?client_version=0.1.0-client&foo=bar")
        .method("GET")
        .header("authorization", &bearer)
        .header("user-agent", WINDOWS_UA)
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);

    let queries = captured.models_queries.lock().unwrap();
    assert_eq!(queries[0], "client_version=0.154.0&foo=bar");
}

#[tokio::test]
async fn upstream_identity_in_responses_becomes_the_clients() {
    let (app, _captured, bearer) = setup().await;

    let request = Request::builder()
        .uri("/backend-api/wham/usage")
        .method("GET")
        .header("authorization", &bearer)
        .header("user-agent", WINDOWS_UA)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let usage: Value = serde_json::from_slice(&body).unwrap();
    // What the client's own token says about it.
    let token = bearer.trim_start_matches("Bearer ");
    let claims = cocodex_proxy::auth::jwt::ClientJwt::from_secret(common::TEST_SECRET)
        .verify_access_token(token)
        .unwrap();
    assert_eq!(
        usage["user_id"],
        claims.openai_auth.chatgpt_user_id.as_str()
    );
    assert_eq!(
        usage["account_id"],
        claims.openai_auth.chatgpt_account_id.as_str()
    );
    assert_eq!(usage["email"], "user@openai.com");
    assert_eq!(usage["plan_type"], "plus");

    let response = app
        .oneshot(responses_request(
            &bearer,
            None,
            body_with_client_identity(),
        ))
        .await
        .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(!body.contains("user-UPSTREAM"), "{body}");
    assert!(
        body.contains(&format!(
            r#""safety_identifier":"{}""#,
            claims.openai_auth.chatgpt_user_id
        )),
        "{body}"
    );
}

#[tokio::test]
async fn environment_context_timezone_is_replaced_end_to_end() {
    let (app, captured, bearer) = setup().await;

    // A Responses input whose environment context carries the user's tz/date.
    let body = json!({
        "model": "gpt-5.4",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": "<environment_context>\n  <cwd>/home/alice/repo</cwd>\n  \
                         <current_date>2020-01-01</current_date>\n  \
                         <timezone>Asia/Shanghai</timezone>\n</environment_context>"
            }]
        }],
        "client_metadata": { "x-codex-installation-id": "client-install" }
    });
    let response = app
        .oneshot(responses_request(&bearer, None, body))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let responses = captured.responses.lock().unwrap();
    let text = responses[0].1["input"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    // The gateway pins the egress locale to America/New_York in tests.
    assert!(
        text.contains("<timezone>America/New_York</timezone>"),
        "{text}"
    );
    assert!(!text.contains("Asia/Shanghai"), "{text}");
    assert!(!text.contains("2020-01-01"), "{text}");
    // The user's own path is left intact.
    assert!(text.contains("<cwd>/home/alice/repo</cwd>"), "{text}");
}
