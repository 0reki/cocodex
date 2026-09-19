mod common;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::response::Response;
use cocodex_proxy::create_router;
use cocodex_proxy::interceptor::{Interceptor, RequestAction, RequestContext, WsAction};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

struct TestInterceptor {
    intercepted: AtomicBool,
}

#[async_trait::async_trait]
impl Interceptor for TestInterceptor {
    async fn on_request(
        &self,
        _ctx: &mut RequestContext,
        _req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>> {
        self.intercepted.store(true, Ordering::SeqCst);
        let resp = Response::builder()
            .status(StatusCode::OK)
            .header("x-custom-intercepted", "true")
            .body(Body::from("custom-intercepted-response"))
            .unwrap();
        Ok(RequestAction::ShortCircuit(resp))
    }

    async fn on_response(
        &self,
        _ctx: &RequestContext,
        resp: Response,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        Ok(resp)
    }

    fn on_response_chunk(&self, _ctx: &RequestContext, _chunk: &[u8]) {}

    async fn on_ws_client_message(
        &self,
        _ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        Ok(WsAction::Forward(msg))
    }

    async fn on_ws_upstream_message(
        &self,
        _ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        Ok(WsAction::Forward(msg))
    }

    async fn on_request_finish(
        &self,
        _ctx: &RequestContext,
        _status_code: Option<u16>,
        _error: Option<&str>,
    ) {
    }
}

#[tokio::test]
async fn test_interceptor_short_circuit_on_backend_api() {
    let interceptor = Arc::new(TestInterceptor {
        intercepted: AtomicBool::new(false),
    });

    let config = common::config(common::offline_settings(), "https://chatgpt.com");

    let app = create_router(config, Some(interceptor.clone()));

    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("x-custom-intercepted").unwrap(),
        "true"
    );

    let body_bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(&body_bytes[..], b"custom-intercepted-response");
    assert!(interceptor.intercepted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn test_backend_api_requires_access_token() {
    let config = common::config(common::offline_settings(), "https://chatgpt.com");

    let app = create_router(config, None);
    let request = Request::builder()
        .uri("/backend-api/codex/models")
        .method("GET")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_path_normalization() {
    use cocodex_proxy::interceptor::normalize_upstream_path;

    assert_eq!(
        normalize_upstream_path("/backend-api/codex/responses"),
        "/backend-api/codex/responses"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/responses"),
        "/backend-api/codex/responses"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/models"),
        "/backend-api/codex/models"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/accounts/check"),
        "/backend-api/wham/accounts/check"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/profiles/me"),
        "/backend-api/wham/profiles/me"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/usage"),
        "/backend-api/wham/usage"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/tasks/list"),
        "/backend-api/wham/tasks/list"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/config/bundle"),
        "/backend-api/wham/config/bundle"
    );
    assert_eq!(
        normalize_upstream_path("/api/codex/settings/user"),
        "/backend-api/wham/settings/user"
    );
    assert_eq!(
        normalize_upstream_path("/wham/accounts/check"),
        "/backend-api/wham/accounts/check"
    );
    assert_eq!(normalize_upstream_path("/v1/responses"), "/v1/responses");
}

#[tokio::test]
async fn test_unknown_paths_are_not_found() {
    let app = create_router(
        common::config(common::offline_settings(), "https://chatgpt.com"),
        None,
    );
    for uri in ["/nothing-here", "/v1", "/v1/responses"] {
        let request = Request::builder().uri(uri).body(Body::empty()).unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }
}
