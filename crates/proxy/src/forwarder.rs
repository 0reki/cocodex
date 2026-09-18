use crate::interceptor::{RequestAction, RequestContext, SharedInterceptor};
use crate::websocket::handle_ws_upgrade;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::header::{HeaderName, HeaderValue, AUTHORIZATION, HOST};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use tracing::{debug, error, info, warn};
use url::Url;

/// Forwarder for `/backend-api/*` requests to upstream ChatGPT.
#[derive(Clone)]
pub struct BackendForwarder {
    client: Client,
    upstream_origin: String,
    interceptor: SharedInterceptor,
}

impl BackendForwarder {
    pub fn new(upstream_origin: String, interceptor: SharedInterceptor) -> Self {
        // reqwest client without request timeout so long-lived responses flow uninterrupted
        let client = Client::builder()
            .build()
            .expect("Failed to build reqwest client");

        Self {
            client,
            upstream_origin,
            interceptor,
        }
    }

    /// Primary entry point for handling any `/backend-api/*` request.
    pub async fn handle_request(
        &self,
        ws_opt: Option<WebSocketUpgrade>,
        req: Request<Body>,
    ) -> Response {
        let mut ctx = RequestContext::new(&req);

        // Check if this is a WebSocket upgrade on /backend-api/codex/responses
        let is_ws_path = ctx.target_path == "/backend-api/codex/responses"
            || ctx.target_path.ends_with("/codex/responses");
        if is_ws_path && ws_opt.is_some() {
            let is_upgrade = req
                .headers()
                .get(http::header::UPGRADE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| s.eq_ignore_ascii_case("websocket"));

            if is_upgrade {
                info!(request_id = %ctx.request_id, "Upgrading connection to WebSocket");
                return handle_ws_upgrade(
                    ws_opt.unwrap(),
                    ctx,
                    self.upstream_origin.clone(),
                    Arc::clone(&self.interceptor),
                )
                .await;
            }
        }

        // Run user request interceptor hook
        let action = match self.interceptor.on_request(&mut ctx, req).await {
            Ok(act) => act,
            Err(e) => {
                error!(request_id = %ctx.request_id, "Error in on_request interceptor: {e}");
                self.interceptor
                    .on_request_finish(&ctx, Some(500), Some(&e.to_string()))
                    .await;
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Proxy request interception failed: {e}"),
                )
                    .into_response();
            }
        };

        let req = match action {
            RequestAction::ShortCircuit(resp) => {
                debug!(request_id = %ctx.request_id, "Request short-circuited by interceptor");
                self.interceptor
                    .on_request_finish(&ctx, Some(resp.status().as_u16()), None)
                    .await;
                return resp;
            }
            RequestAction::Forward(r) => r,
        };

        // Forward request upstream
        self.forward_http(ctx, req).await
    }

    async fn forward_http(&self, ctx: RequestContext, req: Request<Body>) -> Response {
        let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
        let upstream_url_str = format!("{}{}{query}", self.upstream_origin, ctx.target_path);

        let upstream_url = match Url::parse(&upstream_url_str) {
            Ok(u) => u,
            Err(e) => {
                error!("Invalid upstream URL '{upstream_url_str}': {e}");
                self.interceptor
                    .on_request_finish(&ctx, Some(500), Some(&e.to_string()))
                    .await;
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Invalid upstream URL",
                )
                    .into_response();
            }
        };

        let (parts, body) = req.into_parts();
        let mut forward_headers = HeaderMap::new();

        // Copy incoming headers except hop-by-hop headers
        for (name, val) in &parts.headers {
            let lower = name.as_str().to_ascii_lowercase();
            if is_hop_by_hop_header(&lower) {
                continue;
            }
            forward_headers.insert(name.clone(), val.clone());
        }

        // Set Host header to upstream host
        if let Some(host) = upstream_url.host_str() {
            if let Ok(hv) = HeaderValue::from_str(host) {
                forward_headers.insert(HOST, hv);
            }
        }

        // Inject upstream token if specified by interceptor
        if let Some(token) = &ctx.upstream_token {
            if let Ok(hv) = HeaderValue::from_str(&format!("Bearer {token}")) {
                forward_headers.insert(AUTHORIZATION, hv);
            }
        }

        // Inject upstream account ID if specified
        if let Some(account_id) = &ctx.upstream_account_id {
            if let Ok(hv) = HeaderValue::from_str(account_id) {
                forward_headers.insert(
                    HeaderName::from_static("chatgpt-account-id"),
                    hv,
                );
            }
        }

        let stream = body.into_data_stream();
        let reqwest_body = reqwest::Body::wrap_stream(stream);

        debug!(
            request_id = %ctx.request_id,
            upstream_url = %upstream_url_str,
            "Forwarding request to upstream ChatGPT"
        );

        let upstream_res = self
            .client
            .request(parts.method.clone(), upstream_url)
            .headers(forward_headers)
            .body(reqwest_body)
            .send()
            .await;

        let upstream_resp = match upstream_res {
            Ok(resp) => resp,
            Err(err) => {
                error!(request_id = %ctx.request_id, "Upstream request error: {err}");
                self.interceptor
                    .on_request_finish(&ctx, None, Some(&err.to_string()))
                    .await;
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to connect to upstream ChatGPT: {err}"),
                )
                    .into_response();
            }
        };

        let status = StatusCode::from_u16(upstream_resp.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

        let mut client_resp_headers = HeaderMap::new();
        for (name, val) in upstream_resp.headers() {
            let lower = name.as_str().to_ascii_lowercase();
            if is_hop_by_hop_header(&lower) {
                continue;
            }
            client_resp_headers.insert(name.clone(), val.clone());
        }

        // Create stream with chunk-level interceptor inspection
        let interceptor_chunk = Arc::clone(&self.interceptor);
        let ctx_chunk = ctx.clone();

        let byte_stream = upstream_resp.bytes_stream().map(move |item| match item {
            Ok(bytes) => {
                let _ = interceptor_chunk.on_response_chunk(&ctx_chunk, &bytes);
                Ok(bytes)
            }
            Err(e) => {
                warn!("Stream read error from upstream: {e}");
                Err(std::io::Error::other(e))
            }
        });

        let client_body = Body::from_stream(byte_stream);
        let mut response = Response::new(client_body);
        *response.status_mut() = status;
        *response.headers_mut() = client_resp_headers;

        // Run user on_response interceptor hook
        let final_response = match self.interceptor.on_response(&ctx, response).await {
            Ok(r) => r,
            Err(e) => {
                error!(request_id = %ctx.request_id, "Error in on_response interceptor: {e}");
                self.interceptor
                    .on_request_finish(&ctx, Some(500), Some(&e.to_string()))
                    .await;
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Proxy response interception failed: {e}"),
                )
                    .into_response();
            }
        };

        self.interceptor
            .on_request_finish(&ctx, Some(status.as_u16()), None)
            .await;

        final_response
    }
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "trailer"
    )
}
