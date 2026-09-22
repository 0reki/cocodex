//! Fetching a turn state of the gateway's own.
//!
//! Relayed traffic only ever hands over the state that came back with it, so
//! a login whose state expired between turns would go without one until the
//! next response happened to carry a new one. The probe closes that gap: a
//! tiny Responses turn, sent as the login's own Codex would send it but
//! through the proxy pool, whose only purpose is the state upstream issues
//! with it. It never carries a user's payload.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use serde_json::json;
use tracing::{debug, info, warn};

use super::{StateKey, TurnStateStore, proxy_pool};
use crate::upstream::accounts::AccountService;
use crate::upstream::client::Credentials;
use crate::upstream::sse;

/// How often due keys are looked for.
const SCAN_INTERVAL: Duration = Duration::from_secs(5);
/// How often the logins to keep states for are re-read from the database.
const TRACK_INTERVAL: Duration = Duration::from_secs(60);
/// Probes started per scan, so a burst of due keys is spread out.
const MAX_PER_SCAN: usize = 4;
/// How long an account whose credentials upstream refused is left alone.
const AUTH_BACKOFF_SECS: i64 = 60;
/// How long an exit has to accept the connection. Public pools are mostly
/// dead, and the probe has to walk past those quickly.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Keeps the states of every key live traffic uses fresh, for as long as the
/// gateway runs.
pub fn spawn(store: &Arc<TurnStateStore>, accounts: &Arc<AccountService>) {
    let store = Arc::downgrade(store);
    let accounts = Arc::downgrade(accounts);
    tokio::spawn(async move {
        let mut tracked_at: Option<tokio::time::Instant> = None;
        loop {
            let (Some(store), Some(accounts)) = (store.upgrade(), accounts.upgrade()) else {
                return;
            };
            if tracked_at.is_none_or(|at| at.elapsed() >= TRACK_INTERVAL) {
                track_configured_keys(&store, &accounts).await;
                tracked_at = Some(tokio::time::Instant::now());
            }
            scan(&store, &accounts).await;
            drop(store);
            drop(accounts);
            tokio::time::sleep(SCAN_INTERVAL).await;
        }
    });
}

/// Registers every (login, managed model) pair so the probe keeps their
/// states fresh from the moment it is switched on, instead of waiting for a
/// request to name one. The model list is configured, never guessed.
async fn track_configured_keys(store: &Arc<TurnStateStore>, accounts: &Arc<AccountService>) {
    let settings = store.settings();
    if !settings.enabled || !settings.probe.enabled || !settings.probe.has_exit() {
        return;
    }
    let models: Vec<String> = settings
        .models
        .iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty() && model != "*")
        .collect();
    if models.is_empty() {
        return;
    }
    let logins = match accounts.active_logins().await {
        Ok(logins) => logins,
        Err(error) => {
            warn!(%error, "turn state probe could not list upstream logins");
            return;
        }
    };
    for login in logins {
        for model in &models {
            let key = StateKey::new(&login.account_id, login.platform(), model);
            if store.track(&key) {
                info!(
                    account_id = %login.account_id,
                    platform = login.platform(),
                    %model,
                    "keeping a turn state for this login"
                );
            }
        }
    }
}

async fn scan(store: &Arc<TurnStateStore>, accounts: &Arc<AccountService>) {
    let mut due = store.due_keys(Utc::now());
    due.truncate(MAX_PER_SCAN);
    for (key, reason) in due {
        if !store.start_probe(&key, Utc::now()) {
            continue;
        }
        let store = Arc::clone(store);
        let accounts = Arc::clone(accounts);
        tokio::spawn(async move {
            let outcome = run(&store, &accounts, &key).await;
            let changed = store.finish_probe(&key, &outcome, &reason);
            if outcome == "ok" {
                info!(
                    account_id = %key.account_id,
                    platform = %key.platform,
                    model = %key.model,
                    %reason,
                    "probed a fresh turn state"
                );
            } else if changed {
                // A probe that keeps failing the same way says it once; the
                // console's history keeps every attempt.
                warn!(
                    account_id = %key.account_id,
                    platform = %key.platform,
                    model = %key.model,
                    %reason,
                    %outcome,
                    "turn state probe did not yield a state"
                );
            } else {
                debug!(
                    account_id = %key.account_id,
                    model = %key.model,
                    %outcome,
                    "turn state probe failed again"
                );
            }
        });
    }
}

