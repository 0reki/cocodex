//! Shapes `/wham/usage` and daily analytics into the console's account
//! usage view.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

const CREDITS_PER_USD: f64 = 25.0;
pub const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_ANALYTICS_DAYS: i64 = 90;

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(_) | Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
    .filter(|v: &f64| v.is_finite())
}

fn rounded(value: f64) -> f64 {
    (value * 1e8).round() / 1e8
}

fn iso_seconds(seconds: i64) -> String {
    DateTime::<Utc>::from_timestamp(seconds, 0)
        .map(crate::db::iso)
        .unwrap_or_default()
}

fn iso_date(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub used_percent: f64,
    pub limit_window_seconds: i64,
    pub reset_after_seconds: Option<i64>,
    pub reset_at: i64,
}

impl Window {
    pub fn to_json(self) -> Value {
        json!({
            "usedPercent": self.used_percent,
            "limitWindowSeconds": self.limit_window_seconds,
            "resetAfterSeconds": self.reset_after_seconds,
            "resetAt": self.reset_at,
            "startsAt": iso_seconds(self.reset_at - self.limit_window_seconds),
            "resetsAt": iso_seconds(self.reset_at),
        })
    }
}

fn normalize_window(value: Option<&Value>) -> Option<Window> {
    let value = value?.as_object()?;
    let limit = number(value.get("limit_window_seconds"))?.trunc() as i64;
    let reset_at = number(value.get("reset_at"))?.trunc() as i64;
    if limit <= 0 || reset_at <= 0 {
        return None;
    }
    Some(Window {
        used_percent: number(value.get("used_percent"))
            .unwrap_or(0.0)
            .clamp(0.0, 100.0),
        limit_window_seconds: limit,
        reset_after_seconds: number(value.get("reset_after_seconds"))
            .map(|v| v.trunc().max(0.0) as i64),
        reset_at,
    })
}

pub struct RateLimit {
    pub allowed: Option<bool>,
    pub limit_reached: Option<bool>,
    pub primary: Option<Window>,
    pub secondary: Option<Window>,
}

impl RateLimit {
    pub fn from_usage(usage: &Value) -> Self {
        let rate = usage.get("rate_limit");
        Self {
            allowed: rate.and_then(|r| r.get("allowed")).and_then(Value::as_bool),
            limit_reached: rate
                .and_then(|r| r.get("limit_reached"))
                .and_then(Value::as_bool),
            primary: normalize_window(rate.and_then(|r| r.get("primary_window"))),
            secondary: normalize_window(rate.and_then(|r| r.get("secondary_window"))),
        }
    }

    pub fn weekly(&self) -> Option<Window> {
        [self.primary, self.secondary]
            .into_iter()
            .flatten()
            .find(|w| w.limit_window_seconds == WEEK_SECONDS)
    }

    fn longest(&self) -> Option<Window> {
        [self.primary, self.secondary]
            .into_iter()
            .flatten()
            .max_by_key(|w| w.limit_window_seconds)
    }

    fn to_json(&self) -> Value {
        json!({
            "allowed": self.allowed,
            "limitReached": self.limit_reached,
            "primaryWindow": self.primary.map(Window::to_json),
            "secondaryWindow": self.secondary.map(Window::to_json),
        })
    }
}

fn counters(value: Option<&Value>) -> Value {
    let get = |key: &str| number(value.and_then(|v| v.get(key))).map(|v| v.max(0.0));
    let integer = |key: &str| get(key).map(|v| v.trunc() as i64);
    let credits = get("credits");
    json!({
        "users": integer("users"),
        "threads": integer("threads"),
        "turns": integer("turns"),
        "credits": credits,
        "usd": credits.map(|c| rounded(c / CREDITS_PER_USD)),
        "uncachedTextInputTokens": integer("uncached_text_input_tokens"),
        "cachedTextInputTokens": integer("cached_text_input_tokens"),
        "textOutputTokens": integer("text_output_tokens"),
        "textTotalTokens": integer("text_total_tokens"),
    })
}

fn with_counters(label_key: &str, label: &str, value: &Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert(label_key.into(), Value::String(label.to_string()));
    if let Value::Object(fields) = counters(Some(value)) {
        object.extend(fields);
    }
    Value::Object(object)
}

