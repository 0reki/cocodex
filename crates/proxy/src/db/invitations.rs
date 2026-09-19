use chrono::{DateTime, Utc};
use sqlx::PgPool;

use super::users::{self, MAX_PORTAL_USERS, PortalUserRecord};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Invitation {
    pub id: String,
    pub invited_by_user_id: String,
    pub registered_user_id: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

const COLUMNS: &str = "id::text AS id, invited_by_user_id::text AS invited_by_user_id, \
    registered_user_id::text AS registered_user_id, expires_at, used_at, created_at";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationError {
    Invalid,
    Expired,
    Used,
    UserLimitReached,
}

impl InvitationError {
    pub fn code(self) -> &'static str {
        match self {
            InvitationError::Invalid => "invitation_invalid",
            InvitationError::Expired => "invitation_expired",
            InvitationError::Used => "invitation_used",
            InvitationError::UserLimitReached => "user_limit_reached",
        }
    }
}

#[derive(Debug)]
pub enum RegisterError {
    Invitation(InvitationError),
    UsernameTaken,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for RegisterError {
    fn from(error: sqlx::Error) -> Self {
        match users::UserWriteError::from(error) {
            users::UserWriteError::UsernameTaken => RegisterError::UsernameTaken,
            users::UserWriteError::Database(error) => RegisterError::Database(error),
            users::UserWriteError::SeatLimitReached => {
                RegisterError::Invitation(InvitationError::UserLimitReached)
            }
        }
    }
}

fn check(invitation: &Invitation) -> Result<(), InvitationError> {
    if invitation.used_at.is_some() {
        return Err(InvitationError::Used);
    }
    if invitation.expires_at <= Utc::now() {
        return Err(InvitationError::Expired);
    }
    Ok(())
}

pub enum CreateError {
    UserLimitReached,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for CreateError {
    fn from(error: sqlx::Error) -> Self {
        CreateError::Database(error)
    }
}

pub async fn create(
    pool: &PgPool,
    token_hash: &str,
    invited_by_user_id: &str,
    expires_at: DateTime<Utc>,
) -> Result<Invitation, CreateError> {
    let mut tx = pool.begin().await?;
    users::lock_seats(&mut tx).await?;
    let (users, invitations) = users::seat_usage(&mut tx).await?;
    if users + invitations >= MAX_PORTAL_USERS {
        return Err(CreateError::UserLimitReached);
    }
    let invitation = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO portal_user_invitations (token_hash, invited_by_user_id, expires_at)
        VALUES ($1, $2::uuid, $3)
        RETURNING {COLUMNS}
        "#
    )))
    .bind(token_hash)
    .bind(invited_by_user_id)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(invitation)
}

pub async fn inspect(
    pool: &PgPool,
    token_hash: &str,
) -> Result<Result<Invitation, InvitationError>, sqlx::Error> {
    let invitation: Option<Invitation> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM portal_user_invitations WHERE token_hash = $1 LIMIT 1"
    )))
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    Ok(match invitation {
        None => Err(InvitationError::Invalid),
        Some(invitation) => check(&invitation).map(|()| invitation),
    })
}

/// Consumes an invitation and creates a regular user in one transaction.
pub async fn register(
    pool: &PgPool,
    token_hash: &str,
    username: &str,
    password_hash: &str,
) -> Result<PortalUserRecord, RegisterError> {
    let mut tx = pool.begin().await?;
    users::lock_seats(&mut tx).await?;
    let invitation: Invitation = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM portal_user_invitations WHERE token_hash = $1 FOR UPDATE"
    )))
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(RegisterError::Invitation(InvitationError::Invalid))?;
    check(&invitation).map_err(RegisterError::Invitation)?;

    let (users, _) = users::seat_usage(&mut tx).await?;
    if users >= MAX_PORTAL_USERS {
        return Err(RegisterError::Invitation(InvitationError::UserLimitReached));
    }
    let user = users::insert(&mut tx, username, password_hash, "user").await?;
    sqlx::query(
        r#"
        UPDATE portal_user_invitations
        SET used_at = now(), registered_user_id = $2::uuid
        WHERE id = $1::uuid
        "#,
    )
    .bind(&invitation.id)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(user)
}
