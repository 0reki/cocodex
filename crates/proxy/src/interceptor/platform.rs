//! Client platform detection for platform-isolated upstream account routing.
//!
//! Codex builds User-Agent in `codex-rs/login/src/auth/default_client.rs` as:
//! `{originator}/{version} ({os_info.os_type()} {os_info.version()}; {arch}) {terminal}`
//!
//! `os_type()` is the `Display` of `os_info::Type` (`Windows`, `Mac OS`, `Ubuntu`, …).
//! Version/arch/terminal are per-machine and cannot be reproduced here; matching the
//! type display as a prefix is enough to classify the client.
//!
//! The User-Agent is the only signal: no Codex client sends anything else
//! that names its OS. The first `(os; arch)` group is parsed.
//!
//! Unknown clients are rejected by the interceptor (401), not defaulted.

use std::sync::OnceLock;

use http::HeaderMap;

/// Known client platforms supported by the upstream account isolation scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    Darwin,
}

impl Platform {
    /// The OS the client itself runs on.
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Linux => "linux",
            Platform::Darwin => "darwin",
        }
    }

    /// The upstream login that serves this client. A ChatGPT account is
    /// logged in once for Windows and once for Linux; a macOS client rides
    /// the Linux login, because the two are close enough for one identity
    /// while a Windows one would contradict everything the client sends.
    pub fn served_by(&self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Linux | Platform::Darwin => "linux",
        }
    }
}

/// Normalizes a raw platform string to a known platform.
pub fn normalize_platform(raw: &str) -> Option<Platform> {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "windows" | "win" | "win32" | "windows_nt" => Some(Platform::Windows),
        "linux" => Some(Platform::Linux),
        "darwin" | "macos" | "mac" | "macintosh" | "osx" => Some(Platform::Darwin),
        _ => None,
    }
}

/// Detects the client platform from its User-Agent; `None` when there is
/// none or it names no known OS.
pub fn detect_platform(headers: &HeaderMap) -> Option<Platform> {
    headers
        .get(http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .and_then(detect_platform_from_user_agent)
}

/// Matches a Codex CLI / IDE User-Agent string to its originating OS.
pub fn detect_platform_from_user_agent(user_agent: &str) -> Option<Platform> {
    let token =
        extract_codex_os_token(user_agent).unwrap_or_else(|| user_agent.to_ascii_lowercase());
    classify_os_token(&token)
}

/// Codex UA: `originator/version (OS version; arch) terminal`.
/// The OS identity is the text before `;` inside the first parenthesis.
fn extract_codex_os_token(user_agent: &str) -> Option<String> {
    let start = user_agent.find('(')?;
    let inner = user_agent.get(start + 1..)?;
    let end = inner.find(')')?;
    let os_and_version = inner[..end].split(';').next()?.trim();
    if os_and_version.is_empty() {
        return None;
    }
    Some(os_and_version.to_ascii_lowercase())
}

fn classify_os_token(token: &str) -> Option<Platform> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }

    let mut best: Option<(usize, Platform)> = None;
    for (display, platform) in os_info_type_catalog() {
        if token_matches_os_info_display(token, display)
            && best.is_none_or(|(len, _)| display.len() > len)
        {
            best = Some((display.len(), *platform));
        }
    }
    if let Some((_, platform)) = best {
        return Some(platform);
    }

    // Node-style / older templates still seen in tests and forged upstream UAs.
    if token.starts_with("windows") || token.contains("windows_nt") {
        return Some(Platform::Windows);
    }
    if token.starts_with("darwin") || token.contains("macintosh") {
        return Some(Platform::Darwin);
    }
    None
}

fn token_matches_os_info_display(token: &str, display: &str) -> bool {
    token == display
        || token.starts_with(&format!("{display} "))
        || token.starts_with(&format!("{display}_"))
}

fn os_info_type_catalog() -> &'static [(String, Platform)] {
    static CATALOG: OnceLock<Vec<(String, Platform)>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        os_info_types()
            .iter()
            .copied()
            .filter_map(|os_type| {
                let platform = platform_for_os_info_type(os_type)?;
                Some((os_type.to_string().to_ascii_lowercase(), platform))
            })
            .collect()
    })
}

fn platform_for_os_info_type(os_type: os_info::Type) -> Option<Platform> {
    use os_info::Type::*;
    match os_type {
        Windows | Cygwin => Some(Platform::Windows),
        Macos | Ios => Some(Platform::Darwin),
        Unknown => None,
        AIX | Redox | Illumos | Emscripten | FreeBSD | OpenBSD | NetBSD | DragonFly => None,
        _ => Some(Platform::Linux),
    }
}

