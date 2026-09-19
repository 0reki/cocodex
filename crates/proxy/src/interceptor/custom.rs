use super::observe::{BackendKind, classify_backend_kind};
use super::platform::{PLATFORM_HEADER, detect_platform};
use super::{Interceptor, RequestAction, RequestContext, WsAction};
use crate::auth::jwt::JwtError;
use crate::ipc::protocol::{ReportUsageParams, ResolveUpstreamAccountResult};
use crate::ipc::{IpcClient, UpstreamAccountCache};
use crate::runtime::{NotReady, OwnerStatus, Runtime};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::StatusCode;
use axum::http::header::{CONTENT_TYPE, HeaderValue};
use axum::response::{IntoResponse, Response};
use http::Request;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

/// Default interceptor: verify the Codex-shaped client JWT and its session,
/// check the portal user, route to a platform-isolated upstream account,
/// then settle usage/logs over IPC.
pub struct CustomInterceptor {
    ipc: IpcClient,
    runtime: Arc<Runtime>,
    account_cache: UpstreamAccountCache,
}

impl CustomInterceptor {
    pub fn new(ipc: IpcClient, runtime: Arc<Runtime>) -> Self {
        let account_cache = ipc.upstream_account_cache();
        Self {
            ipc,
            runtime,
            account_cache,
        }
    }

    async fn resolve_platform_account(
        &self,
        platform: &str,
    ) -> Result<ResolveUpstreamAccountResult, crate::ipc::IpcClientError> {
        if let Some(cached) = self.account_cache.get(platform).await {
            return Ok(cached);
        }

        let account = self.ipc.resolve_upstream_account(platform).await?;
        self.account_cache
            .remember(platform.to_string(), account.clone())
            .await;
        Ok(account)
    }
}

#[async_trait]
impl Interceptor for CustomInterceptor {
    async fn on_request(
        &self,
        ctx: &mut RequestContext,
        req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>> {
        let Some(platform) = detect_platform(req.headers()) else {
            return Ok(RequestAction::ShortCircuit(auth_error(
                axum::http::StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid access token",
            )));
        };
        ctx.metadata
            .insert("platform".to_string(), platform.as_str().to_string());

        debug!(
            request_id = %ctx.request_id,
            method = %ctx.method,
            path = %ctx.path,
            platform = platform.as_str(),
            "CustomInterceptor: on_request hook"
        );

        let Some(client_token) = ctx.client_token.clone() else {
            return Ok(RequestAction::ShortCircuit(auth_error(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Missing Authorization bearer token",
            )));
        };

        let ready = match self.runtime.ready().await {
            Ok(ready) => ready,
            Err(error) => {
                warn!(request_id = %ctx.request_id, %error, "gateway not ready");
                return Ok(RequestAction::ShortCircuit(not_ready_error(&error)));
            }
        };

        let claims = match ready.sessions.jwt().verify_access_token(&client_token) {
            Ok(claims) => claims,
            Err(JwtError::Expired) => {
                return Ok(RequestAction::ShortCircuit(auth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Access token has expired",
                )));
            }
            Err(JwtError::Invalid) => {
                return Ok(RequestAction::ShortCircuit(auth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Invalid access token",
                )));
            }
        };

