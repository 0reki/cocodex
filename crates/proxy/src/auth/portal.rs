//! Portal (admin/user web console) tokens: HS256 JWTs signed with
//! `ADMIN_JWT_SECRET`, wire-compatible with those the Node backend issued.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use super::jwt::{now_secs, verify_hmac};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortalTokenKind {
    Access,
    Refresh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalClaims {
    pub sub: String,
    pub typ: PortalTokenKind,
    pub iat: u64,
    pub exp: u64,
}

/// Verifies a portal token of the given kind and returns its claims.
pub fn verify_portal_token(
    secret: &[u8],
    token: &str,
    kind: PortalTokenKind,
) -> Option<PortalClaims> {
    let mut parts = token.trim().split('.');
    let (header_b64, payload_b64, signature_b64) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || header_b64.is_empty() || payload_b64.is_empty() {
        return None;
    }

    let header: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header_b64).ok()?).ok()?;
    if header.get("alg")?.as_str()? != "HS256" || header.get("typ")?.as_str()? != "JWT" {
        return None;
    }
    if !verify_hmac(
        secret,
        format!("{header_b64}.{payload_b64}").as_bytes(),
        signature_b64,
    ) {
        return None;
    }

    let claims: PortalClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload_b64).ok()?).ok()?;
    let claims = PortalClaims {
        sub: claims.sub.trim().to_string(),
        ..claims
    };
    (claims.typ == kind && !claims.sub.is_empty() && claims.exp > now_secs()).then_some(claims)
}

impl PortalTokenKind {
    fn ttl_secs(self) -> u64 {
        let (name, fallback) = match self {
            PortalTokenKind::Access => ("ADMIN_ACCESS_TOKEN_TTL_SECONDS", 10 * 24 * 60 * 60),
            PortalTokenKind::Refresh => ("ADMIN_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 60 * 60),
        };
        std::env::var(name)
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.floor() as u64)
            .unwrap_or(fallback)
    }
}

pub struct IssuedPortalToken {
    pub token: String,
    pub expires_at: u64,
}

pub fn issue_portal_token(
    secret: &[u8],
    user_id: &str,
    kind: PortalTokenKind,
) -> IssuedPortalToken {
    let iat = now_secs();
    let claims = PortalClaims {
        sub: user_id.to_string(),
        typ: kind,
        iat,
        exp: iat + kind.ttl_secs(),
    };
    IssuedPortalToken {
        token: super::jwt::encode_jwt(secret, &claims),
        expires_at: claims.exp,
    }
}
