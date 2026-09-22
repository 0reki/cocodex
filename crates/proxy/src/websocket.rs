use crate::interceptor::{RequestContext, SharedInterceptor, WsAction};
use crate::upstream::cookies::CookieJars;
use axum::extract::ws::{Message as AxumWsMessage, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use http::HeaderMap;
use http::header::COOKIE;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as TungsteniteWsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::extensions::ExtensionsConfig;
use tokio_tungstenite::tungstenite::extensions::compression::deflate::DeflateConfig;
use tokio_tungstenite::tungstenite::handshake::client::Request as WsRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async_with_config};
use tracing::{debug, info, warn};
use url::Url;

type UpstreamSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Context key holding the turn state the upstream handshake answered with.
pub const HANDSHAKE_TURN_STATE: &str = "handshake_turn_state";

/// Offers permessage-deflate on the upstream handshake, matching the Codex
/// client (`codex-rs/codex-api/src/endpoint/responses_websocket.rs`).
fn upstream_ws_config() -> WebSocketConfig {
    let mut extensions = ExtensionsConfig::default();
    extensions.permessage_deflate = Some(DeflateConfig::default());
    let mut config = WebSocketConfig::default();
    config.extensions = extensions;
    config
}

/// Upstream handshake response headers relayed onto the client's 101: the
/// same set an HTTP response keeps (Codex reads the model, reasoning and
/// turn-state markers and logs the rest), minus what the gateway's own
/// upgrade response owns.
fn relayed_handshake_headers(upstream: &HeaderMap) -> HeaderMap {
    crate::forwarder::copy_client_response_headers(upstream)
}

/// A refused upstream handshake as the client should see it: upstream's
/// status, headers and body (Codex reads its usage-limit and auth errors
/// from them), with the login's identity replaced by the client's.
fn relayed_handshake_error(
    response: &http::Response<Option<Vec<u8>>>,
    ctx: &RequestContext,
) -> Response {
    let body = response.body().clone().unwrap_or_default();
    let mut swap = crate::client_identity::IdentitySwap::new(&ctx.identity_swap);
    let mut swapped = swap.push(&body);
    swapped.extend(swap.finish());
    let mut relayed = Response::new(axum::body::Body::from(swapped));
    *relayed.status_mut() = response.status();
    *relayed.headers_mut() = crate::forwarder::copy_client_response_headers(response.headers());
    relayed
}

fn upstream_request(
    ctx: &RequestContext,
    upstream_origin: &str,
    cookies: &CookieJars,
) -> Result<WsRequest, String> {
    let ws_origin = if let Some(rest) = upstream_origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = upstream_origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{}", upstream_origin.trim_start_matches('/'))
    };
    let query = crate::forwarder::upstream_query(ctx, ctx.query.as_deref());
    let target = match query.as_deref() {
        Some(query) if !query.is_empty() => format!("{ws_origin}{}?{query}", ctx.target_path),
        _ => format!("{ws_origin}{}", ctx.target_path),
    };
    let url = Url::parse(&target).map_err(|e| e.to_string())?;
    let mut request = target
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    // tungstenite writes Host, Connection, Upgrade and the Sec-WebSocket
    // version and key first by removing them from the map, and
    // `HeaderMap::remove` swaps the last entry into the freed slot. Keeping
    // those five at the end leaves everything before them in place, so the
    // client's headers reach upstream in the order the client sent them.
    let generated = std::mem::take(request.headers_mut());
    let mut headers = HeaderMap::with_capacity(ctx.client_headers.len() + generated.len() + 1);
    for (name, value) in crate::forwarder::copy_upstream_request_headers(&ctx.client_headers).iter()
    {
        // tungstenite generates its own key and extension offer.
        if !name.as_str().starts_with("sec-websocket-") {
            headers.append(name.clone(), value.clone());
        }
    }
    crate::forwarder::apply_upstream_identity_headers(&mut headers, ctx);
    if let (Some(account_id), Some(platform)) = (&ctx.upstream_account_id, &ctx.upstream_platform)
        && let Some(cookie) = cookies.cookie_header(account_id, platform, &url)
    {
        headers.insert(COOKIE, cookie);
    }
    // Host (with any non-default port, as the client would send it) and the
    // handshake headers come from tungstenite.
    for (name, value) in generated.iter() {
        headers.insert(name.clone(), value.clone());
    }
    *request.headers_mut() = headers;
    Ok(request)
}

