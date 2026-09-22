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

/// The OS a platform string presents upstream: `windows` or `linux` (the
/// default, also used for generic `all` logins). The User-Agent, the
/// installation id and the cookie jar all follow this value, so one upstream
/// login on one OS looks like one Codex installation.
///
/// macOS is not among them: a ChatGPT account is logged in once per Windows
/// and once per Linux, and a macOS client is served by the Linux login, so
/// the gateway never presents a macOS machine.
pub fn platform_family(platform: &str) -> &'static str {
    match platform.trim().to_lowercase().as_str() {
        "windows" => "windows",
        _ => "linux",
    }
}

/// Originator of the interactive Codex CLI, used on the calls the gateway
/// makes in a login's name (usage reads, the console's account test).
pub const CLI_ORIGINATOR: &str = "codex-tui";

/// The machine an upstream login presents on one OS: the `os_info` pieces
/// of the User-Agent, the `std::env::consts` values in analytics events,
/// and for the gateway's own calls a terminal token and default sandbox.
/// Clients keep their type (originator, terminal or host, app-server client
/// name); the machine is the gateway's.
pub struct OsProfile {
    /// `{os_type} {version}` as `os_info` formats it.
    pub ua_os: &'static str,
    /// `os_info` architecture (`arm64` on Apple silicon).
    pub ua_arch: &'static str,
    /// `codex_terminal_detection::user_agent()` for the gateway's own calls;
    /// client traffic keeps the client's terminal.
    pub terminal: &'static str,
    /// `std::env::consts::OS`.
    pub runtime_os: &'static str,
    /// `os_info` version.
    pub runtime_os_version: &'static str,
    /// `std::env::consts::ARCH`.
    pub runtime_arch: &'static str,
    /// Turn-metadata `sandbox` tag of the platform's default sandbox.
    pub sandbox: &'static str,
}

pub fn os_profile(platform: &str) -> &'static OsProfile {
    const WINDOWS: OsProfile = OsProfile {
        ua_os: "Windows 10.0.22631",
        ua_arch: "x86_64",
        terminal: "WindowsTerminal",
        runtime_os: "windows",
        runtime_os_version: "10.0.22631",
        runtime_arch: "x86_64",
        sandbox: "windows_elevated",
    };
    const LINUX: OsProfile = OsProfile {
        ua_os: "Debian 13.0.0",
        ua_arch: "x86_64",
        terminal: "xterm-256color",
        runtime_os: "linux",
        runtime_os_version: "13.0.0",
        runtime_arch: "x86_64",
        sandbox: "seccomp",
    };
    match platform_family(platform) {
        "windows" => &WINDOWS,
        _ => &LINUX,
    }
}

/// Whether a terminal token could have come from `platform`.
///
/// Codex builds the token from the terminal it runs in
/// (`codex_terminal_detection::user_agent()`), so a token only one OS can
/// produce would contradict the OS the User-Agent names. A macOS client is
/// served by a Linux login, and its Terminal.app or iTerm2 token has to go
/// with the machine it came from.
fn terminal_fits_platform(platform: &str, terminal: &str) -> bool {
    let token = terminal.trim().to_ascii_lowercase();
    let mac_only = token.starts_with("apple_terminal") || token.starts_with("iterm.app");
    let windows_only = token.starts_with("windowsterminal");
    let unix_only = [
        "gnome-terminal",
        "konsole",
        "vte",
        "xterm",
        "screen",
        "tmux",
        "linux",
    ]
    .iter()
    .any(|name| token.starts_with(name));
    match platform_family(platform) {
        "windows" => !mac_only && !unix_only,
        _ => !mac_only && !windows_only,
    }
}

/// The sandbox tag of `tag`'s own OS, or `None` when any OS can report it.
/// Codex tags a turn with the sandbox it ran under
/// (`codex-rs/core/src/sandbox_tags.rs`); `none`, `external` and the
/// permission-mode tags say nothing about the machine.
fn sandbox_platform(tag: &str) -> Option<&'static str> {
    match tag.trim().to_ascii_lowercase().as_str() {
        "seatbelt" => Some("macos"),
        "seccomp" => Some("linux"),
        "windows_elevated" | "windows_sandbox" | "windows_mxc" => Some("windows"),
        _ => None,
    }
}