fn daily_rows(payload: &Value) -> Vec<Value> {
    let mut rows: Vec<Value> = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.is_object())
        .filter_map(|item| {
            let date = item.get("date").and_then(Value::as_str)?.to_string();
            let valid = date.len() == 10
                && date.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                });
            if !valid {
                return None;
            }
            let list = |key: &str, label: &str| -> Vec<Value> {
                item.get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|entry| entry.is_object())
                    .map(|entry| {
                        let name = entry.get(label).and_then(Value::as_str).unwrap_or("");
                        let key = if label == "client_id" {
                            "clientId"
                        } else {
                            "model"
                        };
                        with_counters(key, name, entry)
                    })
                    .collect()
            };
            Some(json!({
                "date": date,
                "totals": counters(item.get("totals")),
                "clients": list("clients", "client_id"),
                "models": list("models", "model"),
            }))
        })
        .collect();
    rows.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    rows
}

/// Days of daily analytics to request: the longest rate-limit window,
/// capped at 90 days.
pub fn analytics_range(usage: &Value, captured_at: DateTime<Utc>) -> (String, String) {
    let earliest = captured_at.timestamp() - MAX_ANALYTICS_DAYS * 24 * 60 * 60;
    let start = RateLimit::from_usage(usage)
        .longest()
        .map(|w| w.reset_at - w.limit_window_seconds)
        .unwrap_or(captured_at.timestamp());
    let start = DateTime::<Utc>::from_timestamp(start.max(earliest), 0).unwrap_or(captured_at);
    (iso_date(start), iso_date(captured_at))
}

pub fn summarize(usage: &Value, daily_usage: &Value, captured_at: DateTime<Utc>) -> Value {
    let rate_limit = RateLimit::from_usage(usage);
    let weekly = rate_limit.weekly();
    let daily = daily_rows(daily_usage);
    let credits_of = |row: &Value| row["totals"]["credits"].as_f64().unwrap_or(0.0);
    let observed = weekly
        .map(|w| {
            let starts = iso_seconds(w.reset_at - w.limit_window_seconds);
            let start_date = &starts[..10.min(starts.len())];
            rounded(
                daily
                    .iter()
                    .filter(|row| row["date"].as_str().unwrap_or("") >= start_date)
                    .map(credits_of)
                    .sum(),
            )
        })
        .unwrap_or(0.0);
    let total = rounded(daily.iter().map(credits_of).sum());
    let today = iso_date(captured_at);
    let bool_field = |value: &Value, key: &str| value.get(key).and_then(Value::as_bool);

    json!({
        "capturedAt": crate::db::iso(captured_at),
        "planType": usage.get("plan_type").and_then(Value::as_str),
        "rateLimit": rate_limit.to_json(),
        "credits": usage.get("credits").filter(|v| v.is_object()).map(|credits| json!({
            "hasCredits": bool_field(credits, "has_credits"),
            "unlimited": bool_field(credits, "unlimited"),
            "overageLimitReached": bool_field(credits, "overage_limit_reached"),
            "balance": match credits.get("balance") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Number(n)) => Some(n.to_string()),
                _ => None,
            },
        })),
        "spendControl": usage.get("spend_control").filter(|v| v.is_object()).map(|control| json!({
            "reached": bool_field(control, "reached"),
            "individualLimit": control.get("individual_limit").cloned().unwrap_or(Value::Null),
        })),
        "rateLimitResetCredits": usage.get("rate_limit_reset_credits").filter(|v| v.is_object()).map(|reset| json!({
            "availableCount": number(reset.get("available_count")).map(|v| v.max(0.0)),
            "applicableAvailableCount": number(reset.get("applicable_available_count")).map(|v| v.max(0.0)),
        })),
        "today": daily.iter().find(|row| row["date"].as_str() == Some(today.as_str())).cloned(),
        "daily": daily,
        "totals": { "credits": total, "usd": rounded(total / CREDITS_PER_USD) },
        "weeklyEstimate": {
            "available": false,
            "reason": "quota_inference_disabled",
            "method": null,
            "approximate": false,
            "window": weekly.map(Window::to_json),
            "observedCredits": observed,
            "observedUsd": rounded(observed / CREDITS_PER_USD),
            "estimatedTotalCredits": null,
            "estimatedTotalUsd": null,
            "estimatedRemainingUsd": null,
        },
    })
}
