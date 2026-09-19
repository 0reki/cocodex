//! Per-user share of an upstream ChatGPT account's weekly quota.
//!
//! Each user may consume at most `USER_QUOTA_PERCENT` of the account's
//! weekly window. A user's share is the window's `used_percent` split by the
//! usage (USD) each assigned user recorded in that window.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::sync::{Mutex, RwLock};
use tracing::warn;

use crate::auth::jwt::now_secs;
use crate::billing::usd::Usd;
use crate::db;
use crate::upstream::accounts::AccountService;
use crate::upstream::usage_summary::{RateLimit, Window};

pub const USER_QUOTA_PERCENT: f64 = 25.0;

#[derive(Debug, Clone, Default)]
struct Snapshot {
    reset_at: i64,
    used_percent: f64,
    usage: HashMap<String, f64>,
    updated_at: String,
}

impl Snapshot {
    fn total(&self) -> f64 {
        self.usage.values().sum()
    }

    fn allocated_percent(&self, owner: &str) -> f64 {
        let total = self.total();
        if total <= 0.0 {
            return 0.0;
        }
        self.used_percent * self.usage.get(owner).copied().unwrap_or(0.0) / total
    }

    fn is_current(&self) -> bool {
        self.reset_at > now_secs() as i64
    }
}

pub struct QuotaDecision {
    pub allowed: bool,
    pub allocated_percent: f64,
    pub reset_at: Option<i64>,
}

pub struct QuotaService {
    pool: PgPool,
    accounts: Arc<AccountService>,
    snapshots: RwLock<HashMap<String, Snapshot>>,
    dirty: Mutex<HashSet<String>>,
    syncing: Mutex<HashSet<String>>,
}

