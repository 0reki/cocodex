//! The `x-codex-turn-state` the gateway keeps for each upstream login.
//!
//! Upstream issues a turn state on a Responses turn and a Codex client
//! replays it on every later turn — as a request header over HTTP, inside
//! `client_metadata` on the Responses WebSocket. The state belongs to the
//! login that was served, not to the client, so relaying a client's own
//! state is wrong here: the user it was issued for may since have been
//! routed to another upstream account, and several users share one.
//!
//! So the gateway takes the state over. It learns the states upstream issues
//! (response header, `codex.response.metadata` event, WebSocket handshake),
//! keeps the newest live one per (account, platform, model), and presents it
//! on every managed request, replacing whatever the client sent. When the
//! probe is configured it also fetches states of its own, ahead of expiry,
//! through the proxy pool.

pub mod fernet;
pub mod probe;
pub mod proxy_pool;
pub mod settings;

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, RwLock};

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use tracing::{debug, info, warn};

use settings::{MAX_STATE_BYTES, TurnStateSettings};

/// `gateway_settings` row the console writes.
pub const SETTINGS_KEY: &str = "turn_state";
/// Probe history kept for the console.
const HISTORY_LIMIT: usize = 50;
/// A (account, platform, model) no request touched for this long stops being
/// refreshed; its state is dropped with it.
const TRACKING_TTL_HOURS: i64 = 6;

/// The turn state upstream issues is per login and per model.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StateKey {
    pub account_id: String,
    /// The OS the login presents (`windows`, `linux` or `all`), since one
    /// ChatGPT account logs in once per platform.
    pub platform: String,
    pub model: String,
}

impl StateKey {
    pub fn new(account_id: &str, platform: &str, model: &str) -> Self {
        Self {
            account_id: account_id.to_string(),
            platform: platform.to_string(),
            model: model.to_string(),
        }
    }

    fn json(&self) -> Value {
        json!({
            "accountId": self.account_id,
            "platform": self.platform,
            "model": self.model,
        })
    }
}

/// A turn state the gateway holds, with what its envelope said.
#[derive(Debug, Clone)]
pub struct StoredState {
    pub value: String,
    pub issued_at: DateTime<Utc>,
    pub blocks: usize,
    /// Whether its shape is one `preferred_blocks` asks for; a preferred
    /// state is never replaced by one of another shape.
    pub preferred: bool,
    /// Where it came from: `response`, `metadata`, `handshake` or `probe`.
    pub source: &'static str,
    pub captured_at: DateTime<Utc>,
}

impl StoredState {
    pub fn expires_at(&self) -> DateTime<Utc> {
        self.issued_at + fernet::turn_state_ttl()
    }

    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        now < self.expires_at()
    }
}

#[derive(Debug, Clone, Default)]
struct Counters {
    captured: u64,
    rejected: u64,
    injected: u64,
    replaced: u64,
    probes_ok: u64,
    probes_failed: u64,
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    at: DateTime<Utc>,
    key: StateKey,
    event: &'static str,
    outcome: String,
    detail: String,
}

/// Everything the tracked keys carry between requests and probes.
#[derive(Default)]
struct Cache {
    states: HashMap<StateKey, StoredState>,
    /// Keys live traffic has used, and when last.
    tracked: HashMap<StateKey, DateTime<Utc>>,
    /// Keys a failure asked to refresh early, with the reason.
    refresh_requests: HashMap<StateKey, String>,
    probing: HashMap<StateKey, DateTime<Utc>>,
    /// Probes already spent looking for a preferred state for this key.
    hunts: HashMap<StateKey, u32>,
    last_probe: HashMap<StateKey, DateTime<Utc>>,
    last_outcome: HashMap<StateKey, String>,
    blocked_until: HashMap<StateKey, DateTime<Utc>>,
    account_blocked_until: HashMap<String, DateTime<Utc>>,
    proxy_blocked_until: HashMap<usize, DateTime<Utc>>,
    history: VecDeque<HistoryEntry>,
    counters: Counters,
}

pub struct TurnStateStore {
    settings: RwLock<TurnStateSettings>,
    cache: Mutex<Cache>,
}

impl Default for TurnStateStore {
    fn default() -> Self {
        Self::new(TurnStateSettings::default())
    }
}

impl TurnStateStore {
    pub fn new(settings: TurnStateSettings) -> Self {
        Self {
            settings: RwLock::new(settings),
            cache: Mutex::new(Cache::default()),
        }
    }

