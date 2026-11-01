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
        req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>> {
        self.intercepted.store(true, Ordering::SeqCst);
        if req.headers().contains_key("x-test-forward") {
            return Ok(RequestAction::Forward(req));
        }
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

#[tokio::test]
async fn cors_headers_only_on_console_routes() {
    let app = create_router(
        common::config(common::offline_settings(), "http://127.0.0.1:9"),
        Some(Arc::new(TestInterceptor {
            intercepted: AtomicBool::new(false),
        })),
    );
    let request = |uri: &str| {
        Request::builder()
            .uri(uri)
            .header("origin", "https://console.example")
            .body(Body::empty())
            .unwrap()
    };

    let console = app.clone().oneshot(request("/health")).await.unwrap();
    assert_eq!(console.headers()["access-control-allow-origin"], "*");

    // chatgpt.com sends no CORS headers; neither does the gateway for Codex.
    let gateway = app
        .oneshot(request("/backend-api/codex/models"))
        .await
        .unwrap();
    assert_eq!(gateway.headers()["x-custom-intercepted"], "true");
    assert!(
        gateway
            .headers()
            .get("access-control-allow-origin")
            .is_none()
    );
    assert!(gateway.headers().get("vary").is_none());
}

#[tokio::test]
async fn forwards_http_body_above_previous_64_mib_limit() {
    let upstream = axum::Router::new()
        .fallback(axum::routing::any(|body: axum::body::Bytes| async move {
            body.len().to_string()
        }))
        .layer(axum::extract::DefaultBodyLimit::disable());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let app = create_router(
        common::config(common::offline_settings(), &origin),
        Some(Arc::new(TestInterceptor {
            intercepted: AtomicBool::new(false),
        })),
    );
    let size = 65 * 1024 * 1024;
    let request = Request::builder()
        .uri("/backend-api/codex/responses")
        .method("POST")
        .header("x-test-forward", "1")
        .body(Body::from(vec![b'x'; size]))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap(),
        size.to_string()
    );
    server.abort();
}

#[tokio::test]
async fn console_body_above_previous_10_mib_limit_reaches_json_parser() {
    let app = create_router(
        common::config(common::offline_settings(), "http://127.0.0.1:9"),
        None,
    );
    let mut body = vec![b' '; 11 * 1024 * 1024];
    body.push(b'{');
    let request = Request::builder()
        .uri("/api/setup/complete")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("invalid_json"));
}

#[tokio::test]
async fn forwards_client_websocket_frame_above_previous_message_and_frame_limits() {
    use futures_util::{SinkExt, StreamExt};
    let upstream = axum::Router::new().fallback(axum::routing::any(
        |ws: axum::extract::ws::WebSocketUpgrade| async move {
            ws.max_message_size(usize::MAX)
                .max_frame_size(usize::MAX)
                .on_upgrade(|mut socket| async move {
                    if let Some(Ok(axum::extract::ws::Message::Binary(body))) = socket.recv().await
                    {
                        socket
                            .send(axum::extract::ws::Message::Text(
                                body.len().to_string().into(),
                            ))
                            .await
                            .unwrap();
                    }
                })
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let upstream_server =
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let app = create_router(
        common::config(common::offline_settings(), &origin),
        Some(Arc::new(TestInterceptor {
            intercepted: AtomicBool::new(false),
        })),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://{}/backend-api/codex/responses",
        listener.local_addr().unwrap()
    );
    let gateway_server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("x-test-forward", "1".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let size = 65 * 1024 * 1024;
    socket
        .send(WsMessage::Binary(vec![b'x'; size].into()))
        .await
        .unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(response.into_text().unwrap(), size.to_string());
    gateway_server.abort();
    upstream_server.abort();
}