        match ready.sessions.is_session_live(&claims.session_id).await {
            Ok(true) => {}
            Ok(false) => {
                return Ok(RequestAction::ShortCircuit(auth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Access token has been revoked",
                )));
            }
            Err(error) => {
                warn!(request_id = %ctx.request_id, %error, "session lookup failed");
                return Ok(RequestAction::ShortCircuit(database_error()));
            }
        }

        let owner_user_id = claims.openai_auth.chatgpt_account_id.clone();
        if let Ok(mut obs) = ctx.observation.lock() {
            obs.owner_user_id = Some(owner_user_id.clone());
        }
        ctx.metadata
            .insert("owner_user_id".into(), owner_user_id.clone());

        let rejection = match ready.verify_owner(&owner_user_id).await {
            Ok(OwnerStatus::Active(_)) => None,
            Ok(OwnerStatus::Unknown) => Some((
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid access token",
            )),
            Ok(OwnerStatus::Disabled(_)) => {
                Some((StatusCode::FORBIDDEN, "user_inactive", "User is disabled"))
            }
            Ok(OwnerStatus::QuotaExceeded(_)) => Some((
                StatusCode::TOO_MANY_REQUESTS,
                "insufficient_quota",
                "User quota exceeded",
            )),
            Err(error) => {
                warn!(request_id = %ctx.request_id, %error, "portal user lookup failed");
                return Ok(RequestAction::ShortCircuit(database_error()));
            }
        };
        if let Some((status, code, message)) = rejection {
            return Ok(RequestAction::ShortCircuit(auth_error(
                status, code, message,
            )));
        }

        let account = match self.resolve_platform_account(platform.as_str()).await {
            Ok(account) => account,
            Err(crate::ipc::IpcClientError::Rpc { message, .. }) => {
                warn!(
                    request_id = %ctx.request_id,
                    platform = platform.as_str(),
                    error = %message,
                    "No upstream account configured for platform"
                );
                return Ok(RequestAction::ShortCircuit(
                    (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        format!(
                            "No upstream account configured for platform '{}': {message}",
                            platform.as_str()
                        ),
                    )
                        .into_response(),
                ));
            }
            Err(error) => {
                warn!(
                    request_id = %ctx.request_id,
                    platform = platform.as_str(),
                    error = %error,
                    "Failed to resolve platform upstream account"
                );
                return Ok(RequestAction::ShortCircuit(auth_error(
                    axum::http::StatusCode::BAD_GATEWAY,
                    "upstream_error",
                    "Failed to resolve upstream account",
                )));
            }
        };

        info!(
            request_id = %ctx.request_id,
            platform = platform.as_str(),
            account_id = %account.account_id,
            "Routing request to platform-isolated upstream account"
        );

        ctx.upstream_token = Some(account.access_token.clone());
        ctx.upstream_account_id = Some(account.account_id.clone());
        ctx.upstream_user_agent = Some(account.user_agent.clone());
        ctx.upstream_client_version =
            crate::forwarder::client_version_from_user_agent(&account.user_agent);
        ctx.upstream_installation_id = Some(crate::forwarder::gateway_installation_id(
            &account.account_id,
            platform.as_str(),
        ));

        let (mut parts, body) = req.into_parts();
        parts.headers.remove(PLATFORM_HEADER);
        let req = Request::from_parts(parts, body);

        Ok(RequestAction::Forward(req))
    }

    async fn on_response(
        &self,
        ctx: &RequestContext,
        resp: Response,
    ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
        if let Ok(mut obs) = ctx.observation.lock() {
            if let Some(content_type) = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
            {
                if content_type.contains("text/event-stream") {
                    obs.is_sse = Some(true);
                } else if content_type.contains("json") {
                    obs.is_sse = Some(false);
                }
            }
            if let Some(model) = resp
                .headers()
                .get("openai-model")
                .and_then(|v| v.to_str().ok())
                && !model.is_empty()
            {
                obs.model.get_or_insert_with(|| model.to_string());
            }
        }
        Ok(resp)
    }

    fn on_response_chunk(&self, ctx: &RequestContext, chunk: &[u8]) {
        if let Ok(mut obs) = ctx.observation.lock() {
            obs.ingest_chunk(chunk, ctx.started_at.elapsed().as_millis() as u64);
        }
    }

    async fn on_ws_client_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        if let WsMessage::Text(text) = &msg
            && let Ok(mut obs) = ctx.observation.lock()
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(text)
            && obs.model.is_none()
            && let Some(model) = value.get("model").and_then(|v| v.as_str())
        {
            obs.model = Some(model.to_string());
        }
        Ok(WsAction::Forward(msg))
    }

    async fn on_ws_upstream_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        if let WsMessage::Text(text) = &msg
            && let Ok(mut obs) = ctx.observation.lock()
        {
            obs.ingest_text(text);
        }
        Ok(WsAction::Forward(msg))
    }

    async fn on_request_finish(
        &self,
        ctx: &RequestContext,
        status_code: Option<u16>,
        error: Option<&str>,
    ) {
        // Only an upstream 401 means the cached upstream token went stale;
        // our own client-auth rejections short-circuit before a token is set.
        if status_code == Some(401)
            && ctx.upstream_token.is_some()
            && let Some(platform) = ctx.metadata.get("platform")
        {
            self.account_cache.invalidate(platform).await;
        }

        let elapsed = ctx.started_at.elapsed();
        info!(
            request_id = %ctx.request_id,
            path = %ctx.path,
            platform = ctx
                .metadata
                .get("platform")
                .map(String::as_str)
                .unwrap_or(""),
            status = ?status_code,
            duration_ms = elapsed.as_millis(),
            error = ?error,
            "Request finished"
        );

        let snapshot = {
            let Ok(mut obs) = ctx.observation.lock() else {
                return;
            };
            if obs.settled {
                return;
            }
            obs.settled = true;
            obs.finish_json_body();
            if obs.error_message.is_none()
                && let Some(error) = error
            {
                obs.error_message = Some(error.to_string());
            }
            FinishSnapshot {
                owner_user_id: obs.owner_user_id.clone(),
                model: obs.model.clone(),
                usage: obs.usage.clone(),
                ttfb_ms: obs.ttfb_ms,
                error_code: obs.error_code.clone(),
                error_message: obs.error_message.clone(),
            }
        };

        let Some(owner_user_id) = snapshot.owner_user_id else {
            return;
        };

        let kind = classify_backend_kind(&ctx.target_path);
        let usage = snapshot.usage.unwrap_or_default();
        let model = snapshot
            .model
            .or_else(|| default_model_for_kind(kind))
            .unwrap_or_else(|| "codex-chatgpt".to_string());
        let params = ReportUsageParams {
            owner_user_id: Some(owner_user_id),
            model,
            total_tokens: usage.total_tokens,
            prompt_tokens: usage.input_tokens,
            completion_tokens: usage.output_tokens,
            latency_ms: Some(elapsed.as_millis() as u64),
            ttfb_ms: snapshot.ttfb_ms,
            settlement_id: Some(ctx.request_id.clone()),
            path: Some(ctx.target_path.clone()),
            status_code: status_code.map(u32::from),
            tokens_info: Some(usage.to_tokens_info()),
            error_code: snapshot.error_code,
            error_message: snapshot.error_message,
            billable: Some(kind.billable()),
            is_final: Some(true),
            stream_end_reason: Some(
                error
                    .map(|_| "error".to_string())
                    .unwrap_or_else(|| "stop".to_string()),
            ),
        };

        if let Err(err) = self.ipc.report_usage(params).await {
            warn!(
                request_id = %ctx.request_id,
                error = %err,
                "Failed to report usage over IPC"
            );
        }
    }
}

struct FinishSnapshot {
    owner_user_id: Option<String>,
    model: Option<String>,
    usage: Option<super::observe::UsageStats>,
    ttfb_ms: Option<u64>,
    error_code: Option<String>,
    error_message: Option<String>,
}

fn default_model_for_kind(kind: BackendKind) -> Option<String> {
    match kind {
        BackendKind::Images => Some("gpt-image-2".to_string()),
        BackendKind::Search => Some("codex-search".to_string()),
        _ => None,
    }
}

fn not_ready_error(error: &NotReady) -> Response {
    match error {
        NotReady::SetupRequired => auth_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "setup_required",
            "Gateway setup has not been completed",
        ),
        NotReady::Database(_) => database_error(),
    }
}

fn database_error() -> Response {
    auth_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "database_unavailable",
        "Failed to verify access token",
    )
}

fn auth_error(status: StatusCode, code: &str, message: &str) -> Response {
    let body = serde_json::json!({
        "error": {
            "message": message,
            "type": "invalid_request_error",
            "code": code,
        }
    });
    (
        status,
        [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
        body.to_string(),
    )
        .into_response()
}
