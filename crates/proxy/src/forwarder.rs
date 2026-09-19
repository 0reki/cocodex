use crate::interceptor::{RequestAction, RequestContext, SharedInterceptor};
use crate::websocket::handle_ws_upgrade;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::header::{AUTHORIZATION, HOST, HeaderName, HeaderValue, USER_AGENT};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use tracing::{debug, error, info, warn};
use url::Url;

/// Largest request body accepted for forwarding (image edits carry images).
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

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

        // Any WebSocket upgrade on a Codex/ChatGPT route: Responses
        // (`…/codex/responses`), Realtime (`/v1/realtime`, `/v1/live`, or
        // the ChatGPT-style `/backend-api/codex` websocket), and WHAM.
        let is_upgrade = ws_opt.is_some()
            && req
                .headers()
                .get(http::header::UPGRADE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| s.eq_ignore_ascii_case("websocket"));

        // Run user request interceptor hook for HTTP and WebSocket traffic
        // alike, so platform account resolution and UA normalization also
        // apply to WebSocket handshakes.
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

        // WebSocket upgrade: propagate interceptor header mutations (platform
        // token swap, UA normalization) into the upstream handshake context.
        if is_upgrade {
            ctx.client_headers = req.headers().clone();
            if let Ok(mut obs) = ctx.observation.lock() {
                obs.websocket = true;
            }
            info!(request_id = %ctx.request_id, "Upgrading connection to WebSocket");
            return handle_ws_upgrade(
                ws_opt.unwrap(),
                ctx,
                self.upstream_origin.clone(),
                Arc::clone(&self.interceptor),
            )
            .await;
        }

        // Forward request upstream
        self.forward_http(ctx, req).await
    }

    async fn send_upstream(
        &self,
        ctx: &RequestContext,
        method: &http::Method,
        url: &Url,
        headers: &HeaderMap,
        body: &bytes::Bytes,
    ) -> Result<reqwest::Response, reqwest::Error> {
        let mut forward_headers = copy_upstream_request_headers(headers);
        apply_upstream_identity_headers(&mut forward_headers, ctx);
        if let Some(host) = url.host_str()
            && let Ok(hv) = HeaderValue::from_str(host)
        {
            forward_headers.insert(HOST, hv);
        }
        self.client
            .request(method.clone(), url.clone())
            .headers(forward_headers)
            .body(body.clone())
            .send()
            .await
    }

    async fn forward_http(&self, mut ctx: RequestContext, req: Request<Body>) -> Response {
        let query = req
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let upstream_url_str = format!("{}{}{query}", self.upstream_origin, ctx.target_path);

        let upstream_url = match Url::parse(&upstream_url_str) {
            Ok(u) => u,
            Err(e) => {
                error!("Invalid upstream URL '{upstream_url_str}': {e}");
                self.interceptor
                    .on_request_finish(&ctx, Some(500), Some(&e.to_string()))
                    .await;
                return (StatusCode::INTERNAL_SERVER_ERROR, "Invalid upstream URL").into_response();
            }
        };

        // Buffered so the request can be replayed after a token refresh.
        let (parts, body) = req.into_parts();
        let body = match axum::body::to_bytes(body, MAX_REQUEST_BODY_BYTES).await {
            Ok(body) => body,
            Err(e) => {
                self.interceptor
                    .on_request_finish(&ctx, Some(413), Some(&e.to_string()))
                    .await;
                return crate::interceptor::custom::auth_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "Request payload too large",
                );
            }
        };

        debug!(
            request_id = %ctx.request_id,
            upstream_url = %upstream_url_str,
            "Forwarding request to upstream ChatGPT"
        );

        let mut upstream_res = self
            .send_upstream(&ctx, &parts.method, &upstream_url, &parts.headers, &body)
            .await;
        let rejected = |res: &Result<reqwest::Response, reqwest::Error>| {
            res.as_ref().is_ok_and(|resp| resp.status().as_u16() == 401)
        };
        if rejected(&upstream_res) && ctx.upstream_token.is_some() {
            if self.interceptor.on_upstream_unauthorized(&mut ctx).await {
                info!(request_id = %ctx.request_id, "retrying with refreshed upstream token");
                upstream_res = self
                    .send_upstream(&ctx, &parts.method, &upstream_url, &parts.headers, &body)
                    .await;
            }
            if rejected(&upstream_res) {
                // Not the client's credentials: a 401 would make Codex
                // discard its own (valid) gateway session.
                let message = "Upstream rejected the gateway's credentials";
                self.interceptor
                    .on_request_finish(&ctx, Some(502), Some(message))
                    .await;
                return crate::interceptor::custom::auth_error(
                    StatusCode::BAD_GATEWAY,
                    "upstream_unauthorized",
                    message,
                );
            }
        }

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

        let client_resp_headers = copy_client_response_headers(upstream_resp.headers());

        // Create stream with chunk-level interceptor inspection. Settlement
        // runs when the body is dropped (client finished or disconnected),
        // not when headers are first flushed.
        let interceptor_chunk = Arc::clone(&self.interceptor);
        let ctx_chunk = ctx.clone();
        let finish_guard = Arc::new(StreamFinishGuard {
            interceptor: Arc::clone(&self.interceptor),
            ctx: ctx.clone(),
            status: status.as_u16(),
        });
        let finish_guard_chunk = Arc::clone(&finish_guard);

        let completion_ctx = ctx.clone();
        let end_marker = futures_util::stream::once(async move {
            if let Ok(mut obs) = completion_ctx.observation.lock() {
                obs.upstream_complete = true;
            }
            None
        })
        .filter_map(|item: Option<Result<bytes::Bytes, std::io::Error>>| async move { item });
        let byte_stream = upstream_resp.bytes_stream().map(move |item| {
            let _keep_guard = &finish_guard_chunk;
            match item {
                Ok(bytes) => {
                    interceptor_chunk.on_response_chunk(&ctx_chunk, &bytes);
                    Ok(bytes)
                }
                Err(e) => {
                    warn!("Stream read error from upstream: {e}");
                    Err(std::io::Error::other(e))
                }
            }
        });

        let client_body = Body::from_stream(byte_stream.chain(end_marker));
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

        let _ = finish_guard;
        final_response
    }
}