    pub fn settings(&self) -> TurnStateSettings {
        self.settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    fn set_settings(&self, settings: TurnStateSettings) {
        if let Ok(mut current) = self.settings.write() {
            *current = settings;
        }
    }

    /// Whether this model's state is managed at all.
    pub fn manages(&self, model: &str) -> bool {
        self.settings().manages(model)
    }

    /// Reads the console's settings, keeping the defaults when none were
    /// written yet or the row cannot be parsed.
    pub async fn load(&self, pool: &PgPool) {
        match crate::db::settings::get(pool, SETTINGS_KEY).await {
            Ok(Some(value)) => match serde_json::from_value::<TurnStateSettings>(value) {
                Ok(settings) => {
                    info!(
                        enabled = settings.enabled,
                        models = ?settings.models,
                        probe = settings.probe.enabled,
                        "loaded turn state settings"
                    );
                    self.set_settings(settings);
                }
                Err(error) => warn!(%error, "ignoring unreadable turn state settings"),
            },
            Ok(None) => debug!("no stored turn state settings; using the defaults"),
            Err(error) => warn!(%error, "failed to read turn state settings"),
        }
    }

    /// Validates and stores new settings, and applies them at once.
    pub async fn save(
        &self,
        pool: &PgPool,
        settings: TurnStateSettings,
    ) -> Result<TurnStateSettings, String> {
        settings.validate()?;
        let value = serde_json::to_value(&settings).map_err(|error| error.to_string())?;
        crate::db::settings::put(pool, SETTINGS_KEY, &value)
            .await
            .map_err(|error| error.to_string())?;
        self.set_settings(settings.clone());
        info!(
            enabled = settings.enabled,
            probe = settings.probe.enabled,
            "turn state settings updated"
        );
        Ok(settings)
    }

    /// The state to present for this request, and a note that the key is in
    /// use so the probe keeps it fresh. `None` means the request goes without
    /// one — and the client's own state is dropped either way.
    pub fn inject(&self, key: &StateKey) -> Option<String> {
        let settings = self.settings();
        if !settings.manages(&key.model) {
            return None;
        }
        let now = Utc::now();
        let mut cache = self.cache.lock().ok()?;
        cache.tracked.insert(key.clone(), now);
        let state = cache.states.get(key)?;
        if !state.is_live(now) && !settings.inject_expired {
            return None;
        }
        let value = state.value.clone();
        cache.counters.injected += 1;
        Some(value)
    }

    /// The state to present upstream for this request.
    ///
    /// The one held for the login wins, because it belongs to the login and
    /// not to whichever client asked. When the gateway holds none, the
    /// client's own state is kept and adopted instead of being dropped: it
    /// was issued for this login by an earlier turn, upstream only reissues a
    /// state when it wants to change the routing, and a turn sent without one
    /// starts cold — which is how a client that had earned a good state ends
    /// up served by a cheaper model.
    pub fn present(&self, key: &StateKey, client: Option<&str>) -> Option<String> {
        if let Some(held) = self.presentable(key) {
            if client.is_some_and(|value| value != held) {
                self.note_replaced();
            }
            return Some(held);
        }
        let client = client.map(str::trim).filter(|value| !value.is_empty())?;
        // The client's own state is adopted only if it is one the gateway
        // would present itself. A state of the shape being hunted away from
        // pins the turn to whatever issued it, and a client that keeps
        // replaying it never escapes: it must not travel in either direction.
        if !self.capture(key, client, "client") {
            return None;
        }
        self.presentable(key)
    }

    /// The held state, if it is one worth presenting: live, and of the shape
    /// being hunted for when a preference is configured. A state of another
    /// shape is kept (it is what the probe counts its hunts against) but
    /// never handed out, because presenting it is what keeps a login on the
    /// model that issued it.
    pub fn presentable(&self, key: &StateKey) -> Option<String> {
        let settings = self.settings();
        if !settings.manages(&key.model) {
            return None;
        }
        let now = Utc::now();
        let mut cache = self.cache.lock().ok()?;
        cache.tracked.insert(key.clone(), now);
        let state = cache.states.get(key)?;
        if !state.preferred && settings.hunts() {
            return None;
        }
        if !state.is_live(now) && !settings.inject_expired {
            return None;
        }
        let value = state.value.clone();
        cache.counters.injected += 1;
        Some(value)
    }

    /// Records that a managed request's own state was dropped, for the
    /// console's counters.
    pub fn note_replaced(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.counters.replaced += 1;
        }
    }

