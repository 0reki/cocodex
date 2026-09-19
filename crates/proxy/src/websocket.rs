use crate::interceptor::{RequestContext, SharedInterceptor, WsAction};
use axum::extract::ws::{Message as AxumWsMessage, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use http::header::HOST;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as TungsteniteWsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request as WsRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tracing::{debug, info, warn};
use url::Url;

type UpstreamSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn upstream_request(ctx: &RequestContext, upstream_origin: &str) -> Result<WsRequest, String> {
    let ws_origin = if let Some(rest) = upstream_origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = upstream_origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{}", upstream_origin.trim_start_matches('/'))
    };
    let target = match ctx.query.as_deref() {
        Some(query) if !query.is_empty() => format!("{ws_origin}{}?{query}", ctx.target_path),
        _ => format!("{ws_origin}{}", ctx.target_path),
    };
    let url = Url::parse(&target).map_err(|e| e.to_string())?;
    let mut request = target
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    let forwarded = crate::forwarder::copy_upstream_request_headers(&ctx.client_headers);
    for (name, value) in forwarded.iter() {
        if !name
            .as_str()
            .to_ascii_lowercase()
            .starts_with("sec-websocket-")
        {
            headers.insert(name.clone(), value.clone());
        }
    }
    crate::forwarder::apply_upstream_identity_headers(headers, ctx);
    if let Some(host) = url.host_str()
        && let Ok(value) = host.parse()
    {
        headers.insert(HOST, value);
    }
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
) -> Response {
    let fail = |status: StatusCode, code: &str, message: &str| {
        crate::interceptor::custom::auth_error(status, code, message)
    };
    let mut attempt = 0;
    let upstream = loop {
        let request = match upstream_request(&ctx, &upstream_origin) {
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
        debug!(request_id = %ctx.request_id, "connecting upstream WebSocket");
        match connect_async(request).await {
            Ok((socket, _)) => break socket,
            Err(error) if handshake_status(&error) == Some(401) && ctx.upstream_token.is_some() => {
                attempt += 1;
                if attempt == 1 && interceptor.on_upstream_unauthorized(&mut ctx).await {
                    info!(request_id = %ctx.request_id, "retrying WebSocket with refreshed upstream token");
                    continue;
                }
                let message = "Upstream rejected the gateway's credentials";
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
                interceptor
                    .on_request_finish(&ctx, Some(status.as_u16()), Some(&message))
                    .await;
                return fail(status, "upstream_error", &message);
            }
        }
    };
    info!(request_id = %ctx.request_id, "WebSocket proxy established with upstream");
    ws.on_upgrade(move |client| relay(client, upstream, ctx, interceptor))
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
