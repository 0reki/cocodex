//! Which ChatGPT account (`openai_accounts.account_id`) serves each user.

use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Assignment {
    pub owner_user_id: String,
    pub account_id: String,
}

pub async fn get(pool: &PgPool, owner_user_id: &str) -> Result<Option<String>, sqlx::Error> {
    let Ok(owner) = Uuid::parse_str(owner_user_id.trim()) else {
        return Ok(None);
    };
    sqlx::query_scalar(
        "SELECT account_id FROM portal_user_upstream_assignments WHERE owner_user_id = $1",
    )
    .bind(owner)
    .fetch_optional(pool)
    .await
}

pub async fn list(pool: &PgPool) -> Result<Vec<Assignment>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT owner_user_id::text AS owner_user_id, account_id
        FROM portal_user_upstream_assignments
        "#,
    )
    .fetch_all(pool)
    .await
}

pub async fn list_account_ids(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT DISTINCT account_id FROM portal_user_upstream_assignments")
        .fetch_all(pool)
        .await
}

pub enum SetOutcome {
    Assigned,
    Cleared,
    /// The user or a usable login of the account does not exist.
    Unavailable,
}

/// Assigns `account_id` (or clears the assignment with `None`). The account
/// must have at least one login that is not disabled.
pub async fn set(
    pool: &PgPool,
    owner_user_id: &str,
    account_id: Option<&str>,
) -> Result<SetOutcome, sqlx::Error> {
    let Ok(owner) = Uuid::parse_str(owner_user_id.trim()) else {
        return Ok(SetOutcome::Unavailable);
    };
    let Some(account_id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM portal_users WHERE id = $1)")
                .bind(owner)
                .fetch_one(pool)
                .await?;
        if !exists {
            return Ok(SetOutcome::Unavailable);
        }
        sqlx::query("DELETE FROM portal_user_upstream_assignments WHERE owner_user_id = $1")
            .bind(owner)
            .execute(pool)
            .await?;
        return Ok(SetOutcome::Cleared);
    };
    let assigned = sqlx::query(
        r#"
        INSERT INTO portal_user_upstream_assignments (owner_user_id, account_id)
        SELECT users.id, $2
        FROM portal_users AS users
        WHERE users.id = $1
          AND EXISTS (
            SELECT 1 FROM openai_accounts
            WHERE account_id = $2 AND LOWER(TRIM(status)) <> 'disabled'
          )
        ON CONFLICT (owner_user_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          updated_at = now()
        "#,
    )
    .bind(owner)
    .bind(account_id)
    .execute(pool)
    .await?;
    Ok(if assigned.rows_affected() > 0 {
        SetOutcome::Assigned
    } else {
        SetOutcome::Unavailable
    })
}
