//! Configuration that becomes available at runtime (the database and the
//! signing secrets) and the services built on it. Before Setup has written
//! them the gateway runs in a "setup required" state and every endpoint that
//! needs them returns 503.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::{Mutex, OnceCell};
use tracing::{info, warn};

use crate::auth::jwt::ClientJwt;
use crate::auth::owner_cache::OwnerAuthCache;
use crate::auth::session::CodexClientSessionStore;
use crate::billing::pricing::Pricing;
use crate::billing::settlement::{SettlementConfig, SettlementQueue};
use crate::db;
use crate::db::users::PortalUser;
use crate::quota::QuotaService;
use crate::turn_state::TurnStateStore;
use crate::upstream::accounts::AccountService;
use crate::upstream::client::UpstreamClient;

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
    /// Directory for runtime state such as the settlement log.
    pub fn data_dir(&self) -> PathBuf {
        self.config_path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }

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

    fn database_url(&self, file: Option<&SetupConfigFile>) -> Option<String> {
        non_empty(self.database_url.clone())
            .or_else(|| non_empty(file.map(|f| f.database_url.clone())))
    }

    fn admin_secret(&self, file: Option<&SetupConfigFile>) -> Option<String> {
        non_empty(self.admin_jwt_secret.clone())
            .or_else(|| non_empty(file.map(|f| f.admin_jwt_secret.clone())))
    }

    /// Environment values take precedence over the Setup config file.
    fn resolve(&self) -> Option<(String, String, String)> {
        let file = self.read_setup_file();
        let database_url = self.database_url(file.as_ref())?;
        let admin_secret = self.admin_secret(file.as_ref())?;
        let client_secret =
            non_empty(self.client_jwt_secret.clone()).unwrap_or_else(|| admin_secret.clone());
        Some((database_url, admin_secret, client_secret))
    }
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

/// Everything that needs the database.
pub struct Ready {
    pub db: PgPool,
    pub sessions: CodexClientSessionStore,
    pub portal_secret: Vec<u8>,
    pub accounts: Arc<AccountService>,
    pub quota: Arc<QuotaService>,
    pub settlements: Arc<SettlementQueue>,
    pub pricing: Arc<Pricing>,
    pub turn_state: Arc<TurnStateStore>,
    owners: OwnerAuthCache,
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

    pub async fn evict_owner(&self, owner_user_id: &str) {
        self.owners.invalidate(owner_user_id).await;
    }
}

pub struct Runtime {
    settings: Settings,
    upstream: Arc<UpstreamClient>,
    pricing: Arc<Pricing>,
    owners: OwnerAuthCache,
    /// Built before the database is reachable, because the proxy path reads
    /// it on every request; its console settings arrive with `ready()`.
    turn_state: Arc<TurnStateStore>,
    ready: OnceCell<Arc<Ready>>,
    last_failure: Mutex<Option<Instant>>,
}

impl Runtime {
    pub fn new(settings: Settings, upstream: Arc<UpstreamClient>, pricing: Pricing) -> Self {
        Self {
            settings,
            upstream,
            pricing: Arc::new(pricing),
            owners: OwnerAuthCache::default(),
            turn_state: Arc::new(TurnStateStore::default()),
            ready: OnceCell::new(),
            last_failure: Mutex::new(None),
        }
    }

    /// The turn states held per upstream login, which the proxy path reads
    /// without waiting for the database.
    pub fn turn_state(&self) -> &Arc<TurnStateStore> {
        &self.turn_state
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
        let settlements = SettlementQueue::start(
            pool.clone(),
            self.owners.clone(),
            SettlementConfig::from_env(&self.settings.data_dir()),
        )
        .await
        .map_err(|error| NotReady::Database(sqlx::Error::Io(error)))?;
        let accounts = AccountService::new(pool.clone(), self.upstream.clone());
        accounts.spawn_refresher();
        let quota = QuotaService::new(pool.clone(), accounts.clone());
        quota.spawn_sync_loop();
        self.turn_state.load(&pool).await;
        crate::turn_state::probe::spawn(&self.turn_state, &accounts);
        Ok(Ready {
            sessions: CodexClientSessionStore::with_jwt_and_db(
                ClientJwt::from_secret(client_secret),
                pool.clone(),
            ),
            db: pool,
            portal_secret: admin_secret.into_bytes(),
            accounts,
            quota,
            settlements,
            pricing: self.pricing.clone(),
            turn_state: self.turn_state.clone(),
            owners: self.owners.clone(),
        })
    }

    /// `(database URL, whether the admin secret is configured)` for Setup.
    pub fn setup_view(&self) -> (Option<String>, bool) {
        let file = self.settings.read_setup_file();
        (
            self.settings.database_url(file.as_ref()),
            self.settings.admin_secret(file.as_ref()).is_some(),
        )
    }

    /// Writes the Setup config file (mode 0600, atomically) so the next
    /// `ready()` connects. The admin secret is generated unless configured.
    pub fn persist_setup(&self, database_url: &str) -> Result<(), String> {
        let secret = non_empty(self.settings.admin_jwt_secret.clone()).unwrap_or_else(|| {
            let mut bytes = [0u8; 48];
            rand::thread_rng().fill_bytes(&mut bytes);
            URL_SAFE_NO_PAD.encode(bytes)
        });
        let config = serde_json::json!({
            "version": 1,
            "databaseUrl": database_url,
            "adminJwtSecret": secret,
            "configuredAt": db::iso(chrono::Utc::now()),
        });
        write_private_file(
            &self.settings.config_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&config).unwrap_or_default()
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
        if let Ok(mut last_failure) = self.last_failure.try_lock() {
            *last_failure = None;
        }
        Ok(())
    }

    /// Flushes queued settlements before the process exits.
    pub async fn shutdown(&self) {
        if let Some(ready) = self.ready.get() {
            ready.settlements.shutdown().await;
        }
    }
}

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config"),
        std::process::id()
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        if dir != Path::new(".") {
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
