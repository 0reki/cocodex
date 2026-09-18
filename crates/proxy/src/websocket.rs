use crate::interceptor::{RequestContext, SharedInterceptor, WsAction};
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use http::header::{AUTHORIZATION, HOST};
use std::sync::Arc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungsteniteWsMessage;
use tracing::{debug, info, warn};
use url::Url;

/// Handles WebSocket upgrade on `/backend-api/codex/responses`.
pub async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    ctx: RequestContext,
    upstream_origin: String,
    interceptor: SharedInterceptor,
) -> Response {
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = proxy_websocket(socket, ctx, upstream_origin, interceptor).await {
            warn!("WebSocket proxy error: {e}");
        }
    })
}

async fn proxy_websocket(
    client_ws: WebSocket,
    ctx: RequestContext,
    upstream_origin: String,
    interceptor: SharedInterceptor,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws_origin = if upstream_origin.starts_with("https://") {
        upstream_origin.replacen("https://", "wss://", 1)
    } else if upstream_origin.starts_with("http://") {
        upstream_origin.replacen("http://", "ws://", 1)
    } else {
        format!("wss://{}", upstream_origin.trim_start_matches('/'))
    };

    let target_url_str = format!("{ws_origin}{}", ctx.target_path);
    let target_url = Url::parse(&target_url_str)?;
    let mut request = target_url_str.as_str().into_client_request()?;

    // Copy relevant headers to upstream handshake
    let req_headers = request.headers_mut();
    for (name, val) in &ctx.client_headers {
        let name_str = name.as_str().to_ascii_lowercase();
        if matches!(
            name_str.as_str(),
            "upgrade"
                | "connection"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
                | "host"
        ) {
            continue;
        }
        req_headers.insert(name.clone(), val.clone());
    }

    if let Some(token) = &ctx.upstream_token {
        let auth_val = format!("Bearer {token}");
        if let Ok(hv) = auth_val.parse() {
            req_headers.insert(AUTHORIZATION, hv);
        }
    }

    if let Some(account_id) = &ctx.upstream_account_id {
        if let Ok(hv) = account_id.parse() {
            req_headers.insert(
                http::HeaderName::from_static("chatgpt-account-id"),
                hv,
            );
        }
    }

    if let Some(host) = target_url.host_str() {
        if let Ok(hv) = host.parse() {
            req_headers.insert(HOST, hv);
        }
    }

    debug!("Connecting to upstream WebSocket: {target_url_str}");
    let (upstream_ws, _) = connect_async(request).await?;
    info!(request_id = %ctx.request_id, "WebSocket proxy established with upstream");

    let (mut client_tx, mut client_rx) = client_ws.split();
    let (mut upstream_tx, mut upstream_rx) = upstream_ws.split();

    let ctx_client = ctx.clone();
    let interceptor_client = Arc::clone(&interceptor);

    // Client -> Upstream pump
    let client_to_upstream = async move {
        while let Some(msg_res) = client_rx.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                Err(e) => {
                    debug!("Client WS error: {e}");
                    break;
                }
            };

            let tungstenite_msg = match msg {
                AxumWsMessage::Text(t) => TungsteniteWsMessage::Text(t.as_str().into()),
                AxumWsMessage::Binary(b) => TungsteniteWsMessage::Binary(b),
                AxumWsMessage::Ping(p) => TungsteniteWsMessage::Ping(p),
                AxumWsMessage::Pong(p) => TungsteniteWsMessage::Pong(p),
                AxumWsMessage::Close(c) => {
                    let frame = c.map(|cf| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(cf.code),
                        reason: cf.reason.as_str().into(),
                    });
                    TungsteniteWsMessage::Close(frame)
                }
            };

            match interceptor_client
                .on_ws_client_message(&ctx_client, tungstenite_msg)
                .await
            {
                Ok(WsAction::Forward(forward_msg)) => {
                    if let Err(e) = upstream_tx.send(forward_msg).await {
                        debug!("Upstream WS send error: {e}");
                        break;
                    }
                }
                Ok(WsAction::Drop) => {}
                Err(e) => {
                    warn!("Interceptor error on client WS message: {e}");
                }
            }
        }
    };

    let ctx_upstream = ctx.clone();
    let interceptor_upstream = Arc::clone(&interceptor);

    // Upstream -> Client pump
    let upstream_to_client = async move {
        while let Some(msg_res) = upstream_rx.next().await {
            let msg = match msg_res {
                Ok(m) => m,
                Err(e) => {
                    debug!("Upstream WS error: {e}");
                    break;
                }
            };

            match interceptor_upstream
                .on_ws_upstream_message(&ctx_upstream, msg)
                .await
            {
                Ok(WsAction::Forward(forward_msg)) => {
                    let axum_msg = match forward_msg {
                        TungsteniteWsMessage::Text(t) => AxumWsMessage::Text(t.as_str().into()),
                        TungsteniteWsMessage::Binary(b) => AxumWsMessage::Binary(b),
                        TungsteniteWsMessage::Ping(p) => AxumWsMessage::Ping(p),
                        TungsteniteWsMessage::Pong(p) => AxumWsMessage::Pong(p),
                        TungsteniteWsMessage::Close(c) => {
                            let frame = c.map(|cf| axum::extract::ws::CloseFrame {
                                code: cf.code.into(),
                                reason: cf.reason.as_str().into(),
                            });
                            AxumWsMessage::Close(frame)
                        }
                        TungsteniteWsMessage::Frame(_) => continue,
                    };

                    if let Err(e) = client_tx.send(axum_msg).await {
                        debug!("Client WS send error: {e}");
                        break;
                    }
                }
                Ok(WsAction::Drop) => {}
                Err(e) => {
                    warn!("Interceptor error on upstream WS message: {e}");
                }
            }
        }
    };

    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
    }

    interceptor.on_request_finish(&ctx, Some(1000), None).await;
    Ok(())
}
