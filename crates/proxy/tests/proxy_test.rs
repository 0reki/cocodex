use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use cocodex_proxy::config::ProxyConfig;
use cocodex_proxy::create_router;
use cocodex_proxy::interceptor::{Interceptor, RequestAction, RequestContext, WsAction};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
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

    async fn on_response_chunk(
        &self,
        _ctx: &RequestContext,
        _chunk: &[u8],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        Ok(())
    }

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

    let config = ProxyConfig {
        bind_addr: "127.0.0.1:53141".parse().unwrap(),
        node_backend_url: "http://127.0.0.1:53142".to_string(),
        upstream_chatgpt_origin: "https://chatgpt.com".to_string(),
        ipc_socket_path: "./data/test-ipc.sock".to_string(),
        public_app_url: "http://localhost:53332".to_string(),
    };

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
async fn test_fallback_reverse_proxies_to_node_backend() {
    // 1. Spawn a mock Node.js server
    let mock_node = Router::new().route(
        "/api/users",
        get(|| async {
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(Body::from(r#"{"users":[]}"#))
                .unwrap()
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, mock_node).await.unwrap();
    });

    // 2. Configure proxy pointing to mock Node.js server
    let config = ProxyConfig {
        bind_addr: "127.0.0.1:53141".parse().unwrap(),
        node_backend_url: format!("http://127.0.0.1:{mock_port}"),
        upstream_chatgpt_origin: "https://chatgpt.com".to_string(),
        ipc_socket_path: "./data/test-ipc.sock".to_string(),
        public_app_url: "http://localhost:53332".to_string(),
    };

    let app = create_router(config, None);

    // 3. Send request to /api/users through proxy
    let request = Request::builder()
        .uri("/api/users")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(&body_bytes[..], br#"{"users":[]}"#);
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
}

#[tokio::test]
async fn test_codex_client_device_routes_fallback_to_node() {
    // Mock Node.js server handling device approval
    let mock_node = Router::new().route(
        "/api/admin/info",
        axum::routing::post(|| async {
            Response::builder()
                .status(StatusCode::OK)
                .body(Body::from(r#"{"status":"admin-ok"}"#))
                .unwrap()
        }),
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, mock_node).await.unwrap();
    });

    let config = ProxyConfig {
        bind_addr: "127.0.0.1:53141".parse().unwrap(),
        node_backend_url: format!("http://127.0.0.1:{mock_port}"),
        upstream_chatgpt_origin: "https://chatgpt.com".to_string(),
        ipc_socket_path: "./data/test-ipc.sock".to_string(),
        public_app_url: "http://localhost:53332".to_string(),
    };

    let app = create_router(config, None);

    // Ensure /api/admin/... falls through to Node.js and is NOT intercepted as an upstream codex request
    let request = Request::builder()
        .uri("/api/admin/info")
        .method("POST")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(&body_bytes[..], br#"{"status":"admin-ok"}"#);
}

