pub mod api;
pub mod auth;
pub mod billing;
pub mod client_identity;
pub mod config;
pub mod db;
pub mod egress_locale;
pub mod forwarder;
pub mod interceptor;
pub mod quota;
pub mod runtime;
pub mod upstream;
pub mod websocket;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::routing::any;
use config::ProxyConfig;
use forwarder::BackendForwarder;
use interceptor::SharedInterceptor;
use interceptor::custom::CustomInterceptor;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::billing::pricing::Pricing;
use crate::egress_locale::EgressLocaleResolver;
use crate::runtime::Runtime;
use crate::upstream::client::UpstreamClient;
use crate::upstream::cookies::CookieJars;
use crate::upstream::identity::VersionResolver;

/// Shared application state for router handlers.
#[derive(Clone)]
pub struct AppState {
    pub forwarder: Arc<BackendForwarder>,
    pub runtime: Arc<Runtime>,
    pub public_app_url: String,
}

/// Builds the HTTP application and the runtime it serves from.
pub fn build(
    config: ProxyConfig,
    interceptor: Option<SharedInterceptor>,
) -> (Router, Arc<Runtime>) {
    // Codex's own HTTP client negotiates no compression; neither do the
    // calls the gateway makes in its name.
    let http = reqwest::Client::builder()
        .no_gzip()
        .no_zstd()
        .build()
        .expect("Failed to build reqwest client");
    let versions = Arc::new(
        VersionResolver::from_env(http.clone())
            .expect("CODEX_CLIENT_VERSION is validated at startup"),
    );
    let cookies = Arc::new(
        CookieJars::from_env().expect("UPSTREAM_COOKIE_IDLE_SECS is validated at startup"),
    );
    let upstream = Arc::new(UpstreamClient {
        http,
        chatgpt_origin: config.upstream_chatgpt_origin.clone(),
        auth_origin: config.upstream_auth_origin.clone(),
        versions,
        cookies: cookies.clone(),
    });
    let pricing = Pricing::from_env().expect("OPENAI_MODEL_PRICING_JSON is validated at startup");
    let egress_locale = EgressLocaleResolver::from_env(reqwest::Client::new())
        .expect("COCODEX_EGRESS_LOCALE is validated at startup");
    let runtime = Arc::new(Runtime::new(config.settings.clone(), upstream, pricing));
    let interceptor = interceptor
        .unwrap_or_else(|| Arc::new(CustomInterceptor::new(runtime.clone(), egress_locale)));
    let forwarder = Arc::new(BackendForwarder::new(
        config.upstream_chatgpt_origin.clone(),
        interceptor,
        cookies,
    ));

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
        runtime: runtime.clone(),
        public_app_url: config.public_app_url,
    };

    // Codex traffic is relayed exactly as chatgpt.com answers it, so the
    // browser-facing CORS headers only go on the console and login routes.
    let gateway = Router::new()
        .route("/backend-api/{*path}", any(handle_backend_api))
        .route("/backend-api", any(handle_backend_api))
        .route("/wham/{*path}", any(handle_backend_api))
        .route("/wham", any(handle_backend_api))
        .route("/api/codex/{*path}", any(handle_backend_api))
        .route("/api/codex", any(handle_backend_api));
    let router = Router::new()
        .merge(auth::routes::create_auth_router())
        .merge(api::router(state.clone()))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .merge(gateway)
        .fallback(handle_not_found)
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    (router, runtime)
}

pub fn create_router(config: ProxyConfig, interceptor: Option<SharedInterceptor>) -> Router {
    build(config, interceptor).0
}

async fn handle_backend_api(
    axum::extract::State(state): axum::extract::State<AppState>,
    ws_opt: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    req: Request<Body>,
) -> Response {
    state.forwarder.handle_request(ws_opt.ok(), req).await
}

async fn handle_not_found() -> Response {
    api::api_error(StatusCode::NOT_FOUND, "not_found", "Not found")
}