/// The sandbox a turn of `platform` would report in place of `tag`, or
/// `None` when the tag already fits the platform presented upstream.
pub fn presented_sandbox(platform: &str, tag: &str) -> Option<&'static str> {
    let family = platform_family(platform);
    match sandbox_platform(tag) {
        Some(owner) if owner != family => Some(os_profile(platform).sandbox),
        _ => None,
    }
}

/// Mirrors Codex `get_codex_user_agent()`:
/// `{originator}/{version} ({os}; {arch}) {terminal}` followed, once the
/// app-server client is initialized, by `({client}; {client_version})`.
fn codex_user_agent(
    originator: &str,
    platform: &str,
    version: &str,
    terminal: &str,
    suffix: Option<(&str, &str)>,
) -> String {
    let os = os_profile(platform);
    let mut user_agent = format!(
        "{originator}/{version} ({}; {}) {terminal}",
        os.ua_os, os.ua_arch
    );
    if let Some((client, client_version)) = suffix {
        user_agent.push_str(&format!(" ({client}; {client_version})"));
    }
    ascii_only(user_agent)
}

/// The interactive CLI's User-Agent on `platform`, for the gateway's own
/// calls.
pub fn user_agent_for_platform(platform: &str, version: &str) -> String {
    codex_user_agent(
        CLI_ORIGINATOR,
        platform,
        version,
        os_profile(platform).terminal,
        Some((CLI_ORIGINATOR, version)),
    )
}

/// The Codex version a client User-Agent carries: `{originator}/{version}`
/// (also `codex-mcp-client/{version}`).
pub fn codex_version_from_user_agent(user_agent: &str) -> Option<&str> {
    let after_slash = user_agent.split_once('/')?.1;
    let version = after_slash.split([' ', '(']).next()?.trim();
    (!version.is_empty()).then_some(version)
}

/// The version an app-server client reports for itself (the UA suffix and
/// analytics `client_version`): the CLI's is its Codex version, which
/// becomes the presented one; a host app's own version is kept.
pub fn presented_client_version<'a>(
    reported: &'a str,
    client_codex_version: Option<&str>,
    version: &'a str,
) -> &'a str {
    if Some(reported) == client_codex_version {
        version
    } else {
        reported
    }
}

