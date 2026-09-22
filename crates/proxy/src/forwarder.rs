use crate::client_identity;
use crate::interceptor::{RequestAction, RequestContext, SharedInterceptor};
use crate::upstream::cookies::CookieJars;
use crate::upstream::identity;
use crate::websocket::handle_ws_upgrade;
use axum::body::Body;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::header::{AUTHORIZATION, COOKIE, HOST, HeaderName, HeaderValue, USER_AGENT};
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
    cookies: Arc<CookieJars>,
}

impl BackendForwarder {
    pub fn new(
        upstream_origin: String,
        interceptor: SharedInterceptor,
        cookies: Arc<CookieJars>,
    ) -> Self {
        // No request timeout so long-lived responses flow uninterrupted, and
        // no automatic `accept-encoding`: Codex sends none, so upstream
        // answers uncompressed and the body is relayed as is.
        let client = Client::builder()
            .no_gzip()
            .no_zstd()
            .build()
            .expect("Failed to build reqwest client");

        Self {
            client,
            upstream_origin,
            interceptor,
            cookies,
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
        // (`…/codex/responses`), Realtime (`…/codex/realtime`, `…/codex/live`,
        // or the ChatGPT-style `/backend-api/codex` websocket), and WHAM.
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
                Arc::clone(&self.cookies),
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
        apply_upstream_cookies(&mut forward_headers, ctx, &self.cookies, url);
        if let Some(host) = url.host_str()
            && let Ok(hv) = HeaderValue::from_str(host)
        {
            forward_headers.insert(HOST, hv);
        }
        let response = self
            .client
            .request(method.clone(), url.clone())
            .headers(forward_headers)
            .body(body.clone())
            .send()
            .await?;
        store_upstream_cookies(ctx, &self.cookies, url, response.headers());
        Ok(response)
    }

    async fn forward_http(&self, mut ctx: RequestContext, req: Request<Body>) -> Response {
        let query = upstream_query(&ctx, req.uri().query())
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
        // The body carries the same installation id and turn metadata as the
        // headers (and analytics the client's version and machine), so
        // rewrite both to the upstream login's identity.
        let body = client_identity::rewrite_request_body(&ctx, &parts.headers, body);

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
                warn!(
                    request_id = %ctx.request_id,
                    account_id = ctx.upstream_account_id.as_deref().unwrap_or(""),
                    path = %ctx.target_path,
                    "{message}"
                );
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

        // Upstream reports its login's identity back (e.g. `/wham/usage`,
        // Responses `safety_identifier`); the client sees its own instead.
        // A compressed body is relayed as is: Codex never asks for one.
        let compressed = upstream_resp
            .headers()
            .get(http::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| !v.trim().eq_ignore_ascii_case("identity"));
        let swap = Arc::new(std::sync::Mutex::new(if compressed {
            client_identity::IdentitySwap::default()
        } else {
            client_identity::IdentitySwap::new(&ctx.identity_swap)
        }));
        let swap_chunk = Arc::clone(&swap);

        let completion_ctx = ctx.clone();
        let end_marker = futures_util::stream::once(async move {
            if let Ok(mut obs) = completion_ctx.observation.lock() {
                obs.upstream_complete = true;
            }
            let rest = swap
                .lock()
                .map(|mut swap| swap.finish())
                .unwrap_or_default();
            (!rest.is_empty()).then(|| Ok(bytes::Bytes::from(rest)))
        })
        .filter_map(|item: Option<Result<bytes::Bytes, std::io::Error>>| async move { item });
        let byte_stream = upstream_resp.bytes_stream().map(move |item| {
            let _keep_guard = &finish_guard_chunk;
            match item {
                Ok(bytes) => {
                    // Metering reads what upstream actually sent.
                    interceptor_chunk.on_response_chunk(&ctx_chunk, &bytes);
                    Ok(match swap_chunk.lock() {
                        Ok(mut swap) if !swap.is_empty() => bytes::Bytes::from(swap.push(&bytes)),
                        _ => bytes,
                    })
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

/// `x-oai-attestation` as Codex sends it when the host app's attestation
/// times out (`codex-rs/app-server/src/attestation.rs`: version 1, status 1).
const ATTESTATION_TIMED_OUT: &str = r#"{"v":1,"s":1}"#;

/// Replaces the client's identity in its headers with the upstream login's;
/// only the client's type (originator) is kept. Only headers the
/// client sent are rewritten: a genuine client of that login sends exactly
/// the same set (Codex omits `originator` and `version` on several
/// endpoints, and the User-Agent on some), so nothing is added and nothing
/// is dropped.
pub(crate) fn apply_upstream_identity_headers(headers: &mut HeaderMap, ctx: &RequestContext) {
    // The client's own credentials are the gateway's and never go upstream.
    match ctx
        .upstream_token
        .as_ref()
        .and_then(|token| HeaderValue::from_str(&format!("Bearer {token}")).ok())
    {
        Some(hv) => {
            headers.insert(AUTHORIZATION, hv);
        }
        None => {
            headers.remove(AUTHORIZATION);
        }
    }
    let account_header = HeaderName::from_static("chatgpt-account-id");
    if headers.contains_key(&account_header) {
        match ctx
            .upstream_account_id
            .as_deref()
            .and_then(|id| HeaderValue::from_str(id).ok())
        {
            Some(hv) => {
                headers.insert(account_header, hv);
            }
            None => {
                headers.remove(account_header);
            }
        }
    }
    // Only the client's type (originator, app-server client name) is its
    // own; the version and the machine are the upstream login's.
    let version = ctx.upstream_client_version.as_deref();
    if let Some(version) = version
        && let Some(client) = headers.get(USER_AGENT).and_then(|v| v.to_str().ok())
        && let Some(presented) = match ctx.upstream_platform.as_deref() {
            Some(platform) => Some(identity::rewrite_user_agent(client, platform, version)),
            // Unauthenticated MCP traffic has no login; its agent names no
            // machine anyway.
            None => (!client.contains(' '))
                .then(|| identity::rewrite_user_agent(client, "linux", version)),
        }
        && let Ok(hv) = HeaderValue::from_str(&presented)
    {
        headers.insert(USER_AGENT, hv);
    }
    // A host app's attestation proves its own device and session, which the
    // gateway can neither forward nor forge. Codex sends this envelope when
    // the host misses its 100 ms budget, so the header stays as a genuine
    // client of the login could send it.
    let attestation = HeaderName::from_static("x-oai-attestation");
    if headers.contains_key(&attestation) {
        headers.insert(attestation, HeaderValue::from_static(ATTESTATION_TIMED_OUT));
    }
    let version_header = HeaderName::from_static("version");
    if headers.contains_key(&version_header)
        && let Some(version) = version
        && let Ok(hv) = HeaderValue::from_str(version)
    {
        headers.insert(version_header, hv);
    }

    // The turn state is the login's, not the client's: on a managed model
    // the client's own value never reaches upstream, and the one the gateway
    // holds for that login takes its place. Unlike the identity headers this
    // one may be added or removed, because a genuine Codex client sends it
    // only once its session has been issued one.
    if ctx.turn_state_key.is_some() {
        let header = HeaderName::from_static(crate::upstream::client::TURN_STATE_HEADER);
        match ctx
            .upstream_turn_state
            .as_deref()
            .and_then(|state| HeaderValue::from_str(state).ok())
        {
            Some(hv) => {
                headers.insert(header, hv);
            }
            None => {
                headers.remove(header);
            }
        }
    }

    let Some(identity) = client_identity::PresentedIdentity::from_ctx(ctx) else {
        return;
    };
    let installation_header = HeaderName::from_static("x-codex-installation-id");
    if headers.contains_key(&installation_header)
        && let Ok(hv) = HeaderValue::from_str(identity.installation_id)
    {
        headers.insert(installation_header, hv);
    }
    if let Some(raw) = headers
        .get("x-codex-turn-metadata")
        .and_then(|value| value.to_str().ok())
        && let Some(rewritten) = client_identity::rewrite_turn_metadata(raw, &identity)
        && let Ok(hv) = HeaderValue::from_str(&rewritten)
    {
        headers.insert(HeaderName::from_static("x-codex-turn-metadata"), hv);
    }
}

/// The upstream query string: identical to the client's except that the
/// `client_version` Codex sends to `/models` becomes the presented version.
pub(crate) fn upstream_query(ctx: &RequestContext, query: Option<&str>) -> Option<String> {
    let query = query?;
    Some(match ctx.upstream_client_version.as_deref() {
        Some(version) => client_identity::rewrite_client_version_query(query, version),
        None => query.to_string(),
    })
}

/// Sends the upstream login's infrastructure cookies, as Codex does on every
/// request and WebSocket handshake to ChatGPT.
pub(crate) fn apply_upstream_cookies(
    headers: &mut HeaderMap,
    ctx: &RequestContext,
    cookies: &CookieJars,
    url: &Url,
) {
    if let (Some(account_id), Some(platform)) = (&ctx.upstream_account_id, &ctx.upstream_platform)
        && let Some(cookie) = cookies.cookie_header(account_id, platform, url)
    {
        headers.insert(COOKIE, cookie);
    }
}

/// Keeps the allowlisted cookies from an upstream response in the login's jar.
pub(crate) fn store_upstream_cookies(
    ctx: &RequestContext,
    cookies: &CookieJars,
    url: &Url,
    headers: &HeaderMap,
) {
    if let (Some(account_id), Some(platform)) = (&ctx.upstream_account_id, &ctx.upstream_platform) {
        cookies.store(account_id, platform, url, headers);
    }
}

pub(crate) fn copy_upstream_request_headers(headers: &HeaderMap) -> HeaderMap {
    let mut forwarded = HeaderMap::new();
    for (name, val) in headers {
        if should_drop_request_header(name.as_str()) {
            continue;
        }
        forwarded.append(name.clone(), val.clone());
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
        // Kept so its presence is mirrored; the value is always replaced.
        || (is_client_account_header(&name) && name != "chatgpt-account-id")
        // Codex never sends it; reqwest must not negotiate compression the
        // client did not ask for either (see `BackendForwarder::new`).
        || name == "accept-encoding"
}

fn should_drop_response_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    is_hop_by_hop_header(&name)
        || is_client_account_header(&name)
        // Upstream cookies belong to the gateway's per-login jar, not the client.
        || name == "set-cookie"
        // A relayed WebSocket handshake negotiates its own key and extensions;
        // the client side is handled by the gateway's own upgrade response.
        || name.starts_with("sec-websocket-")
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
        "cookie" | "forwarded" | "origin" | "via" | "x-real-ip"
    ) || name.starts_with("cf-")
        || name.starts_with("x-forwarded-")
}

fn is_client_account_header(name: &str) -> bool {
    matches!(
        name,
        "chatgpt-account-id"
            | "openai-organization"
            | "openai-project"
            | "x-openai-fedramp"
            | "x-openai-actor-authorization"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::RequestContext;
    use axum::http::Request;

    const CLIENT_UA: &str =
        "codex-tui/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.155.1)";

    fn ctx_with_identity(request: http::request::Builder) -> RequestContext {
        let req = request
            .uri("/backend-api/codex/responses")
            .body(Body::empty())
            .unwrap();
        let mut ctx = RequestContext::new(&req);
        ctx.upstream_token = Some("upstream-token".into());
        ctx.upstream_account_id = Some("upstream-account".into());
        ctx.upstream_client_version = Some("0.156.0".into());
        ctx.upstream_installation_id = Some(client_identity::gateway_installation_id(
            "upstream-account",
            "windows",
        ));
        ctx.upstream_platform = Some("windows".into());
        ctx
    }

    fn upstream_headers(ctx: &RequestContext) -> HeaderMap {
        let mut forwarded = copy_upstream_request_headers(&ctx.client_headers);
        apply_upstream_identity_headers(&mut forwarded, ctx);
        forwarded
    }

    #[test]
    fn rewrites_client_identity_and_keeps_session_fields() {
        let ctx = ctx_with_identity(
            Request::builder()
                .header("authorization", "Bearer client-jwt")
                .header("chatgpt-account-id", "gateway-account")
                .header("user-agent", CLIENT_UA)
                .header("originator", "codex-tui")
                .header("version", "0.155.1")
                .header("session-id", "sess-keep")
                .header("thread-id", "thread-keep")
                .header("x-codex-installation-id", "install-leak")
                .header(
                    "x-codex-turn-metadata",
                    r#"{"installation_id":"install-leak","session_id":"sess-keep","sandbox":"seccomp","workspaces":{"repo":{"associated_remote_urls":{"origin":"https://github.com/user/secret.git"}}}}"#,
                )
                .header("openai-beta", "responses_websockets=2026-02-06")
                .header("content-type", "application/json"),
        );
        let forwarded = upstream_headers(&ctx);

        assert_eq!(
            forwarded.get("authorization").unwrap(),
            "Bearer upstream-token"
        );
        assert_eq!(
            forwarded.get("user-agent").unwrap(),
            "codex-tui/0.156.0 (Windows 10.0.22631; x86_64) WindowsTerminal (codex-tui; 0.156.0)"
        );
        assert_eq!(forwarded.get("originator").unwrap(), "codex-tui");
        assert_eq!(forwarded.get("version").unwrap(), "0.156.0");
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
        let install = client_identity::gateway_installation_id("upstream-account", "windows");
        assert_eq!(
            forwarded.get("x-codex-installation-id").unwrap(),
            install.as_str()
        );
        let metadata: serde_json::Value = serde_json::from_str(
            forwarded
                .get("x-codex-turn-metadata")
                .unwrap()
                .to_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["installation_id"].as_str(), Some(install.as_str()));
        assert_eq!(metadata["session_id"].as_str(), Some("sess-keep"));
        // The sandbox follows the machine presented upstream: this client
        // ran under Linux seccomp and is served by the Windows login.
        assert_eq!(metadata["sandbox"].as_str(), Some("windows_elevated"));
        // The client's workspaces are its own and pass through unchanged.
        assert_eq!(
            metadata["workspaces"]["repo"]["associated_remote_urls"]["origin"].as_str(),
            Some("https://github.com/user/secret.git")
        );
    }

    #[test]
    fn identity_headers_the_client_omits_stay_omitted() {
        // Codex 0.155.1 sends `/wham/*` without `originator` or `version`,
        // and `/accounts/verified_access` without a User-Agent.
        let ctx = ctx_with_identity(
            Request::builder()
                .header("authorization", "Bearer client-jwt")
                .header("accept", "*/*"),
        );
        let forwarded = upstream_headers(&ctx);
        assert_eq!(
            forwarded.get("authorization").unwrap(),
            "Bearer upstream-token"
        );
        for name in [
            "user-agent",
            "originator",
            "version",
            "chatgpt-account-id",
            "accept-encoding",
        ] {
            assert!(forwarded.get(name).is_none(), "{name} was added");
        }
    }

    #[test]
    fn client_type_is_kept_and_the_rest_presented() {
        let ctx = ctx_with_identity(
            Request::builder()
                .header(
                    "user-agent",
                    "codex_exec/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex_exec; 0.155.1)",
                )
                .header("originator", "codex_exec"),
        );
        let forwarded = upstream_headers(&ctx);
        assert_eq!(
            forwarded.get("user-agent").unwrap(),
            "codex_exec/0.156.0 (Windows 10.0.22631; x86_64) WindowsTerminal (codex_exec; 0.156.0)"
        );
        assert_eq!(forwarded.get("originator").unwrap(), "codex_exec");

        let ctx = ctx_with_identity(
            Request::builder()
                .header("user-agent", "codex-mcp-client/0.155.1")
                .header("originator", "codex_vscode")
                .header(
                    "x-oai-attestation",
                    r#"{"v":1,"s":0,"t":"v1.device-bound"}"#,
                )
                .header("accept-encoding", "gzip"),
        );
        let forwarded = upstream_headers(&ctx);
        assert_eq!(
            forwarded.get("user-agent").unwrap(),
            "codex-mcp-client/0.156.0"
        );
        // The client's type is its own, whatever host it is.
        assert_eq!(forwarded.get("originator").unwrap(), "codex_vscode");
        // The host's own attestation never goes upstream; the header does.
        assert_eq!(
            forwarded.get("x-oai-attestation").unwrap(),
            r#"{"v":1,"s":1}"#
        );
        assert!(forwarded.get("accept-encoding").is_none());
    }

    #[test]
    fn client_credentials_never_leak_without_an_upstream_login() {
        let req = Request::builder()
            .uri("/backend-api/wham/usage")
            .header("authorization", "Bearer client-jwt")
            .header("chatgpt-account-id", "gateway-account")
            .body(Body::empty())
            .unwrap();
        let ctx = RequestContext::new(&req);
        let forwarded = upstream_headers(&ctx);
        assert!(forwarded.get("authorization").is_none());
        assert!(forwarded.get("chatgpt-account-id").is_none());
    }

    #[test]
    fn client_version_query_uses_presented_version() {
        let ctx = ctx_with_identity(Request::builder());
        assert_eq!(
            upstream_query(&ctx, Some("client_version=0.1.0")).as_deref(),
            Some("client_version=0.156.0")
        );
        assert_eq!(upstream_query(&ctx, None), None);
    }
}
