//! Calls the gateway itself makes to OpenAI: token refresh, device login,
//! usage reads and the console's account test.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::identity::{CLI_ORIGINATOR, VersionResolver, os_profile, user_agent_for_platform};

pub const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

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

/// The account and tokens learned from a finished OpenAI login.
pub struct CompletedLogin {
    pub email: String,
    pub account_id: String,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}

/// Everything the console shows to start a browser OAuth login and finish it.
/// The verifier and state are handed back to the caller for the exchange, the
/// way a PKCE public client (the browser here) holds them.
pub struct OAuthStart {
    pub authorize_url: String,
    pub code_verifier: String,
    pub state: String,
    pub redirect_uri: String,
}

/// The browser redirect Codex registers for its OAuth client; the console
/// shows it to the admin, who pastes back the `code` it receives.
pub const CODEX_OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
/// The scope the Codex CLI requests, so the login looks identical upstream.
const CODEX_OAUTH_SCOPE: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";

/// The opaque routing token upstream issues with a Responses turn; Codex
/// replays it on the turns that follow.
pub const TURN_STATE_HEADER: &str = "x-codex-turn-state";

/// What a Responses request answered with.
pub struct ResponsesReply {
    pub status: u16,
    /// The turn state upstream issued, when the response carried one.
    pub turn_state: Option<String>,
    pub body: String,
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
    /// Shared with the proxy path so every chatgpt.com call the gateway makes
    /// for a login carries that login's infrastructure cookies, the way one
    /// Codex process shares one cookie jar.
    pub cookies: Arc<super::cookies::CookieJars>,
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
    // The cause chain is where the useful part lives: reqwest's own Display
    // is just "error sending request", while the source says whether the
    // connection timed out or a proxy refused the tunnel.
    let mut message = format!("{endpoint}: {error}");
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&error);
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    UpstreamError::new(None, message)
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

    /// The authorization URL the admin opens to log an upstream account in,
    /// identical to what the Codex CLI builds, plus the PKCE verifier and
    /// state to finish the exchange with.
    pub fn oauth_authorize_url(&self, platform: &str) -> OAuthStart {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use rand::RngCore;
        use sha2::{Digest, Sha256};

        let mut verifier_bytes = [0u8; 64];
        rand::thread_rng().fill_bytes(&mut verifier_bytes);
        let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        let mut state_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut state_bytes);
        let state = URL_SAFE_NO_PAD.encode(state_bytes);

        let mut url = url::Url::parse(&format!("{}/oauth/authorize", self.auth_origin))
            .expect("auth origin is validated at startup");
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CODEX_OAUTH_CLIENT_ID)
            .append_pair("redirect_uri", CODEX_OAUTH_REDIRECT_URI)
            .append_pair("code_challenge", &code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("scope", CODEX_OAUTH_SCOPE)
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true")
            .append_pair("originator", CLI_ORIGINATOR);
        // The platform decides the User-Agent, not the authorize URL, but
        // keep it so a caller can log which login this belongs to.
        let _ = platform;
        OAuthStart {
            authorize_url: url.to_string(),
            code_verifier,
            state,
            redirect_uri: CODEX_OAUTH_REDIRECT_URI.to_string(),
        }
    }

    /// Finishes a browser OAuth login: exchanges the pasted code for tokens.
    pub async fn exchange_oauth_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        platform: &str,
    ) -> Result<CompletedLogin, UpstreamError> {
        self.exchange_authorization_code(
            code.trim(),
            code_verifier.trim(),
            redirect_uri,
            &self.user_agent(platform),
        )
        .await
    }

    /// Trades an authorization code for tokens and reads the account out of
    /// the returned ID token.
    async fn exchange_authorization_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        user_agent: &str,
    ) -> Result<CompletedLogin, UpstreamError> {
        let response = self
            .http
            .post(format!("{}/oauth/token", self.auth_origin))
            .timeout(Duration::from_secs(15))
            .header("Accept", "application/json")
            .header("User-Agent", user_agent)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", CODEX_OAUTH_CLIENT_ID),
                ("code_verifier", code_verifier),
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
        Ok(CompletedLogin {
            email,
            account_id,
            id_token,
            access_token,
            refresh_token,
        })
    }

    /// Attaches the login's cookies to a chatgpt.com request the way the
    /// client would.
    fn with_cookies(
        &self,
        mut request: reqwest::RequestBuilder,
        credentials: &Credentials<'_>,
        url: &str,
    ) -> reqwest::RequestBuilder {
        if let Ok(parsed) = url::Url::parse(url)
            && let Some(cookie) =
                self.cookies
                    .cookie_header(credentials.account_id, credentials.platform, &parsed)
            && let Ok(value) = cookie.to_str()
        {
            request = request.header("Cookie", value.to_string());
        }
        request
    }

    async fn get_json(
        &self,
        url: String,
        endpoint: &str,
        credentials: &Credentials<'_>,
        headers: Vec<(&'static str, String)>,
    ) -> Result<Value, UpstreamError> {
        let mut request = self.http.get(&url).timeout(Duration::from_secs(10));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        request = self.with_cookies(request, credentials, &url);
        let response = request.send().await.map_err(|e| transport(e, endpoint))?;
        if let Ok(parsed) = url::Url::parse(&url) {
            self.cookies.store(
                credentials.account_id,
                credentials.platform,
                &parsed,
                response.headers(),
            );
        }
        let payload = read_json(response, endpoint).await?;
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
            credentials,
            vec![
                // The CLI's own usage read carries no `originator`.
                ("User-Agent", self.user_agent(credentials.platform)),
                (
                    "Authorization",
                    format!("Bearer {}", credentials.access_token),
                ),
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
            credentials,
            vec![
                ("Accept", "application/json".to_string()),
                (
                    "Authorization",
                    format!("Bearer {}", credentials.access_token),
                ),
                ("OpenAI-Beta", "codex-1".to_string()),
                ("originator", CLI_ORIGINATOR.to_string()),
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
        let reply = self
            .post_responses_with(&self.http, credentials, payload)
            .await?;
        Ok((reply.status, reply.body))
    }

    /// The same request over a caller-supplied client, so a turn-state probe
    /// can leave through its own proxy. The turn state upstream issued comes
    /// back with it.
    pub async fn post_responses_with(
        &self,
        http: &reqwest::Client,
        credentials: &Credentials<'_>,
        payload: &Value,
    ) -> Result<ResponsesReply, UpstreamError> {
        let body = zstd::encode_all(payload.to_string().as_bytes(), 3)
            .map_err(|e| UpstreamError::new(None, e.to_string()))?;
        let url = format!("{}/backend-api/codex/responses", self.chatgpt_origin);
        let mut request = http
            .post(&url)
            .timeout(Duration::from_secs(300))
            .header(
                "Authorization",
                format!("Bearer {}", credentials.access_token),
            )
            .header("originator", CLI_ORIGINATOR)
            .header("session-id", uuid::Uuid::new_v4().to_string())
            .header("version", self.versions.version())
            .header(
                "x-codex-turn-metadata",
                json!({ "turn_id": uuid::Uuid::new_v4().to_string(), "sandbox": os_profile(credentials.platform).sandbox })
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
        request = self.with_cookies(request, credentials, &url);
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|e| transport(e, "/backend-api/codex/responses"))?;
        if let Ok(parsed) = url::Url::parse(&url) {
            self.cookies.store(
                credentials.account_id,
                credentials.platform,
                &parsed,
                response.headers(),
            );
        }
        let status = response.status().as_u16();
        let turn_state = response
            .headers()
            .get(TURN_STATE_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
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
        Ok(ResponsesReply {
            status,
            turn_state,
            body: text,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> UpstreamClient {
        let http = reqwest::Client::new();
        UpstreamClient {
            http: http.clone(),
            chatgpt_origin: "https://chatgpt.com".to_string(),
            auth_origin: "https://auth.openai.com".to_string(),
            versions: std::sync::Arc::new(VersionResolver::from_env(http).unwrap()),
            cookies: std::sync::Arc::new(super::super::cookies::CookieJars::from_env().unwrap()),
        }
    }

    #[test]
    fn authorize_url_matches_the_codex_oauth_shape() {
        use base64::Engine;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use sha2::{Digest, Sha256};

        let start = client().oauth_authorize_url("windows");
        let url = url::Url::parse(&start.authorize_url).unwrap();
        assert_eq!(url.path(), "/oauth/authorize");
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["response_type"], "code");
        assert_eq!(query["client_id"], CODEX_OAUTH_CLIENT_ID);
        assert_eq!(query["redirect_uri"], CODEX_OAUTH_REDIRECT_URI);
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["codex_cli_simplified_flow"], "true");
        assert_eq!(query["id_token_add_organizations"], "true");
        assert_eq!(query["scope"], CODEX_OAUTH_SCOPE);
        assert_eq!(query["state"], start.state);
        // The challenge is the S256 hash of the verifier handed back.
        let expected = URL_SAFE_NO_PAD.encode(Sha256::digest(start.code_verifier.as_bytes()));
        assert_eq!(query["code_challenge"], expected);
        // Two starts never share a verifier.
        assert_ne!(
            start.code_verifier,
            client().oauth_authorize_url("windows").code_verifier
        );
    }
}
