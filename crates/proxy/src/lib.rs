pub mod auth;
pub mod config;
pub mod forwarder;
pub mod interceptor;
pub mod ipc;
pub mod reverse_proxy;
pub mod websocket;

use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::Request;
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use config::ProxyConfig;
use forwarder::BackendForwarder;
use interceptor::custom::CustomInterceptor;
use interceptor::SharedInterceptor;
use reverse_proxy::NodeReverseProxy;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::auth::session::CodexClientSessionStore;
use crate::ipc::IpcClient;

/// Shared application state for router handlers.
#[derive(Clone)]
pub struct AppState {
    pub forwarder: Arc<BackendForwarder>,
    pub reverse_proxy: Arc<NodeReverseProxy>,
    pub sessions: Arc<CodexClientSessionStore>,
    pub ipc_client: IpcClient,
    pub public_app_url: String,
}

pub fn create_router(config: ProxyConfig, interceptor: Option<SharedInterceptor>) -> Router {
    let interceptor = interceptor.unwrap_or_else(|| Arc::new(CustomInterceptor::new()));
    let forwarder = Arc::new(BackendForwarder::new(
        config.upstream_chatgpt_origin.clone(),
        interceptor,
    ));
    let reverse_proxy = Arc::new(NodeReverseProxy::new(config.node_backend_url.clone()));
    let sessions = Arc::new(CodexClientSessionStore::new());
    let ipc_client = IpcClient::new(&config.ipc_socket_path);

    let state = AppState {
        forwarder,
        reverse_proxy,
        sessions,
        ipc_client,
        public_app_url: config.public_app_url,
    };

    Router::new()
        .merge(auth::routes::create_auth_router())
        .route(
            "/backend-api/{*path}",
            any(handle_backend_api),
        )
        .route(
            "/backend-api",
            any(handle_backend_api),
        )
        .route(
            "/wham/{*path}",
            any(handle_backend_api),
        )
        .route(
            "/wham",
            any(handle_backend_api),
        )
        .route(
            "/api/codex/{*path}",
            any(handle_backend_api),
        )
        .route(
            "/api/codex",
            any(handle_backend_api),
        )
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
