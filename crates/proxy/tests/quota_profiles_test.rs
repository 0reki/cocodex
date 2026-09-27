//! Quota profiles: an admin caps a user's Deep Research and image uses, the
//! user sees their own allowance in `/conversation/init`, and a turn past it
//! is refused.

mod common;

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{Request, StatusCode};
use cocodex_proxy::auth::portal::{PortalTokenKind, issue_portal_token};
use cocodex_proxy::create_router;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;

const WEBVIEW_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/// Turns upstream took, by the features they asked for.
type Turns = Arc<Mutex<Vec<Value>>>;

async fn mock_upstream() -> (String, Turns) {
    let turns = Turns::default();
    let app = Router::new()
        .route(
            "/backend-api/conversation/init",
            // The upstream account's pool, shared by every user on it.
            axum::routing::post(|| async {
                axum::Json(json!({
                    "type": "conversation_detail_metadata",
                    "limits_progress": [
                        { "feature_name": "deep_research", "remaining": 250,
                          "reset_after": "2026-10-27T14:57:39.889987+00:00" },
                        { "feature_name": "image_gen", "remaining": 1000,
                          "reset_after": "2026-09-28T14:57:39.890011+00:00" }
                    ],
                    "default_model_slug": "auto"
                }))
            }),
        )
        .route(
            "/backend-api/f/conversation",
            axum::routing::post(|State(turns): State<Turns>, body: Bytes| async move {
                let body: Value = serde_json::from_slice(&body).unwrap();
                turns.lock().unwrap().push(body["system_hints"].clone());
                "data: [DONE]\n\n"
            }),
        )
        .with_state(turns.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, turns)
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

fn turn(hint: &str) -> Option<Value> {
    Some(json!({
        "action": "next",
        "system_hints": [hint],
        "messages": [{ "metadata": { "system_hints": [hint] } }]
    }))
}

fn remaining(init: &Value, feature: &str) -> i64 {
    init["limits_progress"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["feature_name"] == feature)
        .unwrap()["remaining"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn a_profile_caps_a_users_feature_uses() {
    common::pin_codex_version();
    let db = common::test_db().await;
    let (origin, turns) = mock_upstream().await;
    db.insert_account("win@x", "acct-1", "windows", "win-token")
        .await;
    let user = db.create_user("alice").await;
    db.assign(&user, "acct-1").await;
    let bearer = db.client_bearer(&user).await;
    let admin_id = db.create_user("root").await;
    sqlx::query("UPDATE portal_users SET role = 'admin' WHERE id = $1::uuid")
        .bind(&admin_id)
        .execute(&db.pool)
        .await
        .unwrap();
    let admin = format!(
        "Bearer {}",
        issue_portal_token(
            common::TEST_SECRET.as_bytes(),
            &admin_id,
            PortalTokenKind::Access
        )
        .token
    );
    let app = create_router(common::config(db.settings(), &origin), None);

    // Every user starts on the default profile: 25%, no caps of its own.
    let (status, profiles) = call(&app, &admin, "GET", "/api/quota-profiles", None).await;
    assert_eq!(status, StatusCode::OK, "{profiles}");
    let default = &profiles["items"][0];
    assert_eq!(default["isDefault"], true);
    assert_eq!(default["weeklySharePercent"], 25.0);
    assert_eq!(default["deepResearchLimit"], Value::Null);
    let (_, init) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/conversation/init",
        Some(json!({})),
    )
    .await;
    assert_eq!(remaining(&init, "deep_research"), 250);

    // A profile capping both, and alice on it with images overridden.
    let (status, created) = call(
        &app,
        &admin,
        "POST",
        "/api/quota-profiles",
        Some(json!({
            "name": "limited", "weeklySharePercent": 10,
            "deepResearchLimit": 1, "imageGenLimit": 5
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let profile_id = created["profile"]["id"].as_str().unwrap().to_string();
    let (status, assigned) = call(
        &app,
        &admin,
        "PUT",
        &format!("/api/users/{user}/quota-profile"),
        Some(json!({
            "profileId": profile_id,
            "overrides": { "imageGenLimit": 2, "proMessageLimit": 1 }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assigned}");
    assert_eq!(
        assigned["quota"]["effective"],
        json!({
            "weeklySharePercent": 10.0, "deepResearchLimit": 1,
            "imageGenLimit": 2, "proMessageLimit": 1
        })
    );
    let (_, users) = call(&app, &admin, "GET", "/api/users", None).await;
    let alice = users["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == user.as_str())
        .unwrap();
    assert_eq!(alice["quota"]["profileName"], "limited");
    assert_eq!(
        alice["quota"]["overrides"],
        json!({ "imageGenLimit": 2, "proMessageLimit": 1 })
    );

    // conversation/init reports alice's own allowance, not the pool's.
    let (status, init) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/conversation/init",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(remaining(&init, "deep_research"), 1);
    assert_eq!(remaining(&init, "image_gen"), 2);
    assert_eq!(init["default_model_slug"], "auto");

    // One Deep Research turn goes through and is counted...
    let (status, _) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/f/conversation",
        turn("plugin:connector_openai_deep_research"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut init = Value::Null;
    for _ in 0..50 {
        init = call(
            &app,
            &bearer,
            "POST",
            "/backend-api/conversation/init",
            Some(json!({})),
        )
        .await
        .1;
        if remaining(&init, "deep_research") == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(remaining(&init, "deep_research"), 0);
    // ...and the next one is refused before it reaches upstream.
    let (status, refused) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/f/conversation",
        turn("plugin:connector_openai_deep_research"),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{refused}");
    assert_eq!(refused["detail"]["code"], "feature_quota_exceeded");
    // Images and plain turns are unaffected.
    let (status, _) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/f/conversation",
        turn("picture_v2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &app,
        &bearer,
        "POST",
        "/backend-api/f/conversation",
        Some(json!({ "action": "next", "system_hints": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A Pro model counts every message against its own weekly cap.
    let pro = || Some(json!({ "action": "next", "model": "gpt-6-pro", "system_hints": [] }));
    let (status, _) = call(&app, &bearer, "POST", "/backend-api/f/conversation", pro()).await;
    assert_eq!(status, StatusCode::OK);
    let mut refused = (StatusCode::OK, Value::Null);
    for _ in 0..50 {
        // The use is recorded once upstream answers; wait for it.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let used: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM feature_usage WHERE feature = 'pro_message'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        if used == 1 {
            refused = call(&app, &bearer, "POST", "/backend-api/f/conversation", pro()).await;
            break;
        }
    }
    assert_eq!(refused.0, StatusCode::TOO_MANY_REQUESTS, "{}", refused.1);

    assert_eq!(
        *turns.lock().unwrap(),
        vec![
            json!(["plugin:connector_openai_deep_research"]),
            json!(["picture_v2"]),
            json!([]),
            json!([]),
        ]
    );

    // Codex's own image tool is not ChatGPT image generation: it counts
    // against nothing here, whatever its body says.
    let image_uses = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM feature_usage WHERE feature = 'image_gen'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap()
    };
    let before = image_uses().await;
    call(
        &app,
        &bearer,
        "POST",
        "/backend-api/codex/images/generations",
        Some(json!({ "prompt": "a cat", "system_hints": ["picture_v2"] })),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(image_uses().await, before);

    // The default profile stays; a deleted one hands its users back to it.
    let default_id = default["id"].as_str().unwrap();
    let (status, _) = call(
        &app,
        &admin,
        "DELETE",
        &format!("/api/quota-profiles/{default_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        &admin,
        "DELETE",
        &format!("/api/quota-profiles/{profile_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, users) = call(&app, &admin, "GET", "/api/users", None).await;
    let alice = users["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == user.as_str())
        .unwrap();
    assert_eq!(alice["quota"]["profileName"], "默认");
    assert_eq!(alice["quota"]["effective"]["weeklySharePercent"], 25.0);
    // The override outlives the profile.
    assert_eq!(alice["quota"]["effective"]["imageGenLimit"], 2);
}