/// One probe: at most `max_attempts` exits, all sharing one budget.
async fn run(store: &TurnStateStore, accounts: &AccountService, key: &StateKey) -> String {
    let settings = store.settings();
    let probe = &settings.probe;
    let account = match accounts.resolve(&key.account_id, &key.platform).await {
        Ok(Some(account)) => account,
        Ok(None) => return "auth_unavailable".to_string(),
        Err(error) => {
            warn!(%error, "turn state probe could not resolve its upstream login");
            return "auth_unavailable".to_string();
        }
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(probe.timeout_seconds);
    // Read the pool now: one configured entry may be a file listing hundreds
    // of exits, and it is re-read on every probe so an updated list applies
    // without a restart.
    let exits = proxy_pool::expand(&probe.proxy_pool);
    if !probe.proxy_pool.is_empty() && exits.is_empty() {
        return "no_exit".to_string();
    }
    let pool_size = exits.len();
    let attempts = probe.max_attempts.min(pool_size.max(1));
    let mut outcome = "probe_failed".to_string();
    for _ in 0..attempts {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        // A configured pool is the only way out: when every exit is cooling
        // the probe waits rather than fall back to the gateway's own egress,
        // which is the address the pool exists to avoid.
        let exit = if pool_size == 0 {
            if !probe.allow_direct {
                return "no_exit".to_string();
            }
            None
        } else {
            match store.next_proxy(pool_size, Utc::now()) {
                Some(index) => Some((index, exits[index].clone())),
                None => return "exits_cooling".to_string(),
            }
        };
        // The attempts share one budget. A dead exit spends only the connect
        // timeout of it, so the one that answers still has room for a whole
        // turn.
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        let client = match proxy_pool::client(
            exit.as_ref().map(|(_, url)| url.as_str()),
            left.max(Duration::from_secs(1)),
            CONNECT_TIMEOUT,
        ) {
            Ok(client) => client,
            Err(error) => {
                warn!(%error, "turn state probe could not build its client");
                outcome = "proxy_unavailable".to_string();
                continue;
            }
        };
        let (status, value) = attempt(accounts, &account, key, &client).await;
        outcome = status;
        if outcome == "ok"
            && let Some(value) = value
        {
            if let Some((index, _)) = exit {
                store.clear_proxy_cooldown(index);
            }
            if store.capture(key, &value, "probe") {
                return "ok".to_string();
            }
            outcome = "state_rejected".to_string();
            continue;
        }
        if account_level_failure(&outcome) {
            let backoff = if quota_failure(&outcome) {
                probe.quota_backoff_seconds as i64
            } else {
                AUTH_BACKOFF_SECS
            };
            store.block_account(
                &key.account_id,
                Utc::now() + chrono::Duration::seconds(backoff),
            );
            if quota_failure(&outcome) {
                store.block_key(
                    key,
                    Utc::now() + chrono::Duration::seconds(probe.quota_backoff_seconds as i64),
                );
            }
            return outcome;
        }
        // A transport failure says something about the exit, not the account.
        if let Some((index, url)) = &exit
            && transport_failure(&outcome)
        {
            debug!(proxy = %proxy_pool::display(url), %outcome, "cooling a probe exit");
            store.cool_proxy(
                *index,
                Utc::now() + chrono::Duration::seconds(probe.retry_seconds as i64),
            );
        }
    }
    outcome
}

/// One request through one exit, reported as a probe outcome plus the state
/// upstream issued.
async fn attempt(
    accounts: &AccountService,
    account: &crate::db::accounts::Account,
    key: &StateKey,
    client: &reqwest::Client,
) -> (String, Option<String>) {
    let payload = json!({
        "model": key.model,
        "instructions": "",
        "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "ping" }] }],
        "tools": [],
        "store": false,
        "stream": true,
        "prompt_cache_key": uuid::Uuid::new_v4().to_string(),
    });
    let reply = accounts
        .call_with_refresh(account, |row| {
            let upstream = Arc::clone(&accounts.client);
            let payload = payload.clone();
            async move {
                upstream
                    .post_responses_with(
                        client,
                        &Credentials {
                            access_token: &row.access_token,
                            account_id: &row.account_id,
                            platform: row.platform(),
                        },
                        &payload,
                    )
                    .await
            }
        })
        .await;
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            return (
                match error.status {
                    Some(status) => upstream_outcome(status, &error.message),
                    None => exit_outcome(&error.message),
                },
                None,
            );
        }
    };
    if !(200..300).contains(&reply.status) {
        return (upstream_outcome(reply.status, &reply.body), None);
    }
    // An HTTP 200 whose stream failed issues no state worth keeping.
    let Some(response) =
        sse::terminal_response(&reply.body).filter(|response| response["status"] == "completed")
    else {
        return ("upstream_incomplete".to_string(), None);
    };
    // Upstream does not always serve the model that was asked for: a request
    // it treats as suspect is answered by a cheaper one, and the state that
    // comes back belongs to that model. Caching it under the model the probe
    // asked for would hand a client the wrong turn state.
    if let Some(served) = response["model"].as_str()
        && !served.is_empty()
        && !same_model(served, &key.model)
    {
        return (format!("model_downgraded_{served}"), None);
    }
    match reply.turn_state {
        Some(value) => ("ok".to_string(), Some(value)),
        None => ("no_state_issued".to_string(), None),
    }
}