    /// Takes in a state upstream issued. It is kept when it is a well-formed
    /// Fernet token of an accepted shape, still live, and newer than the one
    /// held. Returns whether it was.
    pub fn capture(&self, key: &StateKey, value: &str, source: &'static str) -> bool {
        let settings = self.settings();
        if !settings.manages(&key.model) {
            return false;
        }
        let now = Utc::now();
        let info = match fernet::parse(value, MAX_STATE_BYTES) {
            Ok(info) => info,
            Err(error) => {
                self.record(key, "capture", "rejected", error);
                return false;
            }
        };
        // A state issued in the future, or already past its hour, is not one
        // the gateway should hand out.
        if !info.is_live(now) || info.issued_at > now + Duration::minutes(5) {
            self.record(key, "capture", "rejected", "issue time out of range");
            return false;
        }
        // Every well-formed state upstream issues for this login is usable:
        // the block count only says which shape the probe keeps looking for
        // (a Pro account was measured issuing 11-block states, so treating
        // any particular count as the only valid one leaves the gateway with
        // nothing to present).
        let preferred = settings.prefers_blocks(info.blocks);
        let Ok(mut cache) = self.cache.lock() else {
            return false;
        };
        if let Some(held) = cache.states.get(key).filter(|held| held.is_live(now)) {
            // Finding the shape being hunted for is an upgrade whatever its
            // age; otherwise keep the newer state, and never trade a
            // preferred one for another shape.
            let upgrade = preferred && !held.preferred;
            if !upgrade && (held.issued_at >= info.issued_at || (held.preferred && !preferred)) {
                return false;
            }
        }
        if preferred {
            cache.hunts.remove(key);
        } else if source == "probe" {
            *cache.hunts.entry(key.clone()).or_default() += 1;
        }
        cache.states.insert(
            key.clone(),
            StoredState {
                value: value.to_string(),
                issued_at: info.issued_at,
                blocks: info.blocks,
                preferred,
                source,
                captured_at: now,
            },
        );
        cache.tracked.insert(key.clone(), now);
        cache.refresh_requests.remove(key);
        cache.blocked_until.remove(key);
        cache.account_blocked_until.remove(&key.account_id);
        cache.counters.captured += 1;
        let detail = format!(
            "blocks={} length={}{}",
            info.blocks,
            value.len(),
            if preferred { "" } else { " (not preferred)" }
        );
        drop(cache);
        self.record(key, "capture", source, &detail);
        info!(
            account_id = %key.account_id,
            platform = %key.platform,
            model = %key.model,
            source,
            blocks = info.blocks,
            "captured upstream turn state"
        );
        true
    }

    /// An upstream failure that a newer state may fix: the key is probed
    /// ahead of its schedule.
    pub fn note_failure(&self, key: &StateKey, status: u16) {
        if !matches!(status, 429 | 500 | 502 | 503 | 504) || !self.manages(&key.model) {
            return;
        }
        if let Ok(mut cache) = self.cache.lock()
            // Only a key live traffic uses is worth a probe; the model that
            // served a turn is not always the one that was asked for.
            && cache.tracked.contains_key(key)
        {
            cache
                .refresh_requests
                .insert(key.clone(), format!("upstream_http_{status}"));
        }
    }

