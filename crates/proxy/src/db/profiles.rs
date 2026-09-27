//! Quota profiles and the quota settings each user takes from them.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

/// The effective quota columns for `users` (aliased `u`) joined to their
/// profile (aliased `p`, see `PROFILE_JOIN`): an override key wins over the
/// profile, including an override to no limit (`null`).
pub(crate) const EFFECTIVE_COLUMNS: &str = r#"
  COALESCE((u.quota_overrides->>'weeklySharePercent')::float8, p.weekly_share_percent, 25)
    AS weekly_share_percent,
  CASE WHEN u.quota_overrides ? 'deepResearchLimit'
    THEN (u.quota_overrides->>'deepResearchLimit')::int
    ELSE p.deep_research_limit END AS deep_research_limit,
  CASE WHEN u.quota_overrides ? 'imageGenLimit'
    THEN (u.quota_overrides->>'imageGenLimit')::int
    ELSE p.image_gen_limit END AS image_gen_limit,
  CASE WHEN u.quota_overrides ? 'proMessageLimit'
    THEN (u.quota_overrides->>'proMessageLimit')::int
    ELSE p.pro_message_limit END AS pro_message_limit"#;

/// A user's own profile, or the default one.
pub(crate) const PROFILE_JOIN: &str = r#"
  LEFT JOIN quota_profiles p ON p.id = COALESCE(
    u.quota_profile_id,
    (SELECT id FROM quota_profiles WHERE is_default LIMIT 1)
  )"#;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct QuotaProfile {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub weekly_share_percent: f64,
    pub deep_research_limit: Option<i32>,
    pub image_gen_limit: Option<i32>,
    pub pro_message_limit: Option<i32>,
    pub user_count: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// What an admin sets on a profile; `None` leaves a field as it is.
#[derive(Debug, Default)]
pub struct ProfileChanges {
    pub name: Option<String>,
    pub weekly_share_percent: Option<f64>,
    /// `Some(None)` clears the limit.
    pub deep_research_limit: Option<Option<i32>>,
    pub image_gen_limit: Option<Option<i32>>,
    pub pro_message_limit: Option<Option<i32>>,
}

const PROFILE_COLUMNS: &str = r#"
  p.id::text AS id, p.name, p.is_default, p.weekly_share_percent,
  p.deep_research_limit, p.image_gen_limit, p.pro_message_limit,
  (SELECT COUNT(*) FROM portal_users u WHERE u.quota_profile_id = p.id
     OR (u.quota_profile_id IS NULL AND p.is_default))::int8 AS user_count,
  p.created_at, p.updated_at"#;

pub async fn list(pool: &PgPool) -> Result<Vec<QuotaProfile>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROFILE_COLUMNS} FROM quota_profiles p ORDER BY p.is_default DESC, p.name"
    )))
    .fetch_all(pool)
    .await
}

pub async fn get(pool: &PgPool, id: &str) -> Result<Option<QuotaProfile>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Ok(None);
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROFILE_COLUMNS} FROM quota_profiles p WHERE p.id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn create(pool: &PgPool, changes: &ProfileChanges) -> Result<String, sqlx::Error> {
    sqlx::query_scalar(
        r#"
        INSERT INTO quota_profiles
          (name, weekly_share_percent, deep_research_limit, image_gen_limit,
           pro_message_limit)
        VALUES ($1, COALESCE($2, 25), $3, $4, $5)
        RETURNING id::text
        "#,
    )
    .bind(changes.name.as_deref().unwrap_or_default())
    .bind(changes.weekly_share_percent)
    .bind(changes.deep_research_limit.flatten())
    .bind(changes.image_gen_limit.flatten())
    .bind(changes.pro_message_limit.flatten())
    .fetch_one(pool)
    .await
}

/// Returns whether the profile exists.
pub async fn update(
    pool: &PgPool,
    id: &str,
    changes: &ProfileChanges,
) -> Result<bool, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Ok(false);
    };
    let updated = sqlx::query(
        r#"
        UPDATE quota_profiles SET
          name = COALESCE($2, name),
          weekly_share_percent = COALESCE($3, weekly_share_percent),
          deep_research_limit = CASE WHEN $4 THEN $5 ELSE deep_research_limit END,
          image_gen_limit = CASE WHEN $6 THEN $7 ELSE image_gen_limit END,
          pro_message_limit = CASE WHEN $8 THEN $9 ELSE pro_message_limit END
        WHERE id = $1
        "#,
    )
    .bind(id)
    .bind(changes.name.as_deref())
    .bind(changes.weekly_share_percent)
    .bind(changes.deep_research_limit.is_some())
    .bind(changes.deep_research_limit.flatten())
    .bind(changes.image_gen_limit.is_some())
    .bind(changes.image_gen_limit.flatten())
    .bind(changes.pro_message_limit.is_some())
    .bind(changes.pro_message_limit.flatten())
    .execute(pool)
    .await?;
    Ok(updated.rows_affected() > 0)
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    NotFound,
    /// The default profile is what users without one fall back to.
    IsDefault,
}

/// Users on a deleted profile fall back to the default one.
pub async fn delete(pool: &PgPool, id: &str) -> Result<DeleteOutcome, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Ok(DeleteOutcome::NotFound);
    };
    let is_default: Option<bool> =
        sqlx::query_scalar("SELECT is_default FROM quota_profiles WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    match is_default {
        None => Ok(DeleteOutcome::NotFound),
        Some(true) => Ok(DeleteOutcome::IsDefault),
        Some(false) => {
            sqlx::query("DELETE FROM quota_profiles WHERE id = $1")
                .bind(id)
                .execute(pool)
                .await?;
            Ok(DeleteOutcome::Deleted)
        }
    }
}

/// A user's quota settings: the profile they are on, their overrides, and
/// what results.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserQuotaSettings {
    pub user_id: String,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub overrides: Value,
    pub weekly_share_percent: f64,
    pub deep_research_limit: Option<i32>,
    pub image_gen_limit: Option<i32>,
    pub pro_message_limit: Option<i32>,
}

pub async fn user_settings(pool: &PgPool) -> Result<Vec<UserQuotaSettings>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"
        SELECT
          u.id::text AS user_id,
          p.id::text AS profile_id,
          p.name AS profile_name,
          u.quota_overrides AS overrides,
          {EFFECTIVE_COLUMNS}
        FROM portal_users u
        {PROFILE_JOIN}
        "#
    )))
    .fetch_all(pool)
    .await
}

/// Puts a user on a profile (`None`: the default one) with `overrides`.
/// Returns whether the user and the profile exist.
pub async fn set_user_profile(
    pool: &PgPool,
    user_id: &str,
    profile_id: Option<&str>,
    overrides: &Value,
) -> Result<bool, sqlx::Error> {
    let Ok(user_id) = Uuid::parse_str(user_id.trim()) else {
        return Ok(false);
    };
    let profile_id = match profile_id {
        Some(id) => match Uuid::parse_str(id.trim()) {
            Ok(id) => Some(id),
            Err(_) => return Ok(false),
        },
        None => None,
    };
    let updated = sqlx::query(
        r#"
        UPDATE portal_users SET quota_profile_id = $2, quota_overrides = $3
        WHERE id = $1
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM quota_profiles WHERE id = $2))
        "#,
    )
    .bind(user_id)
    .bind(profile_id)
    .bind(overrides)
    .execute(pool)
    .await?;
    Ok(updated.rows_affected() > 0)
}
