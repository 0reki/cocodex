//! Calls the gateway itself makes to OpenAI: token refresh, device login,
//! usage reads and the console's account test.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::identity::{VersionResolver, user_agent_for_platform};

pub const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";
const DEFAULT_SANDBOX: &str = "windows_elevated";

#[derive(Debug, Clone)]
pub struct UpstreamError {
    pub status: Option<u16>,
    pub message: String,
}

impl UpstreamError {
    fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// The access token was rejected; a refresh may help.
    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }
}

impl std::fmt::Display for UpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub struct RefreshedTokens {
    pub id_token: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
}

pub struct DeviceCode {
    pub device_auth_id: String,
    pub user_code: String,
    pub verification_url: String,
    pub interval_seconds: u64,
    pub expires_in_seconds: u64,
}

pub enum DevicePoll {
    Pending,
    Complete {
        email: String,
        account_id: String,
        id_token: String,
        access_token: String,
        refresh_token: String,
    },
}

/// The account a call is made on behalf of.
pub struct Credentials<'a> {
    pub access_token: &'a str,
    pub account_id: &'a str,
    pub platform: &'a str,
}

pub struct UpstreamClient {
    pub http: reqwest::Client,
    pub chatgpt_origin: String,
    pub auth_origin: String,
    pub versions: Arc<VersionResolver>,
}

fn truncate(text: &str) -> String {
    text.chars().take(500).collect()
}

async fn read_json(response: reqwest::Response, endpoint: &str) -> Result<Value, UpstreamError> {
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| UpstreamError::new(Some(status), format!("{endpoint}: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(UpstreamError::new(
            Some(status),
            format!("{endpoint} HTTP {status}: {}", truncate(&text)),
        ));
    }
    serde_json::from_str(&text)
        .map_err(|_| UpstreamError::new(Some(status), format!("Invalid JSON from {endpoint}")))
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn transport(error: reqwest::Error, endpoint: &str) -> UpstreamError {
    UpstreamError::new(None, format!("{endpoint}: {error}"))
}

impl UpstreamClient {
    pub fn user_agent(&self, platform: &str) -> String {
        user_agent_for_platform(platform, &self.versions.version())
    }

    pub async fn refresh_tokens(
        &self,
        refresh_token: &str,
        platform: &str,
    ) -> Result<RefreshedTokens, UpstreamError> {
        let response = self
            .http
            .post(format!("{}/oauth/token", self.auth_origin))
            .timeout(Duration::from_secs(15))
            .header("Accept", "application/json")
            .header("User-Agent", self.user_agent(platform))
            .json(&json!({
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token.trim(),
            }))
            .send()
            .await
            .map_err(|e| transport(e, "/oauth/token"))?;
        let payload = read_json(response, "/oauth/token").await?;
        let access_token = string_field(&payload, "access_token");
        if access_token.is_empty() {
            return Err(UpstreamError::new(
                None,
                "Access token refresh returned no access token",
            ));
        }
        let optional = |key: &str| Some(string_field(&payload, key)).filter(|v| !v.is_empty());
        Ok(RefreshedTokens {
            id_token: optional("id_token"),
            access_token,
            refresh_token: optional("refresh_token"),
        })
    }

