use super::observe::{BackendKind, ResponseObservation, Terminal, classify_backend_kind};
use super::platform::detect_platform;
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
    egress_locale: Arc<crate::egress_locale::EgressLocaleResolver>,
}

impl CustomInterceptor {
    pub fn new(
        runtime: Arc<Runtime>,
        egress_locale: Arc<crate::egress_locale::EgressLocaleResolver>,
    ) -> Self {
        Self {
            runtime,
            egress_locale,
        }
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
    ///
    /// `platform` is `None` for requests Codex sends without a User-Agent:
    /// they carry nothing that depends on the device, so any of the
    /// account's logins serves them.
    async fn admit(
        &self,
        ctx: &mut RequestContext,
        platform: Option<&str>,
    ) -> Result<(), Rejection> {
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
        let client_user_id = claims.openai_auth.chatgpt_user_id.clone();
        let client_email = claims
            .openai_profile
            .as_ref()
            .map(|profile| profile.email.clone())
            .unwrap_or_default();
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

        let resolved = match platform {
            Some(platform) => ready.accounts.resolve(&account_id, platform).await,
            None => ready.accounts.resolve_any(&account_id).await,
        };
        let row = match resolved {
            Ok(Some(row)) => row,
            Ok(None) => {
                return Err(Rejection::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "upstream_account_unavailable",
                    format!(
                        "No upstream login for platform '{}'",
                        platform.unwrap_or("any")
                    ),
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
        let identity_platform = match (row.platform(), platform) {
            ("all", Some(platform)) => platform,
            (row_platform, _) => row_platform,
        };
        ctx.metadata
            .insert(META_PLATFORM.to_string(), identity_platform.to_string());
        info!(
            request_id = %ctx.request_id,
            platform = identity_platform,
            email = %row.email,
            "routing request to upstream login"
        );
        ctx.metadata.insert(META_ROW.into(), row.id.clone());
        ctx.upstream_token = Some(row.access_token.clone());
        ctx.upstream_account_id = Some(row.account_id.clone());
        ctx.upstream_client_version = Some(ready.accounts.client.versions.version());
        ctx.upstream_installation_id = Some(crate::client_identity::gateway_installation_id(
            &row.account_id,
            identity_platform,
        ));
        ctx.upstream_platform =
            Some(crate::upstream::identity::platform_family(identity_platform).to_string());
        // The conversation's timezone and date follow the gateway's egress
        // IP, not the user's machine.
        let (timezone, current_date) = self.egress_locale.snapshot();
        ctx.presented_timezone = Some(timezone);
        ctx.presented_current_date = Some(current_date);
        let (upstream_user_id, token_email) = upstream_token_identity(&row);
        ctx.identity_swap = vec![
            (upstream_user_id, client_user_id),
            (row.account_id.clone(), owner),
            (token_email, client_email.clone()),
            (row.email.clone(), client_email),
        ];
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
        // Billing follows the completed model; without a completed event, the
        // requested one.
        let requested_model = response.requested_model.clone();
        let used_model = response.completed_model.clone();
        let model = used_model
            .clone()
            .or_else(|| requested_model.clone())
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
            requested_model,
            used_model,
            turn_state_len: response.turn_state_len.map(|len| len as i64),
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

/// The login's ChatGPT user id (`user-…`) and email as its ID token states
/// them (the access token as a fallback).
fn upstream_token_identity(row: &crate::db::accounts::Account) -> (String, String) {
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let claims: Vec<serde_json::Value> = [&row.id_token, &row.access_token]
        .into_iter()
        .filter_map(|token| token.split('.').nth(1))
        .filter_map(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect();
    let first = |read: &dyn Fn(&serde_json::Value) -> Option<&str>| {
        claims
            .iter()
            .find_map(|claims| read(claims).filter(|value| !value.is_empty()))
            .unwrap_or_default()
            .to_string()
    };
    let user_id = first(&|claims| {
        let auth = &claims["https://api.openai.com/auth"];
        auth["chatgpt_user_id"]
            .as_str()
            .or_else(|| auth["user_id"].as_str())
    });
    let email = first(&|claims| {
        claims["email"]
            .as_str()
            .or_else(|| claims["https://api.openai.com/profile"]["email"].as_str())
    });
    (user_id, email)
}

/// The ChatGPT MCP endpoint without an `Authorization` header: Codex sends
/// its session setup this way, and nothing in it identifies the user.
fn is_unauthenticated_mcp(path: &str, headers: &http::HeaderMap) -> bool {
    path.trim_end_matches('/').ends_with("/ps/mcp")
        && !headers.contains_key(http::header::AUTHORIZATION)
}

#[async_trait]
impl Interceptor for CustomInterceptor {
    async fn on_request(
        &self,
        ctx: &mut RequestContext,
        req: Request<Body>,
    ) -> Result<RequestAction, Box<dyn std::error::Error + Send + Sync>> {
        // Codex opens the ChatGPT MCP session without credentials; a
        // genuine client's request reaches upstream just like that.
        if is_unauthenticated_mcp(&ctx.target_path, req.headers()) {
            if let Ok(ready) = self.runtime.ready().await {
                ctx.upstream_client_version = Some(ready.accounts.client.versions.version());
            }
            debug!(request_id = %ctx.request_id, "forwarding unauthenticated MCP request");
            return Ok(RequestAction::Forward(req));
        }

        // A few Codex requests carry no User-Agent at all; anything else
        // must identify its OS.
        let platform = match detect_platform(req.headers()) {
            Some(platform) => Some(platform.as_str()),
            None if !req.headers().contains_key(http::header::USER_AGENT) => None,
            None => {
                return Ok(RequestAction::ShortCircuit(auth_error(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Invalid access token",
                )));
            }
        };
        if let Some(platform) = platform {
            ctx.metadata
                .insert(META_PLATFORM.to_string(), platform.to_string());
        }
        debug!(
            request_id = %ctx.request_id,
            method = %ctx.method,
            path = %ctx.path,
            platform = platform.unwrap_or(""),
            "CustomInterceptor: on_request hook"
        );

        if let Err(rejection) = self.admit(ctx, platform).await {
            if let Ok(mut obs) = ctx.observation.lock() {
                obs.record_error(rejection.code, &rejection.message);
            }
            return Ok(RequestAction::ShortCircuit(rejection.response()));
        }

        // The requested model of an HTTP response is only in the request; the
        // routing hint carries it (a WebSocket turn brings its own).
        if let Some(model) = routing_hint_model(req.headers())
            && let Ok(mut obs) = ctx.observation.lock()
        {
            obs.set_requested_model(model);
        }

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
            // The upstream `openai-model` header names the model that served
            // the request, the used model even for a header-only response.
            if let Some(model) = resp
                .headers()
                .get("openai-model")
                .and_then(|v| v.to_str().ok())
                && !model.is_empty()
            {
                obs.current
                    .completed_model
                    .get_or_insert_with(|| model.to_string());
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

        // Only usage endpoints (Responses, Images, Search) are logged and
        // settled. Housekeeping traffic — analytics events, plugins, models,
        // the MCP handshake, usage polls — carries no model or tokens and
        // must not fill the request log.
        if classify_backend_kind(&ctx.target_path) == BackendKind::Passthrough {
            return;
        }

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

/// The model in a `x-codex-routing-hint: model=<m>[;tier=<t>]` request
/// header, which Codex sends on every Responses request.
fn routing_hint_model(headers: &http::HeaderMap) -> Option<&str> {
    headers
        .get("x-codex-routing-hint")
        .and_then(|value| value.to_str().ok())
        .and_then(|hint| {
            hint.split(';').find_map(|part| {
                part.trim()
                    .strip_prefix("model=")
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
            })
        })
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
