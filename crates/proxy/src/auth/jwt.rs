use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ACCESS_TTL_SECS: u64 = 10 * 24 * 60 * 60;
pub const ID_TTL_SECS: u64 = 60 * 60;
const ISSUER: &str = "https://auth.openai.com";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JwtError {
    Invalid,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenaiAuthClaim {
    #[serde(default)]
    pub amr: Vec<String>,
    pub chatgpt_account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_account_user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_compute_residency: Option<String>,
    pub chatgpt_plan_type: String,
    pub chatgpt_user_id: String,
    #[serde(default)]
    pub localhost: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poid: Option<String>,
    pub user_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenaiProfileClaim {
    pub email: String,
    pub email_verified: bool,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexJwtClaims {
    pub iss: String,
    pub aud: serde_json::Value,
    pub sub: String,
    pub iat: u64,
    pub exp: u64,
    #[serde(default)]
    pub nbf: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub jti: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scp: Vec<String>,
    #[serde(default)]
    pub sl: bool,
    #[serde(default)]
    pub pwd_auth_time: u64,
    #[serde(rename = "https://api.openai.com/auth")]
    pub openai_auth: OpenaiAuthClaim,
    #[serde(
        rename = "https://api.openai.com/profile",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub openai_profile: Option<OpenaiProfileClaim>,
}

#[derive(Debug, Clone)]
pub struct SignedCodexTokens {
    pub access_token: String,
    pub id_token: String,
    pub account_id: String,
    pub expires_in: u64,
}

#[derive(Clone)]
pub struct ClientJwt {
    secret: Vec<u8>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

pub fn new_session_id() -> String {
    format!("authsess_{}", uuid::Uuid::new_v4().simple())
}

/// Gateway-facing ChatGPT account id for this portal user.
/// Never the upstream `openai_accounts.account_id` — the interceptor swaps
/// `ChatGPT-Account-ID` on the way out.
pub fn gateway_account_id(owner_user_id: &str) -> String {
    owner_user_id.trim().to_string()
}

pub fn chatgpt_user_id_for(account_id: &str) -> String {
    let compact = compact_alnum(account_id);
    let take = compact.len().min(24);
    format!("user-{}", &compact[..take])
}

pub fn chatgpt_org_id_for(account_id: &str) -> String {
    let compact = compact_alnum(account_id);
    let take = compact.len().min(24);
    format!("org-{}", &compact[..take])
}

fn compact_alnum(value: &str) -> String {
    let compact: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    if compact.is_empty() {
        "gateway".to_string()
    } else {
        compact
    }
}

fn display_name_from_email(email: &str) -> String {
    email
        .split('@')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("user")
        .to_string()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_LEN: usize = 64;
    let mut key_block = [0u8; BLOCK_LEN];
    if key.len() > BLOCK_LEN {
        let hashed = Sha256::digest(key);
        key_block[..hashed.len()].copy_from_slice(&hashed);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK_LEN];
    let mut opad = [0x5cu8; BLOCK_LEN];
    for i in 0..BLOCK_LEN {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let digest = outer.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn sign(secret: &[u8], input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(hmac_sha256(secret, input))
}

pub(crate) fn verify_hmac(secret: &[u8], input: &[u8], signature_b64: &str) -> bool {
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature_b64) else {
        return false;
    };
    let expected = hmac_sha256(secret, input);
    if expected.len() != signature.len() {
        return false;
    }
    expected
        .iter()
        .zip(signature.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub(crate) fn encode_jwt<T: Serialize>(secret: &[u8], claims: &T) -> String {
    let header = serde_json::json!({ "alg": "HS256", "typ": "JWT" });
    let header_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap_or_default());
    let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let signing_input = format!("{header_b64}.{payload_b64}");
    let signature = sign(secret, signing_input.as_bytes());
    format!("{signing_input}.{signature}")
}

fn at_hash(access_token: &str) -> String {
    let digest = Sha256::digest(access_token.as_bytes());
    URL_SAFE_NO_PAD.encode(&digest[..16])
}

fn unix_to_iso8601(secs: u64) -> String {
    let z = (secs / 86400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let rem = secs % 86400;
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}+00:00")
}

impl ClientJwt {
    pub fn from_secret(secret: impl AsRef<[u8]>) -> Self {
        Self {
            secret: secret.as_ref().to_vec(),
        }
    }

    pub fn sign_session_tokens(&self, account_id: &str, email: &str) -> SignedCodexTokens {
        self.sign_session_tokens_at(account_id, email, now_secs())
    }

    pub fn sign_session_tokens_at(
        &self,
        account_id: &str,
        email: &str,
        now: u64,
    ) -> SignedCodexTokens {
        self.sign_tokens_for_session(account_id, email, &new_session_id(), now)
    }

    /// Signs tokens bound to `session_id`. An access token is only honoured
    /// while that session still holds an unexpired refresh token.
    pub fn sign_tokens_for_session(
        &self,
        account_id: &str,
        email: &str,
        session_id: &str,
        now: u64,
    ) -> SignedCodexTokens {
        let account_id = gateway_account_id(account_id);
        let chatgpt_user_id = chatgpt_user_id_for(&account_id);
        let org_id = chatgpt_org_id_for(&account_id);
        let name = display_name_from_email(email);
        let session_id = session_id.to_string();
        let chatgpt_account_user_id = format!("{chatgpt_user_id}__{account_id}");
        let sub = format!("cocodex|{account_id}");

        let access_claims = CodexJwtClaims {
            iss: ISSUER.to_string(),
            aud: serde_json::json!(["https://api.openai.com/v1"]),
            sub: sub.clone(),
            iat: now,
            exp: now + ACCESS_TTL_SECS,
            nbf: now,
            jti: uuid::Uuid::new_v4().to_string(),
            client_id: CODEX_CLIENT_ID.to_string(),
            session_id: session_id.clone(),
            scp: vec![
                "openid".to_string(),
                "profile".to_string(),
                "email".to_string(),
                "offline_access".to_string(),
                "api.connectors.read".to_string(),
                "api.connectors.invoke".to_string(),
            ],
            sl: true,
            pwd_auth_time: now.saturating_mul(1000),
            openai_auth: OpenaiAuthClaim {
                amr: vec!["urn:openai:amr:pwd".to_string()],
                chatgpt_account_id: account_id.clone(),
                chatgpt_account_user_id: Some(chatgpt_account_user_id),
                chatgpt_compute_residency: Some("no_constraint".to_string()),
                chatgpt_plan_type: "pro".to_string(),
                chatgpt_user_id: chatgpt_user_id.clone(),
                localhost: false,
                poid: Some(org_id.clone()),
                user_id: chatgpt_user_id.clone(),
            },
            openai_profile: Some(OpenaiProfileClaim {
                email: email.to_string(),
                email_verified: true,
                name: name.clone(),
            }),
        };

        let access_token = encode_jwt(&self.secret, &access_claims);
        let id_claims = serde_json::json!({
            "amr": ["urn:openai:amr:pwd"],
            "aud": [CODEX_CLIENT_ID],
            "auth_provider": "password",
            "auth_time": now,
            "email": email,
            "email_verified": true,
            "https://api.openai.com/auth": {
                "chatgpt_account_id": account_id,
                "chatgpt_plan_type": "pro",
                "chatgpt_subscription_active_start": null,
                "chatgpt_subscription_active_until": null,
                "chatgpt_subscription_last_checked": unix_to_iso8601(now),
                "chatgpt_user_id": chatgpt_user_id,
                "groups": [],
                "localhost": false,
                "organizations": [{
                    "id": org_id,
                    "is_default": true,
                    "role": "owner",
                    "title": "Personal"
                }],
                "user_id": chatgpt_user_id,
            },
            "iss": ISSUER,
            "name": name,
            "rat": now,
            "sid": session_id,
            "sub": sub,
            "iat": now,
            "exp": now + ID_TTL_SECS,
            "jti": uuid::Uuid::new_v4().to_string(),
            "at_hash": at_hash(&access_token),
        });

        SignedCodexTokens {
            access_token,
            id_token: encode_jwt(&self.secret, &id_claims),
            account_id,
            expires_in: ACCESS_TTL_SECS,
        }
    }

    pub fn verify_access_token(&self, token: &str) -> Result<CodexJwtClaims, JwtError> {
        let token = token.trim();
        let mut parts = token.split('.');
        let header_b64 = parts.next().ok_or(JwtError::Invalid)?;
        let payload_b64 = parts.next().ok_or(JwtError::Invalid)?;
        let signature_b64 = parts.next().ok_or(JwtError::Invalid)?;
        if parts.next().is_some() || header_b64.is_empty() || payload_b64.is_empty() {
            return Err(JwtError::Invalid);
        }

        let header_json = URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|_| JwtError::Invalid)?;
        let header: serde_json::Value =
            serde_json::from_slice(&header_json).map_err(|_| JwtError::Invalid)?;
        if header.get("alg").and_then(|value| value.as_str()) != Some("HS256") {
            return Err(JwtError::Invalid);
        }

        let signing_input = format!("{header_b64}.{payload_b64}");
        if !verify_hmac(&self.secret, signing_input.as_bytes(), signature_b64) {
            return Err(JwtError::Invalid);
        }

        let payload_json = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| JwtError::Invalid)?;
        let claims: CodexJwtClaims =
            serde_json::from_slice(&payload_json).map_err(|_| JwtError::Invalid)?;
        if claims.openai_auth.chatgpt_account_id.trim().is_empty()
            || claims.sub.trim().is_empty()
            || claims.session_id.trim().is_empty()
        {
            return Err(JwtError::Invalid);
        }
        if claims.exp <= now_secs() {
            return Err(JwtError::Expired);
        }
        Ok(claims)
    }

    pub fn decode_payload(token: &str) -> Result<serde_json::Value, JwtError> {
        let token = token.trim();
        let payload_b64 = token.split('.').nth(1).ok_or(JwtError::Invalid)?;
        let payload_json = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| JwtError::Invalid)?;
        serde_json::from_slice(&payload_json).map_err(|_| JwtError::Invalid)
    }
}
