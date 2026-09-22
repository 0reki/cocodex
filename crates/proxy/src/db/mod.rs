//! Postgres access. The schema lives in `sql/init.sql` and is applied on
//! startup, exactly as the Node backend did.

pub mod accounts;
pub mod assignments;
pub mod client_sessions;
pub mod invitations;
pub mod logs;
pub mod quota;
pub mod settings;
pub mod settlements;
pub mod users;

use std::str::FromStr;
use std::time::Duration;

use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::{PgConnection, PgPool};

/// Timestamps as JavaScript's `toISOString()` renders them, which is what
/// the console has always received.
pub fn iso(at: chrono::DateTime<chrono::Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) const INIT_SCHEMA_SQL: &str = include_str!("../../../../sql/init.sql");
/// Shared with the Node backend so both never run the schema concurrently.
const SCHEMA_INIT_LOCK_KEY: i64 = 8_453_201_114_257;

fn env_millis(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    connect_with(PgConnectOptions::from_str(database_url)?).await
}

pub async fn connect_with(mut options: PgConnectOptions) -> Result<PgPool, sqlx::Error> {
    if std::env::var("PG_SSL_MODE").is_ok_and(|mode| mode.trim() == "require") {
        options = options.ssl_mode(PgSslMode::Require);
    }
    let statement_timeout = env_millis("PG_STATEMENT_TIMEOUT_MS", 15_000);
    let lock_timeout = env_millis("PG_LOCK_TIMEOUT_MS", 5_000);
    options = options.options([
        ("statement_timeout", statement_timeout.to_string()),
        ("lock_timeout", lock_timeout.to_string()),
    ]);

    PgPoolOptions::new()
        .max_connections(env_millis("PG_POOL_MAX", 10) as u32)
        .idle_timeout(Duration::from_millis(env_millis(
            "PG_IDLE_TIMEOUT_MS",
            30_000,
        )))
        .acquire_timeout(Duration::from_millis(env_millis(
            "PG_CONNECTION_TIMEOUT_MS",
            5_000,
        )))
        .connect_with(options)
        .await
}

/// Applies `sql/init.sql` when it changed since the last run. The script is
/// idempotent, but its DDL takes exclusive table locks, so re-running it on
/// every start would stall (or deadlock with) live traffic.
pub async fn ensure_schema(pool: &PgPool) -> Result<(), sqlx::Error> {
    let digest: String = Sha256::digest(INIT_SCHEMA_SQL.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(SCHEMA_INIT_LOCK_KEY)
        .execute(&mut *conn)
        .await?;
    let applied = apply_if_changed(&mut conn, &digest).await;
    let unlocked = sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(SCHEMA_INIT_LOCK_KEY)
        .execute(&mut *conn)
        .await;
    applied?;
    unlocked?;
    Ok(())
}

async fn apply_if_changed(conn: &mut PgConnection, digest: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS cocodex_schema_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          init_sql_sha256 TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        "#,
    )
    .execute(&mut *conn)
    .await?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT init_sql_sha256 FROM cocodex_schema_state WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await?;
    if current.as_deref() == Some(digest) {
        return Ok(());
    }
    sqlx::raw_sql(INIT_SCHEMA_SQL).execute(&mut *conn).await?;
    sqlx::query(
        r#"
        INSERT INTO cocodex_schema_state (id, init_sql_sha256) VALUES (1, $1)
        ON CONFLICT (id) DO UPDATE SET init_sql_sha256 = $1, applied_at = now()
        "#,
    )
    .bind(digest)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
