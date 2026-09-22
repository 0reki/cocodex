//! What the console configures about turn-state handling.
//!
//! The settings live in `gateway_settings` under `turn_state`, so an admin
//! can turn replacement on or off, widen it past GPT-6 Astra or change the
//! probe's proxy pool without a redeploy.

use serde::{Deserialize, Serialize};

use crate::billing::pricing::base_model_id;

/// The model turn-state handling is meant for: the flagship, where the
/// state's compute tier is worth keeping.
pub const DEFAULT_MANAGED_MODEL: &str = "gpt-6-astra";
/// Longest value accepted as a turn state (a Team state is ~350 bytes).
pub const MAX_STATE_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TurnStateSettings {
    /// Whether the gateway manages `x-codex-turn-state` at all. With this
    /// off, a client's own state is relayed untouched, as before.
    pub enabled: bool,
    /// Models whose turn state is managed; `*` means every model.
    pub models: Vec<String>,
    /// Cipher block counts worth hunting for. Every well-formed state is
    /// kept; these are the ones a probe keeps looking for and that are never
    /// replaced by a state of another shape.
    ///
    /// Empty (the default) means no preference: whatever upstream issues for
    /// the login is held, and the probe only runs when there is nothing live.
    /// The block count is a guess about the compute a state routes to, and a
    /// Pro account was measured issuing 11-block states, so a preference set
    /// here can be hunted for a long time — each attempt is a real request
    /// against the account's quota, which is what `max_hunts` bounds.
    pub preferred_blocks: Vec<usize>,
    /// Inject a state that is past its hour. Off: an expired state is worse
    /// than none.
    pub inject_expired: bool,
    pub probe: ProbeSettings,
}

impl Default for TurnStateSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            models: vec![DEFAULT_MANAGED_MODEL.to_string()],
            preferred_blocks: Vec::new(),
            inject_expired: false,
            probe: ProbeSettings::default(),
        }
    }
}

impl TurnStateSettings {
    /// Whether this model's turn state is managed. The dated snapshot suffix
    /// is ignored, so `gpt-6-astra-2026-01-15` follows `gpt-6-astra`.
    pub fn manages(&self, model: &str) -> bool {
        if !self.enabled || model.is_empty() {
            return false;
        }
        let model = base_model_id(model.trim()).to_ascii_lowercase();
        self.models.iter().any(|managed| {
            let managed = managed.trim();
            managed == "*" || base_model_id(managed).eq_ignore_ascii_case(&model)
        })
    }

    /// Whether a state of this shape is one the gateway stops looking past.
    /// With no preference configured every state is as good as any other.
    pub fn prefers_blocks(&self, blocks: usize) -> bool {
        self.preferred_blocks.is_empty() || self.preferred_blocks.contains(&blocks)
    }

    pub fn hunts(&self) -> bool {
        !self.preferred_blocks.is_empty()
    }

    /// Rejects a configuration the gateway could not act on, so a bad console
    /// write cannot quietly disable turn-state handling.
    pub fn validate(&self) -> Result<(), String> {
        if self.models.iter().all(|model| model.trim().is_empty()) {
            return Err("models must name at least one model".into());
        }
        if self
            .preferred_blocks
            .iter()
            .any(|blocks| *blocks == 0 || *blocks > 64)
        {
            return Err("preferredBlocks must be between 1 and 64".into());
        }
        self.probe.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProbeSettings {
    /// Whether the gateway fetches states of its own instead of only
    /// learning them from the traffic it relays.
    pub enabled: bool,
    /// Budget for one probe, across all of its attempts.
    pub timeout_seconds: u64,
    /// Shortest gap between two probes of the same account, platform and
    /// model.
    pub retry_seconds: u64,
    /// Start fetching a replacement this long before the state expires.
    pub refresh_before_seconds: u64,
    /// Proxies tried in one probe before it gives up.
    pub max_attempts: usize,
    /// How long an account is left alone after upstream said its quota is
    /// spent; a fresh state cannot give quota back.
    pub quota_backoff_seconds: u64,
    /// Probes spent looking for a `preferred_blocks` state while a usable one
    /// is already held. Without this a preference upstream never issues would
    /// probe forever.
    pub max_hunts: u32,
    /// Probe over the gateway's own egress when no proxy is configured. Off
    /// by default: the point of the pool is that probes leave from somewhere
    /// else than the relayed traffic.
    pub allow_direct: bool,
    /// Exits probes rotate through, one per attempt.
    pub proxy_pool: Vec<ProxyEndpoint>,
}

impl Default for ProbeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            timeout_seconds: 30,
            retry_seconds: 60,
            refresh_before_seconds: 300,
            max_attempts: 2,
            quota_backoff_seconds: 900,
            max_hunts: 3,
            allow_direct: false,
            proxy_pool: Vec::new(),
        }
    }
}

