//! Codex client refresh tokens. Only SHA-256 hashes are stored; every token
//! belongs to a session, and access tokens are honoured only while their
//! session still holds an unexpired refresh token.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RefreshRecord {
    pub owner_user_id: String,
    pub email: String,
    pub session_id: String,
}

fn to_timestamp(secs: u64) -> DateTime<Utc> {
    DateTime::from_timestamp(secs as i64, 0).unwrap_or(DateTime::<Utc>::MAX_UTC)
}

pub async fn store(
    pool: &PgPool,
    token_hash: &str,
    owner_user_id: &str,
    email: &str,
    session_id: &str,
    expires_at_secs: u64,
) -> Result<(), sqlx::Error> {
    let owner = Uuid::parse_str(owner_user_id.trim())
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
    sqlx::query(
        r#"
        INSERT INTO codex_client_refresh_tokens (
          token_hash, owner_user_id, email, session_id, expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (token_hash) DO UPDATE SET
          owner_user_id = EXCLUDED.owner_user_id,
          email = EXCLUDED.email,
          session_id = EXCLUDED.session_id,
          expires_at = EXCLUDED.expires_at,
          api_key_id = NULL
        "#,
    )
    .bind(token_hash)
    .bind(owner)
    .bind(email)
    .bind(session_id)
    .bind(to_timestamp(expires_at_secs))
    .execute(pool)
    .await?;
    Ok(())
}

/// Consumes `token_hash` and stores `new_token_hash` in the same session in
/// one transaction, so a failed write never strands the client. Legacy rows
/// without a session adopt `fallback_session_id`.
pub async fn rotate(
    pool: &PgPool,
    token_hash: &str,
    new_token_hash: &str,
    fallback_session_id: &str,
    expires_at_secs: u64,
) -> Result<Option<RefreshRecord>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row: Option<(Uuid, String, Option<String>)> = sqlx::query_as(
        r#"
        DELETE FROM codex_client_refresh_tokens
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING owner_user_id, email, session_id
        "#,
    )
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner, email, session_id)) = row else {
        return Ok(None);
    };
    let session_id = session_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| fallback_session_id.to_string());
    sqlx::query(
        r#"
        INSERT INTO codex_client_refresh_tokens (
          token_hash, owner_user_id, email, session_id, expires_at
        )
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(new_token_hash)
    .bind(owner)
    .bind(&email)
    .bind(&session_id)
    .bind(to_timestamp(expires_at_secs))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(RefreshRecord {
        owner_user_id: owner.to_string(),
        email,
        session_id,
    }))
}

/// Latest refresh-token expiry of a live session, in unix seconds.
pub async fn session_expiry(pool: &PgPool, session_id: &str) -> Result<Option<u64>, sqlx::Error> {
    let expires_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        r#"
        SELECT max(expires_at)
        FROM codex_client_refresh_tokens
        WHERE session_id = $1 AND expires_at > now()
        "#,
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;
    Ok(expires_at.map(|at| at.timestamp().max(0) as u64))
}

/// Deletes matching refresh tokens and returns the sessions they belonged to.
pub async fn revoke(
    pool: &PgPool,
    token_hash: Option<&str>,
    session_id: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    if token_hash.is_none() && session_id.is_none() {
        return Ok(Vec::new());
    }
    let deleted: Vec<Option<String>> = sqlx::query_scalar(
        r#"
        DELETE FROM codex_client_refresh_tokens
        WHERE ($1::text IS NOT NULL AND token_hash = $1)
           OR ($2::text IS NOT NULL AND session_id = $2)
        RETURNING session_id
        "#,
    )
    .bind(token_hash)
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut sessions: Vec<String> = deleted.into_iter().flatten().collect();
    sessions.sort();
    sessions.dedup();
    Ok(sessions)
}