fn os_info_types() -> &'static [os_info::Type] {
    use os_info::Type::*;
    &[
        Windows,
        Cygwin,
        Macos,
        Ios,
        Linux,
        Ubuntu,
        Debian,
        Fedora,
        Arch,
        NixOS,
        Manjaro,
        Pop,
        Mint,
        CentOS,
        Redhat,
        RedHatEnterprise,
        openSUSE,
        SUSE,
        Alpine,
        Amazon,
        Android,
        Gentoo,
        Kali,
        OracleLinux,
        Raspbian,
        Solus,
        Void,
        EndeavourOS,
        Artix,
        AlmaLinux,
        RockyLinux,
        Elementary,
        Alpaquita,
        AOSC,
        ALTLinux,
        Garuda,
        openEuler,
        Uos,
        Zorin,
        Mariner,
        Nobara,
        OpenCloudOS,
        Ultramarine,
        Unknown,
        AIX,
        Redox,
        Illumos,
        Emscripten,
        FreeBSD,
        OpenBSD,
        NetBSD,
        DragonFly,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn detects_windows_linux_darwin_user_agents() {
        assert_eq!(
            detect_platform_from_user_agent(
                "codex_cli_rs/0.154.0 (Windows 10.0.22631; x86_64) WindowsTerminal"
            ),
            Some(Platform::Windows)
        );
        assert_eq!(
            detect_platform_from_user_agent(
                "codex_cli_rs/0.154.0 (Windows_NT 10.0.22631; x86_64) WindowsTerminal"
            ),
            Some(Platform::Windows)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.154.0 (Linux 6.8.0; x86_64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.77.0 (Ubuntu 24.4.0; x86_64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.77.0 (Debian 12; aarch64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.77.0 (Fedora 41; x86_64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.77.0 (NixOS 24.11; x86_64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_cli_rs/0.77.0 (Pop!_OS 22.04; x86_64) unknown"),
            Some(Platform::Linux)
        );
        assert_eq!(
            detect_platform_from_user_agent(
                "codex_cli_rs/0.154.0 (Mac OS 14.5.0; arm64) Apple_Terminal"
            ),
            Some(Platform::Darwin)
        );
        assert_eq!(
            detect_platform_from_user_agent("codex_vscode/0.4.0 (Mac OS 15.1.0; arm64) unknown"),
            Some(Platform::Darwin)
        );
        assert_eq!(
            detect_platform_from_user_agent(
                "codex_cli_rs/0.154.0 (Darwin 23.5.0; arm64) Apple_Terminal"
            ),
            Some(Platform::Darwin)
        );
        assert_eq!(detect_platform_from_user_agent("Apifox/1.0.0"), None);
    }

    #[test]
    fn platform_comes_from_the_user_agent() {
        let map = headers(&[(
            "user-agent",
            "codex_cli_rs/0.154.0 (Windows_NT 10.0.22631; x86_64) WindowsTerminal",
        )]);
        assert_eq!(detect_platform(&map), Some(Platform::Windows));
    }

    #[test]
    fn unknown_clients_have_no_platform() {
        assert_eq!(detect_platform(&HeaderMap::new()), None);
        let map = headers(&[("user-agent", "Apifox/1.0.0")]);
        assert_eq!(detect_platform(&map), None);
    }

    #[test]
    fn normalizes_platform_aliases() {
        assert_eq!(normalize_platform("macos"), Some(Platform::Darwin));
        assert_eq!(normalize_platform(" Windows "), Some(Platform::Windows));
        assert_eq!(normalize_platform("darwin"), Some(Platform::Darwin));
        assert_eq!(normalize_platform("android"), None);
    }

    #[test]
    fn uses_os_info_type_display_names() {
        assert_eq!(os_info::Type::Macos.to_string(), "Mac OS");
        assert_eq!(os_info::Type::Windows.to_string(), "Windows");
        assert_eq!(os_info::Type::Ubuntu.to_string(), "Ubuntu");
        assert_eq!(os_info::Type::Pop.to_string(), "Pop!_OS");
        assert_eq!(
            classify_os_token(&format!(
                "{} 14.5.0",
                os_info::Type::Macos.to_string().to_ascii_lowercase()
            )),
            Some(Platform::Darwin)
        );
        assert_eq!(
            classify_os_token(&format!(
                "{} 24.4.0",
                os_info::Type::Ubuntu.to_string().to_ascii_lowercase()
            )),
            Some(Platform::Linux)
        );
    }
}