fn handshake_status(error: &tokio_tungstenite::tungstenite::Error) -> Option<u16> {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => Some(response.status().as_u16()),
        _ => None,
    }
}

/// Connects upstream first so a failed handshake becomes a proper HTTP
/// error, then upgrades the client and relays frames both ways.
pub async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    mut ctx: RequestContext,
    upstream_origin: String,
    interceptor: SharedInterceptor,
    cookies: Arc<CookieJars>,
) -> Response {
    let fail = |status: StatusCode, code: &str, message: &str| {
        crate::interceptor::custom::auth_error(status, code, message)
    };
    let mut attempt = 0;
    let (upstream, handshake_headers) = loop {
        let request = match upstream_request(&ctx, &upstream_origin, &cookies) {
            Ok(request) => request,
            Err(error) => {
                interceptor
                    .on_request_finish(&ctx, Some(500), Some(&error))
                    .await;
                return fail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_upstream_url",
                    &error,
                );
            }
        };
        let request_url = request.uri().to_string();
        debug!(request_id = %ctx.request_id, "connecting upstream WebSocket");
        match connect_async_with_config(request, Some(upstream_ws_config()), false).await {
            Ok((socket, response)) => {
                if let Ok(url) = Url::parse(&request_url) {
                    crate::forwarder::store_upstream_cookies(
                        &ctx,
                        &cookies,
                        &url,
                        response.headers(),
                    );
                }
                break (socket, relayed_handshake_headers(response.headers()));
            }
            Err(error) if handshake_status(&error) == Some(401) && ctx.upstream_token.is_some() => {
                attempt += 1;
                if attempt == 1 && interceptor.on_upstream_unauthorized(&mut ctx).await {
                    info!(request_id = %ctx.request_id, "retrying WebSocket with refreshed upstream token");
                    continue;
                }
                let message = "Upstream rejected the gateway's credentials";
                warn!(
                    request_id = %ctx.request_id,
                    account_id = ctx.upstream_account_id.as_deref().unwrap_or(""),
                    "{message}"
                );
                interceptor
                    .on_request_finish(&ctx, Some(502), Some(message))
                    .await;
                return fail(StatusCode::BAD_GATEWAY, "upstream_unauthorized", message);
            }
            Err(error) => {
                let status = handshake_status(&error)
                    .and_then(|s| StatusCode::from_u16(s).ok())
                    .unwrap_or(StatusCode::BAD_GATEWAY);
                let message = format!("Upstream WebSocket handshake failed: {error}");
                warn!(request_id = %ctx.request_id, status = status.as_u16(), "{message}");
                interceptor
                    .on_request_finish(&ctx, Some(status.as_u16()), Some(&message))
                    .await;
                if let tokio_tungstenite::tungstenite::Error::Http(response) = &error {
                    return relayed_handshake_error(response, &ctx);
                }
                return fail(status, "upstream_error", &message);
            }
        }
    };
    // The turn state a Responses WebSocket is given arrives on the handshake,
    // before any frame names a model. Keep it until the first
    // `response.create` says which model it belongs to, and keep it from the
    // client until then.
    let mut handshake_headers = handshake_headers;
    if let Some(state) = handshake_headers
        .get(crate::upstream::client::TURN_STATE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    {
        ctx.metadata.insert(HANDSHAKE_TURN_STATE.to_string(), state);
    }
    // The client is handed the state the gateway settles on, per turn, in the
    // metadata event. It must not pick one up here: this Codex reads the
    // handshake's state into nothing, but that is its choice to change, and a
    // state the gateway would not present must not reach a client by way of a
    // detail of the client's own implementation.
    handshake_headers.remove(crate::upstream::client::TURN_STATE_HEADER);
    info!(request_id = %ctx.request_id, "WebSocket proxy established with upstream");
    let mut response = ws.on_upgrade(move |client| relay(client, upstream, ctx, interceptor));
    // Codex reads the model, reasoning and rate-limit markers off the
    // handshake response, so carry the upstream ones onto the client's 101.
    let response_headers = response.headers_mut();
    for name in handshake_headers.keys() {
        response_headers.remove(name);
    }
    for (name, value) in handshake_headers.iter() {
        response_headers.append(name.clone(), value.clone());
    }
    response
}