impl QuotaService {
    pub fn new(pool: PgPool, accounts: Arc<AccountService>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            accounts,
            snapshots: RwLock::new(HashMap::new()),
            dirty: Mutex::new(HashSet::new()),
            syncing: Mutex::new(HashSet::new()),
        })
    }

    /// Whether the user may start another billable request. Without a
    /// current window reading the request is let through and a sync starts.
    pub async fn check(self: &Arc<Self>, account_id: &str, owner: &str) -> QuotaDecision {
        let snapshot = self.snapshots.read().await.get(account_id).cloned();
        match snapshot {
            Some(snapshot) if snapshot.is_current() => {
                let allocated = snapshot.allocated_percent(owner);
                QuotaDecision {
                    allowed: allocated < USER_QUOTA_PERCENT,
                    allocated_percent: allocated,
                    reset_at: Some(snapshot.reset_at),
                }
            }
            _ => {
                self.sync_in_background(account_id);
                QuotaDecision {
                    allowed: true,
                    allocated_percent: 0.0,
                    reset_at: None,
                }
            }
        }
    }

    fn sync_in_background(self: &Arc<Self>, account_id: &str) {
        let this = self.clone();
        let account_id = account_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = this.sync(&account_id).await {
                warn!(%account_id, %error, "upstream quota sync failed");
            }
        });
    }

    /// Reads the account's weekly window from upstream and reloads usage.
    pub async fn sync(&self, account_id: &str) -> Result<Option<Window>, String> {
        {
            let mut syncing = self.syncing.lock().await;
            if !syncing.insert(account_id.to_string()) {
                return Ok(None);
            }
        }
        let result = self.sync_inner(account_id).await;
        self.syncing.lock().await.remove(account_id);
        result
    }

    async fn sync_inner(&self, account_id: &str) -> Result<Option<Window>, String> {
        let Some(account) = db::accounts::representative(&self.pool, account_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let usage = self.accounts.usage(&account).await.map_err(|e| e.message)?;
        let Some(weekly) = RateLimit::from_usage(&usage).weekly() else {
            return Ok(None);
        };
        self.store_window(account_id, weekly).await?;
        Ok(Some(weekly))
    }

    async fn store_window(&self, account_id: &str, weekly: Window) -> Result<(), String> {
        let window =
            db::quota::sync_window(&self.pool, account_id, weekly.reset_at, weekly.used_percent)
                .await
                .map_err(|e| e.to_string())?;
        let usage = db::quota::usage_by_user(&self.pool, account_id, window.reset_at)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        self.snapshots.write().await.insert(
            account_id.to_string(),
            Snapshot {
                reset_at: window.reset_at,
                used_percent: window.used_percent,
                usage,
                updated_at: db::iso(window.updated_at),
            },
        );
        Ok(())
    }

    /// Counts a finished billable request against the user's share.
    pub async fn record(
        self: &Arc<Self>,
        settlement_id: &str,
        account_id: &str,
        owner: &str,
        amount: Usd,
    ) {
        if amount.0 <= 0 {
            return;
        }
        self.dirty.lock().await.insert(account_id.to_string());
        let reset_at = {
            let mut snapshots = self.snapshots.write().await;
            match snapshots.get_mut(account_id).filter(|s| s.is_current()) {
                Some(snapshot) => {
                    *snapshot.usage.entry(owner.to_string()).or_default() += amount.to_f64();
                    Some(snapshot.reset_at)
                }
                None => None,
            }
        };
        let reset_at = match reset_at {
            Some(reset_at) => reset_at,
            None => match self.sync(account_id).await {
                Ok(_) => match self.snapshots.read().await.get(account_id) {
                    Some(snapshot) if snapshot.is_current() => snapshot.reset_at,
                    _ => return,
                },
                Err(error) => {
                    warn!(%account_id, %error, "cannot record quota usage without a window");
                    return;
                }
            },
        };
        if let Err(error) = db::quota::record_usage(
            &self.pool,
            settlement_id,
            account_id,
            reset_at,
            owner,
            &amount.to_string(),
        )
        .await
        {
            warn!(%account_id, %error, "failed to persist quota usage");
        }
    }

    /// Re-reads upstream usage for accounts that saw traffic.
    pub fn spawn_sync_loop(self: &Arc<Self>) {
        let interval = Duration::from_millis(
            std::env::var("UPSTREAM_QUOTA_REFRESH_INTERVAL_MS")
                .ok()
                .and_then(|v| v.trim().parse::<u64>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(30_000),
        );
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            if let Some(this) = service.upgrade() {
                match db::assignments::list_account_ids(&this.pool).await {
                    Ok(ids) => {
                        for id in ids {
                            if let Err(error) = this.sync(&id).await {
                                warn!(account_id = %id, %error, "startup quota sync failed");
                            }
                        }
                    }
                    Err(error) => warn!(%error, "failed to list assigned accounts"),
                }
                let _ = db::quota::prune_settlements(&this.pool).await;
            }
            loop {
                tokio::time::sleep(interval).await;
                let Some(this) = service.upgrade() else {
                    return;
                };
                let dirty: Vec<String> = this.dirty.lock().await.drain().collect();
                for id in dirty {
                    if let Err(error) = this.sync(&id).await {
                        warn!(account_id = %id, %error, "quota sync failed");
                        this.dirty.lock().await.insert(id);
                    }
                }
            }
        });
    }

    /// The console's view of the user's share, read live from upstream.
    pub async fn summary(&self, account_id: &str, owner: &str) -> Result<Value, String> {
        let account = db::accounts::representative(&self.pool, account_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("upstream_account_unassigned")?;
        let usage = self.accounts.usage(&account).await.map_err(|e| e.message)?;
        let rate_limit = RateLimit::from_usage(&usage);
        let Some(weekly) = rate_limit.weekly() else {
            return Ok(json!({
                "capturedAt": db::iso(chrono::Utc::now()),
                "limitPercent": USER_QUOTA_PERCENT,
                "pools": { "standard": {
                    "available": false,
                    "usageUnit": "weighted_usd",
                    "shortWindow": rate_limit.primary.map(Window::to_json),
                    "weeklyWindow": null,
                    "allocation": null,
                    "members": [],
                }},
            }));
        };
        self.store_window(account_id, weekly).await?;
        let snapshot = self
            .snapshots
            .read()
            .await
            .get(account_id)
            .cloned()
            .unwrap_or_default();
        let members = db::quota::members(&self.pool, account_id, snapshot.reset_at)
            .await
            .map_err(|e| e.to_string())?;
        let total = snapshot.total();
        let short = rate_limit
            .primary
            .filter(|w| w.limit_window_seconds != crate::upstream::usage_summary::WEEK_SECONDS);
        Ok(json!({
            "capturedAt": db::iso(chrono::Utc::now()),
            "limitPercent": USER_QUOTA_PERCENT,
            "pools": { "standard": {
                "available": true,
                "usageUnit": "weighted_usd",
                "shortWindow": short.map(Window::to_json),
                "weeklyWindow": weekly.to_json(),
                "allocation": {
                    "accountId": account_id,
                    "resetAt": snapshot.reset_at,
                    "usedPercent": snapshot.used_percent,
                    "userUsageAmount": snapshot.usage.get(owner).copied().unwrap_or(0.0),
                    "totalUsageAmount": total,
                    "allocatedPercent": snapshot.allocated_percent(owner),
                    "updatedAt": snapshot.updated_at,
                },
                "members": members.iter().map(|member| json!({
                    "ownerUserId": member.owner_user_id,
                    "username": member.username,
                    "role": if member.role == "admin" { "admin" } else { "user" },
                    "enabled": member.enabled,
                    "usageAmount": member.usage_amount,
                    "allocatedPercent": snapshot.allocated_percent(&member.owner_user_id),
                })).collect::<Vec<_>>(),
            }},
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_is_split_by_recorded_usage() {
        let snapshot = Snapshot {
            reset_at: i64::MAX,
            used_percent: 60.0,
            usage: HashMap::from([("a".to_string(), 3.0), ("b".to_string(), 1.0)]),
            updated_at: String::new(),
        };
        assert_eq!(snapshot.allocated_percent("a"), 45.0);
        assert_eq!(snapshot.allocated_percent("b"), 15.0);
        assert_eq!(snapshot.allocated_percent("c"), 0.0);
        assert!(Snapshot::default().allocated_percent("a") == 0.0);
    }
}
