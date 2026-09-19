//! `openai_accounts`: one row per upstream login. A ChatGPT account
//! (`account_id`) is usually logged in once per client platform.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

pub const STATUSES: [&str; 3] = ["active", "inactive", "disabled"];
pub const PLATFORMS: [&str; 4] = ["windows", "linux", "darwin", "all"];

fn normalize(value: &str) -> String {
    value.trim().to_lowercase().replace(' ', "_")
}

pub fn normalize_status(value: &str) -> Option<&'static str> {
    let value = normalize(value);
    STATUSES.iter().copied().find(|status| *status == value)
}

pub fn normalize_platform(value: &str) -> Option<&'static str> {
    let value = normalize(value);
    if value == "macos" {
        return Some("darwin");
    }
    PLATFORMS
        .iter()
        .copied()
        .find(|platform| *platform == value)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Account {
    pub id: String,
    pub email: String,
    pub account_id: String,
    status: Option<String>,
    platform: Option<String>,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Account {
    pub fn status(&self) -> &'static str {
        self.status
            .as_deref()
            .and_then(normalize_status)
            .unwrap_or("inactive")
    }

    pub fn platform(&self) -> &'static str {
        self.platform
            .as_deref()
            .and_then(normalize_platform)
            .unwrap_or("all")
    }
}

const COLUMNS: &str = "id::text AS id, email, account_id, status, platform, id_token, \
    access_token, refresh_token, created_at, updated_at";

fn select(where_sql: &str) -> String {
    format!("SELECT {COLUMNS} FROM openai_accounts {where_sql}")
}

pub struct AccountPage {
    pub items: Vec<Account>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

pub async fn list_page(
    pool: &PgPool,
    page: i64,
    page_size: i64,
    status: &str,
    keyword: &str,
) -> Result<AccountPage, sqlx::Error> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 500);
    let status = status.trim().to_lowercase();
    let keyword = keyword.trim();
    let status = (!status.is_empty()).then_some(status);
    let pattern = (!keyword.is_empty()).then(|| format!("%{keyword}%"));
    let filter = r#"
        WHERE ($1::text IS NULL OR LOWER(TRIM(COALESCE(status, ''))) = $1)
          AND ($2::text IS NULL OR email ILIKE $2)
    "#;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM openai_accounts {filter}"
    )))
    .bind(&status)
    .bind(&pattern)
    .fetch_one(pool)
    .await?;
    let items = sqlx::query_as(sqlx::AssertSqlSafe(select(&format!(
        "{filter} ORDER BY updated_at DESC LIMIT $3 OFFSET $4"
    ))))
    .bind(&status)
    .bind(&pattern)
    .bind(page_size)
    .bind((page - 1) * page_size)
    .fetch_all(pool)
    .await?;
    Ok(AccountPage {
        items,
        total,
        page,
        page_size,
    })
}

pub async fn get_by_email(pool: &PgPool, email: &str) -> Result<Option<Account>, sqlx::Error> {
    let email = email.trim();
    if email.is_empty() {
        return Ok(None);
    }
    sqlx::query_as(sqlx::AssertSqlSafe(select(
        "WHERE LOWER(email) = LOWER($1) LIMIT 1",
    )))
    .bind(email)
    .fetch_optional(pool)
    .await
}

pub async fn get_by_id(pool: &PgPool, id: &str) -> Result<Option<Account>, sqlx::Error> {
    let Ok(id) = uuid::Uuid::parse_str(id.trim()) else {
        return Ok(None);
    };
    sqlx::query_as(sqlx::AssertSqlSafe(select("WHERE id = $1")))
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The row serving `platform` for a ChatGPT account: the exact platform
/// first, then a generic `all` login. Disabled rows never serve traffic.
pub async fn resolve_for_platform(
    pool: &PgPool,
    account_id: &str,
    platform: &str,
) -> Result<Option<Account>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(select(
        r#"
        WHERE account_id = $1
          AND LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
          AND BTRIM(access_token) <> ''
          AND LOWER(TRIM(COALESCE(platform, 'all'))) IN ($2, 'all')
        ORDER BY
          (LOWER(TRIM(COALESCE(platform, 'all'))) = $2) DESC,
          (LOWER(TRIM(status)) = 'active') DESC,
          updated_at DESC
        LIMIT 1
        "#,
    )))
    .bind(account_id)
    .bind(platform)
    .fetch_optional(pool)
    .await
}

/// Any usable row of a ChatGPT account, for account-level calls such as usage.
pub async fn representative(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<Account>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(select(
        r#"
        WHERE account_id = $1
          AND LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
          AND BTRIM(access_token) <> ''
        ORDER BY (LOWER(TRIM(status)) = 'active') DESC, updated_at DESC
        LIMIT 1
        "#,
    )))
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

/// Rows whose tokens should be kept fresh.
pub async fn list_refreshable(pool: &PgPool) -> Result<Vec<Account>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(select(
        r#"
        WHERE LOWER(TRIM(COALESCE(status, ''))) <> 'disabled'
          AND BTRIM(refresh_token) <> ''
        "#,
    )))
    .fetch_all(pool)
    .await
}