    fn record(&self, key: &StateKey, event: &'static str, outcome: &str, detail: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            if outcome == "rejected" {
                cache.counters.rejected += 1;
            }
            cache.history.push_front(HistoryEntry {
                at: Utc::now(),
                key: key.clone(),
                event,
                outcome: outcome.to_string(),
                detail: detail.to_string(),
            });
            cache.history.truncate(HISTORY_LIMIT);
        }
    }

    /// Forgets keys no request has used for a while, with their states.
    fn evict_stale(cache: &mut Cache, now: DateTime<Utc>) {
        let live: Vec<StateKey> = cache
            .tracked
            .iter()
            .filter(|(_, seen)| now - **seen < Duration::hours(TRACKING_TTL_HOURS))
            .map(|(key, _)| key.clone())
            .collect();
        if live.len() == cache.tracked.len() {
            return;
        }
        cache.tracked.retain(|key, _| live.contains(key));
        cache.states.retain(|key, _| live.contains(key));
        cache.refresh_requests.retain(|key, _| live.contains(key));
        cache.blocked_until.retain(|key, _| live.contains(key));
        cache.last_probe.retain(|key, _| live.contains(key));
        cache.last_outcome.retain(|key, _| live.contains(key));
        cache.hunts.retain(|key, _| live.contains(key));
    }

    /// When a key should next be probed, or `None` when it needs no probe.
    fn due_at(
        cache: &Cache,
        settings: &TurnStateSettings,
        key: &StateKey,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        let requested = cache.refresh_requests.contains_key(key);
        let hunted = cache.hunts.get(key).copied().unwrap_or(0) < settings.probe.max_hunts;
        let ready_at = match cache.states.get(key) {
            // Nothing held: as soon as the retry gap allows.
            None => now,
            Some(state) if requested || !state.is_live(now) => now,
            // A usable state of the wrong shape: keep looking for the one
            // being hunted for, until `max_hunts` says it is not coming.
            Some(state) if !state.preferred && hunted => now,
            // Fetch the replacement before the held state runs out.
            Some(state) => {
                state.expires_at() - Duration::seconds(settings.probe.refresh_before_seconds as i64)
            }
        };
        let after_retry = cache
            .last_probe
            .get(key)
            .map(|last| *last + Duration::seconds(settings.probe.retry_seconds as i64));
        let blocked = cache.blocked_until.get(key).copied();
        let account_blocked = cache.account_blocked_until.get(&key.account_id).copied();
        Some(
            [Some(ready_at), after_retry, blocked, account_blocked]
                .into_iter()
                .flatten()
                .max()
                .unwrap_or(now),
        )
    }

    /// The tracked keys a probe should refresh now, newest need first.
    pub fn due_keys(&self, now: DateTime<Utc>) -> Vec<(StateKey, String)> {
        let settings = self.settings();
        if !settings.enabled || !settings.probe.enabled || !settings.probe.has_exit() {
            return Vec::new();
        }
        let Ok(mut cache) = self.cache.lock() else {
            return Vec::new();
        };
        Self::evict_stale(&mut cache, now);
        let mut due: Vec<(StateKey, String)> = Vec::new();
        for key in cache.tracked.keys() {
            if cache.probing.contains_key(key) || !settings.manages(&key.model) {
                continue;
            }
            if Self::due_at(&cache, &settings, key, now).is_none_or(|at| at > now) {
                continue;
            }
            let reason = cache.refresh_requests.get(key).cloned().unwrap_or_else(|| {
                match cache.states.get(key) {
                    Some(state) if !state.preferred && state.is_live(now) => {
                        "hunting_preferred".to_string()
                    }
                    Some(_) => "before_expiry".to_string(),
                    None => "no_state_held".to_string(),
                }
            });
            due.push((key.clone(), reason));
        }
        due.sort();
        due
    }

    /// Starts keeping a state for this login and model, before any request
    /// has needed one. Without it a restart leaves the gateway holding
    /// nothing until traffic happens to arrive.
    pub fn track(&self, key: &StateKey) -> bool {
        if !self.manages(&key.model) {
            return false;
        }
        match self.cache.lock() {
            Ok(mut cache) => cache.tracked.insert(key.clone(), Utc::now()).is_none(),
            Err(_) => false,
        }
    }

    /// Claims a key for one probe. `false` when another probe holds it.
    pub fn start_probe(&self, key: &StateKey, now: DateTime<Utc>) -> bool {
        let Ok(mut cache) = self.cache.lock() else {
            return false;
        };
        if cache.probing.contains_key(key) {
            return false;
        }
        cache.probing.insert(key.clone(), now);
        cache.last_probe.insert(key.clone(), now);
        // The request is spent on the probe it started, whether or not that
        // probe finds a state: a key that still needs one is due again on its
        // own, under the reason that actually applies.
        cache.refresh_requests.remove(key);
        true
    }

    /// Closes out one probe. Returns whether this outcome differs from the
    /// last one for the key, so a repeated failure is not logged every time.
    pub fn finish_probe(&self, key: &StateKey, outcome: &str, reason: &str) -> bool {
        let mut changed = true;
        if let Ok(mut cache) = self.cache.lock() {
            cache.probing.remove(key);
            changed = cache.last_outcome.insert(key.clone(), outcome.to_string())
                != Some(outcome.to_string());
            if outcome == "ok" {
                cache.counters.probes_ok += 1;
            } else {
                cache.counters.probes_failed += 1;
            }
        }
        self.record(key, "probe", outcome, reason);
        changed
    }

    /// Leaves an account alone for a while: upstream refused for a reason a
    /// new state cannot fix (spent quota, rejected credentials).
    pub fn block_account(&self, account_id: &str, until: DateTime<Utc>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache
                .account_blocked_until
                .insert(account_id.to_string(), until);
        }
    }

    pub fn block_key(&self, key: &StateKey, until: DateTime<Utc>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.blocked_until.insert(key.clone(), until);
        }
    }

    /// The next pool entry to try, skipping exits that just failed.
    pub fn next_proxy(&self, pool_size: usize, now: DateTime<Utc>) -> Option<usize> {
        if pool_size == 0 {
            return None;
        }
        // Start somewhere random rather than walking the pool from the top.
        // A pool is a concatenation of lists, so its order carries whatever
        // bias the sources had; marching through it means a probe only ever
        // sees the first few dozen entries, and a bad opening block stops the
        // rest from ever being tried.
        let start = rand::random::<u32>() as usize % pool_size;
        let cache = self.cache.lock().ok()?;
        (0..pool_size).find_map(|offset| {
            let index = start.wrapping_add(offset) % pool_size;
            let cooling = cache
                .proxy_blocked_until
                .get(&index)
                .is_some_and(|until| now < *until);
            (!cooling).then_some(index)
        })
    }

    pub fn cool_proxy(&self, index: usize, until: DateTime<Utc>) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.proxy_blocked_until.insert(index, until);
        }
    }

    pub fn clear_proxy_cooldown(&self, index: usize) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.proxy_blocked_until.remove(&index);
        }
    }

    /// Queues an early refresh for the keys a selector names. Returns how
    /// many were queued.
    pub fn request_refresh(&self, selector: &RefreshSelector) -> usize {
        let Ok(mut cache) = self.cache.lock() else {
            return 0;
        };
        let keys: Vec<StateKey> = cache
            .tracked
            .keys()
            .filter(|key| selector.matches(key))
            .cloned()
            .collect();
        for key in &keys {
            cache
                .refresh_requests
                .insert(key.clone(), "manual".to_string());
            cache.blocked_until.remove(key);
            cache.account_blocked_until.remove(&key.account_id);
            // A manual refresh is meant now, not after the retry gap, and it
            // starts the hunt for a preferred state over.
            cache.last_probe.remove(key);
            cache.hunts.remove(key);
        }
        keys.len()
    }

    /// Drops held states: everything a selector names, or only those no
    /// longer usable.
    pub fn clear(&self, selector: &RefreshSelector, only_expired: bool) -> usize {
        let now = Utc::now();
        let Ok(mut cache) = self.cache.lock() else {
            return 0;
        };
        let keys: Vec<StateKey> = cache
            .states
            .iter()
            .filter(|(key, state)| selector.matches(key) && (!only_expired || !state.is_live(now)))
            .map(|(key, _)| key.clone())
            .collect();
        for key in &keys {
            cache.states.remove(key);
            cache.hunts.remove(key);
        }
        keys.len()
    }

    /// What the console shows: the held states, the probe's bookkeeping and
    /// the recent history. Never the states themselves.
    pub fn status(&self) -> Value {
        let settings = self.settings();
        let now = Utc::now();
        let Ok(cache) = self.cache.lock() else {
            return json!({ "error": "turn state cache is unavailable" });
        };
        let mut keys: Vec<&StateKey> = cache.tracked.keys().collect();
        keys.sort();
        let entries: Vec<Value> = keys
            .into_iter()
            .map(|key| {
                let state = cache.states.get(key);
                json!({
                    "accountId": key.account_id,
                    "platform": key.platform,
                    "model": key.model,
                    "hasState": state.is_some(),
                    "blocks": state.map(|s| s.blocks),
                    "preferred": state.map(|s| s.preferred),
                    "hunts": cache.hunts.get(key).copied().unwrap_or(0),
                    "length": state.map(|s| s.value.len()),
                    "source": state.map(|s| s.source),
                    "issuedAt": state.map(|s| crate::db::iso(s.issued_at)),
                    "expiresAt": state.map(|s| crate::db::iso(s.expires_at())),
                    "live": state.is_some_and(|s| s.is_live(now)),
                    "lastSeenAt": cache.tracked.get(key).map(|at| crate::db::iso(*at)),
                    "lastProbeAt": cache.last_probe.get(key).map(|at| crate::db::iso(*at)),
                    "lastProbeOutcome": cache.last_outcome.get(key),
                    "refreshPending": cache.refresh_requests.contains_key(key),
                    "probing": cache.probing.contains_key(key),
                    "nextRefreshAt": Self::due_at(&cache, &settings, key, now)
                        .map(crate::db::iso),
                })
            })
            .collect();
        let history: Vec<Value> = cache
            .history
            .iter()
            .map(|entry| {
                json!({
                    "at": crate::db::iso(entry.at),
                    "key": entry.key.json(),
                    "event": entry.event,
                    "outcome": entry.outcome,
                    "detail": entry.detail,
                })
            })
            .collect();
        json!({
            "enabled": settings.enabled,
            "models": settings.models,
            "probeEnabled": settings.probe.enabled,
            "preferredBlocks": settings.preferred_blocks,
            "proxyPoolSize": settings.probe.proxy_pool.len(),
            "entries": entries,
            "counters": {
                "captured": cache.counters.captured,
                "rejected": cache.counters.rejected,
                "injected": cache.counters.injected,
                "replaced": cache.counters.replaced,
                "probesOk": cache.counters.probes_ok,
                "probesFailed": cache.counters.probes_failed,
            },
            "history": history,
        })
    }
}

