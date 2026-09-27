//! Uses of counted ChatGPT features (Deep Research, image generation).

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub async fn record(
    pool: &PgPool,
    owner: &str,
    account_id: &str,
    feature: &str,
    conversation_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let Ok(owner) = Uuid::parse_str(owner.trim()) else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO feature_usage (owner_user_id, account_id, feature, conversation_id) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(owner)
    .bind(account_id)
    .bind(feature)
    .bind(conversation_id)
    .execute(pool)
    .await
    .map(|_| ())
}

/// How often `owner` used `feature` since `since`, and when the oldest of
/// those uses was.
pub async fn usage_since(
    pool: &PgPool,
    owner: &str,
    feature: &str,
    since: DateTime<Utc>,
) -> Result<(i64, Option<DateTime<Utc>>), sqlx::Error> {
    let Ok(owner) = Uuid::parse_str(owner.trim()) else {
        return Ok((0, None));
    };
    sqlx::query_as(
        "SELECT COUNT(*)::int8, MIN(used_at) FROM feature_usage \
         WHERE owner_user_id = $1 AND feature = $2 AND used_at > $3",
    )
    .bind(owner)
    .bind(feature)
    .bind(since)
    .fetch_one(pool)
    .await
}
