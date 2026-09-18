use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ipc::ApiKeyRecord;

const DEVICE_TTL_SECS: u64 = 15 * 60;
const AUTH_CODE_TTL_SECS: u64 = 5 * 60;
const REFRESH_TTL_SECS: u64 = 30 * 24 * 60 * 60;
const DEVICE_INTERVAL_SECONDS: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssuedCodexClientTokens {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_auth_id: String,
    pub user_code: String,
    pub interval: String,
}

#[derive(Debug, Clone)]
struct DeviceAuthorization {
    code: String,
    code_challenge: String,
    code_verifier: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct DeviceSession {
    device_auth_id: String,
    user_code: String,
    expires_at_secs: u64,
    authorization: Option<DeviceAuthorization>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct AuthCodeSession {
    code: String,
    api_key: ApiKeyRecord,
    email: String,
    code_challenge: String,
    redirect_uri: String,
    expires_at_secs: u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct RefreshSession {
    refresh_token: String,
    api_key: ApiKeyRecord,
    email: String,
    expires_at_secs: u64,
}

#[derive(Debug, Clone)]
pub enum PollDeviceResult {
    Complete {
        authorization_code: String,
        code_challenge: String,
        code_verifier: String,
    },
    Pending,
    Unknown,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

pub fn random_token(bytes_count: usize) -> String {
    let mut bytes = vec![0u8; bytes_count];
    rand::thread_rng().fill(&mut bytes[..]);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn generate_user_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    let mut raw = String::with_capacity(8);
    for _ in 0..8 {
        let idx = rng.gen_range(0..ALPHABET.len());
        raw.push(ALPHABET[idx] as char);
    }
    format!("{}-{}", &raw[..4], &raw[4..])
}

pub fn create_pkce_pair() -> (String, String) {
    let code_verifier = random_token(48);
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let hash = hasher.finalize();
    let code_challenge = URL_SAFE_NO_PAD.encode(hash);
    (code_verifier, code_challenge)
}

pub fn verify_pkce(code_verifier: &str, code_challenge: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let hash = hasher.finalize();
    let expected = URL_SAFE_NO_PAD.encode(hash);
    // Timing safe compare
    if expected.len() != code_challenge.len() {
        return false;
    }
    expected
        .bytes()
        .zip(code_challenge.bytes())
        .fold(0, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub fn create_codex_id_token(api_key: &ApiKeyRecord, expires_at_secs: u64, email: &str) -> String {
    let account_id = api_key
        .owner_user_id
        .as_deref()
        .unwrap_or(&api_key.id);

    let header = serde_json::json!({ "alg": "none", "typ": "JWT" });
    let payload = serde_json::json!({
        "email": email,
        "exp": expires_at_secs,
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "pro",
            "chatgpt_user_id": account_id,
            "chatgpt_account_id": account_id
        }
    });

    let header_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&header).unwrap_or_default());
    let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap_or_default());
    format!("{header_b64}.{payload_b64}.")
}

pub struct CodexClientSessionStore {
    inner: RwLock<SessionState>,
}

struct SessionState {
    devices_by_id: HashMap<String, DeviceSession>,
    devices_by_user_code: HashMap<String, String>,
    auth_codes: HashMap<String, AuthCodeSession>,
    refresh_sessions: HashMap<String, RefreshSession>,
    token_cache: HashMap<String, ApiKeyRecord>,
}

impl CodexClientSessionStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(SessionState {
                devices_by_id: HashMap::new(),
                devices_by_user_code: HashMap::new(),
                auth_codes: HashMap::new(),
                refresh_sessions: HashMap::new(),
                token_cache: HashMap::new(),
            }),
        }
    }

    fn sweep_expired(state: &mut SessionState, ts: u64) {
        state.devices_by_id.retain(|_, s| s.expires_at_secs > ts);
        let valid_ids: std::collections::HashSet<_> = state.devices_by_id.keys().cloned().collect();
        state
            .devices_by_user_code
            .retain(|_, id| valid_ids.contains(id));
        state.auth_codes.retain(|_, s| s.expires_at_secs > ts);
        state.refresh_sessions.retain(|_, s| s.expires_at_secs > ts);
    }

    pub fn create_device_code(&self) -> DeviceCodeResponse {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let device_auth_id = random_token(18);
        let user_code = generate_user_code();

        let session = DeviceSession {
            device_auth_id: device_auth_id.clone(),
            user_code: user_code.clone(),
            expires_at_secs: ts + DEVICE_TTL_SECS,
            authorization: None,
        };

        state.devices_by_id.insert(device_auth_id.clone(), session);
        state
            .devices_by_user_code
            .insert(user_code.clone(), device_auth_id.clone());

        DeviceCodeResponse {
            device_auth_id,
            user_code,
            interval: DEVICE_INTERVAL_SECONDS.to_string(),
        }
    }

    pub fn poll_device_token(&self, device_auth_id: &str, user_code: &str) -> PollDeviceResult {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let device = match state.devices_by_id.get(device_auth_id.trim()) {
            Some(d) => d,
            None => return PollDeviceResult::Unknown,
        };

        if !device.user_code.eq_ignore_ascii_case(user_code.trim()) {
            return PollDeviceResult::Unknown;
        }

        match &device.authorization {
            Some(auth) => PollDeviceResult::Complete {
                authorization_code: auth.code.clone(),
                code_challenge: auth.code_challenge.clone(),
                code_verifier: auth.code_verifier.clone(),
            },
            None => PollDeviceResult::Pending,
        }
    }

    pub fn approve_device(
        &self,
        user_code: &str,
        api_key: ApiKeyRecord,
        email: &str,
    ) -> Result<(), String> {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let normalized = user_code.trim().to_uppercase();
        let device_auth_id = state
            .devices_by_user_code
            .get(&normalized)
            .cloned()
            .ok_or_else(|| "Invalid or expired device code".to_string())?;

        let (code_verifier, code_challenge) = create_pkce_pair();
        let code = random_token(32);

        if let Some(device) = state.devices_by_id.get_mut(&device_auth_id) {
            device.authorization = Some(DeviceAuthorization {
                code: code.clone(),
                code_challenge: code_challenge.clone(),
                code_verifier,
            });
        } else {
            return Err("Device code not found".to_string());
        }

        state.auth_codes.insert(
            code.clone(),
            AuthCodeSession {
                code,
                api_key: api_key.clone(),
                email: email.to_string(),
                code_challenge,
                redirect_uri: "/deviceauth/callback".to_string(),
                expires_at_secs: ts + AUTH_CODE_TTL_SECS,
            },
        );

        state.token_cache.insert(api_key.api_key.clone(), api_key);
        Ok(())
    }

    pub fn create_browser_authorization(
        &self,
        api_key: ApiKeyRecord,
        email: &str,
        code_challenge: &str,
        redirect_uri: &str,
    ) -> String {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let code = random_token(32);
        state.auth_codes.insert(
            code.clone(),
            AuthCodeSession {
                code: code.clone(),
                api_key: api_key.clone(),
                email: email.to_string(),
                code_challenge: code_challenge.to_string(),
                redirect_uri: redirect_uri.to_string(),
                expires_at_secs: ts + AUTH_CODE_TTL_SECS,
            },
        );

        state.token_cache.insert(api_key.api_key.clone(), api_key);
        code
    }

    pub fn exchange_authorization_code(
        &self,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
    ) -> Option<IssuedCodexClientTokens> {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let session = state.auth_codes.remove(code.trim())?;
        if session.redirect_uri != redirect_uri {
            return None;
        }

        if !verify_pkce(code_verifier, &session.code_challenge) {
            return None;
        }

        Some(Self::issue_tokens_internal(
            &mut state,
            session.api_key,
            &session.email,
            ts,
        ))
    }

    pub fn refresh(&self, refresh_token: &str) -> Option<IssuedCodexClientTokens> {
        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);

        let session = state.refresh_sessions.remove(refresh_token.trim())?;
        Some(Self::issue_tokens_internal(
            &mut state,
            session.api_key,
            &session.email,
            ts,
        ))
    }

    pub fn revoke(&self, token: &str) {
        let mut state = self.inner.write().unwrap();
        let normalized = token.trim();
        state.refresh_sessions.remove(normalized);
        state.auth_codes.retain(|_, s| s.api_key.api_key != normalized);
        state.token_cache.remove(normalized);
    }

    pub fn get_cached_api_key(&self, token: &str) -> Option<ApiKeyRecord> {
        let state = self.inner.read().unwrap();
        state.token_cache.get(token.trim()).cloned()
    }

    pub fn cache_api_key(&self, api_key: ApiKeyRecord) {
        let mut state = self.inner.write().unwrap();
        state.token_cache.insert(api_key.api_key.clone(), api_key);
    }

    fn issue_tokens_internal(
        state: &mut SessionState,
        api_key: ApiKeyRecord,
        email: &str,
        ts: u64,
    ) -> IssuedCodexClientTokens {
        let expires_at_secs = ts + 10 * 24 * 60 * 60;
        let refresh_token = random_token(32);

        state.refresh_sessions.insert(
            refresh_token.clone(),
            RefreshSession {
                refresh_token: refresh_token.clone(),
                api_key: api_key.clone(),
                email: email.to_string(),
                expires_at_secs: ts + REFRESH_TTL_SECS,
            },
        );

        state
            .token_cache
            .insert(api_key.api_key.clone(), api_key.clone());

        IssuedCodexClientTokens {
            id_token: create_codex_id_token(&api_key, expires_at_secs, email),
            access_token: api_key.api_key,
            refresh_token,
        }
    }
}