struct StreamFinishGuard {
    interceptor: crate::interceptor::SharedInterceptor,
    ctx: RequestContext,
    status: u16,
}

impl Drop for StreamFinishGuard {
    fn drop(&mut self) {
        let interceptor = Arc::clone(&self.interceptor);
        let ctx = self.ctx.clone();
        let status = self.status;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                interceptor
                    .on_request_finish(&ctx, Some(status), None)
                    .await;
            });
        }
    }
}

pub(crate) const DEFAULT_CODEX_ORIGINATOR: &str = "codex_cli_rs";

/// Stable install id for one upstream account on one OS.
/// Same account+platform always yields the same UUID; a different account or
/// OS yields a different one.
pub fn gateway_installation_id(account_id: &str, platform: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(format!("cocodex-install:{platform}:{account_id}").as_bytes());
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        digest[0],
        digest[1],
        digest[2],
        digest[3],
        digest[4],
        digest[5],
        (digest[6] & 0x0f) | 0x50,
        digest[7],
        (digest[8] & 0x3f) | 0x80,
        digest[9],
        digest[10],
        digest[11],
        digest[12],
        digest[13],
        digest[14],
        digest[15],
    )
}

/// Codex UA is `{originator}/{version} ({os} {ver}; {arch}) {terminal}`.
pub(crate) fn client_version_from_user_agent(user_agent: &str) -> Option<String> {
    let after_slash = user_agent.split_once('/')?.1;
    let version = after_slash.split([' ', '(']).next()?.trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

pub(crate) fn apply_upstream_identity_headers(headers: &mut HeaderMap, ctx: &RequestContext) {
    if let Some(token) = &ctx.upstream_token
        && let Ok(hv) = HeaderValue::from_str(&format!("Bearer {token}"))
    {
        headers.insert(AUTHORIZATION, hv);
    }
    if let Some(account_id) = &ctx.upstream_account_id
        && let Ok(hv) = HeaderValue::from_str(account_id)
    {
        headers.insert(HeaderName::from_static("chatgpt-account-id"), hv);
    }
    if let Some(user_agent) = &ctx.upstream_user_agent
        && let Ok(hv) = HeaderValue::from_str(user_agent)
    {
        headers.insert(USER_AGENT, hv);
    }
    headers.insert(
        HeaderName::from_static("originator"),
        HeaderValue::from_static(DEFAULT_CODEX_ORIGINATOR),
    );
    if let Some(version) = &ctx.upstream_client_version
        && let Ok(hv) = HeaderValue::from_str(version)
    {
        headers.insert(HeaderName::from_static("version"), hv);
    }

    let installation_id = ctx.upstream_installation_id.as_deref();
    if headers.contains_key("x-codex-installation-id")
        && let Some(installation_id) = installation_id
        && let Ok(hv) = HeaderValue::from_str(installation_id)
    {
        headers.insert(HeaderName::from_static("x-codex-installation-id"), hv);
    }
    if let Some(raw) = headers
        .get("x-codex-turn-metadata")
        .and_then(|value| value.to_str().ok())
        && let Some(installation_id) = installation_id
        && let Some(rewritten) = rewrite_turn_metadata(raw, installation_id)
        && let Ok(hv) = HeaderValue::from_str(&rewritten)
    {
        headers.insert(HeaderName::from_static("x-codex-turn-metadata"), hv);
    }
}

fn rewrite_turn_metadata(raw: &str, installation_id: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object_mut()?;
    if object.contains_key("installation_id") {
        object.insert(
            "installation_id".to_string(),
            serde_json::Value::String(installation_id.to_string()),
        );
    }
    if object.contains_key("workspaces") {
        object.insert(
            "workspaces".to_string(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
    }
    Some(value.to_string())
}

pub(crate) fn copy_upstream_request_headers(headers: &HeaderMap) -> HeaderMap {
    let mut forwarded = HeaderMap::new();
    for (name, val) in headers {
        if should_drop_request_header(name.as_str()) {
            continue;
        }
        forwarded.insert(name.clone(), val.clone());
    }
    forwarded
}

pub(crate) fn copy_client_response_headers(headers: &HeaderMap) -> HeaderMap {
    let mut forwarded = HeaderMap::new();
    for (name, val) in headers {
        if should_drop_response_header(name.as_str()) {
            continue;
        }
        forwarded.insert(name.clone(), val.clone());
    }
    forwarded
}

fn should_drop_request_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    is_hop_by_hop_header(&name)
        || is_proxy_context_header(&name)
        || is_client_account_header(&name)
        || is_replaced_identity_header(&name)
}

fn should_drop_response_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    is_hop_by_hop_header(&name)
        || is_client_account_header(&name)
        || name == "set-cookie"
        || name == "content-encoding"
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "trailer"
    )
}

