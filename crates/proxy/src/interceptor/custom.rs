use super::observe::{BackendKind, ResponseObservation, Terminal, classify_backend_kind};
use super::platform::{PLATFORM_HEADER, detect_platform};
use super::{Interceptor, RequestAction, RequestContext, WsAction};
use crate::auth::jwt::JwtError;
use crate::billing::pricing;
use crate::billing::usd::Usd;
use crate::db::settlements::Settlement;
use crate::runtime::{NotReady, OwnerStatus, Ready, Runtime};
use async_trait::async_trait;
use axum::body::Body;
use axum::http::StatusCode;
use axum::http::header::{CONTENT_TYPE, HeaderValue};
use axum::response::{IntoResponse, Response};
use http::Request;
use std::sync::Arc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

const META_PLATFORM: &str = "platform";
const META_OWNER: &str = "owner_user_id";
const META_ACCOUNT: &str = "account_id";
const META_ROW: &str = "upstream_row_id";

/// Why a request (or a WebSocket turn) is refused before reaching upstream.
struct Rejection {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl Rejection {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn response(&self) -> Response {
        auth_error(self.status, self.code, &self.message)
    }

    /// The Codex Responses WebSocket error event.
    fn ws_event(&self) -> WsMessage {
        WsMessage::Text(
            serde_json::json!({
                "type": "error",
                "status": self.status.as_u16(),
                "error": {
                    "type": "invalid_request_error",
                    "code": self.code,
                    "message": self.message,
                }
            })
            .to_string()
            .into(),
        )
    }
}

/// Default interceptor: verify the Codex client token and its session,
/// check the user, route to the user's upstream account for the client's
/// platform, then settle each response.
pub struct CustomInterceptor {
    runtime: Arc<Runtime>,
}

impl CustomInterceptor {
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self { runtime }
    }