/// Which tracked keys a console action applies to. An empty selector means
/// every key, so `all` must be asked for explicitly by the caller.
#[derive(Debug, Default, Clone)]
pub struct RefreshSelector {
    pub accounts: Vec<String>,
    pub models: Vec<String>,
    pub platforms: Vec<String>,
}

impl RefreshSelector {
    fn matches(&self, key: &StateKey) -> bool {
        let any = |values: &[String], value: &str| {
            values.is_empty() || values.iter().any(|item| item.eq_ignore_ascii_case(value))
        };
        any(&self.accounts, &key.account_id)
            && any(&self.models, &key.model)
            && any(&self.platforms, &key.platform)
    }
}

#[cfg(test)]
impl TurnStateStore {
    /// Places a state directly, so a test can hold one that is already past
    /// its hour.
    fn insert_for_test(&self, key: &StateKey, value: &str, issued_at: DateTime<Utc>) {
        let mut cache = self.cache.lock().unwrap();
        cache.states.insert(
            key.clone(),
            StoredState {
                value: value.to_string(),
                issued_at,
                blocks: 10,
                preferred: true,
                source: "response",
                captured_at: Utc::now(),
            },
        );
        cache.tracked.insert(key.clone(), Utc::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> StateKey {
        StateKey::new("acct-1", "linux", "gpt-6-astra")
    }

    fn state(minutes_ago: i64, blocks: usize) -> String {
        fernet::encode_for_test(Utc::now() - Duration::minutes(minutes_ago), blocks)
    }

    #[test]
    fn a_captured_state_is_the_one_injected() {
        let store = TurnStateStore::default();
        let value = state(0, 10);
        assert!(store.capture(&key(), &value, "response"));
        assert_eq!(store.inject(&key()), Some(value));
    }

    #[test]
    fn the_clients_own_state_is_kept_when_the_gateway_holds_none() {
        let store = TurnStateStore::default();
        let client = state(5, 10);
        // Nothing held: the client keeps what it earned, and the gateway
        // learns it.
        assert_eq!(store.present(&key(), Some(&client)), Some(client.clone()));
        assert_eq!(store.inject(&key()), Some(client.clone()));
        // A newer one held for the login wins over the client's.
        let newer = state(0, 12);
        assert!(store.capture(&key(), &newer, "response"));
        assert_eq!(store.present(&key(), Some(&client)), Some(newer));
    }

    /// The shape that routes to another model must not travel in either
    /// direction: presenting it pins the login, and handing it to the client
    /// makes the client replay it forever.
    #[test]
    fn a_state_of_the_wrong_shape_is_held_but_never_presented() {
        let hunting = TurnStateSettings {
            preferred_blocks: vec![10],
            ..TurnStateSettings::default()
        };
        let store = TurnStateStore::new(hunting);
        let wrong_shape = state(0, 11);
        // It is kept — the probe counts its hunts against it …
        assert!(store.capture(&key(), &wrong_shape, "response"));
        assert_eq!(store.status()["entries"][0]["blocks"], 11);
        // … but it is never handed out, in either direction.
        assert_eq!(store.presentable(&key()), None);
        assert_eq!(store.present(&key(), None), None);
        // A client arriving with one is not allowed to keep it either.
        assert_eq!(store.present(&key(), Some(&wrong_shape)), None);
        // The shape being hunted for is presented as soon as it turns up.
        let wanted = state(0, 10);
        assert!(store.capture(&key(), &wanted, "probe"));
        assert_eq!(store.presentable(&key()), Some(wanted.clone()));
        assert_eq!(store.present(&key(), Some(&wrong_shape)), Some(wanted));
    }

    #[test]
    fn with_no_preference_every_state_is_presented() {
        let store = TurnStateStore::default();
        let any_shape = state(0, 11);
        assert!(store.capture(&key(), &any_shape, "response"));
        assert_eq!(store.presentable(&key()), Some(any_shape));
    }

    #[test]
    fn a_client_state_that_is_not_one_is_still_dropped() {
        let store = TurnStateStore::default();
        assert_eq!(store.present(&key(), Some("not-a-turn-state")), None);
        // Past its hour: sending it would only start the turn cold.
        assert_eq!(store.present(&key(), Some(&state(61, 10))), None);
        assert_eq!(store.present(&key(), None), None);
        // Any well-formed live state is carried, whatever its shape; the
        // preference only decides what the probe keeps looking for.
        let other_shape = state(0, 11);
        assert_eq!(store.present(&key(), Some(&other_shape)), Some(other_shape));
    }

    #[test]
    fn an_unmanaged_model_is_left_alone() {
        let store = TurnStateStore::default();
        let other = StateKey::new("acct-1", "linux", "gpt-5.6-luna");
        assert!(!store.capture(&other, &state(0, 10), "response"));
        assert_eq!(store.inject(&other), None);
    }

    #[test]
    fn states_are_kept_apart_by_account_platform_and_model() {
        let store = TurnStateStore::default();
        let mine = state(0, 10);
        assert!(store.capture(&key(), &mine, "response"));
        for other in [
            StateKey::new("acct-2", "linux", "gpt-6-astra"),
            StateKey::new("acct-1", "windows", "gpt-6-astra"),
            StateKey::new("acct-1", "linux", "gpt-6-astra-2026-01-15"),
        ] {
            assert_eq!(store.inject(&other), None, "{other:?} must not see it");
        }
    }

    #[test]
    fn a_malformed_state_is_not_kept() {
        let store = TurnStateStore::default();
        assert!(!store.capture(&key(), "not-a-turn-state", "response"));
        assert_eq!(store.inject(&key()), None);
    }

    #[test]
    fn any_well_formed_state_is_kept_when_no_shape_is_preferred() {
        // A Pro account was measured issuing 11-block states, so an unusual
        // block count must not leave the login with nothing to present.
        let store = TurnStateStore::default();
        let eleven = state(0, 11);
        assert!(store.capture(&key(), &eleven, "response"));
        assert_eq!(store.inject(&key()), Some(eleven));
    }

    fn hunting_store() -> TurnStateStore {
        TurnStateStore::new(TurnStateSettings {
            preferred_blocks: vec![10],
            probe: settings::ProbeSettings {
                enabled: true,
                allow_direct: true,
                ..settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        })
    }

    #[test]
    fn a_preferred_state_is_never_replaced_by_another_shape() {
        let store = hunting_store();
        let preferred = state(10, 10);
        assert!(store.capture(&key(), &preferred, "response"));
        // Newer, but not the shape being hunted for.
        assert!(!store.capture(&key(), &state(0, 11), "probe"));
        assert_eq!(store.inject(&key()), Some(preferred));
        // The other way round, the preferred one wins even so.
        let store = hunting_store();
        assert!(store.capture(&key(), &state(10, 11), "response"));
        let preferred = state(0, 10);
        assert!(store.capture(&key(), &preferred, "probe"));
        assert_eq!(store.inject(&key()), Some(preferred));
    }

    #[test]
    fn a_state_of_the_wrong_shape_is_hunted_but_only_so_often() {
        let store = hunting_store();
        store.inject(&key());
        let max = store.settings().probe.max_hunts;
        // Each probe brings back a state of the wrong shape, a little newer
        // than the last.
        let wrong = |seconds_ago: i64| {
            fernet::encode_for_test(Utc::now() - Duration::seconds(seconds_ago), 11)
        };
        for attempt in 0..max - 1 {
            assert!(store.capture(&key(), &wrong((max - attempt) as i64), "probe"));
            let due = store.due_keys(Utc::now() + Duration::seconds(120 * (attempt as i64 + 1)));
            assert_eq!(
                due.first().map(|(_, reason)| reason.as_str()),
                Some("hunting_preferred"),
                "attempt {attempt} should still hunt"
            );
        }
        // The last of `max_hunts` probes spends the budget: the held state is
        // then left alone until it nears its expiry.
        assert!(store.capture(&key(), &wrong(0), "probe"));
        assert!(
            store
                .due_keys(Utc::now() + Duration::seconds(600))
                .is_empty()
        );
        // Finding the preferred shape clears the counter for the next round.
        assert!(store.capture(&key(), &state(0, 10), "probe"));
        assert_eq!(store.status()["entries"][0]["hunts"], 0);
        assert_eq!(store.status()["entries"][0]["preferred"], true);
    }

    #[test]
    fn a_state_that_arrives_past_its_hour_is_not_kept() {
        let store = TurnStateStore::default();
        assert!(!store.capture(&key(), &state(61, 10), "response"));
        assert_eq!(store.inject(&key()), None);
    }

    #[test]
    fn an_expired_state_is_injected_only_when_asked_for() {
        let value = state(61, 10);
        let issued_at = Utc::now() - Duration::minutes(61);
        let store = TurnStateStore::default();
        store.insert_for_test(&key(), &value, issued_at);
        assert_eq!(store.inject(&key()), None);
        let store = TurnStateStore::new(TurnStateSettings {
            inject_expired: true,
            ..TurnStateSettings::default()
        });
        store.insert_for_test(&key(), &value, issued_at);
        assert_eq!(store.inject(&key()), Some(value));
    }

    #[test]
    fn only_a_newer_state_replaces_the_one_held() {
        let store = TurnStateStore::default();
        let newer = state(1, 10);
        let older = state(30, 10);
        assert!(store.capture(&key(), &newer, "response"));
        assert!(!store.capture(&key(), &older, "metadata"));
        assert_eq!(store.inject(&key()), Some(newer));
    }

    #[test]
    fn a_failure_queues_an_early_refresh() {
        let store = TurnStateStore::new(TurnStateSettings {
            probe: settings::ProbeSettings {
                enabled: true,
                allow_direct: true,
                ..settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        });
        store.capture(&key(), &state(0, 10), "response");
        store.inject(&key());
        // A fresh state is not due yet.
        assert!(store.due_keys(Utc::now()).is_empty());
        store.note_failure(&key(), 429);
        let due = store.due_keys(Utc::now());
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].1, "upstream_http_429");
        // A 400 is the client's problem, not the state's.
        assert!(store.start_probe(&key(), Utc::now()));
        store.finish_probe(&key(), "ok", "upstream_http_429");
        store.note_failure(&key(), 400);
        assert!(store.due_keys(Utc::now()).is_empty());
    }

    #[test]
    fn a_queued_refresh_is_spent_on_the_probe_it_starts() {
        let store = TurnStateStore::new(TurnStateSettings {
            probe: settings::ProbeSettings {
                enabled: true,
                allow_direct: true,
                ..settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        });
        store.capture(&key(), &state(0, 10), "response");
        store.inject(&key());
        assert_eq!(store.request_refresh(&RefreshSelector::default()), 1);
        assert_eq!(store.due_keys(Utc::now())[0].1, "manual");
        let now = Utc::now();
        assert!(store.start_probe(&key(), now));
        store.finish_probe(&key(), "network_error", "manual");
        // The failed probe does not leave the key queued as "manual" for
        // every later probe; the held state decides when it is next due.
        assert!(store.due_keys(now + Duration::seconds(120)).is_empty());
        assert_eq!(store.status()["entries"][0]["refreshPending"], false);
    }

    #[test]
    fn a_key_with_no_state_is_due_at_once_and_probed_only_once() {
        let store = TurnStateStore::new(TurnStateSettings {
            probe: settings::ProbeSettings {
                enabled: true,
                allow_direct: true,
                ..settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        });
        assert_eq!(store.inject(&key()), None);
        let due = store.due_keys(Utc::now());
        assert_eq!(due, vec![(key(), "no_state_held".to_string())]);
        assert!(store.start_probe(&key(), Utc::now()));
        assert!(!store.start_probe(&key(), Utc::now()));
        assert!(store.due_keys(Utc::now()).is_empty());
    }

    #[test]
    fn the_probe_stands_down_when_it_is_off_or_has_no_exit() {
        let store = TurnStateStore::default();
        store.inject(&key());
        assert!(store.due_keys(Utc::now()).is_empty());
        let store = TurnStateStore::new(TurnStateSettings {
            probe: settings::ProbeSettings {
                enabled: true,
                ..settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        });
        store.inject(&key());
        assert!(store.due_keys(Utc::now()).is_empty());
    }

    #[test]
    fn the_pool_is_sampled_across_its_whole_length() {
        let store = TurnStateStore::default();
        let now = Utc::now();
        // A pool is a concatenation of lists, so walking it from the top
        // means only its opening block is ever tried. Every entry has to be
        // reachable from the first probe onwards.
        let pool_size = 500;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..4000 {
            let index = store.next_proxy(pool_size, now).expect("an exit");
            assert!(index < pool_size);
            seen.insert(index);
        }
        assert!(
            seen.iter().any(|index| *index > pool_size / 2),
            "the far half of the pool is never reached"
        );
        assert!(
            seen.len() > pool_size / 2,
            "only {} exits reached",
            seen.len()
        );
    }

    #[test]
    fn a_cooling_exit_is_skipped() {
        let store = TurnStateStore::default();
        let now = Utc::now();
        // Two of three cooling: every draw has to land on the third.
        store.cool_proxy(0, now + Duration::minutes(1));
        store.cool_proxy(2, now + Duration::minutes(1));
        for _ in 0..50 {
            assert_eq!(store.next_proxy(3, now), Some(1));
        }
        // Once the cooling passes every exit is a candidate again.
        let later = now + Duration::minutes(2);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            seen.insert(store.next_proxy(3, later).expect("an exit"));
        }
        assert_eq!(seen.len(), 3, "reached {seen:?}");
        // An empty pool has nothing to offer.
        assert_eq!(store.next_proxy(0, now), None);
    }

    #[test]
    fn a_manual_refresh_and_a_clear_pick_their_keys() {
        let store = TurnStateStore::default();
        let other = StateKey::new("acct-2", "linux", "gpt-6-astra");
        store.capture(&key(), &state(0, 10), "response");
        store.capture(&other, &state(0, 10), "response");
        store.inject(&key());
        store.inject(&other);
        let selector = RefreshSelector {
            accounts: vec!["acct-2".into()],
            ..RefreshSelector::default()
        };
        assert_eq!(store.request_refresh(&selector), 1);
        assert_eq!(store.clear(&selector, false), 1);
        assert!(store.inject(&other).is_none());
        assert!(store.inject(&key()).is_some());
        assert_eq!(store.clear(&RefreshSelector::default(), false), 1);
    }

    #[test]
    fn the_status_names_every_tracked_key_but_no_state() {
        let store = TurnStateStore::default();
        let value = state(0, 10);
        store.capture(&key(), &value, "response");
        store.inject(&key());
        let status = store.status();
        assert_eq!(status["entries"][0]["accountId"], "acct-1");
        assert_eq!(status["entries"][0]["blocks"], 10);
        assert_eq!(status["counters"]["captured"], 1);
        assert!(!status.to_string().contains(&value));
    }
}
