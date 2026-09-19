use std::collections::HashMap;
use std::sync::RwLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::warn;

use super::jwt::{gateway_account_id, now_secs, ClientJwt, ACCESS_TTL_SECS};
use crate::ipc::IpcClient;

const DEVICE_TTL_SECS: u64 = 15 * 60;
const AUTH_CODE_TTL_SECS: u64 = 5 * 60;
pub const REFRESH_TTL_SECS: u64 = 30 * 24 * 60 * 60;
const DEVICE_INTERVAL_SECONDS: u64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IssuedCodexClientTokens {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: String,
    pub token_type: String,
    pub expires_in: u64,
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
    owner_user_id: String,
    email: String,
    code_challenge: String,
    redirect_uri: String,
    expires_at_secs: u64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct RefreshSession {
    refresh_token: String,
    owner_user_id: String,
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

pub fn random_token(bytes_count: usize) -> String {
    let mut bytes = vec![0u8; bytes_count];
    rand::thread_rng().fill(&mut bytes[..]);
    URL_SAFE_NO_PAD.encode(&bytes)
}

pub fn issue_refresh_token() -> String {
    format!("rt.1.{}", random_token(72))
}

pub fn hash_refresh_token(token: &str) -> String {
    Sha256::digest(token.trim().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
    if expected.len() != code_challenge.len() {
        return false;
    }
    expected
        .bytes()
        .zip(code_challenge.bytes())
        .fold(0, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub struct CodexClientSessionStore {
    jwt: ClientJwt,
    ipc: Option<IpcClient>,
    inner: RwLock<SessionState>,
}

struct SessionState {
    devices_by_id: HashMap<String, DeviceSession>,
    devices_by_user_code: HashMap<String, String>,
    auth_codes: HashMap<String, AuthCodeSession>,
    refresh_sessions: HashMap<String, RefreshSession>,
}

impl CodexClientSessionStore {
    pub fn new() -> Self {
        Self::with_jwt(ClientJwt::from_env())
    }

    pub fn with_jwt(jwt: ClientJwt) -> Self {
        Self {
            jwt,
            ipc: None,
            inner: RwLock::new(SessionState {
                devices_by_id: HashMap::new(),
                devices_by_user_code: HashMap::new(),
                auth_codes: HashMap::new(),
                refresh_sessions: HashMap::new(),
            }),
        }
    }

    pub fn with_jwt_and_ipc(jwt: ClientJwt, ipc: IpcClient) -> Self {
        Self {
            jwt,
            ipc: Some(ipc),
            inner: RwLock::new(SessionState {
                devices_by_id: HashMap::new(),
                devices_by_user_code: HashMap::new(),
                auth_codes: HashMap::new(),
                refresh_sessions: HashMap::new(),
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
        owner_user_id: String,
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
                owner_user_id,
                email: email.to_string(),
                code_challenge,
                redirect_uri: "/deviceauth/callback".to_string(),
                expires_at_secs: ts + AUTH_CODE_TTL_SECS,
            },
        );

        Ok(())
    }

    pub fn create_browser_authorization(
        &self,
        owner_user_id: String,
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
                owner_user_id,
                email: email.to_string(),
                code_challenge: code_challenge.to_string(),
                redirect_uri: redirect_uri.to_string(),
                expires_at_secs: ts + AUTH_CODE_TTL_SECS,
            },
        );

        code
    }

    pub async fn exchange_authorization_code(
        &self,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
    ) -> Option<IssuedCodexClientTokens> {
        let session = {
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
            session
        };

        self.issue_tokens(&session.owner_user_id, &session.email).await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Option<IssuedCodexClientTokens> {
        let token = refresh_token.trim();
        if token.is_empty() {
            return None;
        }
        let session = self.consume_refresh_session(token).await?;
        self.issue_tokens(&session.owner_user_id, &session.email).await
    }

    pub async fn revoke(&self, token: &str) {
        let normalized = token.trim();
        if normalized.is_empty() {
            return;
        }

        if let Some(ipc) = &self.ipc {
            let token_hash = hash_refresh_token(normalized);
            if let Err(error) = ipc.revoke_refresh_token(Some(&token_hash), None).await {
                warn!(error = %error, "failed to revoke refresh token via IPC");
            }
            if let Ok(claims) = self.jwt.verify_access_token(normalized) {
                let owner = claims.openai_auth.chatgpt_account_id.trim();
                if !owner.is_empty() {
                    if let Err(error) = ipc.revoke_refresh_token(None, Some(owner)).await {
                        warn!(error = %error, "failed to revoke refresh tokens for owner via IPC");
                    }
                }
            }
            return;
        }

        let mut state = self.inner.write().unwrap();
        state.refresh_sessions.remove(normalized);
        if let Ok(claims) = self.jwt.verify_access_token(normalized) {
            let owner = claims.openai_auth.chatgpt_account_id;
            state.refresh_sessions.retain(|_, session| {
                gateway_account_id(&session.owner_user_id) != owner
            });
        }
    }

    async fn consume_refresh_session(&self, refresh_token: &str) -> Option<RefreshSession> {
        if let Some(ipc) = &self.ipc {
            match ipc.consume_refresh_token(&hash_refresh_token(refresh_token)).await {
                Ok(Some(record)) => {
                    return Some(RefreshSession {
                        refresh_token: refresh_token.to_string(),
                        owner_user_id: record.owner_user_id,
                        email: record.email,
                        expires_at_secs: 0,
                    });
                }
                Ok(None) => return None,
                Err(error) => {
                    warn!(error = %error, "failed to consume refresh token via IPC");
                    return None;
                }
            }
        }

        let mut state = self.inner.write().unwrap();
        let ts = now_secs();
        Self::sweep_expired(&mut state, ts);
        state.refresh_sessions.remove(refresh_token.trim())
    }

    async fn issue_tokens(
        &self,
        owner_user_id: &str,
        email: &str,
    ) -> Option<IssuedCodexClientTokens> {
        let ts = now_secs();
        let refresh_token = issue_refresh_token();
        let signed = self.jwt.sign_session_tokens_at(owner_user_id, email, ts);
        let expires_at_secs = ts + REFRESH_TTL_SECS;
        let owner_user_id = gateway_account_id(owner_user_id);

        if let Some(ipc) = &self.ipc {
            if let Err(error) = ipc
                .store_refresh_token(
                    &hash_refresh_token(&refresh_token),
                    &owner_user_id,
                    email,
                    expires_at_secs,
                )
                .await
            {
                warn!(error = %error, "failed to persist refresh token via IPC");
                return None;
            }
        } else {
            let mut state = self.inner.write().unwrap();
            Self::sweep_expired(&mut state, ts);
            state.refresh_sessions.insert(
                refresh_token.clone(),
                RefreshSession {
                    refresh_token: refresh_token.clone(),
                    owner_user_id,
                    email: email.to_string(),
                    expires_at_secs,
                },
            );
        }

        Some(IssuedCodexClientTokens {
            id_token: signed.id_token,
            access_token: signed.access_token,
            refresh_token,
            account_id: signed.account_id,
            token_type: "Bearer".to_string(),
            expires_in: ACCESS_TTL_SECS,
        })
    }
}
