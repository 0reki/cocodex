//! Configuration that becomes available at runtime: the database and the
//! signing secrets. Before Setup has written them the gateway runs in a
//! "setup required" state and every endpoint that needs them returns 503.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::{Mutex, OnceCell};
use tracing::{info, warn};

use crate::auth::jwt::ClientJwt;
use crate::auth::session::CodexClientSessionStore;
use crate::db;
use crate::db::users::PortalUser;
use crate::ipc::OwnerAuthCache;

const RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Values from the environment; anything missing is looked up in the Setup
/// config file on every initialization attempt.
#[derive(Clone, Default)]
pub struct Settings {
    pub database_url: Option<String>,
    pub admin_jwt_secret: Option<String>,
    pub client_jwt_secret: Option<String>,
    pub config_path: PathBuf,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("database_url", &self.database_url.as_ref().map(|_| "<set>"))
            .field("config_path", &self.config_path)
            .finish_non_exhaustive()
    }
}

/// `data/config.json` as written by Setup.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupConfigFile {
    version: u32,
    database_url: String,
    admin_jwt_secret: String,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl Settings {
    fn read_setup_file(&self) -> Option<SetupConfigFile> {
        let raw = std::fs::read_to_string(&self.config_path).ok()?;
        match serde_json::from_str::<SetupConfigFile>(&raw) {
            Ok(config) if config.version == 1 => Some(config),
            Ok(_) | Err(_) => {
                warn!(path = %self.config_path.display(), "ignoring invalid setup config");
                None
            }
        }
    }

    /// Environment values take precedence over the Setup config file.
    fn resolve(&self) -> Option<(String, String, String)> {
        let file = self.read_setup_file();
        let database_url = non_empty(self.database_url.clone())
            .or_else(|| non_empty(file.as_ref().map(|f| f.database_url.clone())))?;
        let admin_secret = non_empty(self.admin_jwt_secret.clone())
            .or_else(|| non_empty(file.as_ref().map(|f| f.admin_jwt_secret.clone())))?;
        let client_secret =
            non_empty(self.client_jwt_secret.clone()).unwrap_or_else(|| admin_secret.clone());
        Some((database_url, admin_secret, client_secret))
    }
}

pub struct Ready {
    pub db: PgPool,
    pub sessions: CodexClientSessionStore,
    pub portal_secret: Vec<u8>,
    owners: OwnerAuthCache,
}

#[derive(Debug)]
pub enum NotReady {
    /// Setup has not provided a database URL and admin secret yet.
    SetupRequired,
    Database(sqlx::Error),
}

impl std::fmt::Display for NotReady {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotReady::SetupRequired => write!(f, "setup required"),
            NotReady::Database(error) => write!(f, "database unavailable: {error}"),
        }
    }
}

pub enum OwnerStatus {
    Active(PortalUser),
    Unknown,
    Disabled(PortalUser),
    QuotaExceeded(PortalUser),
}

impl Ready {
    /// Checks that a portal user exists, is enabled and is under quota.
    /// Only active users are cached; admin changes evict them.
    pub async fn verify_owner(&self, owner_user_id: &str) -> Result<OwnerStatus, sqlx::Error> {
        if let Some(user) = self.owners.get(owner_user_id).await {
            return Ok(OwnerStatus::Active(user));
        }
        let Some(user) = db::users::find_by_id(&self.db, owner_user_id).await? else {
            return Ok(OwnerStatus::Unknown);
        };
        if !user.enabled {
            return Ok(OwnerStatus::Disabled(user));
        }
        if !user.within_quota {
            return Ok(OwnerStatus::QuotaExceeded(user));
        }
        self.owners.remember(user.clone()).await;
        Ok(OwnerStatus::Active(user))
    }
}

pub struct Runtime {
    settings: Settings,
    owners: OwnerAuthCache,
    ready: OnceCell<Arc<Ready>>,
    last_failure: Mutex<Option<Instant>>,
}

impl Runtime {
    pub fn new(settings: Settings, owners: OwnerAuthCache) -> Self {
        Self {
            settings,
            owners,
            ready: OnceCell::new(),
            last_failure: Mutex::new(None),
        }
    }

    /// Connects on first use. Failed attempts are retried at most every
    /// `RETRY_INTERVAL`, so a gateway started before Setup picks the
    /// configuration up once it has been written.
    pub async fn ready(&self) -> Result<Arc<Ready>, NotReady> {
        if let Some(ready) = self.ready.get() {
            return Ok(ready.clone());
        }
        let mut last_failure = self.last_failure.lock().await;
        if let Some(ready) = self.ready.get() {
            return Ok(ready.clone());
        }
        if last_failure.is_some_and(|at| at.elapsed() < RETRY_INTERVAL) {
            return Err(NotReady::SetupRequired);
        }
        match self.initialize().await {
            Ok(ready) => {
                *last_failure = None;
                let ready = Arc::new(ready);
                let _ = self.ready.set(ready.clone());
                info!("database connected and schema ready");
                Ok(ready)
            }
            Err(error) => {
                *last_failure = Some(Instant::now());
                Err(error)
            }
        }
    }

    async fn initialize(&self) -> Result<Ready, NotReady> {
        let (database_url, admin_secret, client_secret) =
            self.settings.resolve().ok_or(NotReady::SetupRequired)?;
        let pool = db::connect(&database_url)
            .await
            .map_err(NotReady::Database)?;
        db::ensure_schema(&pool).await.map_err(NotReady::Database)?;
        Ok(Ready {
            sessions: CodexClientSessionStore::with_jwt_and_db(
                ClientJwt::from_secret(client_secret),
                pool.clone(),
            ),
            db: pool,
            portal_secret: admin_secret.into_bytes(),
            owners: self.owners.clone(),
        })
    }
}