impl ProbeSettings {
    /// Whether a probe has somewhere to go out from.
    pub fn has_exit(&self) -> bool {
        self.allow_direct || !self.proxy_pool.is_empty()
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(1..=180).contains(&self.timeout_seconds) {
            return Err("probe.timeoutSeconds must be between 1 and 180".into());
        }
        if self.retry_seconds < 1 {
            return Err("probe.retrySeconds must be at least 1".into());
        }
        if self.refresh_before_seconds >= 3600 {
            return Err("probe.refreshBeforeSeconds must be below 3600".into());
        }
        if !(1..=20).contains(&self.max_attempts) {
            return Err("probe.maxAttempts must be between 1 and 20".into());
        }
        if !(60..=86_400).contains(&self.quota_backoff_seconds) {
            return Err("probe.quotaBackoffSeconds must be between 60 and 86400".into());
        }
        if self.max_hunts > 100 {
            return Err("probe.maxHunts must be at most 100".into());
        }
        if self.proxy_pool.len() > 100 {
            return Err("probe.proxyPool holds at most 100 entries".into());
        }
        if self.enabled && !self.has_exit() {
            return Err(
                "probe.proxyPool needs an entry, or set probe.allowDirect to probe over the gateway's own egress".into(),
            );
        }
        for endpoint in &self.proxy_pool {
            endpoint.validate()?;
        }
        Ok(())
    }
}

/// One exit a probe can leave through. The URL is given directly, or named
/// so the credentials stay out of the database: `urlEnv` reads an
/// environment variable, `urlFile` a one-line private file that is read on
/// every dial, so rotating credentials needs no restart.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyEndpoint {
    pub url: String,
    pub url_env: String,
    pub url_file: String,
}

impl ProxyEndpoint {
    fn sources(&self) -> usize {
        [&self.url, &self.url_env, &self.url_file]
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .count()
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.sources() != 1 {
            return Err("each proxy needs exactly one of url, urlEnv or urlFile".into());
        }
        if !self.url.trim().is_empty() {
            super::proxy_pool::check_url(self.url.trim())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manages_only_the_configured_models() {
        let settings = TurnStateSettings::default();
        assert!(settings.manages("gpt-6-astra"));
        // A dated snapshot of the same model.
        assert!(settings.manages("gpt-6-astra-2026-01-15"));
        assert!(!settings.manages("gpt-5.6-luna"));
        assert!(!settings.manages(""));
    }

    #[test]
    fn a_wildcard_manages_every_model_and_disabled_manages_none() {
        let settings = TurnStateSettings {
            models: vec!["*".into()],
            ..TurnStateSettings::default()
        };
        assert!(settings.manages("gpt-5.6-luna"));
        let off = TurnStateSettings {
            enabled: false,
            ..settings
        };
        assert!(!off.manages("gpt-5.6-luna"));
    }

    #[test]
    fn a_probe_without_an_exit_is_refused() {
        let mut settings = TurnStateSettings::default();
        settings.probe.enabled = true;
        assert!(settings.validate().is_err());
        settings.probe.allow_direct = true;
        assert!(settings.validate().is_ok());
        settings.probe.allow_direct = false;
        settings.probe.proxy_pool = vec![ProxyEndpoint {
            url: "socks5h://127.0.0.1:1080".into(),
            ..ProxyEndpoint::default()
        }];
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn a_proxy_entry_names_exactly_one_source() {
        let both = ProxyEndpoint {
            url: "http://127.0.0.1:8080".into(),
            url_env: "PROXY".into(),
            ..ProxyEndpoint::default()
        };
        assert!(both.validate().is_err());
        assert!(ProxyEndpoint::default().validate().is_err());
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = TurnStateSettings::default();
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["models"][0], "gpt-6-astra");
        assert_eq!(json["probe"]["refreshBeforeSeconds"], 300);
        let parsed: TurnStateSettings = serde_json::from_value(json).unwrap();
        assert_eq!(parsed, settings);
        // Missing fields fall back to the defaults.
        let sparse: TurnStateSettings = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!sparse.enabled);
        assert_eq!(sparse.models, vec!["gpt-6-astra".to_string()]);
    }
}
