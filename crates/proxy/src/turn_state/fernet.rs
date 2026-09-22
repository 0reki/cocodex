//! The token upstream issues as `x-codex-turn-state`.
//!
//! It is an opaque Fernet token: version byte, big-endian issue time, IV and
//! HMAC around an AES-CBC ciphertext. The gateway never decrypts it — the key
//! is OpenAI's — but the envelope is enough to tell a real state from a
//! truncated or foreign value, to know when it was issued (they last an hour)
//! and to count its cipher blocks, which follow the login's plan.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};

/// How long upstream honours a state after it was issued.
pub const TURN_STATE_TTL_SECS: i64 = 3600;

pub fn turn_state_ttl() -> Duration {
    Duration::seconds(TURN_STATE_TTL_SECS)
}

/// Version byte of a Fernet token.
const VERSION: u8 = 0x80;
/// Version (1) + timestamp (8) + IV (16) + HMAC (32).
const FIXED_BYTES: usize = 1 + 8 + 16 + 32;

/// What the envelope of one turn state says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnStateInfo {
    pub issued_at: DateTime<Utc>,
    pub cipher_bytes: usize,
    /// AES blocks of ciphertext: 10 for Plus/Pro, 12 for Team.
    pub blocks: usize,
}

impl TurnStateInfo {
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.issued_at + turn_state_ttl()
    }

    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        now < self.expires_at()
    }
}

/// Reads the envelope of a turn state, rejecting anything that is not one.
pub fn parse(value: &str, max_bytes: usize) -> Result<TurnStateInfo, &'static str> {
    let value = value.trim();
    if value.is_empty() {
        return Err("turn state is empty");
    }
    if value.len() > max_bytes {
        return Err("turn state is too long");
    }
    if !value.bytes().all(|byte| (0x20..=0x7e).contains(&byte)) {
        return Err("turn state contains a non-printable character");
    }
    let raw = URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .map_err(|_| "turn state is not base64url")?;
    if raw.len() < FIXED_BYTES + 16 {
        return Err("turn state is too short");
    }
    if raw[0] != VERSION {
        return Err("unexpected turn state version");
    }
    let cipher_bytes = raw.len() - FIXED_BYTES;
    if !cipher_bytes.is_multiple_of(16) {
        return Err("turn state ciphertext is not block aligned");
    }
    let seconds = u64::from_be_bytes(raw[1..9].try_into().expect("eight bytes"));
    let issued_at = i64::try_from(seconds)
        .ok()
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .ok_or("turn state timestamp is out of range")?;
    // A plausible issue time: after Codex existed and not absurdly far ahead.
    if issued_at.year() < 2020 || issued_at.year() >= 2100 {
        return Err("turn state timestamp is out of range");
    }
    Ok(TurnStateInfo {
        issued_at,
        cipher_bytes,
        blocks: cipher_bytes / 16,
    })
}

#[cfg(test)]
pub(crate) fn encode_for_test(issued_at: DateTime<Utc>, blocks: usize) -> String {
    let mut raw = vec![VERSION];
    raw.extend_from_slice(&(issued_at.timestamp() as u64).to_be_bytes());
    raw.extend_from_slice(&[0x11; 16]);
    raw.extend(std::iter::repeat_n(0x22, blocks * 16));
    raw.extend_from_slice(&[0x33; 32]);
    URL_SAFE_NO_PAD.encode(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: usize = 4096;

    #[test]
    fn reads_the_issue_time_and_block_count() {
        let issued_at = Utc.timestamp_opt(1_800_000_000, 0).unwrap();
        let info = parse(&encode_for_test(issued_at, 10), MAX).unwrap();
        assert_eq!(info.issued_at, issued_at);
        assert_eq!(info.blocks, 10);
        assert_eq!(info.cipher_bytes, 160);
        assert_eq!(info.expires_at(), issued_at + turn_state_ttl());
    }

    #[test]
    fn rejects_values_that_are_not_turn_states() {
        assert!(parse("", MAX).is_err());
        assert!(parse("not a token", MAX).is_err());
        // Right shape, wrong version byte.
        let issued_at = Utc.timestamp_opt(1_800_000_000, 0).unwrap();
        let mut raw = URL_SAFE_NO_PAD
            .decode(encode_for_test(issued_at, 10))
            .unwrap();
        raw[0] = 0x81;
        assert!(parse(&URL_SAFE_NO_PAD.encode(&raw), MAX).is_err());
        // Truncated ciphertext.
        raw[0] = VERSION;
        raw.truncate(raw.len() - 4);
        assert!(parse(&URL_SAFE_NO_PAD.encode(&raw), MAX).is_err());
    }

    #[test]
    fn rejects_an_oversized_value() {
        let issued_at = Utc.timestamp_opt(1_800_000_000, 0).unwrap();
        assert!(parse(&encode_for_test(issued_at, 10), 16).is_err());
    }
}
