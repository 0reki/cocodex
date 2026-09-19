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
            config_path: scratch_dir().join("config.json"),
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
        config_path: scratch_dir().join("config.json"),
    }
}

/// A fresh directory for per-test state such as the settlement log.
pub fn scratch_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cocodex-test-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Gateway configuration pointing upstream calls at `origin`.
pub fn config(settings: Settings, origin: &str) -> cocodex_proxy::config::ProxyConfig {
    cocodex_proxy::config::ProxyConfig {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        upstream_chatgpt_origin: origin.to_string(),
        upstream_auth_origin: origin.to_string(),
        public_app_url: "http://localhost:53332".to_string(),
        settings,
    }
}

/// Pins the impersonated Codex version so tests never ask GitHub.
pub fn pin_codex_version() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    // SAFETY: set once, before any test reads the environment variables.
    // The pinned egress locale keeps tests off the geolocation network and
    // makes the presented timezone deterministic.
    ONCE.call_once(|| unsafe {
        std::env::set_var("CODEX_CLIENT_VERSION", "0.154.0");
        std::env::set_var("COCODEX_EGRESS_LOCALE", "America/New_York|-14400");
    });
}

impl TestDb {
    pub async fn insert_account(
        &self,
        email: &str,
        account_id: &str,
        platform: &str,
        token: &str,
    ) -> String {
        sqlx::query_scalar::<_, String>(
            r#"
            INSERT INTO openai_accounts (
              email, account_id, status, platform, id_token, access_token, refresh_token
            )
            VALUES ($1, $2, 'active', $3, 'id-token', $4, $5)
            RETURNING id::text
            "#,
        )
        .bind(email)
        .bind(account_id)
        .bind(platform)
        .bind(token)
        .bind(format!("refresh-{token}"))
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// Gives the logins of `account_id` an ID token naming their ChatGPT
    /// user, as a real OpenAI login has.
    pub async fn set_upstream_user_id(&self, account_id: &str, user_id: &str) {
        use base64::Engine;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;

        let claims = serde_json::json!({
            "https://api.openai.com/auth": { "chatgpt_user_id": user_id }
        });
        let id_token = format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(claims.to_string().as_bytes())
        );
        sqlx::query("UPDATE openai_accounts SET id_token = $1 WHERE account_id = $2")
            .bind(id_token)
            .bind(account_id)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    pub async fn assign(&self, owner_user_id: &str, account_id: &str) {
        sqlx::query(
            "INSERT INTO portal_user_upstream_assignments (owner_user_id, account_id) VALUES ($1::uuid, $2)",
        )
        .bind(owner_user_id)
        .bind(account_id)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// A Codex client bearer token with a live session for the user.
    pub async fn client_bearer(&self, user_id: &str) -> String {
        let jwt = cocodex_proxy::auth::jwt::ClientJwt::from_secret(TEST_SECRET);
        let tokens = jwt.sign_session_tokens(user_id, "user@openai.com");
        let session_id = jwt
            .verify_access_token(&tokens.access_token)
            .unwrap()
            .session_id;
        cocodex_proxy::db::client_sessions::store(
            &self.pool,
            &format!("hash-{session_id}"),
            user_id,
            "user@openai.com",
            &session_id,
            cocodex_proxy::auth::jwt::now_secs() + 86_400,
        )
        .await
        .unwrap();
        format!("Bearer {}", tokens.access_token)
    }
}
