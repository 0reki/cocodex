//! Gateway settings the console writes at runtime, as JSON documents keyed
//! by name. Each one is small and read on startup, so it is stored whole
//! rather than spread over columns.

use serde_json::Value;
use sqlx::PgPool;
use sqlx::Row;

pub async fn get(pool: &PgPool, key: &str) -> Result<Option<Value>, sqlx::Error> {
    let row = sqlx::query("SELECT value FROM gateway_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    row.map(|row| row.try_get::<Value, _>("value")).transpose()
}

pub async fn put(pool: &PgPool, key: &str, value: &Value) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO gateway_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .map(|_| ())
}