/// The User-Agent presented upstream in place of the client's. The client's
/// type survives (the originator, the terminal or host it runs in, and the
/// app-server client name); the Codex version, OS and architecture are the
/// upstream login's. `codex-mcp-client/{version}` names no machine and only gets
/// the version; an agent in no Codex shape becomes the CLI's.
pub fn rewrite_user_agent(client: &str, platform: &str, version: &str) -> String {
    let Some((name, rest)) = client.split_once('/') else {
        return user_agent_for_platform(platform, version);
    };
    let Some(current) = codex_version_from_user_agent(client) else {
        return user_agent_for_platform(platform, version);
    };
    if !rest.contains(" (") {
        return if name.is_empty() || name.contains(' ') {
            user_agent_for_platform(platform, version)
        } else {
            ascii_only(format!("{name}/{version}"))
        };
    }
    // The app-server suffix is a second parenthesized group at the end.
    let has_suffix = rest.ends_with(')') && rest.matches(" (").count() >= 2;
    let (machine_and_terminal, suffix) = match rest.rsplit_once(" (") {
        Some((head, tail)) if has_suffix => (
            head,
            tail.strip_suffix(')')
                .and_then(|inner| inner.split_once("; "))
                .map(|(client, client_version)| {
                    (
                        client,
                        presented_client_version(client_version, Some(current), version),
                    )
                }),
        ),
        _ => (rest, None),
    };
    // `{version} ({os}; {arch}) {terminal}`: the terminal follows the
    // machine group.
    let terminal = machine_and_terminal
        .split_once(") ")
        .map(|(_, terminal)| terminal.trim())
        .filter(|terminal| !terminal.is_empty())
        .filter(|terminal| terminal_fits_platform(platform, terminal))
        .unwrap_or_else(|| os_profile(platform).terminal);
    codex_user_agent(name, platform, version, terminal, suffix)
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
            "codex-tui/0.200.0 (Windows 10.0.22631; x86_64) WindowsTerminal (codex-tui; 0.200.0)"
        );
        // A macOS login presents the Linux machine: the gateway keeps one
        // Windows and one Linux identity, and macOS clients ride the latter.
        assert_eq!(
            user_agent_for_platform("darwin", "0.200.0"),
            "codex-tui/0.200.0 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.200.0)"
        );
        assert_eq!(
            user_agent_for_platform("linux", "0.200.0"),
            "codex-tui/0.200.0 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.200.0)"
        );
    }

    #[test]
    fn client_user_agents_keep_only_their_type_and_terminal() {
        // Captured from Codex 0.155.1 on Linux.
        assert_eq!(
            rewrite_user_agent(
                "codex-tui/0.155.1 (Ubuntu 24.4.0; x86_64) gnome-terminal (codex-tui; 0.155.1)",
                "linux",
                "0.156.0"
            ),
            "codex-tui/0.156.0 (Debian 13.0.0; x86_64) gnome-terminal (codex-tui; 0.156.0)"
        );
        assert_eq!(
            rewrite_user_agent(
                "codex_cli_rs/0.155.1 (Debian 13.0.0; x86_64) xterm-256color",
                "linux",
                "0.156.0"
            ),
            "codex_cli_rs/0.156.0 (Debian 13.0.0; x86_64) xterm-256color"
        );
        assert_eq!(
            rewrite_user_agent(
                "codex_exec/0.155.1 (Windows 10.0.26100; x86_64) vscode/1.99.0 (codex_exec; 0.155.1)",
                "windows",
                "0.156.0"
            ),
            "codex_exec/0.156.0 (Windows 10.0.22631; x86_64) vscode/1.99.0 (codex_exec; 0.156.0)"
        );
        assert_eq!(
            rewrite_user_agent("codex-mcp-client/0.155.1", "linux", "0.156.0"),
            "codex-mcp-client/0.156.0"
        );
        // A host app keeps its type and its own app version.
        assert_eq!(
            rewrite_user_agent(
                "Codex Desktop/0.155.1 (Mac OS 14.1.0; arm64) unknown (Codex Desktop; 26.915.1)",
                "linux",
                "0.156.0"
            ),
            "Codex Desktop/0.156.0 (Debian 13.0.0; x86_64) unknown (Codex Desktop; 26.915.1)"
        );
        assert_eq!(
            rewrite_user_agent("Apifox/1.0.0 (x)", "linux", "0.156.0"),
            "Apifox/0.156.0 (Debian 13.0.0; x86_64) xterm-256color"
        );
    }

    #[test]
    fn a_macos_client_is_presented_as_the_linux_machine() {
        // Terminal.app cannot run on the Debian machine the login presents,
        // so the terminal token goes with the machine it belonged to.
        assert_eq!(
            rewrite_user_agent(
                "codex-tui/0.155.1 (Mac OS 15.5.0; arm64) Apple_Terminal/455 (codex-tui; 0.155.1)",
                "darwin",
                "0.156.0"
            ),
            "codex-tui/0.156.0 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.156.0)"
        );
        assert_eq!(
            rewrite_user_agent(
                "codex_exec/0.155.1 (Mac OS 15.5.0; arm64) iTerm.app/3.5.0",
                "linux",
                "0.156.0"
            ),
            "codex_exec/0.156.0 (Debian 13.0.0; x86_64) xterm-256color"
        );
        // A terminal that exists on both keeps the client's own.
        assert_eq!(
            rewrite_user_agent(
                "codex-tui/0.155.1 (Mac OS 15.5.0; arm64) vscode/1.99.0 (codex-tui; 0.155.1)",
                "darwin",
                "0.156.0"
            ),
            "codex-tui/0.156.0 (Debian 13.0.0; x86_64) vscode/1.99.0 (codex-tui; 0.156.0)"
        );
        // A Windows terminal under the Linux identity goes the same way.
        assert_eq!(
            rewrite_user_agent(
                "codex-tui/0.155.1 (Windows 10.0.26100; x86_64) WindowsTerminal",
                "linux",
                "0.156.0"
            ),
            "codex-tui/0.156.0 (Debian 13.0.0; x86_64) xterm-256color"
        );
    }

    #[test]
    fn a_sandbox_of_another_os_becomes_the_presented_ones() {
        assert_eq!(presented_sandbox("linux", "seatbelt"), Some("seccomp"));
        assert_eq!(
            presented_sandbox("windows", "seccomp"),
            Some("windows_elevated")
        );
        // Already right, or nothing to do with the machine.
        assert_eq!(presented_sandbox("linux", "seccomp"), None);
        assert_eq!(presented_sandbox("linux", "none"), None);
        assert_eq!(presented_sandbox("windows", "external"), None);
        assert_eq!(presented_sandbox("darwin", "seatbelt"), Some("seccomp"));
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
