#![allow(dead_code)]

use cocodex_proxy::runtime::Settings;
use sqlx::PgPool;
use uuid::Uuid;

pub const TEST_SECRET: &str = "test-client-jwt-secret";

/// A fresh schema in `TEST_DATABASE_URL` (default: the local docker
/// Postgres used for development), with `sql/init.sql` applied.
pub struct TestDb {
    pub pool: PgPool,
    pub url: String,
}

pub async fn test_db() -> TestDb {
    let base = std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://postgres:postgres@127.0.0.1:55432/cocodex_test".to_string()
    });
    let schema = format!("t_{}", Uuid::new_v4().simple());
    let admin = PgPool::connect(&base)
        .await
        .expect("TEST_DATABASE_URL must point at a reachable Postgres");
    // The schema name is generated above, never user input.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;

    let separator = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{separator}options=-c%20search_path%3D{schema}");
    let pool = cocodex_proxy::db::connect(&url).await.unwrap();
    cocodex_proxy::db::ensure_schema(&pool).await.unwrap();
    TestDb { pool, url }
}

impl TestDb {
    pub fn settings(&self) -> Settings {
        Settings {
            database_url: Some(self.url.clone()),
            admin_jwt_secret: Some(TEST_SECRET.to_string()),
            client_jwt_secret: None,
            config_path: "/nonexistent/config.json".into(),
        }
    }

    pub async fn create_user(&self, username: &str) -> String {
        sqlx::query_scalar::<_, String>(
            "INSERT INTO portal_users (username, password_hash) VALUES ($1, 'x') RETURNING id::text",
        )
        .bind(username)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

/// Settings for tests that never touch the database.
pub fn offline_settings() -> Settings {
    Settings {
        database_url: None,
        admin_jwt_secret: Some(TEST_SECRET.to_string()),
        client_jwt_secret: None,
        config_path: "/nonexistent/config.json".into(),
    }
}