pub async fn delete_by_email(pool: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    let deleted = sqlx::query("DELETE FROM openai_accounts WHERE email = $1")
        .bind(email)
        .execute(pool)
        .await?;
    Ok(deleted.rows_affected() > 0)
}

fn distinct_emails(emails: &[String]) -> Vec<String> {
    let mut emails: Vec<String> = emails
        .iter()
        .map(|email| email.trim().to_string())
        .filter(|email| !email.is_empty())
        .collect();
    emails.sort();
    emails.dedup();
    emails
}

pub async fn delete_many(pool: &PgPool, emails: &[String]) -> Result<u64, sqlx::Error> {
    let emails = distinct_emails(emails);
    if emails.is_empty() {
        return Ok(0);
    }
    Ok(
        sqlx::query("DELETE FROM openai_accounts WHERE email = ANY($1)")
            .bind(emails)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

pub async fn disable(pool: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    Ok(disable_many(pool, &[email.to_string()]).await? > 0)
}

pub async fn disable_many(pool: &PgPool, emails: &[String]) -> Result<u64, sqlx::Error> {
    let emails = distinct_emails(emails);
    if emails.is_empty() {
        return Ok(0);
    }
    Ok(
        sqlx::query("UPDATE openai_accounts SET status = 'disabled' WHERE email = ANY($1)")
            .bind(emails)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

/// Makes `email` the active login of its platform, demoting the previous one.
pub async fn activate(pool: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let platform: Option<Option<String>> =
        sqlx::query_scalar("SELECT platform FROM openai_accounts WHERE email = $1 FOR UPDATE")
            .bind(email)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(platform) = platform else {
        return Ok(false);
    };
    sqlx::query(
        r#"
        UPDATE openai_accounts
        SET status = 'inactive'
        WHERE LOWER(TRIM(status)) = 'active'
          AND email <> $1
          AND LOWER(TRIM(COALESCE(platform, 'all'))) = LOWER(TRIM(COALESCE($2, 'all')))
        "#,
    )
    .bind(email)
    .bind(platform)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE openai_accounts SET status = 'active' WHERE email = $1")
        .bind(email)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

pub struct UpsertInput {
    pub email: String,
    pub account_id: String,
    pub status: Option<&'static str>,
    pub platform: Option<&'static str>,
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}

/// Inserts or updates a login by email. Without an explicit status, a new
/// login becomes active only if its platform has no active login yet.
pub async fn upsert(pool: &PgPool, input: UpsertInput) -> Result<Account, sqlx::Error> {
    let email = input.email.trim().to_lowercase();
    let mut tx = pool.begin().await?;
    let existing: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT status, platform FROM openai_accounts WHERE email = $1 FOR UPDATE")
            .bind(&email)
            .fetch_optional(&mut *tx)
            .await?;

    let platform = input.platform.unwrap_or_else(|| {
        existing
            .as_ref()
            .and_then(|(_, platform)| platform.as_deref().and_then(normalize_platform))
            .unwrap_or("all")
    });
    let status = match (input.status, &existing) {
        (Some(status), _) => status,
        (None, Some((status, _))) => status
            .as_deref()
            .and_then(normalize_status)
            .unwrap_or("inactive"),
        (None, None) => {
            let active_exists: bool = sqlx::query_scalar(
                r#"
                SELECT EXISTS (
                  SELECT 1 FROM openai_accounts
                  WHERE LOWER(TRIM(status)) = 'active'
                    AND LOWER(TRIM(COALESCE(platform, 'all'))) = $1
                )
                "#,
            )
            .bind(platform)
            .fetch_one(&mut *tx)
            .await?;
            if active_exists { "inactive" } else { "active" }
        }
    };

    if status == "active" {
        sqlx::query(
            r#"
            UPDATE openai_accounts
            SET status = 'inactive'
            WHERE LOWER(TRIM(status)) = 'active'
              AND email <> $1
              AND LOWER(TRIM(COALESCE(platform, 'all'))) = $2
            "#,
        )
        .bind(&email)
        .bind(platform)
        .execute(&mut *tx)
        .await?;
    }

    let account = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO openai_accounts (
          email, account_id, status, platform, id_token, access_token, refresh_token
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (email) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          status = EXCLUDED.status,
          platform = EXCLUDED.platform,
          id_token = EXCLUDED.id_token,
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token
        RETURNING {COLUMNS}
        "#
    )))
    .bind(&email)
    .bind(input.account_id.trim())
    .bind(status)
    .bind(platform)
    .bind(input.id_token.trim())
    .bind(input.access_token.trim())
    .bind(input.refresh_token.trim())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(account)
}

pub async fn update_tokens(
    pool: &PgPool,
    id: &str,
    id_token: Option<&str>,
    access_token: &str,
    refresh_token: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE openai_accounts
        SET id_token = COALESCE($2, id_token),
            access_token = $3,
            refresh_token = COALESCE($4, refresh_token)
        WHERE id = $1::uuid
        "#,
    )
    .bind(id)
    .bind(id_token.map(str::trim).filter(|v| !v.is_empty()))
    .bind(access_token.trim())
    .bind(refresh_token.map(str::trim).filter(|v| !v.is_empty()))
    .execute(pool)
    .await?;
    Ok(())
}
