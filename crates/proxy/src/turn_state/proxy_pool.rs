//! The exits a probe leaves through.
//!
//! Relayed traffic keeps using the gateway's own egress; only the probes
//! that fetch a turn state rotate through this pool, so a state is fetched
//! from somewhere other than where every user's traffic comes from.

use std::time::Duration;

use rand::Rng;
use url::Url;

use super::settings::ProxyEndpoint;

/// Replaced with eight random hex characters on every dial, for providers
/// whose exit IP follows a session token in the proxy username.
const SESSION_PLACEHOLDER: &str = "{session}";

fn session_token() -> String {
    let value: u32 = rand::thread_rng().r#gen();
    format!("{value:08x}")
}

/// Checks a proxy URL the console offers, before it is stored.
pub fn check_url(raw: &str) -> Result<(), String> {
    let probe = raw.replace(SESSION_PLACEHOLDER, "00000000");
    let url = Url::parse(&probe).map_err(|error| format!("invalid proxy url: {error}"))?;
    // The schemes reqwest can dial. `socks5h`/`socks4a` resolve the target
    // through the proxy, which is what a probe wants.
    if !matches!(
        url.scheme(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return Err("proxy url must be http, https, socks4(a) or socks5(h)".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("proxy url must name a host".into());
    }
    Ok(())
}

fn with_session(url: &str) -> String {
    url.replace(SESSION_PLACEHOLDER, &session_token())
}

/// The URLs to dial for this entry, each with a fresh session token. A file
/// holds a whole pool, one proxy per line (`#` comments and blank lines are
/// skipped), and is read on every probe so an updated list applies without a
/// restart; a line that is not a proxy URL is left out rather than spoiling
/// the rest.
pub fn resolve_all(endpoint: &ProxyEndpoint) -> Result<Vec<String>, String> {
    if !endpoint.url.trim().is_empty() {
        let url = endpoint.url.trim();
        check_url(url)?;
        return Ok(vec![with_session(url)]);
    }
    if !endpoint.url_env.trim().is_empty() {
        let name = endpoint.url_env.trim();
        let value = std::env::var(name)
            .map_err(|_| format!("proxy environment variable {name} is not set"))?;
        let url = value.trim();
        check_url(url)?;
        return Ok(vec![with_session(url)]);
    }
    if !endpoint.url_file.trim().is_empty() {
        let path = endpoint.url_file.trim();
        let text =
            std::fs::read_to_string(path).map_err(|error| format!("proxy file {path}: {error}"))?;
        let urls: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter(|line| check_url(line).is_ok())
            .map(with_session)
            .collect();
        if urls.is_empty() {
            return Err(format!("proxy file {path} holds no usable url"));
        }
        return Ok(urls);
    }
    Err("proxy entry names no url".into())
}

/// Every exit the configured pool currently offers. An entry that cannot be
/// read is left out with a warning: one bad line or a missing file must not
/// stop the probe from using the rest.
pub fn expand(pool: &[ProxyEndpoint]) -> Vec<String> {
    let mut exits = Vec::new();
    for endpoint in pool {
        match resolve_all(endpoint) {
            Ok(urls) => exits.extend(urls),
            Err(error) => {
                tracing::warn!(%error, "turn state probe skipped an unusable proxy entry")
            }
        }
    }
    exits
}

/// `scheme://host:port` — a proxy as logs and the console may name it,
/// without the credentials the URL carries.
pub fn display(url: &str) -> String {
    match Url::parse(url) {
        Ok(parsed) => match (parsed.host_str(), parsed.port()) {
            (Some(host), Some(port)) => format!("{}://{host}:{port}", parsed.scheme()),
            (Some(host), None) => format!("{}://{host}", parsed.scheme()),
            (None, _) => parsed.scheme().to_string(),
        },
        Err(_) => "invalid".to_string(),
    }
}

/// The same URL with its password replaced, for anything the console reads
/// back. A write that returns this value unchanged keeps the stored secret
/// (see `settings_with_secrets`).
pub const REDACTED_PASSWORD: &str = "***";

pub fn redact(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    if parsed.password().is_none() {
        return url.to_string();
    }
    let _ = parsed.set_password(Some(REDACTED_PASSWORD));
    parsed.to_string()
}

/// An HTTP client that dials through `proxy`, or directly when it is `None`.
/// Codex negotiates no compression and neither does a probe made in its name.
///
/// The two budgets are separate on purpose: an exit that is gone fails to
/// connect, which is quick to find out, while an exit that works still has to
/// carry a whole Responses turn. Cutting the request short at the time a dead
/// exit deserves would throw away the good ones.
pub fn client(
    proxy: Option<&str>,
    timeout: Duration,
    connect_timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_gzip()
        .no_zstd()
        .timeout(timeout)
        .connect_timeout(connect_timeout.min(timeout));
    if let Some(proxy) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy).map_err(|error| format!("invalid proxy url: {error}"))?,
        );
    } else {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|error| format!("failed to build proxy client: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_proxy_schemes_are_accepted() {
        assert!(check_url("http://user:pass@proxy.example:8080").is_ok());
        assert!(check_url("socks5h://proxy.example:1080").is_ok());
        assert!(check_url("socks4a://proxy.example:1080").is_ok());
        assert!(check_url("https://proxy.example:8443").is_ok());
        assert!(check_url("socks5h://[::1]:1080").is_ok());
        assert!(check_url("ftp://proxy.example:21").is_err());
        assert!(check_url("proxy.example:8080").is_err());
    }

    fn resolve_one(endpoint: &ProxyEndpoint) -> Result<String, String> {
        resolve_all(endpoint).map(|urls| urls[0].clone())
    }

    #[test]
    fn a_session_placeholder_changes_on_every_resolve() {
        let endpoint = ProxyEndpoint {
            url: "http://user-{session}:pass@proxy.example:8080".into(),
            ..ProxyEndpoint::default()
        };
        let first = resolve_one(&endpoint).unwrap();
        assert!(!first.contains(SESSION_PLACEHOLDER));
        // Eight hex characters where the placeholder was.
        let token = first
            .trim_start_matches("http://user-")
            .split(':')
            .next()
            .unwrap()
            .to_string();
        assert_eq!(token.len(), 8);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn an_environment_entry_reads_its_variable() {
        // SAFETY: single-threaded test, no other thread reads the variable.
        unsafe { std::env::set_var("COCODEX_TEST_PROXY_URL", "socks5h://127.0.0.1:1080") };
        let endpoint = ProxyEndpoint {
            url_env: "COCODEX_TEST_PROXY_URL".into(),
            ..ProxyEndpoint::default()
        };
        assert_eq!(resolve_one(&endpoint).unwrap(), "socks5h://127.0.0.1:1080");
        let missing = ProxyEndpoint {
            url_env: "COCODEX_TEST_PROXY_MISSING".into(),
            ..ProxyEndpoint::default()
        };
        assert!(resolve_all(&missing).is_err());
    }

    #[test]
    fn a_file_entry_is_a_whole_pool() {
        let dir = std::env::temp_dir().join(format!("cocodex-proxy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pool.txt");
        std::fs::write(
            &path,
            "# comment\n\nhttp://127.0.0.1:8080\nnot a proxy\nsocks5h://127.0.0.1:1080\n",
        )
        .unwrap();
        let endpoint = ProxyEndpoint {
            url_file: path.to_string_lossy().to_string(),
            ..ProxyEndpoint::default()
        };
        // Comments, blank lines and unusable lines are skipped; the rest are
        // all exits.
        assert_eq!(
            resolve_all(&endpoint).unwrap(),
            vec![
                "http://127.0.0.1:8080".to_string(),
                "socks5h://127.0.0.1:1080".to_string(),
            ]
        );
        assert_eq!(expand(std::slice::from_ref(&endpoint)).len(), 2);
        // A file with nothing usable in it is an error, not an empty pool.
        std::fs::write(&path, "# only comments\n").unwrap();
        assert!(resolve_all(&endpoint).is_err());
        assert!(expand(&[endpoint]).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn credentials_never_reach_logs_or_the_console() {
        let url = "http://user:secret@proxy.example:8080";
        assert_eq!(display(url), "http://proxy.example:8080");
        assert!(!redact(url).contains("secret"));
        assert!(redact(url).contains("user"));
        assert_eq!(
            redact("socks5h://proxy.example:1080"),
            "socks5h://proxy.example:1080"
        );
    }
}
