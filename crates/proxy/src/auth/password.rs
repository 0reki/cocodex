//! Portal password hashes: `scrypt$<salt b64>$<hash b64>` with Node's
//! `crypto.scrypt` defaults (N=16384, r=8, p=1, 64-byte key), so hashes
//! written by the Node backend keep verifying.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rand::RngCore;

pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;
const LOG_N: u8 = 14;
const KEY_LENGTH: usize = 64;

pub fn validation_error(password: &str) -> Option<String> {
    let length = password.encode_utf16().count();
    if length < MIN_LENGTH {
        return Some(format!("Password must be at least {MIN_LENGTH} characters"));
    }
    if length > MAX_LENGTH {
        return Some(format!("Password must be at most {MAX_LENGTH} characters"));
    }
    None
}

fn derive(password: &str, salt: &[u8], length: usize) -> Option<Vec<u8>> {
    let params = scrypt::Params::new(LOG_N, 8, 1).ok()?;
    let mut output = vec![0u8; length];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut output).ok()?;
    Some(output)
}

/// scrypt is deliberately slow, so it runs off the async executor.
pub async fn hash(password: String) -> String {
    tokio::task::spawn_blocking(move || {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let digest = derive(&password, &salt, KEY_LENGTH).expect("valid scrypt parameters");
        format!(
            "scrypt${}${}",
            STANDARD.encode(salt),
            STANDARD.encode(digest)
        )
    })
    .await
    .expect("password hashing task panicked")
}

pub async fn verify(password: String, stored: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let mut parts = stored.split('$');
        let (Some("scrypt"), Some(salt), Some(expected)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        let (Ok(salt), Ok(expected)) = (STANDARD.decode(salt), STANDARD.decode(expected)) else {
            return false;
        };
        if expected.is_empty() {
            return false;
        }
        derive(&password, &salt, expected.len()).is_some_and(|actual| {
            actual.len() == expected.len()
                && actual
                    .iter()
                    .zip(&expected)
                    .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                    == 0
        })
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_hash_produced_by_node() {
        // node -e 'crypto.scrypt("correct-horse", Buffer.alloc(16, 1), 64, ...)'
        let stored = "scrypt$AQEBAQEBAQEBAQEBAQEBAQ==$MUUxNgFXv6bDwum8D3G1btl/R3un7u9Qh+LCxtJ+/vwdRhfrwpnSoYmyMCYu0HYuYePYacwMD5JHYPcBjyTL3w==";
        assert!(verify("correct-horse".into(), stored.into()).await);
        assert!(!verify("correct-horsf".into(), stored.into()).await);
    }

    #[tokio::test]
    async fn round_trips() {
        let stored = hash("correct-horse".into()).await;
        assert!(verify("correct-horse".into(), stored.clone()).await);
        assert!(!verify("wrong-horse".into(), stored).await);
        assert!(!verify("x".into(), "bcrypt$a$b".into()).await);
    }
}
