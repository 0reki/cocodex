//! Weekly upstream quota windows per ChatGPT account and the usage each
//! assigned user recorded inside the current window.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Window {
    pub account_id: String,
    pub reset_at: i64,
    pub used_percent: f64,
    pub synced_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberUsage {
    pub owner_user_id: String,
    pub username: String,
    pub role: String,
    pub enabled: bool,
    pub usage_amount: f64,
}

pub async fn get_window(pool: &PgPool, account_id: &str) -> Result<Option<Window>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT account_id, reset_at, used_percent::float8 AS used_percent, synced_at, updated_at
        FROM upstream_account_quota_windows
        WHERE account_id = $1
        "#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// Records an upstream usage reading. A lower `used_percent` or a passed
/// `reset_at` starts a new window; otherwise the stored `reset_at` is kept
/// (upstream jitters it by a few seconds between reads) and the percentage
/// only moves up.
pub async fn sync_window(
    pool: &PgPool,
    account_id: &str,
    reset_at: i64,
    used_percent: f64,
) -> Result<Window, sqlx::Error> {
    sqlx::query_as(
        r#"
        INSERT INTO upstream_account_quota_windows (account_id, reset_at, used_percent)
        VALUES ($1, $2, $3)
        ON CONFLICT (account_id) DO UPDATE SET
          reset_at = CASE
            WHEN EXCLUDED.used_percent < upstream_account_quota_windows.used_percent
              OR upstream_account_quota_windows.reset_at <= extract(epoch FROM now())
            THEN EXCLUDED.reset_at
            ELSE upstream_account_quota_windows.reset_at
          END,
          used_percent = CASE
            WHEN EXCLUDED.used_percent < upstream_account_quota_windows.used_percent
              OR upstream_account_quota_windows.reset_at <= extract(epoch FROM now())
            THEN EXCLUDED.used_percent
            ELSE GREATEST(upstream_account_quota_windows.used_percent, EXCLUDED.used_percent)
          END,
          synced_at = now(),
          updated_at = now()
        RETURNING account_id, reset_at, used_percent::float8 AS used_percent, synced_at, updated_at
        "#,
    )
    .bind(account_id)
    .bind(reset_at)
    .bind(used_percent)
    .fetch_one(pool)
    .await
}

/// Usage of every user assigned to the account within the window.
pub async fn members(
    pool: &PgPool,
    account_id: &str,
    reset_at: i64,
) -> Result<Vec<MemberUsage>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
          users.id::text AS owner_user_id,
          users.username,
          users.role,
          users.enabled,
          COALESCE(usage.usage_amount, 0)::float8 AS usage_amount
        FROM portal_users AS users
        JOIN portal_user_upstream_assignments AS assignments
          ON assignments.owner_user_id = users.id
          AND assignments.account_id = $1
        LEFT JOIN upstream_account_user_usage AS usage
          ON usage.owner_user_id = users.id
          AND usage.account_id = $1
          AND usage.reset_at = $2
        ORDER BY users.created_at ASC
        "#,
    )
    .bind(account_id)
    .bind(reset_at)
    .fetch_all(pool)
    .await
}

/// Per-user usage in the window, including users no longer assigned.
pub async fn usage_by_user(
    pool: &PgPool,
    account_id: &str,
    reset_at: i64,
) -> Result<Vec<(String, f64)>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT owner_user_id::text, usage_amount::float8
        FROM upstream_account_user_usage
        WHERE account_id = $1 AND reset_at = $2
        "#,
    )
    .bind(account_id)
    .bind(reset_at)
    .fetch_all(pool)
    .await
}

/// Adds `usage_amount` (USD) for a user once per settlement id.
pub async fn record_usage(
    pool: &PgPool,
    settlement_id: &str,
    account_id: &str,
    reset_at: i64,
    owner_user_id: &str,
    usage_amount: &str,
) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let inserted = sqlx::query(
        r#"
        INSERT INTO upstream_account_quota_settlements (
          settlement_id, account_id, reset_at, owner_user_id, usage_amount
        )
        VALUES ($1, $2, $3, $4::uuid, $5::numeric)
        ON CONFLICT (settlement_id) DO NOTHING
        "#,
    )
    .bind(settlement_id)
    .bind(account_id)
    .bind(reset_at)
    .bind(owner_user_id)
    .bind(usage_amount)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if inserted {
        sqlx::query(
            r#"
            INSERT INTO upstream_account_user_usage (
              account_id, reset_at, owner_user_id, usage_amount
            )
            VALUES ($1, $2, $3::uuid, $4::numeric)
            ON CONFLICT (account_id, reset_at, owner_user_id) DO UPDATE SET
              usage_amount = upstream_account_user_usage.usage_amount + EXCLUDED.usage_amount,
              updated_at = now()
            "#,
        )
        .bind(account_id)
        .bind(reset_at)
        .bind(owner_user_id)
        .bind(usage_amount)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(inserted)
}

/// Settlement ids only need to outlive retries.
pub async fn prune_settlements(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM upstream_account_quota_settlements WHERE created_at < now() - interval '14 days'",
    )
    .execute(pool)
    .await?;
    Ok(())
}
