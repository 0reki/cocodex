use chrono::{DateTime, Utc};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

/// Portal user as the gateway checks it on every request.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PortalUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub enabled: bool,
    /// `quota IS NULL OR used < quota`, computed in SQL to avoid NUMERIC decoding.
    pub within_quota: bool,
}

/// Full portal user row for the management API.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PortalUserRecord {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub enabled: bool,
    pub quota: Option<f64>,
    pub used: f64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl PortalUserRecord {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }

    pub fn role(&self) -> &'static str {
        if self.is_admin() { "admin" } else { "user" }
    }
}

/// Four user seats; each assigned user gets a quarter of the upstream quota.
pub const MAX_PORTAL_USERS: i64 = 4;
const SEAT_LOCK_KEY: i64 = 8_453_201_114_258;

const RECORD_COLUMNS: &str = "id::text AS id, username, password_hash, role, enabled, \
    quota::float8 AS quota, used::float8 AS used, created_at, updated_at";

#[derive(Debug)]
pub enum UserWriteError {
    SeatLimitReached,
    UsernameTaken,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for UserWriteError {
    fn from(error: sqlx::Error) -> Self {
        if error
            .as_database_error()
            .is_some_and(|db| db.code().as_deref() == Some("23505"))
        {
            UserWriteError::UsernameTaken
        } else {
            UserWriteError::Database(error)
        }
    }
}

fn parse_id(id: &str) -> Option<Uuid> {
    Uuid::parse_str(id.trim()).ok()
}

pub async fn find_by_id(pool: &PgPool, id: &str) -> Result<Option<PortalUser>, sqlx::Error> {
    let Some(id) = parse_id(id) else {
        return Ok(None);
    };
    sqlx::query_as::<_, PortalUser>(
        r#"
        SELECT
          id::text AS id,
          username,
          role,
          enabled,
          (quota IS NULL OR used < quota) AS within_quota
        FROM portal_users
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn get_record(pool: &PgPool, id: &str) -> Result<Option<PortalUserRecord>, sqlx::Error> {
    let Some(id) = parse_id(id) else {
        return Ok(None);
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {RECORD_COLUMNS} FROM portal_users WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn get_by_username(
    pool: &PgPool,
    username: &str,
) -> Result<Option<PortalUserRecord>, sqlx::Error> {
    let username = username.trim().to_lowercase();
    if username.is_empty() {
        return Ok(None);
    }
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {RECORD_COLUMNS} FROM portal_users WHERE LOWER(username) = $1 LIMIT 1"
    )))
    .bind(username)
    .fetch_optional(pool)
    .await
}

pub async fn list(pool: &PgPool) -> Result<Vec<PortalUserRecord>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {RECORD_COLUMNS} FROM portal_users ORDER BY created_at ASC"
    )))
    .fetch_all(pool)
    .await
}

pub async fn count(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT COUNT(*) FROM portal_users")
        .fetch_one(pool)
        .await
}

/// Serializes seat accounting across concurrent registrations.
pub async fn lock_seats(conn: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SEAT_LOCK_KEY)
        .execute(conn)
        .await?;
    Ok(())
}

/// `(users, unused unexpired invitations)`.
pub async fn seat_usage(conn: &mut PgConnection) -> Result<(i64, i64), sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT
          (SELECT COUNT(*) FROM portal_users),
          (SELECT COUNT(*) FROM portal_user_invitations
            WHERE used_at IS NULL AND expires_at > now())
        "#,
    )
    .fetch_one(conn)
    .await
}

pub async fn insert(
    conn: &mut PgConnection,
    username: &str,
    password_hash: &str,
    role: &str,
) -> Result<PortalUserRecord, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO portal_users (username, password_hash, role, enabled)
        VALUES ($1, $2, $3, true)
        RETURNING {RECORD_COLUMNS}
        "#
    )))
    .bind(username.trim().to_lowercase())
    .bind(password_hash.trim())
    .bind(role)
    .fetch_one(conn)
    .await
}

/// Creates a regular user, respecting the seat limit.
pub async fn create_user(
    pool: &PgPool,
    username: &str,
    password_hash: &str,
) -> Result<PortalUserRecord, UserWriteError> {
    let mut tx = pool.begin().await?;
    lock_seats(&mut tx).await?;
    let (users, invitations) = seat_usage(&mut tx).await?;
    if users + invitations >= MAX_PORTAL_USERS {
        return Err(UserWriteError::SeatLimitReached);
    }
    let user = insert(&mut tx, username, password_hash, "user").await?;
    tx.commit().await?;
    Ok(user)
}

/// Creates the first admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` when the
/// table is empty, as the Node backend did on the first login.
pub async fn ensure_bootstrap_admin(pool: &PgPool) -> Result<(), String> {
    if count(pool).await.map_err(|e| e.to_string())? > 0 {
        return Ok(());
    }
    let username = std::env::var("ADMIN_USERNAME")
        .unwrap_or_else(|_| "admin".to_string())
        .trim()
        .to_lowercase();
    let password = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
    if username.is_empty() || password.is_empty() {
        return Err("Configure ADMIN_USERNAME and ADMIN_PASSWORD before the first login".into());
    }
    if get_by_username(pool, &username)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok(());
    }
    let hash = crate::auth::password::hash(password).await;
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
    insert(&mut conn, &username, &hash, "admin")
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

async fn update_returning(
    pool: &PgPool,
    id: &str,
    set_sql: &str,
    bind: impl FnOnce(
        sqlx::query::QueryAs<'_, sqlx::Postgres, PortalUserRecord, sqlx::postgres::PgArguments>,
    ) -> sqlx::query::QueryAs<
        '_,
        sqlx::Postgres,
        PortalUserRecord,
        sqlx::postgres::PgArguments,
    >,
) -> Result<Option<PortalUserRecord>, UserWriteError> {
    let Some(id) = parse_id(id) else {
        return Ok(None);
    };
    let sql = format!("UPDATE portal_users SET {set_sql} WHERE id = $1 RETURNING {RECORD_COLUMNS}");
    let query = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(id);
    Ok(bind(query).fetch_optional(pool).await?)
}

pub async fn update_username(
    pool: &PgPool,
    id: &str,
    username: &str,
) -> Result<Option<PortalUserRecord>, UserWriteError> {
    let username = username.trim().to_lowercase();
    update_returning(pool, id, "username = $2", |q| q.bind(username)).await
}

pub async fn update_password(
    pool: &PgPool,
    id: &str,
    password_hash: &str,
) -> Result<Option<PortalUserRecord>, UserWriteError> {
    let hash = password_hash.trim().to_string();
    update_returning(pool, id, "password_hash = $2", |q| q.bind(hash)).await
}

pub async fn set_enabled(
    pool: &PgPool,
    id: &str,
    enabled: bool,
) -> Result<Option<PortalUserRecord>, UserWriteError> {
    update_returning(pool, id, "enabled = $2", |q| q.bind(enabled)).await
}

/// `quota` is a decimal string such as `"10.00000000"`, or `None` for unlimited.
pub async fn update_quota(
    pool: &PgPool,
    id: &str,
    quota: Option<String>,
) -> Result<Option<PortalUserRecord>, UserWriteError> {
    update_returning(pool, id, "quota = $2::numeric", |q| q.bind(quota)).await
}
