use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};

use super::protocol::{
    ApiKeyRecord, JsonRpcRequest, JsonRpcResponse, ReportUsageParams, VerifyApiKeyResult,
    VerifyPortalTokenResult,
};

#[derive(Debug)]
pub enum IpcClientError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Rpc { code: i64, message: String },
    ChannelClosed,
    Timeout,
}

impl std::fmt::Display for IpcClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "I/O error: {e}"),
            Self::Json(e) => write!(f, "JSON error: {e}"),
            Self::Rpc { code, message } => write!(f, "RPC error ({code}): {message}"),
            Self::ChannelClosed => write!(f, "IPC channel closed"),
            Self::Timeout => write!(f, "Timeout waiting for IPC response"),
        }
    }
}

impl std::error::Error for IpcClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            Self::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for IpcClientError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<serde_json::Error> for IpcClientError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}


enum IpcCommand {
    Call {
        request: JsonRpcRequest,
        responder: oneshot::Sender<Result<JsonRpcResponse, IpcClientError>>,
    },
    Notify {
        request: JsonRpcRequest,
    },
}

#[derive(Clone)]
pub struct IpcClient {
    tx: mpsc::Sender<IpcCommand>,
    req_counter: Arc<AtomicU64>,
}

impl IpcClient {
    pub fn new(socket_path: impl AsRef<Path>) -> Self {
        let socket_path = socket_path.as_ref().to_path_buf();
        let (tx, rx) = mpsc::channel(256);
        let req_counter = Arc::new(AtomicU64::new(1));

        tokio::spawn(ipc_worker_loop(socket_path, rx));

        Self { tx, req_counter }
    }

    async fn call(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, IpcClientError> {
        let id = self.req_counter.fetch_add(1, Ordering::Relaxed).to_string();
        let request = JsonRpcRequest {
            id: Some(id),
            method: method.to_string(),
            params: Some(params),
        };

        let (resp_tx, resp_rx) = oneshot::channel();
        self.tx
            .send(IpcCommand::Call {
                request,
                responder: resp_tx,
            })
            .await
            .map_err(|_| IpcClientError::ChannelClosed)?;

        let resp = match tokio::time::timeout(Duration::from_secs(10), resp_rx).await {
            Ok(Ok(result)) => result?,
            Ok(Err(_)) => return Err(IpcClientError::ChannelClosed),
            Err(_) => return Err(IpcClientError::Timeout),
        };

        if let Some(err) = resp.error {
            return Err(IpcClientError::Rpc {
                code: err.code,
                message: err.message,
            });
        }

        resp.result.ok_or_else(|| IpcClientError::Rpc {
            code: -32603,
            message: "Missing result in response".to_string(),
        })
    }

    async fn notify(&self, method: &str, params: serde_json::Value) -> Result<(), IpcClientError> {
        let request = JsonRpcRequest {
            id: None,
            method: method.to_string(),
            params: Some(params),
        };

        self.tx
            .send(IpcCommand::Notify { request })
            .await
            .map_err(|_| IpcClientError::ChannelClosed)?;

        Ok(())
    }

    pub async fn ping(&self) -> Result<bool, IpcClientError> {
        let res = self.call("health.ping", serde_json::json!({})).await?;
        Ok(res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
    }

    pub async fn verify_api_key(&self, api_key: &str) -> Result<VerifyApiKeyResult, IpcClientError> {
        let res = self
            .call("auth.verify_api_key", serde_json::json!({ "api_key": api_key }))
            .await?;
        let parsed: VerifyApiKeyResult = serde_json::from_value(res)?;
        Ok(parsed)
    }

    pub async fn resolve_user_api_key(&self, user_id: &str) -> Result<ApiKeyRecord, IpcClientError> {
        let res = self
            .call("auth.resolve_user_api_key", serde_json::json!({ "user_id": user_id }))
            .await?;
        let parsed: ApiKeyRecord = serde_json::from_value(res)?;
        Ok(parsed)
    }

    pub async fn verify_portal_token(&self, token: &str) -> Result<VerifyPortalTokenResult, IpcClientError> {
        let res = self
            .call("auth.verify_portal_token", serde_json::json!({ "token": token }))
            .await?;
        let parsed: VerifyPortalTokenResult = serde_json::from_value(res)?;
        Ok(parsed)
    }

    pub async fn report_usage(&self, params: ReportUsageParams) -> Result<(), IpcClientError> {
        let val = serde_json::to_value(params)?;
        self.notify("usage.report_consumption", val).await
    }
}

async fn ipc_worker_loop(socket_path: PathBuf, mut rx: mpsc::Receiver<IpcCommand>) {
    while let Some(first_cmd) = rx.recv().await {
        // Attempt connection to Unix socket
        let stream = match UnixStream::connect(&socket_path).await {
            Ok(s) => s,
            Err(e) => {
                debug!("Failed to connect to UDS at {:?}: {}", socket_path, e);
                // Fail first command if it's a Call
                if let IpcCommand::Call { responder, .. } = first_cmd {
                    let _ = responder.send(Err(IpcClientError::Io(e)));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };

        info!("Connected to Node UDS at {:?}", socket_path);
        if let Err(e) = handle_connection(stream, first_cmd, &mut rx).await {
            warn!("IPC connection broken: {}", e);
        }
    }
}

async fn send_ipc_cmd(
    cmd: IpcCommand,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    pending: &mut HashMap<String, oneshot::Sender<Result<JsonRpcResponse, IpcClientError>>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match cmd {
        IpcCommand::Call { request, responder } => {
            if let Some(id) = &request.id {
                pending.insert(id.clone(), responder);
            }
            let mut line = serde_json::to_string(&request)?;
            line.push('\n');
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
        }
        IpcCommand::Notify { request } => {
            let mut line = serde_json::to_string(&request)?;
            line.push('\n');
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
        }
    }
    Ok(())
}

async fn handle_connection(
    stream: UnixStream,
    first_cmd: IpcCommand,
    rx: &mut mpsc::Receiver<IpcCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    let mut pending: HashMap<String, oneshot::Sender<Result<JsonRpcResponse, IpcClientError>>> =
        HashMap::new();

    // Send first command
    send_ipc_cmd(first_cmd, &mut writer, &mut pending).await?;

    let mut line_buf = String::new();

    loop {
        tokio::select! {
            cmd_opt = rx.recv() => {
                match cmd_opt {
                    Some(cmd) => {
                        if let Err(e) = send_ipc_cmd(cmd, &mut writer, &mut pending).await {
                            return Err(e);
                        }
                    }
                    None => return Ok(()),
                }
            }
            read_res = reader.read_line(&mut line_buf) => {
                let bytes_read = read_res?;
                if bytes_read == 0 {
                    // Socket closed by peer
                    return Err("Socket closed by remote".into());
                }
                let line = line_buf.trim();
                if !line.is_empty() {
                    if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(line) {
                        if let Some(id) = &resp.id {
                            if let Some(responder) = pending.remove(id) {
                                let _ = responder.send(Ok(resp));
                            }
                        }
                    }
                }
                line_buf.clear();
            }
        }
    }
}
