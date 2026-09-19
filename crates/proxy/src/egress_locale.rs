//! The timezone and current date the gateway presents in the conversation's
//! `<environment_context>`.
//!
//! A genuine Codex client fills those from the user's own machine
//! (`iana_time_zone::get_timezone()` and the local date), which leaks the
//! user's location. The gateway replaces them with the location of its own
//! egress IP, so upstream sees a timezone consistent with where the traffic
//! comes from. The egress location is geolocated once at startup and reused
//! for the whole process lifetime; the date is derived from it per request
//! so it stays correct across midnight.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{info, warn};

/// Geolocates the caller's own (egress) IP, returning its IANA timezone and
/// UTC offset in seconds. No API key, rate-limited to ~45 requests/minute,
/// which one startup lookup never approaches.
const LOOKUP_URL: &str = "http://ip-api.com/json/?fields=status,timezone,offset";
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// The timezone presented upstream and the offset its date is computed in.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Locale {
    timezone: String,
    offset_seconds: i64,
}

impl Locale {
    /// Codex's own fallback when it cannot read the local timezone, so a
    /// plausible value before the lookup finishes or when it fails.
    fn utc() -> Self {
        Self {
            timezone: "Etc/UTC".to_string(),
            offset_seconds: 0,
        }
    }

    /// Today's date at this locale's offset, formatted like Codex's
    /// `%Y-%m-%d`.
    fn current_date(&self) -> String {
        let now = chrono::Utc::now() + chrono::Duration::seconds(self.offset_seconds);
        now.format("%Y-%m-%d").to_string()
    }
}

struct State {
    locale: Locale,
    /// Whether the one-time geolocation has been kicked off.
    lookup_started: bool,
}

/// Resolves the egress timezone and date. Pinned by `COCODEX_EGRESS_LOCALE`,
/// otherwise geolocated once in the background (UTC until it resolves).
pub struct EgressLocaleResolver {
    state: Mutex<State>,
    http: reqwest::Client,
}

impl EgressLocaleResolver {
    /// `COCODEX_EGRESS_LOCALE` pins the locale as `<iana>` or
    /// `<iana>|<utc_offset_seconds>` (offset defaults to 0); `auto` or unset
    /// geolocates the egress IP.
    pub fn from_env(http: reqwest::Client) -> Result<Arc<Self>, String> {
        let pinned = std::env::var("COCODEX_EGRESS_LOCALE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "auto");
        let (locale, pinned) = match pinned {
            Some(value) => (parse_pinned_locale(&value)?, true),
            None => (Locale::utc(), false),
        };
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                locale,
                // A pinned locale never triggers the geolocation lookup.
                lookup_started: pinned,
            }),
            http,
        }))
    }

    /// The timezone and today's date the gateway presents. Never blocks; the
    /// first call starts the background geolocation when one is due.
    pub fn snapshot(self: &Arc<Self>) -> (String, String) {
        let mut state = self.state.lock().expect("egress locale poisoned");
        if !state.lookup_started && tokio::runtime::Handle::try_current().is_ok() {
            state.lookup_started = true;
            let this = Arc::clone(self);
            tokio::spawn(async move { this.lookup().await });
        }
        (state.locale.timezone.clone(), state.locale.current_date())
    }

    async fn lookup(&self) {
        match self.fetch().await {
            Ok(locale) => {
                info!(timezone = %locale.timezone, "resolved egress locale");
                self.state.lock().expect("egress locale poisoned").locale = locale;
            }
            // Never log a body: a geolocation response can carry the IP.
            Err(reason) => warn!(%reason, "egress locale lookup failed; presenting UTC"),
        }
    }

    async fn fetch(&self) -> Result<Locale, String> {
        let response = self
            .http
            .get(LOOKUP_URL)
            .timeout(LOOKUP_TIMEOUT)
            .send()
            .await
            .map_err(|_| "network error".to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "invalid geolocation payload".to_string())?;
        if payload.get("status").and_then(|v| v.as_str()) != Some("success") {
            return Err("geolocation reported failure".to_string());
        }
        let timezone = payload
            .get("timezone")
            .and_then(|v| v.as_str())
            .filter(|tz| !tz.is_empty())
            .ok_or("geolocation returned no timezone")?
            .to_string();
        let offset_seconds = payload
            .get("offset")
            .and_then(serde_json::Value::as_i64)
            .ok_or("geolocation returned no offset")?;
        Ok(Locale {
            timezone,
            offset_seconds,
        })
    }
}

fn parse_pinned_locale(value: &str) -> Result<Locale, String> {
    let (timezone, offset) = match value.split_once('|') {
        Some((timezone, offset)) => (
            timezone.trim(),
            offset
                .trim()
                .parse::<i64>()
                .map_err(|_| "COCODEX_EGRESS_LOCALE offset must be whole seconds".to_string())?,
        ),
        None => (value, 0),
    };
    if timezone.is_empty() {
        return Err("COCODEX_EGRESS_LOCALE must name a timezone".to_string());
    }
    Ok(Locale {
        timezone: timezone.to_string(),
        offset_seconds: offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver() -> Arc<EgressLocaleResolver> {
        Arc::new(EgressLocaleResolver {
            state: Mutex::new(State {
                locale: Locale::utc(),
                lookup_started: true,
            }),
            http: reqwest::Client::new(),
        })
    }

    #[test]
    fn pinned_locale_parses_timezone_and_offset() {
        assert_eq!(
            parse_pinned_locale("Asia/Shanghai|28800").unwrap(),
            Locale {
                timezone: "Asia/Shanghai".to_string(),
                offset_seconds: 28800,
            }
        );
        assert_eq!(
            parse_pinned_locale("Etc/UTC").unwrap(),
            Locale {
                timezone: "Etc/UTC".to_string(),
                offset_seconds: 0,
            }
        );
        assert!(parse_pinned_locale("Asia/Shanghai|noon").is_err());
        assert!(parse_pinned_locale("|28800").is_err());
    }

    #[test]
    fn date_is_computed_at_the_offset() {
        let ahead = Locale {
            timezone: "Kiritimati".to_string(),
            offset_seconds: 14 * 3600,
        };
        let behind = Locale {
            timezone: "Etc/GMT+12".to_string(),
            offset_seconds: -12 * 3600,
        };
        let expected = |offset: i64| {
            (chrono::Utc::now() + chrono::Duration::seconds(offset))
                .format("%Y-%m-%d")
                .to_string()
        };
        assert_eq!(ahead.current_date(), expected(ahead.offset_seconds));
        assert_eq!(behind.current_date(), expected(behind.offset_seconds));
        // The extreme offsets span more than a day, so at least one differs
        // from UTC's date at any instant.
        assert!(
            ahead.current_date() != Locale::utc().current_date()
                || behind.current_date() != Locale::utc().current_date()
        );
    }

    #[test]
    fn a_pinned_resolver_never_starts_a_lookup() {
        let resolver = resolver();
        let (timezone, date) = resolver.snapshot();
        assert_eq!(timezone, "Etc/UTC");
        assert_eq!(date.len(), "2026-09-19".len());
        assert!(resolver.state.lock().unwrap().lookup_started);
    }
}
