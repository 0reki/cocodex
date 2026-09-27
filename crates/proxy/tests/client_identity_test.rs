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
/// The desktop app's webview, which calls ChatGPT's own endpoints.
const WEBVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

#[derive(Clone, Default)]
struct Captured {
    responses: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    models_queries: Arc<Mutex<Vec<String>>>,
    /// (User-Agent, path and query) of the webview's ChatGPT requests.
    webview: Arc<Mutex<Vec<(String, String)>>>,
}

fn record_webview(state: &Captured, headers: &HeaderMap, uri: &axum::http::Uri) {
    let agent = headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    state.webview.lock().unwrap().push((agent, uri.to_string()));
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
                            (
                                axum::http::HeaderName::from_static("x-codex-turn-state"),
                                "upstream-state",
                            ),
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
        .route(
            "/backend-api/me",
            // Shape of chatgpt.com's reply, with the login's person in it.
            axum::routing::get(
                |State(state): State<Captured>, headers: HeaderMap, uri: axum::http::Uri| async move {
                    record_webview(&state, &headers, &uri);
                    axum::Json(json!({
                        "object": "user",
                        "id": "user-UPSTREAM",
                        "email": "win@x",
                        "name": "kk",
                        "picture": "https://cdn.auth0.com/avatars/kk.png",
                        "phone_number": "+48576391110",
                        "created": 1787633488,
                        "amr": ["urn:openai:amr:apple"],
                        "country": "SG",
                        "orgs": { "object": "list", "data": [{
                            "object": "organization",
                            "id": "org-UPSTREAM",
                            "created": 1787633487,
                            "title": "Personal",
                            "name": "user-upstream",
                            "description": "Personal org for win@x",
                            "personal": true
                        }]},
                        "first_name": null
                    }))
                },
            ),
        )
        .route(
            "/backend-api/wham/profiles/me",
            axum::routing::get(
                |State(state): State<Captured>, headers: HeaderMap, uri: axum::http::Uri| async move {
                    record_webview(&state, &headers, &uri);
                    // chatgpt.com pretty-prints this one.
                    serde_json::to_string_pretty(&json!({
                        "profile": {
                            "username": "win",
                            "display_name": "kk",
                            "profile_picture_url": "https://cdn.auth0.com/avatars/kk.png"
                        },
                        "stats": { "lifetime_tokens": 12341904269_i64, "total_threads": 1694 }
                    }))
                    .unwrap()
                },
            ),
        )
        .route(
            "/backend-api/accounts/check/v4-2023-04-27",
            axum::routing::get(
                |State(state): State<Captured>, headers: HeaderMap, uri: axum::http::Uri| async move {
                    record_webview(&state, &headers, &uri);
                    axum::Json(json!({ "accounts": { "acct-1": {
                        "account": {
                            "account_id": "acct-1",
                            "account_owner_id": "user-UPSTREAM",
                            "created_time": "2026-08-25T04:51:29.428628Z",
                            "pthdnu": "9a077e77608a3aa6c8769b5279a6fbf84441946232772b2485075f5b72bcb97f",
                            "plan_type": "plus"
                        },
                        "features": ["wham"]
                    }}}))
                },
            ),
        )
        .route(
            "/public-api/gizmos/discovery/mine",
            axum::routing::get(
                |State(state): State<Captured>, headers: HeaderMap, uri: axum::http::Uri| async move {
                    record_webview(&state, &headers, &uri);
                    // The login's own GPTs name it as their author.
                    axum::Json(json!({
                        "info": { "id": "mine", "title": "My GPTs" },
                        "list": { "items": [{ "resource": { "gizmo": {
                            "id": "g-1",
                            "organization_id": "org-UPSTREAM",
                            "author": { "user_id": "user-UPSTREAM" }
                        }}}], "cursor": null }
                    }))
                },
            ),
        )
        .route(
            "/backend-api/celsius/ws/user",
            // Upstream's own WebSocket credentials, which name the login.
            axum::routing::get(|| async {
                axum::Json(json!({
                    "websocket_url": "wss://ws.chatgpt.com/celsius/user-UPSTREAM?account=acct-1",
                    "user_id": "user-UPSTREAM"
                }))
            }),
        )
        .route(
            "/backend-api/subscriptions",
            axum::routing::get(
                |State(state): State<Captured>, headers: HeaderMap, uri: axum::http::Uri| async move {
                    record_webview(&state, &headers, &uri);
                    axum::Json(json!({ "account_id": "acct-1", "plan_type": "plus" }))
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

async fn webview_get(app: &Router, bearer: &str, uri: &str) -> Value {
    let request = Request::builder()
        .uri(uri)
        .method("GET")
        .header("authorization", bearer)
        .header("user-agent", WEBVIEW_UA)
        .header("cf-ipcountry", "JP")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    for upstream in [
        "UPSTREAM",
        "upstream",
        "acct-1",
        "win@x",
        "kk",
        "+48",
        "1787633",
        "apple",
        "SG",
        "2026-08-25",
        "9a077e",
        "12341904269",
        "1694",
    ] {
        assert!(!text.contains(upstream), "{upstream} leaked: {text}");
    }
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn webview_chatgpt_requests_are_presented_as_the_login_and_answered_as_the_client() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, captured) = mock_upstream().await;
    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    db.set_upstream_user_id("acct-1", "user-UPSTREAM").await;
    let user = db.create_user("user-1").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    // The client's own usage: two hours on one day.
    sqlx::query(
        "INSERT INTO model_response_log_owner_hourly_rollups \
           (hour_bucket, owner_user_id, model_id, request_count, total_tokens) \
         VALUES ('2026-09-01T03:00:00Z', $1::uuid, 'gpt-5.4', 1, 400), \
                ('2026-09-01T05:00:00Z', $1::uuid, 'gpt-5.4', 1, 200)",
    )
    .bind(&user)
    .execute(&db.pool)
    .await
    .unwrap();
    let created: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT created_at FROM portal_users WHERE id = $1::uuid")
            .bind(&user)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let app = create_router(common::config(db.settings(), &origin), None);
    let token = bearer.trim_start_matches("Bearer ");
    let claims = cocodex_proxy::auth::jwt::ClientJwt::from_secret(common::TEST_SECRET)
        .verify_access_token(token)
        .unwrap();
    let auth = &claims.openai_auth;
    let profile = claims.openai_profile.as_ref().unwrap();
    let initials: String = profile
        .name
        .chars()
        .take(2)
        .collect::<String>()
        .to_lowercase();
    let picture = format!("https://cdn.auth0.com/avatars/{initials}.png");

    let me = webview_get(&app, &bearer, "/backend-api/me").await;
    assert_eq!(me["id"], auth.chatgpt_user_id.as_str());
    assert_eq!(me["email"], "user@openai.com");
    assert_eq!(me["name"], profile.name.as_str());
    assert_eq!(me["picture"], picture.as_str());
    assert_eq!(me["phone_number"], Value::Null);
    let org = &me["orgs"]["data"][0];
    assert_eq!(org["id"], auth.poid.as_deref().unwrap());
    assert_eq!(org["name"], auth.chatgpt_user_id.to_lowercase().as_str());
    assert_eq!(org["description"], "Personal org for user@openai.com");
    assert_eq!(me["created"], created.timestamp());
    assert_eq!(org["created"], created.timestamp() - 1);
    assert_eq!(me["amr"], json!(auth.amr));
    assert_eq!(me["country"], "JP");

    let check = webview_get(&app, &bearer, "/backend-api/accounts/check/v4-2023-04-27").await;
    let account = &check["accounts"][auth.chatgpt_account_id.as_str()]["account"];
    assert_eq!(account["account_id"], auth.chatgpt_account_id.as_str());
    assert_eq!(account["plan_type"], "plus");
    assert_eq!(account["pthdnu"].as_str().unwrap().len(), 64);
    let account_created =
        chrono::DateTime::parse_from_rfc3339(account["created_time"].as_str().unwrap()).unwrap();
    assert_eq!(account_created, created);

    let wham = webview_get(&app, &bearer, "/backend-api/wham/profiles/me").await;
    assert_eq!(wham["profile"]["username"], "user");
    assert_eq!(wham["profile"]["display_name"], profile.name.as_str());
    assert_eq!(wham["profile"]["profile_picture_url"], picture.as_str());
    assert_eq!(wham["stats"]["lifetime_tokens"], 600);
    assert_eq!(wham["stats"]["total_threads"], 0);
    assert_eq!(
        wham["stats"]["daily_usage_buckets"],
        json!([{ "start_date": "2026-09-01", "tokens": 600 }])
    );

    // The webview asks about the account its own token names.
    let uri = format!(
        "/backend-api/subscriptions?account_id={}",
        auth.chatgpt_account_id
    );
    let subscription = webview_get(&app, &bearer, &uri).await;
    assert_eq!(subscription["account_id"], auth.chatgpt_account_id.as_str());

    let seen = captured.webview.lock().unwrap();
    assert_eq!(seen.len(), 4);
    // A browser agent goes upstream as is: a mangled one is banned by
    // Cloudflare (403 "error code: 1010").
    assert!(
        seen.iter().all(|(agent, _)| agent == WEBVIEW_UA),
        "{seen:?}"
    );
    assert_eq!(seen[3].1, "/backend-api/subscriptions?account_id=acct-1");
}

#[tokio::test]
async fn payments_are_never_relayed() {
    let (app, captured, bearer) = setup().await;
    for (method, uri) in [
        (
            "GET",
            "/backend-api/payments/payment_methods?account_id=acct-1",
        ),
        ("POST", "/backend-api/payments/payment_methods"),
        ("GET", "/backend-api/payments/checkout"),
        ("GET", "/backend-api/subscriptions/auto_top_up/settings"),
        ("POST", "/backend-api/subscriptions/auto_top_up/enable"),
    ] {
        let request = Request::builder()
            .uri(uri)
            .method(method)
            .header("authorization", &bearer)
            .header("user-agent", WEBVIEW_UA)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {uri}");
    }
    assert!(captured.webview.lock().unwrap().is_empty());
    // Only those: the subscription itself is still relayed.
    let request = Request::builder()
        .uri("/backend-api/subscriptions?account_id=acct-1")
        .header("authorization", &bearer)
        .header("user-agent", WEBVIEW_UA)
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn public_api_is_relayed_as_the_client() {
    let (app, captured, bearer) = setup().await;
    let token = bearer.trim_start_matches("Bearer ");
    let claims = cocodex_proxy::auth::jwt::ClientJwt::from_secret(common::TEST_SECRET)
        .verify_access_token(token)
        .unwrap();

    let mine = webview_get(&app, &bearer, "/public-api/gizmos/discovery/mine?limit=20").await;
    let gizmo = &mine["list"]["items"][0]["resource"]["gizmo"];
    assert_eq!(
        gizmo["author"]["user_id"],
        claims.openai_auth.chatgpt_user_id.as_str()
    );
    assert_eq!(
        gizmo["organization_id"],
        claims.openai_auth.poid.as_deref().unwrap()
    );

    let seen = captured.webview.lock().unwrap();
    assert_eq!(
        seen.as_slice(),
        [(
            WEBVIEW_UA.to_string(),
            "/public-api/gizmos/discovery/mine?limit=20".to_string()
        )]
    );
}

#[tokio::test]
async fn turn_state_is_relayed_as_is() {
    let (app, captured, bearer) = setup().await;
    let mut request = responses_request(&bearer, None, body_with_client_identity());
    request.headers_mut().insert(
        "x-codex-turn-state",
        axum::http::HeaderValue::from_static("client-state"),
    );
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // Upstream's state reaches the client, and the client's reaches upstream.
    assert_eq!(response.headers()["x-codex-turn-state"], "upstream-state");
    let responses = captured.responses.lock().unwrap();
    assert_eq!(responses[0].0["x-codex-turn-state"], "client-state");
}

#[tokio::test]
async fn upstream_websocket_credentials_are_relayed_verbatim() {
    let (app, _captured, bearer) = setup().await;
    let request = Request::builder()
        .uri("/backend-api/celsius/ws/user")
        .header("authorization", &bearer)
        .header("user-agent", WEBVIEW_UA)
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        body,
        json!({
            "websocket_url": "wss://ws.chatgpt.com/celsius/user-UPSTREAM?account=acct-1",
            "user_id": "user-UPSTREAM"
        })
    );
}

#[tokio::test]
async fn a_profile_edit_never_reaches_the_upstream_login() {
    let (app, captured, bearer) = setup().await;
    let request = Request::builder()
        .method("PATCH")
        .uri("/backend-api/wham/profiles/me")
        .header("authorization", &bearer)
        .header("user-agent", WEBVIEW_UA)
        .header(CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"display_name":"renamed"}"#))
        .unwrap();
    // Upstream serves the profile to GET only: a PATCH would be a 405.
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let profile: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(profile["profile"]["username"], "user");
    assert_ne!(profile["profile"]["display_name"], "renamed");
    assert_eq!(captured.webview.lock().unwrap().len(), 1);
}