    async fn owner_rejection(&self, ready: &Ready, owner: &str) -> Option<Rejection> {
        match ready.verify_owner(owner).await {
            Ok(OwnerStatus::Active(_)) => None,
            Ok(OwnerStatus::Unknown) => Some(Rejection::new(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid access token",
            )),
            Ok(OwnerStatus::Disabled(_)) => Some(Rejection::new(
                StatusCode::FORBIDDEN,
                "user_inactive",
                "User is disabled",
            )),
            Ok(OwnerStatus::QuotaExceeded(_)) => Some(Rejection::new(
                StatusCode::TOO_MANY_REQUESTS,
                "insufficient_quota",
                "User quota exceeded",
            )),
            Err(error) => {
                warn!(%error, "portal user lookup failed");
                Some(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "Failed to verify access token",
                ))
            }
        }
    }

    async fn quota_rejection(ready: &Ready, account_id: &str, owner: &str) -> Option<Rejection> {
        let decision = ready.quota.check(account_id, owner).await;
        (!decision.allowed).then(|| {
            Rejection::new(
                StatusCode::TOO_MANY_REQUESTS,
                "upstream_user_quota_exceeded",
                format!(
                    "Your share of the upstream account's weekly quota is used up ({:.1}% of {}%)",
                    decision.allocated_percent,
                    crate::quota::USER_QUOTA_PERCENT
                ),
            )
        })
    }

    /// Checks an authenticated request and picks its upstream login.
    async fn admit(&self, ctx: &mut RequestContext, platform: &str) -> Result<(), Rejection> {
        let token = ctx.client_token.clone().ok_or_else(|| {
            Rejection::new(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Missing Authorization bearer token",
            )
        })?;
        let ready = self.runtime.ready().await.map_err(|error| {
            warn!(request_id = %ctx.request_id, %error, "gateway not ready");
            match error {
                NotReady::SetupRequired => Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "setup_required",
                    "Gateway setup has not been completed",
                ),
                NotReady::Database(_) => Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "Failed to verify access token",
                ),
            }
        })?;
        let claims = ready
            .sessions
            .jwt()
            .verify_access_token(&token)
            .map_err(|error| {
                let message = match error {
                    JwtError::Expired => "Access token has expired",
                    JwtError::Invalid => "Invalid access token",
                };
                Rejection::new(StatusCode::UNAUTHORIZED, "invalid_token", message)
            })?;
        match ready.sessions.is_session_live(&claims.session_id).await {
            Ok(true) => {}
            Ok(false) => {
                return Err(Rejection::new(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Access token has been revoked",
                ));
            }
            Err(error) => {
                warn!(request_id = %ctx.request_id, %error, "session lookup failed");
                return Err(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "Failed to verify access token",
                ));
            }
        }

        let owner = claims.openai_auth.chatgpt_account_id.clone();
        ctx.metadata.insert(META_OWNER.into(), owner.clone());
        if let Ok(mut obs) = ctx.observation.lock() {
            obs.owner_user_id = Some(owner.clone());
        }
        if let Some(rejection) = self.owner_rejection(&ready, &owner).await {
            return Err(rejection);
        }

        let account_id = match ready.accounts.assigned_account(&owner).await {
            Ok(Some(account_id)) => account_id,
            Ok(None) => {
                return Err(Rejection::new(
                    StatusCode::FORBIDDEN,
                    "upstream_account_unassigned",
                    "尚未分配上游账号",
                ));
            }
            Err(error) => {
                warn!(%error, "assignment lookup failed");
                return Err(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "Failed to resolve upstream account",
                ));
            }
        };
        ctx.metadata.insert(META_ACCOUNT.into(), account_id.clone());

        if classify_backend_kind(&ctx.target_path).billable()
            && let Some(rejection) = Self::quota_rejection(&ready, &account_id, &owner).await
        {
            return Err(rejection);
        }

        let row = match ready.accounts.resolve(&account_id, platform).await {
            Ok(Some(row)) => row,
            Ok(None) => {
                return Err(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_account_unavailable",
                    format!("No upstream login for platform '{platform}'"),
                ));
            }
            Err(error) => {
                warn!(%error, "upstream account lookup failed");
                return Err(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_unavailable",
                    "Failed to resolve upstream account",
                ));
            }
        };
        // A login made for one OS keeps that OS's identity; a generic
        // login presents the client's own OS.
        let identity_platform = if row.platform() == "all" {
            platform
        } else {
            row.platform()
        };
        let user_agent = ready.accounts.client.user_agent(identity_platform);
        info!(
            request_id = %ctx.request_id,
            platform,
            email = %row.email,
            "routing request to upstream login"
        );
        ctx.metadata.insert(META_ROW.into(), row.id.clone());
        ctx.upstream_token = Some(row.access_token.clone());
        ctx.upstream_account_id = Some(row.account_id.clone());
        ctx.upstream_client_version = crate::forwarder::client_version_from_user_agent(&user_agent);
        ctx.upstream_user_agent = Some(user_agent);
        ctx.upstream_installation_id = Some(crate::forwarder::gateway_installation_id(
            &row.account_id,
            identity_platform,
        ));
        Ok(())
    }

    /// Writes one response to the log, the user's spend and the quota share.
    fn settle(
        &self,
        ready: &Arc<Ready>,
        ctx: &RequestContext,
        response: ResponseObservation,
        status: u16,
        transport_error: Option<&str>,
        client_left: bool,
    ) {
        let Some(owner) = ctx.metadata.get(META_OWNER).cloned() else {
            return;
        };
        let kind = classify_backend_kind(&ctx.target_path);
        let model = response
            .model
            .clone()
            .or_else(|| default_model_for_kind(kind))
            .unwrap_or_else(|| "codex-chatgpt".to_string());
        let tokens_info = response
            .usage
            .as_ref()
            .map(|u| u.tokens_info.clone())
            .unwrap_or_default();
        let cost = pricing::apply_service_tier(
            ready.pricing.estimate(Some(&model), &tokens_info),
            response.service_tier.as_deref(),
            Some(&model),
        );
        let charge = if kind.billable() {
            cost.unwrap_or_default()
        } else {
            Usd::ZERO
        };
        let status = response.status.unwrap_or(status);
        let success = (200..300).contains(&status);
        let (is_final, end_reason) = match response.terminal {
            Some(Terminal::Completed) => (true, Some("completed")),
            Some(Terminal::Incomplete) => (true, Some("incomplete")),
            Some(Terminal::Failed) => (false, Some("failed")),
            Some(Terminal::Cancelled) => (false, Some("cancelled")),
            None if !success => (false, None),
            None if client_left => (false, Some("client_aborted")),
            None if transport_error.is_some() => (false, Some("upstream_error")),
            None => (false, None),
        };
        let started_at = chrono::Utc::now()
            - chrono::Duration::from_std(response.started_at.elapsed()).unwrap_or_default();
        let settlement_id = uuid::Uuid::new_v4().to_string();
        let settlement = Settlement {
            settlement_id: settlement_id.clone(),
            intent_id: Some(ctx.request_id.clone()),
            owner_user_id: Some(owner.clone()),
            api_key_id: None,
            charge,
            is_final: Some(is_final),
            stream_end_reason: end_reason.map(str::to_string),
            path: ctx.target_path.clone(),
            model_id: Some(model),
            service_tier: response.service_tier.clone(),
            status_code: Some(status as i64),
            ttfb_ms: response.ttfb_ms.map(|v| v as i64),
            latency_ms: Some(response.started_at.elapsed().as_millis() as i64),
            tokens_info: Some(serde_json::Value::Object(tokens_info)),
            total_tokens: response
                .usage
                .as_ref()
                .and_then(|u| u.total_tokens)
                .map(|v| v as i64),
            cost,
            error_code: response.error_code.clone(),
            error_message: response
                .error_message
                .clone()
                .or_else(|| transport_error.map(str::to_string)),
            request_time: crate::db::iso(started_at),
        };
        let ready = ready.clone();
        let account_id = ctx.metadata.get(META_ACCOUNT).cloned();
        tokio::spawn(async move {
            if let Err(error) = ready.settlements.enqueue(settlement).await {
                warn!(%error, "failed to queue settlement");
            }
            if charge.0 > 0
                && let Some(account_id) = account_id
            {
                ready
                    .quota
                    .record(&settlement_id, &account_id, &owner, charge)
                    .await;
            }
        });
    }

    async fn settle_finished(&self, ctx: &RequestContext) {
        let finished = match ctx.observation.lock() {
            Ok(mut obs) => std::mem::take(&mut obs.finished),
            Err(_) => return,
        };
        if finished.is_empty() {
            return;
        }
        if let Ok(ready) = self.runtime.ready().await {
            for response in finished {
                self.settle(&ready, ctx, response, 200, None, false);
            }
        }
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
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid access token",
            )));
        };
        ctx.metadata
            .insert(META_PLATFORM.to_string(), platform.as_str().to_string());
        debug!(
            request_id = %ctx.request_id,
            method = %ctx.method,
            path = %ctx.path,
            platform = platform.as_str(),
            "CustomInterceptor: on_request hook"
        );

        if let Err(rejection) = self.admit(ctx, platform.as_str()).await {
            if let Ok(mut obs) = ctx.observation.lock() {
                obs.record_error(rejection.code, &rejection.message);
            }
            return Ok(RequestAction::ShortCircuit(rejection.response()));
        }

        let (mut parts, body) = req.into_parts();
        parts.headers.remove(PLATFORM_HEADER);
        Ok(RequestAction::Forward(Request::from_parts(parts, body)))
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
                obs.current.model.get_or_insert_with(|| model.to_string());
            }
        }
        Ok(resp)
    }

    fn on_response_chunk(&self, ctx: &RequestContext, chunk: &[u8]) {
        if let Ok(mut obs) = ctx.observation.lock() {
            obs.ingest_chunk(chunk);
        }
    }

    async fn on_ws_client_message(
        &self,
        ctx: &RequestContext,
        msg: WsMessage,
    ) -> Result<WsAction, Box<dyn std::error::Error + Send + Sync>> {
        let WsMessage::Text(text) = &msg else {
            return Ok(WsAction::Forward(msg));
        };
        let starts_response = match ctx.observation.lock() {
            Ok(mut obs) => obs.ingest_client_text(text).is_some_and(|value| {
                value.get("type").and_then(|t| t.as_str()) == Some("response.create")
            }),
            Err(_) => false,
        };
        if !starts_response {
            return Ok(WsAction::Forward(msg));
        }
        // Every turn re-checks the user: a long-lived socket must not
        // outlive a disable, a spent quota or an exhausted share.
        let (Some(owner), Ok(ready)) = (ctx.metadata.get(META_OWNER), self.runtime.ready().await)
        else {
            return Ok(WsAction::Forward(msg));
        };
        let mut rejection = self.owner_rejection(&ready, owner).await;
        if rejection.is_none()
            && classify_backend_kind(&ctx.target_path).billable()
            && let Some(account_id) = ctx.metadata.get(META_ACCOUNT)
        {
            rejection = Self::quota_rejection(&ready, account_id, owner).await;
        }
        let Some(rejection) = rejection else {
            return Ok(WsAction::Forward(msg));
        };
        if let Ok(mut obs) = ctx.observation.lock() {
            obs.record_error(rejection.code, &rejection.message);
            obs.current.status = Some(rejection.status.as_u16());
            obs.current.terminal = Some(Terminal::Failed);
            let refused = std::mem::replace(
                &mut obs.current,
                ResponseObservation::new(std::time::Instant::now()),
            );
            obs.finished.push(refused);
        }
        self.settle_finished(ctx).await;
        Ok(WsAction::Reply(rejection.ws_event()))
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
        self.settle_finished(ctx).await;
        Ok(WsAction::Forward(msg))
    }

    async fn on_upstream_unauthorized(&self, ctx: &mut RequestContext) -> bool {
        let (Some(row_id), Some(token)) = (
            ctx.metadata.get(META_ROW).cloned(),
            ctx.upstream_token.clone(),
        ) else {
            return false;
        };
        let Ok(ready) = self.runtime.ready().await else {
            return false;
        };
        match ready.accounts.refresh(&row_id, &token).await {
            Ok(row) if row.access_token != token => {
                ctx.upstream_token = Some(row.access_token);
                true
            }
            Ok(_) => false,
            Err(error) => {
                warn!(request_id = %ctx.request_id, %error, "upstream token refresh failed");
                false
            }
        }
    }

    async fn on_request_finish(
        &self,
        ctx: &RequestContext,
        status_code: Option<u16>,
        error: Option<&str>,
    ) {
        info!(
            request_id = %ctx.request_id,
            path = %ctx.path,
            platform = ctx.metadata.get(META_PLATFORM).map(String::as_str).unwrap_or(""),
            status = ?status_code,
            duration_ms = ctx.started_at.elapsed().as_millis(),
            error = ?error,
            "Request finished"
        );

        let (responses, websocket, client_left) = {
            let Ok(mut obs) = ctx.observation.lock() else {
                return;
            };
            if obs.settled {
                return;
            }
            obs.settled = true;
            obs.finish_body();
            let websocket = obs.websocket;
            let client_left = !websocket && !obs.upstream_complete && ctx.upstream_token.is_some();
            let mut responses = obs.take_all();
            if responses.is_empty() && !websocket {
                // Rejected before reaching upstream, or an empty body.
                responses.push(std::mem::replace(
                    &mut obs.current,
                    ResponseObservation::new(ctx.started_at),
                ));
            }
            (responses, websocket, client_left)
        };
        if !ctx.metadata.contains_key(META_OWNER) || responses.is_empty() {
            return;
        }
        let Ok(ready) = self.runtime.ready().await else {
            return;
        };
        let status = if websocket {
            200
        } else {
            status_code.unwrap_or(502)
        };
        for response in responses {
            self.settle(&ready, ctx, response, status, error, client_left);
        }
    }
}

fn default_model_for_kind(kind: BackendKind) -> Option<String> {
    match kind {
        BackendKind::Images => Some("gpt-image-2".to_string()),
        BackendKind::Search => Some("codex-search".to_string()),
        _ => None,
    }
}

pub(crate) fn auth_error(status: StatusCode, code: &str, message: &str) -> Response {
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
