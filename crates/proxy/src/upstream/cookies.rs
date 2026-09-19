//! The infrastructure cookies ChatGPT hands a Codex client.
//!
//! Codex keeps Cloudflare and load-balancer cookies in one in-memory jar per
//! process, never on disk, and nothing else: account and session cookies
//! are filtered out (`codex-rs/http-client/src/chatgpt_cloudflare_cookies.rs`).
//! The gateway is the process that talks to ChatGPT, so it keeps such a jar
//! for every upstream login and OS, the same unit as the installation id.
//! A jar left idle is dropped, like a Codex process that exited, and every
//! jar is gone after a restart.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use http::HeaderMap;
use http::HeaderValue;
use http::header::SET_COOKIE;
use reqwest::cookie::{CookieStore, Jar};
use url::Url;

use super::identity::platform_family;

const IDLE_ENV: &str = "UPSTREAM_COOKIE_IDLE_SECS";
const DEFAULT_IDLE: Duration = Duration::from_secs(2 * 60 * 60);

/// Codex's allowlist of Cloudflare service cookies plus `__oailb`, the
/// OpenAI load-balancer routing cookie.
fn is_allowed_cookie_name(name: &str) -> bool {
    matches!(
        name,
        "__cf_bm"
            | "__cflb"
            | "__cfruid"
            | "__cfseq"
            | "__cfwaitingroom"
            | "__oailb"
            | "_cfuvid"
            | "cf_clearance"
            | "cf_ob_info"
            | "cf_use_ob"
    ) || name.starts_with("cf_chl_")
}

fn is_allowed_set_cookie(header: &HeaderValue) -> bool {
    header
        .to_str()
        .ok()
        .and_then(|value| value.split_once('='))
        .is_some_and(|(name, _)| is_allowed_cookie_name(name.trim()))
}

fn only_allowed_cookies(header: HeaderValue) -> Option<HeaderValue> {
    let header = header.to_str().ok()?;
    let cookies = header
        .split(';')
        .map(str::trim)
        .filter(|cookie| {
            cookie
                .split_once('=')
                .is_some_and(|(name, _)| is_allowed_cookie_name(name.trim()))
        })
        .collect::<Vec<_>>()
        .join("; ");
    (!cookies.is_empty())
        .then(|| HeaderValue::from_str(&cookies).ok())
        .flatten()
}

/// A WebSocket handshake has the same cookie scope as HTTP(S).
fn cookie_url(url: &Url) -> Url {
    let mut url = url.clone();
    let scheme = match url.scheme() {
        "wss" => Some("https"),
        "ws" => Some("http"),
        _ => None,
    };
    if let Some(scheme) = scheme {
        let _ = url.set_scheme(scheme);
    }
    url
}

struct Entry {
    jar: Arc<Jar>,
    last_used: Instant,
}

pub struct CookieJars {
    idle: Duration,
    jars: Mutex<HashMap<(String, &'static str), Entry>>,
}

impl Default for CookieJars {
    fn default() -> Self {
        Self::new(DEFAULT_IDLE)
    }
}

impl CookieJars {
    pub fn new(idle: Duration) -> Self {
        Self {
            idle,
            jars: Mutex::new(HashMap::new()),
        }
    }

    /// Idle lifetime from `UPSTREAM_COOKIE_IDLE_SECS` (default two hours).
    pub fn from_env() -> Result<Self, String> {
        match std::env::var(IDLE_ENV) {
            Ok(value) if !value.trim().is_empty() => {
                let seconds: u64 = value
                    .trim()
                    .parse()
                    .map_err(|e| format!("Invalid {IDLE_ENV} '{value}': {e}"))?;
                if seconds == 0 {
                    return Err(format!("{IDLE_ENV} must be greater than zero"));
                }
                Ok(Self::new(Duration::from_secs(seconds)))
            }
            _ => Ok(Self::default()),
        }
    }

    fn jar(&self, account_id: &str, platform: &str) -> Arc<Jar> {
        let now = Instant::now();
        let mut jars = self.jars.lock().unwrap_or_else(PoisonError::into_inner);
        jars.retain(|_, entry| now.duration_since(entry.last_used) < self.idle);
        let entry = jars
            .entry((account_id.to_string(), platform_family(platform)))
            .or_insert_with(|| Entry {
                jar: Arc::new(Jar::default()),
                last_used: now,
            });
        entry.last_used = now;
        entry.jar.clone()
    }

    /// The `Cookie` header this login's client would send to `url`.
    pub fn cookie_header(
        &self,
        account_id: &str,
        platform: &str,
        url: &Url,
    ) -> Option<HeaderValue> {
        self.jar(account_id, platform)
            .cookies(&cookie_url(url))
            .and_then(only_allowed_cookies)
    }

    /// Keeps the allowlisted cookies from a response to `url`.
    pub fn store(&self, account_id: &str, platform: &str, url: &Url, headers: &HeaderMap) {
        let mut cookies = headers
            .get_all(SET_COOKIE)
            .iter()
            .filter(|header| is_allowed_set_cookie(header))
            .peekable();
        if cookies.peek().is_none() {
            return;
        }
        self.jar(account_id, platform)
            .set_cookies(&mut cookies, &cookie_url(url));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_cookies(values: &[&str]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(SET_COOKIE, value.parse().unwrap());
        }
        headers
    }

    #[test]
    fn keeps_only_infrastructure_cookies_per_login_and_os() {
        let jars = CookieJars::default();
        let url = Url::parse("https://chatgpt.com/backend-api/codex/responses").unwrap();
        jars.store(
            "acct",
            "windows",
            &url,
            &set_cookies(&[
                "__cf_bm=bm; Path=/; Secure; HttpOnly",
                "__oailb=lb; Path=/",
                "__Secure-next-auth.session-token=secret; Path=/; Secure",
            ]),
        );
        let header = jars.cookie_header("acct", "windows", &url).unwrap();
        let mut cookies: Vec<&str> = header.to_str().unwrap().split("; ").collect();
        cookies.sort_unstable();
        assert_eq!(cookies, ["__cf_bm=bm", "__oailb=lb"]);

        // WebSocket handshakes share the jar; other logins and OSes do not.
        let wss = Url::parse("wss://chatgpt.com/backend-api/codex/responses").unwrap();
        assert!(jars.cookie_header("acct", "windows", &wss).is_some());
        assert!(jars.cookie_header("acct", "linux", &url).is_none());
        assert!(jars.cookie_header("other", "windows", &url).is_none());
    }

    #[test]
    fn idle_jars_are_dropped() {
        let jars = CookieJars::new(Duration::from_millis(20));
        let url = Url::parse("https://chatgpt.com/").unwrap();
        jars.store("acct", "linux", &url, &set_cookies(&["_cfuvid=u; Path=/"]));
        assert!(jars.cookie_header("acct", "linux", &url).is_some());
        std::thread::sleep(Duration::from_millis(40));
        assert!(jars.cookie_header("acct", "linux", &url).is_none());
    }
}
