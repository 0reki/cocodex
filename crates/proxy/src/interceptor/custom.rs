use super::{Interceptor, RequestAction, RequestContext, WsAction};
use async_trait::async_trait;
use axum::body::Body;
use axum::response::Response;
use http::Request;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info};

/// User-customizable interceptor.
///
/// You can implement your own custom logic in this struct:
/// - Modify or inspect requests before they reach upstream ChatGPT
/// - Replace or inject client/upstream credentials
/// - Inspect or transform SSE streams and WebSocket messages
/// - Settle usage metrics, quotas, or trigger alerts
#[derive(Debug, Default, Clone)]
pub struct CustomInterceptor {
    // Add any state needed for your custom operations here,
    // such as a cache, database client, HTTP client, or config.
}

impl CustomInterceptor {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl Interceptor for CustomInterceptor {
    /// Called before an incoming `/backend-api/*` HTTP request is forwarded to upstream ChatGPT.
    ///
    /// Custom operations you can perform here:
    /// 1. Inspect or modify request body (JSON or zstd).
    /// 2. Change the target path or query params.
    /// 3. Inject custom headers or modify existing ones.
    /// 4. Swap tokens: read client token and set upstream token in `ctx.upstream_token`.
    /// 5. Return `RequestAction::ShortCircuit(response)` to intercept and reply directly.
    async fn on_request(
        &self,
        ctx: &mut RequestContext,
        req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>> {
        debug!(
            request_id = %ctx.request_id,
            method = %ctx.method,
            path = %ctx.path,
            "CustomInterceptor: on_request hook"
        );

        // [USER HOOK POINT: REQUEST]
        // Example: If client sent an internal token, swap it for an upstream token:
        // if let Some(token) = &ctx.client_token {
        //     ctx.upstream_token = Some(resolve_upstream_token(token).await);
        // }

        Ok(RequestAction::Forward(req))
    }

    /// Called when upstream ChatGPT responds with headers and status, before streaming starts.
    ///
    /// Custom operations you can perform here:
    /// 1. Check or log upstream status code (e.g. detect 401/429).
    /// 2. Add, remove, or modify response headers returned to the client.
    async fn on_response(
        &self,
        ctx: &RequestContext,
        resp: Response,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        debug!(
            request_id = %ctx.request_id,
            status = %resp.status(),
            "CustomInterceptor: on_response hook"
        );

        // [USER HOOK POINT: RESPONSE HEADERS/STATUS]
        Ok(resp)
    }

    /// Called for each stream chunk received from upstream (for SSE/chunked responses).
    ///
    /// Custom operations you can perform here:
    /// 1. Inspect SSE event lines (`event: ...`, `data: ...`).
    /// 2. Extract token usage info or terminal events.
    /// 3. Filter or record stream output chunks.
    async fn on_response_chunk(
        &self,
        _ctx: &RequestContext,
        _chunk: &[u8],
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // [USER HOOK POINT: STREAMING CHUNKS]
        // Note: Keep operations fast to avoid slowing down SSE stream delivery.
        Ok(())
    }

    /// Called when the client sends a WebSocket frame to upstream (`/backend-api/codex/responses`).
    async fn on_ws_client_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        debug!(
            request_id = %ctx.request_id,
            "CustomInterceptor: on_ws_client_message"
        );

        // [USER HOOK POINT: WEBSOCKET CLIENT MESSAGE]
        Ok(WsAction::Forward(msg))
    }

    /// Called when upstream sends a WebSocket frame to the client (`/backend-api/codex/responses`).
    async fn on_ws_upstream_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        debug!(
            request_id = %ctx.request_id,
            "CustomInterceptor: on_ws_upstream_message"
        );

        // [USER HOOK POINT: WEBSOCKET UPSTREAM MESSAGE]
        Ok(WsAction::Forward(msg))
    }

    /// Called when the request/stream finishes or disconnects.
    ///
    /// Custom operations you can perform here:
    /// 1. Record total latency: `ctx.started_at.elapsed()`.
    /// 2. Send settlement/usage log to Node.js backend or database.
    /// 3. Update local in-memory metrics.
    async fn on_request_finish(
        &self,
        ctx: &RequestContext,
        status_code: Option<u16>,
        error: Option<&str>,
    ) {
        let elapsed = ctx.started_at.elapsed();
        info!(
            request_id = %ctx.request_id,
            path = %ctx.path,
            status = ?status_code,
            duration_ms = elapsed.as_millis(),
            error = ?error,
            "Request finished"
        );

        // [USER HOOK POINT: SETTLEMENT & LOGGING]
    }
}