fn is_proxy_context_header(name: &str) -> bool {
    matches!(
        name,
        "cookie" | "forwarded" | "origin" | "via" | "x-real-ip" | "x-cocodex-platform"
    ) || name.starts_with("cf-")
        || name.starts_with("x-forwarded-")
}

fn is_client_account_header(name: &str) -> bool {
    matches!(
        name,
        "chatgpt-account-id"
            | "openai-organization"
            | "openai-project"
            | "x-oai-attestation"
            | "x-openai-fedramp"
            | "x-openai-actor-authorization"
    )
}

/// Values we always replace with gateway identity. The headers themselves
/// are still sent — copy drops the client value, then overlay writes ours.
fn is_replaced_identity_header(name: &str) -> bool {
    matches!(
        name,
        "authorization" | "user-agent" | "originator" | "version"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::RequestContext;
    use axum::http::Request;

    fn ctx_with_identity() -> RequestContext {
        let req = Request::builder()
            .uri("/backend-api/codex/responses")
            .header("authorization", "Bearer client-jwt")
            .header("user-agent", "codex_vscode/0.1.0 (Mac OS 15.1.0; arm64) unknown")
            .header("originator", "codex_vscode")
            .header("version", "0.1.0")
            .header("session-id", "sess-keep")
            .header("thread-id", "thread-keep")
            .header("x-codex-installation-id", "install-leak")
            .header(
                "x-codex-turn-metadata",
                r#"{"installation_id":"install-leak","session_id":"sess-keep","workspaces":{"repo":{"associated_remote_urls":{"origin":"https://github.com/user/secret.git"}}}}"#,
            )
            .header("openai-beta", "responses_websockets=2026-02-06")
            .header("content-type", "application/json")
            .body(Body::empty())
            .unwrap();
        let mut ctx = RequestContext::new(&req);
        ctx.upstream_token = Some("upstream-token".into());
        ctx.upstream_account_id = Some("upstream-account".into());
        ctx.upstream_user_agent =
            Some("codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal".into());
        ctx.upstream_client_version = Some("0.154.0".into());
        ctx.upstream_installation_id = Some(gateway_installation_id("upstream-account", "windows"));
        ctx
    }

    #[test]
    fn parses_version_from_codex_user_agent() {
        assert_eq!(
            client_version_from_user_agent(
                "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal"
            )
            .as_deref(),
            Some("0.154.0")
        );
        assert_eq!(
            client_version_from_user_agent("codex_vscode/0.4.0 (Mac OS 15.1.0; arm64) unknown")
                .as_deref(),
            Some("0.4.0")
        );
    }

    #[test]
    fn rewrites_client_identity_and_keeps_session_fields() {
        let ctx = ctx_with_identity();
        let mut forwarded = copy_upstream_request_headers(&ctx.client_headers);
        apply_upstream_identity_headers(&mut forwarded, &ctx);

        assert_eq!(
            forwarded.get("authorization").unwrap(),
            "Bearer upstream-token"
        );
        assert_eq!(
            forwarded.get("user-agent").unwrap(),
            "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal"
        );
        assert_eq!(forwarded.get("originator").unwrap(), "codex_cli_rs");
        assert_eq!(forwarded.get("version").unwrap(), "0.154.0");
        assert_eq!(
            forwarded.get("chatgpt-account-id").unwrap(),
            "upstream-account"
        );
        assert_eq!(forwarded.get("session-id").unwrap(), "sess-keep");
        assert_eq!(forwarded.get("thread-id").unwrap(), "thread-keep");
        assert_eq!(
            forwarded.get("openai-beta").unwrap(),
            "responses_websockets=2026-02-06"
        );
        assert_eq!(forwarded.get("content-type").unwrap(), "application/json");
        assert_eq!(
            forwarded.get("x-codex-installation-id").unwrap(),
            gateway_installation_id("upstream-account", "windows").as_str()
        );
        let metadata: serde_json::Value = serde_json::from_str(
            forwarded
                .get("x-codex-turn-metadata")
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            metadata["installation_id"].as_str(),
            Some(gateway_installation_id("upstream-account", "windows").as_str())
        );
        assert_eq!(metadata["session_id"].as_str(), Some("sess-keep"));
        assert_eq!(metadata["workspaces"], serde_json::json!({}));
    }

    #[test]
    fn installation_id_differs_by_account_and_platform() {
        let windows_a = gateway_installation_id("acct-a", "windows");
        let windows_b = gateway_installation_id("acct-b", "windows");
        let linux_a = gateway_installation_id("acct-a", "linux");
        assert_eq!(windows_a, gateway_installation_id("acct-a", "windows"));
        assert_ne!(windows_a, windows_b);
        assert_ne!(windows_a, linux_a);
    }
}
