//! The console's view of turn-state handling: the switch that decides
//! whether the gateway replaces `x-codex-turn-state` at all, which models it
//! does that for, the probe's proxy pool, and what it currently holds.

use axum::Router;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::turn_state::settings::TurnStateSettings;
use crate::turn_state::{RefreshSelector, proxy_pool};

use super::{Body, Db, fail};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/turn-state", get(read).put(update))
        .route("/api/turn-state/refresh", post(refresh))
        .route("/api/turn-state/clear", post(clear))
}

/// The settings as the console may see them: a proxy password never leaves
/// the gateway, and a write that returns the redacted URL keeps the stored
/// one (see `merge_secrets`).
fn public_settings(settings: &TurnStateSettings) -> Value {
    let mut settings = settings.clone();
    for endpoint in &mut settings.probe.proxy_pool {
        endpoint.url = proxy_pool::redact(&endpoint.url);
    }
    serde_json::to_value(settings).unwrap_or(Value::Null)
}

fn view(settings: &TurnStateSettings, status: Value) -> Response {
    // One configured entry may be a file listing many proxies, so the console
    // is told how many exits the pool actually offers right now.
    let mut status = status;
    let exits = proxy_pool::expand(&settings.probe.proxy_pool).len();
    if let Some(object) = status.as_object_mut() {
        object.insert("proxyExitCount".to_string(), json!(exits));
    }
    axum::Json(json!({ "settings": public_settings(settings), "status": status })).into_response()
}

async fn read(Db(ready): Db) -> Response {
    let settings = ready.turn_state.settings();
    view(&settings, ready.turn_state.status())
}

