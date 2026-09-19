//! The Codex client identity presented to OpenAI: a genuine-looking
//! User-Agent per platform and the current stable Codex version.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tracing::warn;

pub const DEFAULT_CODEX_CLIENT_VERSION: &str = "0.153.4";
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);
const RELEASES_URL: &str = "https://api.github.com/repos/openai/codex/releases/latest";

fn ascii_only(value: String) -> String {
    value
        .chars()
        .map(|c| if (' '..='~').contains(&c) { c } else { '_' })
        .collect()
}

/// Mirrors Codex `get_codex_user_agent()` with a representative OS build.
pub fn user_agent_for_platform(platform: &str, version: &str) -> String {
    ascii_only(match platform.trim().to_lowercase().as_str() {
        "windows" => format!("codex_cli_rs/{version} (Windows 10.0.22631; x86_64) WindowsTerminal"),
        "darwin" | "macos" => {
            format!("codex_cli_rs/{version} (Mac OS 14.5.0; arm64) Apple_Terminal")
        }
        _ => format!("codex_cli_rs/{version} (Debian 12; x86_64) unknown"),
    })
}

fn is_stable(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_valid_pin(version: &str) -> bool {
    let (core, pre) = version.split_once('-').unwrap_or((version, ""));
    is_stable(core)
        && pre
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

struct VersionState {
    version: String,
    next_check: Option<Instant>,
    etag: Option<String>,
    refreshing: bool,
}

/// The Codex version to impersonate: `CODEX_CLIENT_VERSION` when pinned,
/// otherwise the latest stable GitHub release, refreshed in the background.
pub struct VersionResolver {
    pinned: Option<String>,
    state: Mutex<VersionState>,
    http: reqwest::Client,
}

impl VersionResolver {
    pub fn from_env(http: reqwest::Client) -> Result<Self, String> {
        let pinned = std::env::var("CODEX_CLIENT_VERSION")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "auto");
        if let Some(version) = &pinned
            && !is_valid_pin(version)
        {
            return Err("CODEX_CLIENT_VERSION must be auto or a Codex version number".into());
        }
        Ok(Self {
            pinned,
            state: Mutex::new(VersionState {
                version: DEFAULT_CODEX_CLIENT_VERSION.to_string(),
                next_check: None,
                etag: None,
                refreshing: false,
            }),
            http,
        })
    }

    /// Never blocks on GitHub; a due refresh runs in the background.
    pub fn version(self: &std::sync::Arc<Self>) -> String {
        if let Some(version) = &self.pinned {
            return version.clone();
        }
        let mut state = self.state.lock().expect("version state poisoned");
        let due = state.next_check.is_none_or(|at| Instant::now() >= at);
        if due && !state.refreshing && tokio::runtime::Handle::try_current().is_ok() {
            state.refreshing = true;
            let this = self.clone();
            tokio::spawn(async move { this.refresh().await });
        }
        state.version.clone()
    }

    async fn refresh(&self) {
        let (current, etag) = {
            let mut state = self.state.lock().expect("version state poisoned");
            state.next_check = Some(Instant::now() + RETRY_INTERVAL);
            (state.version.clone(), state.etag.clone())
        };
        let mut request = self
            .http
            .get(RELEASES_URL)
            .timeout(Duration::from_secs(5))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", user_agent_for_platform("linux", &current))
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Ok(token) = std::env::var("CODEX_GITHUB_TOKEN")
            && !token.trim().is_empty()
        {
            request = request.bearer_auth(token.trim());
        }
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let outcome = async {
            let response = request
                .send()
                .await
                .map_err(|_| "network error".to_string())?;
            let status = response.status();
            if status == reqwest::StatusCode::NOT_MODIFIED {
                return Ok(None);
            }
            if !status.is_success() {
                return Err(format!("HTTP {}", status.as_u16()));
            }
            let etag = response
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let release: serde_json::Value = response
                .json()
                .await
                .map_err(|_| "invalid release metadata".to_string())?;
            let candidate = release
                .get("tag_name")
                .and_then(|v| v.as_str())
                .map(|tag| tag.trim_start_matches("rust-v").to_string())
                .unwrap_or_default();
            let stable = is_stable(&candidate)
                && release.get("draft").and_then(|v| v.as_bool()) == Some(false)
                && release.get("prerelease").and_then(|v| v.as_bool()) == Some(false);
            if !stable {
                return Err("invalid release metadata".to_string());
            }
            Ok(Some((candidate, etag)))
        }
        .await;

        let mut state = self.state.lock().expect("version state poisoned");
        state.refreshing = false;
        match outcome {
            Ok(Some((version, etag))) => {
                state.version = version;
                state.etag = etag;
                state.next_check = Some(Instant::now() + REFRESH_INTERVAL);
            }
            Ok(None) => state.next_check = Some(Instant::now() + REFRESH_INTERVAL),
            // Never log bodies or headers: they may carry credentials.
            Err(reason) => warn!(%reason, version = %state.version, "codex version check failed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_user_agents_match_codex_format() {
        assert_eq!(
            user_agent_for_platform("windows", "0.200.0"),
            "codex_cli_rs/0.200.0 (Windows 10.0.22631; x86_64) WindowsTerminal"
        );
        assert_eq!(
            user_agent_for_platform("macos", "0.200.0"),
            "codex_cli_rs/0.200.0 (Mac OS 14.5.0; arm64) Apple_Terminal"
        );
        assert_eq!(
            user_agent_for_platform("all", "0.200.0"),
            "codex_cli_rs/0.200.0 (Debian 12; x86_64) unknown"
        );
    }

    #[test]
    fn validates_versions() {
        assert!(is_stable("0.153.4"));
        assert!(!is_stable("0.153"));
        assert!(!is_stable("0.153.4-alpha.1"));
        assert!(is_valid_pin("0.153.4-alpha.1"));
        assert!(!is_valid_pin("latest"));
    }
}