/// Whether two model ids name the same model, ignoring a dated snapshot
/// suffix.
fn same_model(left: &str, right: &str) -> bool {
    crate::billing::pricing::base_model_id(left.trim())
        .eq_ignore_ascii_case(crate::billing::pricing::base_model_id(right.trim()))
}

/// What an exit did wrong, named so the console can tell the cases apart.
/// Most public proxies answer at once and refuse the tunnel — telling that
/// from an exit that is simply gone is the difference between a pool worth
/// keeping and one worth replacing. The wording is reqwest's own
/// (`tunnel error: unsuccessful`, `operation timed out`), which carries no
/// status code of its own.
fn exit_outcome(message: &str) -> String {
    let lowered = message.to_ascii_lowercase();
    if lowered.contains("tunnel") {
        // The proxy answered and would not open the tunnel, or closed it.
        return if lowered.contains("end of file") {
            "tunnel_closed".to_string()
        } else {
            "tunnel_refused".to_string()
        };
    }
    if lowered.contains("timed out") || lowered.contains("timeout") {
        return "connect_timeout".to_string();
    }
    if lowered.contains("certificate") || lowered.contains("tls") {
        // An exit that answers with a certificate the gateway will not trust
        // is intercepting TLS; it would see the login's token if it were
        // ever believed. Named apart so the console can say so.
        return if lowered.contains("unknownissuer") || lowered.contains("unknown issuer") {
            "tls_intercepted".to_string()
        } else {
            "tls_failed".to_string()
        };
    }
    if lowered.contains("connect") || lowered.contains("connection refused") {
        return "connect_failed".to_string();
    }
    "network_error".to_string()
}

/// `upstream_http_429_usage_limit_reached` and the like: the status, plus
/// the error code upstream named when it is one the probe acts on.
fn upstream_outcome(status: u16, body: &str) -> String {
    let outcome = format!("upstream_http_{status}");
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return outcome;
    };
    for field in ["code", "type"] {
        if let Some(code) = value["error"][field].as_str()
            && matches!(
                code,
                "usage_limit_reached"
                    | "rate_limit_exceeded"
                    | "insufficient_quota"
                    | "model_not_found"
                    | "invalid_api_key"
            )
        {
            return format!("{outcome}_{code}");
        }
    }
    outcome
}

/// Failures that belong to the login: another exit cannot repair them, and
/// trying only spends more of the account's quota.
fn account_level_failure(outcome: &str) -> bool {
    quota_failure(outcome)
        || outcome.starts_with("upstream_http_401")
        || outcome.starts_with("upstream_http_403")
        || outcome.contains("invalid_api_key")
        || outcome.contains("model_not_found")
}