fn from_client(message: AxumWsMessage) -> TungsteniteWsMessage {
    match message {
        AxumWsMessage::Text(t) => TungsteniteWsMessage::Text(t.as_str().into()),
        AxumWsMessage::Binary(b) => TungsteniteWsMessage::Binary(b),
        AxumWsMessage::Ping(p) => TungsteniteWsMessage::Ping(p),
        AxumWsMessage::Pong(p) => TungsteniteWsMessage::Pong(p),
        AxumWsMessage::Close(frame) => TungsteniteWsMessage::Close(frame.map(|cf| {
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: cf.code.into(),
                reason: cf.reason.as_str().into(),
            }
        })),
    }
}

fn to_client(message: TungsteniteWsMessage) -> Option<AxumWsMessage> {
    Some(match message {
        TungsteniteWsMessage::Text(t) => AxumWsMessage::Text(t.as_str().into()),
        TungsteniteWsMessage::Binary(b) => AxumWsMessage::Binary(b),
        TungsteniteWsMessage::Ping(p) => AxumWsMessage::Ping(p),
        TungsteniteWsMessage::Pong(p) => AxumWsMessage::Pong(p),
        TungsteniteWsMessage::Close(frame) => {
            AxumWsMessage::Close(frame.map(|cf| axum::extract::ws::CloseFrame {
                code: cf.code.into(),
                reason: cf.reason.as_str().into(),
            }))
        }
        TungsteniteWsMessage::Frame(_) => return None,
    })
}

/// Replaces the client identity inside a `response.create` frame with the
/// upstream login's, the WebSocket counterpart to the HTTP body rewrite.
fn rewrite_client_frame(
    message: TungsteniteWsMessage,
    ctx: &RequestContext,
) -> TungsteniteWsMessage {
    let TungsteniteWsMessage::Text(text) = &message else {
        return message;
    };
    let Some(identity) = crate::client_identity::PresentedIdentity::from_ctx(ctx) else {
        return message;
    };
    match crate::client_identity::rewrite_ws_client_text(text.as_str(), &identity) {
        Some(rewritten) => TungsteniteWsMessage::Text(rewritten.into()),
        None => message,
    }
}

async fn relay(
    client: axum::extract::ws::WebSocket,
    upstream: UpstreamSocket,
    ctx: RequestContext,
    interceptor: SharedInterceptor,
) {
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    // Everything bound for the client goes through one writer, so the
    // interceptor can answer the client directly.
    let (to_client_tx, mut to_client_rx) = tokio::sync::mpsc::channel::<AxumWsMessage>(64);

    let writer = async {
        while let Some(message) = to_client_rx.recv().await {
            if let Err(e) = client_tx.send(message).await {
                debug!("Client WS send error: {e}");
                break;
            }
        }
    };

    let ctx_client = ctx.clone();
    let interceptor_client = Arc::clone(&interceptor);
    let replies = to_client_tx.clone();
    let client_to_upstream = async move {
        while let Some(Ok(message)) = client_rx.next().await {
            match interceptor_client
                .on_ws_client_message(&ctx_client, from_client(message))
                .await
            {
                Ok(WsAction::Forward(message)) => {
                    let message = rewrite_client_frame(message, &ctx_client);
                    if let Err(e) = upstream_tx.send(message).await {
                        debug!("Upstream WS send error: {e}");
                        break;
                    }
                }
                Ok(WsAction::Reply(message)) => {
                    if let Some(message) = to_client(message)
                        && replies.send(message).await.is_err()
                    {
                        break;
                    }
                }
                Ok(WsAction::Drop) => {}
                Err(e) => warn!("Interceptor error on client WS message: {e}"),
            }
        }
    };

    let ctx_upstream = ctx.clone();
    let interceptor_upstream = Arc::clone(&interceptor);
    let swap = crate::client_identity::IdentitySwap::new(&ctx.identity_swap);
    let upstream_to_client = async move {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let message = match interceptor_upstream
                .on_ws_upstream_message(&ctx_upstream, message)
                .await
            {
                Ok(WsAction::Forward(message)) | Ok(WsAction::Reply(message)) => message,
                Ok(WsAction::Drop) => continue,
                Err(e) => {
                    warn!("Interceptor error on upstream WS message: {e}");
                    continue;
                }
            };
            let message = match &message {
                TungsteniteWsMessage::Text(text) => match swap.swap_text(text.as_str()) {
                    Some(swapped) => TungsteniteWsMessage::Text(swapped.into()),
                    None => message,
                },
                _ => message,
            };
            if let Some(message) = to_client(message)
                && to_client_tx.send(message).await.is_err()
            {
                break;
            }
        }
    };

    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
        _ = writer => {},
    }
    interceptor.on_request_finish(&ctx, Some(101), None).await;
}
