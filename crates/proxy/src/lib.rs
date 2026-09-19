pub mod auth;
pub mod config;
pub mod db;
pub mod forwarder;
pub mod interceptor;
pub mod ipc;
pub mod reverse_proxy;
pub mod runtime;
pub mod websocket;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::Request;
use axum::response::Response;
use axum::routing::any;
use config::ProxyConfig;
use forwarder::BackendForwarder;
use interceptor::SharedInterceptor;
use interceptor::custom::CustomInterceptor;
use reverse_proxy::NodeReverseProxy;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::ipc::IpcClient;
use crate::runtime::Runtime;

/// Shared application state for router handlers.
#[derive(Clone)]
pub struct AppState {
    pub forwarder: Arc<BackendForwarder>,
    pub reverse_proxy: Arc<NodeReverseProxy>,
    pub runtime: Arc<Runtime>,
    pub public_app_url: String,
}

pub fn create_router(config: ProxyConfig, interceptor: Option<SharedInterceptor>) -> Router {
    let ipc_client = IpcClient::new(&config.ipc_socket_path);
    let runtime = Arc::new(Runtime::new(
        config.settings.clone(),
        ipc_client.owner_auth_cache(),
    ));
    let interceptor = interceptor
        .unwrap_or_else(|| Arc::new(CustomInterceptor::new(ipc_client.clone(), runtime.clone())));
    let forwarder = Arc::new(BackendForwarder::new(
        config.upstream_chatgpt_origin.clone(),
        interceptor,
    ));
    let reverse_proxy = Arc::new(NodeReverseProxy::new(config.node_backend_url.clone()));

    // Connect eagerly so problems surface at startup; requests retry lazily.
    tokio::spawn({
        let runtime = runtime.clone();
        async move {
            if let Err(error) = runtime.ready().await {
                tracing::warn!(%error, "database not ready yet");
            }
        }
    });

    let state = AppState {
        forwarder,
        reverse_proxy,
        runtime,
        public_app_url: config.public_app_url,
    };

    Router::new()
        .merge(auth::routes::create_auth_router())
        .route("/backend-api/{*path}", any(handle_backend_api))
        .route("/backend-api", any(handle_backend_api))
        .route("/wham/{*path}", any(handle_backend_api))
        .route("/wham", any(handle_backend_api))
        .route("/api/codex/{*path}", any(handle_backend_api))
        .route("/api/codex", any(handle_backend_api))
        .route("/v1/{*path}", any(handle_backend_api))
        .route("/v1", any(handle_backend_api))
        .fallback(handle_fallback)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn handle_backend_api(
    axum::extract::State(state): axum::extract::State<AppState>,
    ws_opt: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    req: Request<Body>,
) -> Response {
    state.forwarder.handle_request(ws_opt.ok(), req).await
}

async fn handle_fallback(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: Request<Body>,
) -> Response {
    state.reverse_proxy.handle_request(req).await
}