/// Merges a patch into a JSON object, one level deep, so the console can
/// send only what it changed without resetting the rest.
fn merge(base: &mut Value, patch: &Map<String, Value>) {
    let Some(object) = base.as_object_mut() else {
        return;
    };
    for (key, value) in patch {
        match (object.get_mut(key), value) {
            (Some(existing), Value::Object(inner)) if existing.is_object() => {
                merge(existing, inner)
            }
            _ => {
                object.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Keeps a proxy password the console read back redacted. Entries are
/// matched by everything but the password, so an edited host or username
/// counts as a new proxy and must carry its own credentials.
fn merge_secrets(new: &mut TurnStateSettings, old: &TurnStateSettings) {
    let anonymous = |url: &str| {
        url::Url::parse(url)
            .map(|mut parsed| {
                let _ = parsed.set_password(None);
                parsed.to_string()
            })
            .unwrap_or_else(|_| url.to_string())
    };
    for endpoint in &mut new.probe.proxy_pool {
        if !endpoint.url.contains(proxy_pool::REDACTED_PASSWORD) {
            continue;
        }
        let shape = anonymous(&endpoint.url);
        if let Some(stored) = old
            .probe
            .proxy_pool
            .iter()
            .find(|candidate| anonymous(&candidate.url) == shape)
        {
            endpoint.url = stored.url.clone();
        }
    }
}

async fn update(Db(ready): Db, Body(body): Body) -> Response {
    let current = ready.turn_state.settings();
    let mut merged = match serde_json::to_value(&current) {
        Ok(value) => value,
        Err(error) => return fail(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    merge(&mut merged, &body);
    let mut settings: TurnStateSettings = match serde_json::from_value(merged) {
        Ok(settings) => settings,
        Err(error) => return fail(StatusCode::BAD_REQUEST, error.to_string()),
    };
    merge_secrets(&mut settings, &current);
    match ready.turn_state.save(&ready.db, settings).await {
        Ok(saved) => view(&saved, ready.turn_state.status()),
        Err(error) => fail(StatusCode::BAD_REQUEST, error),
    }
}

fn strings(body: &Body, key: &str) -> Vec<String> {
    body.0
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn selector(body: &Body) -> RefreshSelector {
    RefreshSelector {
        accounts: strings(body, "accountIds"),
        models: strings(body, "models"),
        platforms: strings(body, "platforms"),
    }
}

fn is_empty(selector: &RefreshSelector) -> bool {
    selector.accounts.is_empty() && selector.models.is_empty() && selector.platforms.is_empty()
}

fn wants_all(body: &Body) -> bool {
    body.0.get("all").and_then(Value::as_bool).unwrap_or(false)
}

/// Queues an early probe. An empty selector needs `all`, so a console bug
/// cannot make every login probe at once.
async fn refresh(Db(ready): Db, body: Body) -> Response {
    let selector = selector(&body);
    if is_empty(&selector) && !wants_all(&body) {
        return fail(
            StatusCode::BAD_REQUEST,
            "name accountIds, models or platforms, or pass all=true",
        );
    }
    let probe = ready.turn_state.settings().probe;
    let queued = ready.turn_state.request_refresh(&selector);
    axum::Json(json!({
        "ok": true,
        "queued": queued,
        // Queuing is all this does; nothing is fetched with the probe off.
        "probeEnabled": probe.enabled && probe.has_exit(),
    }))
    .into_response()
}

/// Drops held states: `scope=expired` only those past their hour,
/// `scope=all` everything the selector names.
async fn clear(Db(ready): Db, body: Body) -> Response {
    let scope = body.str("scope");
    let only_expired = match scope.as_str() {
        "" | "expired" => true,
        "all" => false,
        _ => return fail(StatusCode::BAD_REQUEST, "scope must be expired or all"),
    };
    let selector = selector(&body);
    if !only_expired && is_empty(&selector) && !wants_all(&body) {
        return fail(
            StatusCode::BAD_REQUEST,
            "clearing every state needs all=true",
        );
    }
    let cleared = ready.turn_state.clear(&selector, only_expired);
    axum::Json(json!({ "ok": true, "cleared": cleared })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_state::settings::ProxyEndpoint;

    fn with_proxy(url: &str) -> TurnStateSettings {
        TurnStateSettings {
            probe: crate::turn_state::settings::ProbeSettings {
                proxy_pool: vec![ProxyEndpoint {
                    url: url.to_string(),
                    ..ProxyEndpoint::default()
                }],
                ..crate::turn_state::settings::ProbeSettings::default()
            },
            ..TurnStateSettings::default()
        }
    }

    #[test]
    fn a_proxy_password_is_never_read_back() {
        let settings = with_proxy("http://user:secret@proxy.example:8080");
        let public = public_settings(&settings);
        assert!(!public.to_string().contains("secret"));
    }

    #[test]
    fn writing_back_the_redacted_url_keeps_the_stored_password() {
        let stored = with_proxy("http://user:secret@proxy.example:8080");
        let mut incoming: TurnStateSettings =
            serde_json::from_value(public_settings(&stored)).unwrap();
        merge_secrets(&mut incoming, &stored);
        assert_eq!(
            incoming.probe.proxy_pool[0].url,
            "http://user:secret@proxy.example:8080"
        );
        // A different host is a new proxy and keeps what was sent.
        let mut moved = with_proxy("http://user:***@other.example:8080");
        merge_secrets(&mut moved, &stored);
        assert_eq!(
            moved.probe.proxy_pool[0].url,
            "http://user:***@other.example:8080"
        );
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let mut merged = serde_json::to_value(TurnStateSettings::default()).unwrap();
        let patch: Map<String, Value> =
            serde_json::from_str(r#"{"probe":{"enabled":true,"allowDirect":true}}"#).unwrap();
        merge(&mut merged, &patch);
        let settings: TurnStateSettings = serde_json::from_value(merged).unwrap();
        assert!(settings.probe.enabled);
        assert!(settings.probe.allow_direct);
        // Untouched fields keep their values.
        assert_eq!(settings.models, vec!["gpt-6-astra".to_string()]);
        assert_eq!(settings.probe.refresh_before_seconds, 300);
    }
}
