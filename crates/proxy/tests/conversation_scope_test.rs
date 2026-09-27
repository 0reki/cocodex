//! Users sharing one upstream account each see only their own ChatGPT
//! conversations.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{Request, StatusCode};
use cocodex_proxy::create_router;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;

const WEBVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const ALICE_CHAT: &str = "6ab9293a-fadc-83ea-80b7-004e72636b6d";
const BOB_CHAT: &str = "6ab9270f-a5b8-83ea-be3e-562f1f943a19";
const UNBOUND_CHAT: &str = "6ab91111-1111-83ea-be3e-562f1f943a19";
/// What upstream assigns to a chat started without an id.
const NEW_CHAT: &str = "6ab92222-2222-83ea-be3e-562f1f943a19";

/// Paths upstream was asked for.
type Seen = Arc<Mutex<Vec<String>>>;

async fn mock_upstream() -> (String, Seen) {
    let seen = Seen::default();
    let app = Router::new()
        .route(
            "/backend-api/f/conversation",
            axum::routing::post(|State(seen): State<Seen>, body: Bytes| async move {
                let body: Value = serde_json::from_slice(&body).unwrap();
                let named = body["conversation_id"].as_str().unwrap_or("new").to_string();
                seen.lock()
                    .unwrap()
                    .push(format!("POST /f/conversation {named}"));
                // The stream names the conversation, a new one included.
                let id = if named == "new" { NEW_CHAT.to_string() } else { named };
                format!(
                    "event: delta_encoding\ndata: \"v1\"\n\n\
                     data: {{\"type\": \"resume_conversation_token\", \"conversation_id\": \"{id}\"}}\n\n\
                     data: [DONE]\n\n"
                )
            }),
        )
        .route(
            "/backend-api/conversations",
            // The upstream account's whole history: everyone's chats.
            axum::routing::get(|State(seen): State<Seen>| async move {
                seen.lock().unwrap().push("GET /conversations".into());
                axum::Json(json!({
                    "items": [
                        { "id": NEW_CHAT, "title": "New chat" },
                        { "id": ALICE_CHAT, "title": "alice" },
                        { "id": BOB_CHAT, "title": "bob" },
                        { "id": UNBOUND_CHAT, "title": "from before" }
                    ],
                    "total": 97, "limit": 100, "offset": 0
                }))
            }),
        )
        .route(
            "/backend-api/conversation/{id}",
            axum::routing::get(
                |State(seen): State<Seen>, Path(id): Path<String>| async move {
                    seen.lock().unwrap().push(format!("GET /conversation/{id}"));
                    axum::Json(json!({ "conversation_id": id }))
                },
            ),
        )
        .with_state(seen.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, seen)
}

async fn call(
    app: &Router,
    bearer: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", bearer)
        .header("user-agent", WEBVIEW_UA);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let request = builder
        .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn turn(conversation_id: &str) -> Option<Value> {
    Some(json!({
        "action": "next",
        "model": "gpt-5-6-thinking",
        "conversation_id": conversation_id,
        "messages": []
    }))
}

#[tokio::test]
async fn each_user_sees_and_opens_only_their_own_conversations() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, seen) = mock_upstream().await;
    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    let alice = db.create_user("alice").await;
    let bob = db.create_user("bob").await;
    db.assign(&alice, "acct-1").await;
    db.assign(&bob, "acct-1").await;
    let alice = db.client_bearer(&alice).await;
    let bob = db.client_bearer(&bob).await;
    let app = create_router(common::config(db.settings(), &origin), None);

    // A turn binds the conversation it names to whoever sent it first.
    let (status, _) = call(
        &app,
        &alice,
        "POST",
        "/backend-api/f/conversation",
        turn(ALICE_CHAT),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        &bob,
        "POST",
        "/backend-api/f/conversation",
        turn(BOB_CHAT),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // Nobody can post into someone else's conversation.
    let (status, body) = call(
        &app,
        &bob,
        "POST",
        "/backend-api/f/conversation",
        turn(ALICE_CHAT),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "detail": "Not Found" }));

    // The history lists only the user's own.
    let (status, list) = call(
        &app,
        &alice,
        "GET",
        "/backend-api/conversations?offset=0&limit=100",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        list["items"],
        json!([{ "id": ALICE_CHAT, "title": "alice" }])
    );
    assert_eq!(list["total"], 1);
    let (_, list) = call(
        &app,
        &bob,
        "GET",
        "/backend-api/conversations?offset=0&limit=100",
        None,
    )
    .await;
    assert_eq!(list["items"], json!([{ "id": BOB_CHAT, "title": "bob" }]));

    // One conversation opens only for its owner; one never bound, for no one.
    let own = format!("/backend-api/conversation/{ALICE_CHAT}");
    assert_eq!(
        call(&app, &alice, "GET", &own, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, &bob, "GET", &own, None).await.0,
        StatusCode::NOT_FOUND
    );
    let unbound = format!("/backend-api/conversation/{UNBOUND_CHAT}");
    assert_eq!(
        call(&app, &alice, "GET", &unbound, None).await.0,
        StatusCode::NOT_FOUND
    );

    // A new chat names no conversation; upstream's stream does, and that
    // binds it to whoever started it.
    let new_chat = json!({ "action": "next", "system_hints": ["picture_v2"], "messages": [] });
    let (status, _) = call(
        &app,
        &alice,
        "POST",
        "/backend-api/f/conversation",
        Some(new_chat),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut listed = Value::Null;
    for _ in 0..50 {
        listed = call(&app, &alice, "GET", "/backend-api/conversations", None)
            .await
            .1;
        if listed["total"] == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        listed["items"],
        json!([{ "id": NEW_CHAT, "title": "New chat" }, { "id": ALICE_CHAT, "title": "alice" }])
    );
    let new_chat = format!("/backend-api/conversation/{NEW_CHAT}");
    assert_eq!(
        call(&app, &bob, "GET", &new_chat, None).await.0,
        StatusCode::NOT_FOUND
    );

    // ChatGPT turns are in the request log, free of charge.
    let mut logged: Vec<(String, Option<String>, Option<i32>, Option<f64>)> = Vec::new();
    for _ in 0..100 {
        logged = sqlx::query_as(
            "SELECT path, model_id, status_code, cost::float8 FROM model_response_logs \
             WHERE path = '/backend-api/f/conversation' ORDER BY request_time",
        )
        .fetch_all(&db.pool)
        .await
        .unwrap();
        if logged.len() >= 4 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(logged.len(), 4, "{logged:?}");
    assert!(
        logged
            .iter()
            .all(|(_, _, _, cost)| cost.unwrap_or(0.0) == 0.0)
    );
    assert!(logged.iter().any(|(_, model, status, _)| {
        model.as_deref() == Some("gpt-5-6-thinking") && *status == Some(200)
    }));
    // Bob's refused turn is there too, as refused.
    assert!(logged.iter().any(|(_, _, status, _)| *status == Some(404)));

    // What was refused never reached upstream.
    let seen: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|call| call.as_str() != "GET /conversations")
        .cloned()
        .collect();
    assert_eq!(
        seen,
        vec![
            format!("POST /f/conversation {ALICE_CHAT}"),
            format!("POST /f/conversation {BOB_CHAT}"),
            format!("GET /conversation/{ALICE_CHAT}"),
            "POST /f/conversation new".to_string(),
        ]
    );
}