    pub async fn request_device_code(&self, platform: &str) -> Result<DeviceCode, UpstreamError> {
        let response = self
            .http
            .post(format!(
                "{}/api/accounts/deviceauth/usercode",
                self.auth_origin
            ))
            .timeout(Duration::from_secs(15))
            .header("Accept", "application/json")
            .header("User-Agent", self.user_agent(platform))
            .json(&json!({ "client_id": CODEX_OAUTH_CLIENT_ID }))
            .send()
            .await
            .map_err(|e| transport(e, "/deviceauth/usercode"))?;
        if response.status().as_u16() == 404 {
            return Err(UpstreamError::new(
                Some(404),
                "Device code login is not enabled for this ChatGPT account or workspace",
            ));
        }
        let payload = read_json(response, "/deviceauth/usercode").await?;
        let device_auth_id = string_field(&payload, "device_auth_id");
        let user_code = Some(string_field(&payload, "user_code"))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| string_field(&payload, "usercode"));
        if device_auth_id.is_empty() || user_code.is_empty() {
            return Err(UpstreamError::new(
                None,
                "Invalid device code response from OpenAI",
            ));
        }
        let interval = payload
            .get("interval")
            .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v.trunc() as u64)
            .unwrap_or(5);
        Ok(DeviceCode {
            device_auth_id,
            user_code,
            verification_url: format!("{}/codex/device", self.auth_origin),
            interval_seconds: interval,
            expires_in_seconds: 15 * 60,
        })
    }

    pub async fn poll_device(
        &self,
        device_auth_id: &str,
        user_code: &str,
        platform: &str,
    ) -> Result<DevicePoll, UpstreamError> {
        let user_agent = self.user_agent(platform);
        let response = self
            .http
            .post(format!(
                "{}/api/accounts/deviceauth/token",
                self.auth_origin
            ))
            .timeout(Duration::from_secs(15))
            .header("Accept", "application/json")
            .header("User-Agent", &user_agent)
            .json(&json!({ "device_auth_id": device_auth_id, "user_code": user_code }))
            .send()
            .await
            .map_err(|e| transport(e, "/deviceauth/token"))?;
        if matches!(response.status().as_u16(), 403 | 404) {
            return Ok(DevicePoll::Pending);
        }
        let code = read_json(response, "/deviceauth/token").await?;
        let authorization_code = string_field(&code, "authorization_code");
        let code_verifier = string_field(&code, "code_verifier");
        if authorization_code.is_empty() || code_verifier.is_empty() {
            return Err(UpstreamError::new(
                None,
                "Invalid device authorization response from OpenAI",
            ));
        }

        let response = self
            .http
            .post(format!("{}/oauth/token", self.auth_origin))
            .timeout(Duration::from_secs(15))
            .header("Accept", "application/json")
            .header("User-Agent", &user_agent)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", authorization_code.as_str()),
                (
                    "redirect_uri",
                    &format!("{}/deviceauth/callback", self.auth_origin),
                ),
                ("client_id", CODEX_OAUTH_CLIENT_ID),
                ("code_verifier", code_verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|e| transport(e, "/oauth/token"))?;
        let tokens = read_json(response, "/oauth/token").await?;
        let id_token = string_field(&tokens, "id_token");
        let access_token = string_field(&tokens, "access_token");
        let refresh_token = string_field(&tokens, "refresh_token");
        if id_token.is_empty() || access_token.is_empty() || refresh_token.is_empty() {
            return Err(UpstreamError::new(
                None,
                "OpenAI token response is incomplete",
            ));
        }

        let claims = id_token
            .split('.')
            .nth(1)
            .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or_else(|| UpstreamError::new(None, "Invalid ID token returned by OpenAI"))?;
        let email = Some(string_field(&claims, "email"))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| string_field(&claims["https://api.openai.com/profile"], "email"));
        let account_id = Some(string_field(
            &claims["https://api.openai.com/auth"],
            "chatgpt_account_id",
        ))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| string_field(&claims, "chatgpt_account_id"));
        if email.is_empty() || account_id.is_empty() {
            return Err(UpstreamError::new(
                None,
                "OpenAI ID token is missing account information",
            ));
        }
        Ok(DevicePoll::Complete {
            email,
            account_id,
            id_token,
            access_token,
            refresh_token,
        })
    }

    async fn get_json(
        &self,
        url: String,
        endpoint: &str,
        headers: Vec<(&'static str, String)>,
    ) -> Result<Value, UpstreamError> {
        let mut request = self.http.get(url).timeout(Duration::from_secs(10));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let payload = read_json(
            request.send().await.map_err(|e| transport(e, endpoint))?,
            endpoint,
        )
        .await?;
        if !payload.is_object() {
            return Err(UpstreamError::new(
                None,
                format!("Invalid JSON from {endpoint}: response is not a JSON object"),
            ));
        }
        Ok(payload)
    }

    /// `/backend-api/wham/usage`: plan and rate-limit windows.
    pub async fn usage(&self, credentials: &Credentials<'_>) -> Result<Value, UpstreamError> {
        self.get_json(
            format!("{}/backend-api/wham/usage", self.chatgpt_origin),
            "/backend-api/wham/usage",
            vec![
                (
                    "Authorization",
                    format!("Bearer {}", credentials.access_token),
                ),
                ("originator", DEFAULT_ORIGINATOR.to_string()),
                ("User-Agent", self.user_agent(credentials.platform)),
                ("ChatGPT-Account-Id", credentials.account_id.to_string()),
            ],
        )
        .await
    }

    pub async fn daily_usage(
        &self,
        credentials: &Credentials<'_>,
        start_date: &str,
        end_date: &str,
    ) -> Result<Value, UpstreamError> {
        let path = "/backend-api/wham/analytics/daily-workspace-usage-counts";
        let mut url = url::Url::parse(&format!("{}{path}", self.chatgpt_origin))
            .map_err(|e| UpstreamError::new(None, e.to_string()))?;
        url.query_pairs_mut()
            .append_pair("start_date", start_date)
            .append_pair("end_date", end_date)
            .append_pair("group_by", "day")
            .append_pair("workspace_user", "true");
        self.get_json(
            url.to_string(),
            path,
            vec![
                ("Accept", "application/json".to_string()),
                (
                    "Authorization",
                    format!("Bearer {}", credentials.access_token),
                ),
                ("OpenAI-Beta", "codex-1".to_string()),
                ("originator", "codex-tui".to_string()),
                ("User-Agent", self.user_agent(credentials.platform)),
                ("version", self.versions.version()),
                ("ChatGPT-Account-Id", credentials.account_id.to_string()),
            ],
        )
        .await
    }

    /// A streamed Responses request sent like the Codex CLI would.
    /// Returns the status and the full SSE body.
    pub async fn post_responses(
        &self,
        credentials: &Credentials<'_>,
        payload: &Value,
    ) -> Result<(u16, String), UpstreamError> {
        let body = zstd::encode_all(payload.to_string().as_bytes(), 3)
            .map_err(|e| UpstreamError::new(None, e.to_string()))?;
        let mut request = self
            .http
            .post(format!(
                "{}/backend-api/codex/responses",
                self.chatgpt_origin
            ))
            .timeout(Duration::from_secs(300))
            .header(
                "Authorization",
                format!("Bearer {}", credentials.access_token),
            )
            .header("originator", DEFAULT_ORIGINATOR)
            .header("session-id", uuid::Uuid::new_v4().to_string())
            .header("version", self.versions.version())
            .header(
                "x-codex-turn-metadata",
                json!({ "turn_id": uuid::Uuid::new_v4().to_string(), "sandbox": DEFAULT_SANDBOX })
                    .to_string(),
            )
            .header("User-Agent", self.user_agent(credentials.platform))
            .header("chatgpt-account-id", credentials.account_id)
            .header("accept", "text/event-stream")
            .header("content-type", "application/json")
            .header("content-encoding", "zstd");
        if let Some(model) = payload.get("model").and_then(Value::as_str) {
            let hint = match payload.get("service_tier").and_then(Value::as_str) {
                Some(tier) if !tier.trim().is_empty() => {
                    format!("model={model};tier={}", tier.trim())
                }
                _ => format!("model={model}"),
            };
            request = request.header("x-codex-routing-hint", hint);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|e| transport(e, "/backend-api/codex/responses"))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|e| transport(e, "/backend-api/codex/responses"))?;
        if status == 401 {
            return Err(UpstreamError::new(
                Some(401),
                format!("HTTP 401: {}", truncate(&text)),
            ));
        }
        Ok((status, text))
    }
}
