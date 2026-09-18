pub mod custom;

use async_trait::async_trait;
use axum::body::Body;
use axum::response::Response;
use http::{HeaderMap, Method, Request, Uri};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Context for an in-flight request passing through the proxy.
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub request_id: String,
    pub method: Method,
    pub uri: Uri,
    pub path: String,
    pub target_path: String,
    pub query: Option<String>,
    pub client_headers: HeaderMap,
    pub client_token: Option<String>,
    pub upstream_token: Option<String>,
    pub upstream_account_id: Option<String>,
    pub metadata: HashMap<String, String>,
    pub started_at: Instant,
}

impl RequestContext {
    pub fn new(req: &Request<Body>) -> Self {
        let request_id = uuid::Uuid::new_v4().to_string();
        let client_headers = req.headers().clone();
        let client_token = client_headers
            .get(http::header::AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|val| val.strip_prefix("Bearer ").or_else(|| val.strip_prefix("bearer ")))
            .map(|s| s.trim().to_string());

        let uri = req.uri().clone();
        let path = uri.path().to_string();
        let target_path = normalize_upstream_path(&path);
        let query = uri.query().map(|q| q.to_string());

        Self {
            request_id,
            method: req.method().clone(),
            uri,
            path,
            target_path,
            query,
            client_headers,
            client_token,
            upstream_token: None,
            upstream_account_id: None,
            metadata: HashMap::new(),
            started_at: Instant::now(),
        }
    }
}

/// Normalizes client paths to the canonical ChatGPT upstream path format (`/backend-api/...`).
///
/// Codex client can connect using either:
/// 1. `chatgpt_base_url` pointing to `/backend-api` (e.g. `https://chatgpt.com/backend-api/`)
///    which results in paths starting with `/backend-api/...`
/// 2. `chatgpt_base_url` pointing to the proxy root (e.g. `http://127.0.0.1:53141`)
///    which results in paths starting with `/api/codex/...`
/// 3. Direct wham paths starting with `/wham/...`
pub fn normalize_upstream_path(raw_path: &str) -> String {
    if raw_path.starts_with("/backend-api/") || raw_path == "/backend-api" {
        raw_path.to_string()
    } else if let Some(stripped) = raw_path.strip_prefix("/wham/") {
        format!("/backend-api/wham/{stripped}")
    } else if raw_path == "/wham" {
        "/backend-api/wham".to_string()
    } else if let Some(stripped) = raw_path.strip_prefix("/api/codex/") {
        // Classify wham vs codex endpoints under /api/codex/...
        if is_wham_subpath(stripped) {
            format!("/backend-api/wham/{stripped}")
        } else {
            format!("/backend-api/codex/{stripped}")
        }
    } else if raw_path == "/api/codex" {
        "/backend-api/codex".to_string()
    } else {
        raw_path.to_string()
    }
}

fn is_wham_subpath(subpath: &str) -> bool {
    subpath.starts_with("accounts")
        || subpath.starts_with("profiles")
        || subpath.starts_with("settings")
        || subpath.starts_with("workspace-messages")
        || subpath.starts_with("config")
        || subpath.starts_with("usage")
        || subpath.starts_with("tasks")
        || subpath.starts_with("rate-limit-reset-credits")
        || subpath.starts_with("analytics")
        || subpath.starts_with("agent-identities")
        || subpath.starts_with("environments")
}

/// Action to take after inspecting an incoming request.
pub enum RequestAction {
    /// Continue forwarding the request (potentially modified) to upstream.
    Forward(Request<Body>),
    /// Short-circuit and respond to the client immediately.
    ShortCircuit(Response),
}

/// Action to take on a WebSocket frame.
pub enum WsAction {
    /// Forward the message as-is or modified.
    Forward(WsMessage),
    /// Drop this message (do not forward).
    Drop,
}

/// Core trait for intercepting and customizing proxy behavior.
#[async_trait]
pub trait Interceptor: Send + Sync {
    /// Hook executed on incoming HTTP requests to `/backend-api/*` before forwarding to upstream.
    async fn on_request(
        &self,
        ctx: &mut RequestContext,
        req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>>;

    /// Hook executed when upstream returns an HTTP response before streaming to the client.
    async fn on_response(
        &self,
        ctx: &RequestContext,
        resp: Response,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>>;

    /// Hook executed when a chunk of data is streamed from upstream (e.g. SSE event chunk).
    async fn on_response_chunk(
        &self,
        ctx: &RequestContext,
        chunk: &[u8],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;

    /// Hook executed on WebSocket frames sent from Client -> Upstream.
    async fn on_ws_client_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>>;

    /// Hook executed on WebSocket frames sent from Upstream -> Client.
    async fn on_ws_upstream_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>>;

    /// Hook executed when request completes or connection closes.
    async fn on_request_finish(
        &self,
        ctx: &RequestContext,
        status_code: Option<u16>,
        error: Option<&str>,
    );
}

pub type SharedInterceptor = Arc<dyn Interceptor>;

