//! Upstream logins as the gateway uses them: user assignments, the row that
//! serves each (ChatGPT account, platform), and keeping tokens fresh.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

use super::client::{Credentials, UpstreamClient, UpstreamError};
use crate::auth::jwt::now_secs;
use crate::db;
use crate::db::accounts::Account;

/// Refresh access tokens this long before they expire.
const REFRESH_AHEAD_SECS: u64 = 2 * 24 * 60 * 60;
const REFRESH_SCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// `exp` of an upstream access token, read without verification.
pub fn token_expiry(access_token: &str) -> Option<u64> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("exp")?
        .as_u64()
}

pub struct AccountService {
    pool: PgPool,
    pub client: Arc<UpstreamClient>,
    assignments: RwLock<Option<HashMap<String, String>>>,
    rows: RwLock<HashMap<(String, String), Account>>,
    refresh_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl AccountService {
    pub fn new(pool: PgPool, client: Arc<UpstreamClient>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            client,
            assignments: RwLock::new(None),
            rows: RwLock::new(HashMap::new()),
            refresh_locks: Mutex::new(HashMap::new()),
        })
    }

    /// The ChatGPT account assigned to a user.
    pub async fn assigned_account(
        &self,
        owner_user_id: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        if let Some(map) = self.assignments.read().await.as_ref() {
            return Ok(map.get(owner_user_id).cloned());
        }
        let map: HashMap<String, String> = db::assignments::list(&self.pool)
            .await?
            .into_iter()
            .map(|a| (a.owner_user_id, a.account_id))
            .collect();
        let assigned = map.get(owner_user_id).cloned();
        *self.assignments.write().await = Some(map);
        Ok(assigned)
    }

    pub async fn invalidate_assignments(&self) {
        *self.assignments.write().await = None;
    }

    /// Drops cached rows after logins were added, changed or removed.
    pub async fn invalidate_rows(&self) {
        self.rows.write().await.clear();
    }

    /// The login serving `platform` for a ChatGPT account.
    pub async fn resolve(
        &self,
        account_id: &str,
        platform: &str,
    ) -> Result<Option<Account>, sqlx::Error> {
        let key = (account_id.to_string(), platform.to_string());
        if let Some(row) = self.rows.read().await.get(&key) {
            return Ok(Some(row.clone()));
        }
        let row = db::accounts::resolve_for_platform(&self.pool, account_id, platform).await?;
        if let Some(row) = &row {
            self.rows.write().await.insert(key, row.clone());
        }
        Ok(row)
    }

    /// Any usable login of the account, for requests that do not depend on
    /// the device (Codex sends them without a User-Agent).
    pub async fn resolve_any(&self, account_id: &str) -> Result<Option<Account>, sqlx::Error> {
        db::accounts::representative(&self.pool, account_id).await
    }

    async fn refresh_lock(&self, row_id: &str) -> Arc<Mutex<()>> {
        self.refresh_locks
            .lock()
            .await
            .entry(row_id.to_string())
            .or_default()
            .clone()
    }

    /// Replaces `failed_access_token` on a login. Concurrent callers share
    /// one refresh: whoever arrives after it sees the new token and reuses it.
    pub async fn refresh(
        &self,
        row_id: &str,
        failed_access_token: &str,
    ) -> Result<Account, UpstreamError> {
        let lock = self.refresh_lock(row_id).await;
        let _guard = lock.lock().await;
        let db_error = |e: sqlx::Error| UpstreamError {
            status: None,
            message: e.to_string(),
        };
        let current = db::accounts::get_by_id(&self.pool, row_id)
            .await
            .map_err(db_error)?
            .ok_or_else(|| UpstreamError {
                status: None,
                message: "Upstream account no longer exists".into(),
            })?;
        if current.access_token != failed_access_token {
            self.invalidate_rows().await;
            return Ok(current);
        }
        if current.refresh_token.trim().is_empty() {
            return Err(UpstreamError {
                status: None,
                message: "Missing refresh token for access token refresh".into(),
            });
        }
        let tokens = self
            .client
            .refresh_tokens(&current.refresh_token, current.platform())
            .await?;
        db::accounts::update_tokens(
            &self.pool,
            row_id,
            tokens.id_token.as_deref(),
            &tokens.access_token,
            tokens.refresh_token.as_deref(),
        )
        .await
        .map_err(db_error)?;
        self.invalidate_rows().await;
        info!(email = %current.email, platform = current.platform(), "refreshed upstream access token");
        db::accounts::get_by_id(&self.pool, row_id)
            .await
            .map_err(db_error)?
            .ok_or_else(|| UpstreamError {
                status: None,
                message: "Upstream account no longer exists".into(),
            })
    }

    /// Runs an upstream call, refreshing the token once if it was rejected.
    pub async fn call_with_refresh<T, F, Fut>(
        &self,
        account: &Account,
        call: F,
    ) -> Result<T, UpstreamError>
    where
        F: Fn(Account) -> Fut,
        Fut: std::future::Future<Output = Result<T, UpstreamError>>,
    {
        match call(account.clone()).await {
            Err(error) if error.is_unauthorized() => {
                let refreshed = self.refresh(&account.id, &account.access_token).await?;
                call(refreshed).await
            }
            result => result,
        }
    }

    pub async fn usage(&self, account: &Account) -> Result<serde_json::Value, UpstreamError> {
        self.call_with_refresh(account, |row| async move {
            self.client
                .usage(&Credentials {
                    access_token: &row.access_token,
                    account_id: &row.account_id,
                    platform: row.platform(),
                })
                .await
        })
        .await
    }

    /// Keeps every login's access token ahead of its expiry.
    pub fn spawn_refresher(self: &Arc<Self>) {
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(this) = service.upgrade() else {
                    return;
                };
                this.refresh_expiring().await;
                drop(this);
                tokio::time::sleep(REFRESH_SCAN_INTERVAL).await;
            }
        });
    }

    async fn refresh_expiring(&self) {
        let rows = match db::accounts::list_refreshable(&self.pool).await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(%error, "failed to list upstream accounts for refresh");
                return;
            }
        };
        let deadline = now_secs() + REFRESH_AHEAD_SECS;
        for row in rows {
            if token_expiry(&row.access_token).is_some_and(|exp| exp <= deadline)
                && let Err(error) = self.refresh(&row.id, &row.access_token).await
            {
                warn!(email = %row.email, %error, "proactive upstream token refresh failed");
            }
        }
    }
}