fn quota_failure(outcome: &str) -> bool {
    outcome.starts_with("upstream_http_429")
        || outcome.contains("usage_limit_reached")
        || outcome.contains("rate_limit_exceeded")
        || outcome.contains("insufficient_quota")
}

/// Failures that belong to the exit, not to upstream: it cannot be reached,
/// or upstream does not treat what comes out of it as the client it claims to
/// be. Either way the next probe should try somewhere else.
fn transport_failure(outcome: &str) -> bool {
    matches!(outcome, "network_error" | "proxy_unavailable")
        || outcome.starts_with("model_downgraded")
        || outcome.starts_with("tunnel_")
        || outcome.starts_with("connect_")
        || outcome.starts_with("tls_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upstream_error_keeps_the_code_the_probe_acts_on() {
        assert_eq!(
            upstream_outcome(429, r#"{"error":{"code":"usage_limit_reached"}}"#),
            "upstream_http_429_usage_limit_reached"
        );
        assert_eq!(
            upstream_outcome(404, r#"{"error":{"type":"model_not_found"}}"#),
            "upstream_http_404_model_not_found"
        );
        // An unrelated code is not worth carrying.
        assert_eq!(
            upstream_outcome(400, r#"{"error":{"code":"invalid_request"}}"#),
            "upstream_http_400"
        );
        assert_eq!(upstream_outcome(502, "<html>"), "upstream_http_502");
    }

    #[test]
    fn an_exit_failure_says_what_the_exit_did() {
        // The messages below are what the gateway's own client reports for
        // exits of a public pool, cause chain and all.
        assert_eq!(
            exit_outcome(
                "error sending request | client error (Connect) | tunnel error: unsuccessful"
            ),
            "tunnel_refused"
        );
        assert_eq!(
            exit_outcome(
                "error sending request | client error (Connect) | tunnel error: unexpected end of file"
            ),
            "tunnel_closed"
        );
        assert_eq!(
            exit_outcome("error sending request | client error (Connect) | operation timed out"),
            "connect_timeout"
        );
        assert_eq!(
            exit_outcome("error sending request | client error (Connect)"),
            "connect_failed"
        );
        assert_eq!(
            exit_outcome("client error (Connect) | invalid peer certificate: UnknownIssuer"),
            "tls_intercepted"
        );
        assert_eq!(
            exit_outcome(
                "client error (Connect) | error connecting to socks proxy | SOCKS error: failed to create underlying connection"
            ),
            "connect_failed"
        );
        assert_eq!(exit_outcome("something else entirely"), "network_error");
        // Every one of them belongs to the exit, so the probe moves on.
        for outcome in ["tunnel_refused", "tunnel_closed", "connect_timeout"] {
            assert!(transport_failure(outcome), "{outcome}");
            assert!(!account_level_failure(outcome), "{outcome}");
        }
    }

    #[test]
    fn a_dated_snapshot_is_the_same_model() {
        assert!(same_model("gpt-6-astra", "gpt-6-astra-2026-01-15"));
        assert!(same_model("GPT-6-Astra", "gpt-6-astra"));
        assert!(!same_model("gpt-5.6-luna", "gpt-6-astra"));
    }

    #[test]
    fn failures_are_blamed_on_the_login_or_on_the_exit() {
        assert!(account_level_failure(
            "upstream_http_429_usage_limit_reached"
        ));
        assert!(quota_failure("upstream_http_429"));
        assert!(account_level_failure("upstream_http_401"));
        assert!(!account_level_failure("upstream_http_503"));
        assert!(!quota_failure("upstream_http_401"));
        assert!(transport_failure("network_error"));
        // An exit whose requests upstream answers with a cheaper model is
        // spent for this purpose, however well it connects.
        assert!(transport_failure("model_downgraded_gpt-5.6-luna"));
        assert!(!account_level_failure("model_downgraded_gpt-5.6-luna"));
        assert!(!transport_failure("upstream_http_503"));
    }
}
