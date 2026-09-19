//! First-run setup: pick the database, create the first admin and persist
//! the configuration to the Setup config file.

use std::sync::atomic::{AtomicBool, Ordering};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::PgPool;

use super::{Body, no_store};
use crate::AppState;
use crate::auth::password;
use crate::db;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/setup/status", get(status))
        .route("/api/setup/complete", post(complete))
}

static SETUP_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn setup_error(status: StatusCode, code: &str, message: &str) -> Response {
    no_store(
        (
            status,
            Json(json!({ "error": { "code": code, "message": message } })),
        )
            .into_response(),
    )
}

struct Status {
    setup_required: bool,
    reason: Option<&'static str>,
    database_configured: bool,
    database_reachable: Option<bool>,
    admin_configured: Option<bool>,
}

impl Status {
    fn json(&self) -> serde_json::Value {
        json!({
            "setupRequired": self.setup_required,
            "reason": self.reason,
            "databaseConfigured": self.database_configured,
            "databaseReachable": self.database_reachable,
            "adminConfigured": self.admin_configured,
        })
    }
}

async fn connect_single(database_url: &str) -> Result<PgPool, sqlx::Error> {
    use std::str::FromStr;
    let options = sqlx::postgres::PgConnectOptions::from_str(database_url)?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect_with(options)
        .await?;
    Ok(pool)
}

async fn admin_configured(database_url: &str) -> Result<bool, sqlx::Error> {
    let pool = connect_single(database_url).await?;
    let table: Option<String> =
        sqlx::query_scalar("SELECT to_regclass(current_schema() || '.portal_users')::text")
            .fetch_one(&pool)
            .await?;
    let configured = match table {
        Some(_) => db::users::count(&pool).await? > 0,
        None => false,
    };
    pool.close().await;
    Ok(configured)
}

async fn read_status(state: &AppState) -> Status {
    let (database_url, secret_configured) = state.runtime.setup_view();
    let Some(database_url) = database_url else {
        return Status {
            setup_required: true,
            reason: Some("missing_database"),
            database_configured: false,
            database_reachable: Some(false),
            admin_configured: Some(false),
        };
    };
    // The admin secret is only persisted once setup succeeded, so it marks
    // completion; a database outage must not reopen setup.
    if secret_configured {
        return Status {
            setup_required: false,
            reason: None,
            database_configured: true,
            database_reachable: None,
            admin_configured: None,
        };
    }
    match admin_configured(&database_url).await {
        Err(_) => Status {
            setup_required: true,
            reason: Some("database_unreachable"),
            database_configured: true,
            database_reachable: Some(false),
            admin_configured: Some(false),
        },
        Ok(admin) => Status {
            setup_required: true,
            reason: Some(if admin || std::env::var("ADMIN_PASSWORD").is_ok() {
                "missing_jwt_secret"
            } else {
                "admin_missing"
            }),
            database_configured: true,
            database_reachable: Some(true),
            admin_configured: Some(admin),
        },
    }
}

async fn status(State(state): State<AppState>) -> Response {
    no_store(Json(read_status(&state).await.json()).into_response())
}

fn valid_database_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "postgres" | "postgresql"))
}

async fn initialize_database(
    database_url: &str,
    username: &str,
    admin_password: &str,
) -> Result<(), Response> {
    let failed = |error: sqlx::Error| {
        setup_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "setup_failed",
            &error.to_string(),
        )
    };
    let pool = crate::db::connect(database_url).await.map_err(failed)?;
    db::ensure_schema(&pool).await.map_err(failed)?;
    let mut tx = pool.begin().await.map_err(failed)?;
    db::users::lock_seats(&mut tx).await.map_err(failed)?;
    let (users, _) = db::users::seat_usage(&mut tx).await.map_err(failed)?;
    if users == 0 {
        let hash = password::hash(admin_password.to_string()).await;
        db::users::insert(&mut tx, username, &hash, "admin")
            .await
            .map_err(failed)?;
    } else {
        let existing = db::users::get_by_username(&pool, username)
            .await
            .map_err(failed)?;
        let valid = match existing {
            Some(admin) if admin.is_admin() && admin.enabled => {
                password::verify(admin_password.to_string(), admin.password_hash).await
            }
            _ => false,
        };
        if !valid {
            return Err(setup_error(
                StatusCode::CONFLICT,
                "database_already_initialized",
                "该数据库已经初始化，请输入现有管理员账号和密码",
            ));
        }
    }
    tx.commit().await.map_err(failed)?;
    pool.close().await;
    Ok(())
}

async fn complete(State(state): State<AppState>, body: Body) -> Response {
    if SETUP_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return setup_error(
            StatusCode::CONFLICT,
            "setup_in_progress",
            "初始化正在进行中",
        );
    }
    let result = run_setup(&state, body).await;
    SETUP_IN_PROGRESS.store(false, Ordering::SeqCst);
    result.unwrap_or_else(|response| response)
}

async fn run_setup(state: &AppState, body: Body) -> Result<Response, Response> {
    let current = read_status(state).await;
    if !current.setup_required {
        return Err(setup_error(
            StatusCode::CONFLICT,
            "setup_already_complete",
            "初始化已经完成",
        ));
    }
    let database_url = if current.database_configured {
        state.runtime.setup_view().0.unwrap_or_default()
    } else {
        body.str("databaseUrl")
    };
    if database_url.is_empty() {
        return Err(setup_error(
            StatusCode::BAD_REQUEST,
            "database_url_required",
            "数据库地址不能为空",
        ));
    }
    if !valid_database_url(&database_url) {
        return Err(setup_error(
            StatusCode::BAD_REQUEST,
            "database_url_invalid",
            "数据库地址必须是有效的 PostgreSQL URL",
        ));
    }
    let username = body.str("adminUsername").to_lowercase();
    if username.is_empty() {
        return Err(setup_error(
            StatusCode::BAD_REQUEST,
            "admin_username_required",
            "管理员用户名不能为空",
        ));
    }
    if username.chars().count() > 80 {
        return Err(setup_error(
            StatusCode::BAD_REQUEST,
            "admin_username_invalid",
            "管理员用户名不能超过 80 个字符",
        ));
    }
    let admin_password = body.raw("adminPassword");
    if password::validation_error(&admin_password).is_some() {
        let code = if admin_password.encode_utf16().count() < password::MIN_LENGTH {
            "admin_password_too_short"
        } else {
            "admin_password_too_long"
        };
        return Err(setup_error(
            StatusCode::BAD_REQUEST,
            code,
            &format!(
                "管理员密码长度必须在 {} 到 {} 个字符之间",
                password::MIN_LENGTH,
                password::MAX_LENGTH
            ),
        ));
    }

    initialize_database(&database_url, &username, &admin_password).await?;
    state
        .runtime
        .persist_setup(&database_url)
        .map_err(|error| setup_error(StatusCode::INTERNAL_SERVER_ERROR, "setup_failed", &error))?;
    Ok(no_store(
        (
            StatusCode::CREATED,
            Json(json!({ "ok": true, "redirectTo": "/login" })),
        )
            .into_response(),
    ))
}
