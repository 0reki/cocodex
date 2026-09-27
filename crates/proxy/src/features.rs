//! Counted ChatGPT features: Deep Research, image generation and messages
//! to Pro models.
//!
//! The upstream account has a pool of each (`limits_progress` in
//! `/conversation/init`), shared by every user assigned to it. A user's
//! quota profile may cap their own uses over the feature's rolling window;
//! the gateway counts each turn that asks for the feature, refuses one past
//! the cap, and reports the user's own remaining uses in place of the
//! pool's.

use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};

use crate::db::users::PortalUser;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Feature {
    DeepResearch,
    ImageGen,
    /// A message to a Pro model (`gpt-6-pro`, `gpt-5-5-pro`, ...), which has
    /// its own weekly pool.
    ProMessage,
}

impl Feature {
    pub const ALL: [Feature; 3] = [
        Feature::DeepResearch,
        Feature::ImageGen,
        Feature::ProMessage,
    ];

    /// The name `limits_progress` and the usage table use.
    pub fn name(self) -> &'static str {
        match self {
            Feature::DeepResearch => "deep_research",
            Feature::ImageGen => "image_gen",
            Feature::ProMessage => "pro_message",
        }
    }

    /// The `system_hints` entry a turn asking for the feature carries; a
    /// Pro message is known by its model instead.
    fn hint(self) -> Option<&'static str> {
        match self {
            Feature::DeepResearch => Some("plugin:connector_openai_deep_research"),
            Feature::ImageGen => Some("picture_v2"),
            Feature::ProMessage => None,
        }
    }

    /// The window uses are counted over. Upstream reports an unused pool as
    /// resetting this long from now: 30 days for Deep Research, a day for
    /// images.
    pub fn window(self) -> Duration {
        match self {
            Feature::DeepResearch => Duration::days(30),
            Feature::ImageGen => Duration::hours(24),
            Feature::ProMessage => Duration::days(7),
        }
    }

    /// The user's cap; `None` when the gateway sets none of its own.
    pub fn limit(self, user: &PortalUser) -> Option<i64> {
        match self {
            Feature::DeepResearch => user.deep_research_limit,
            Feature::ImageGen => user.image_gen_limit,
            Feature::ProMessage => user.pro_message_limit,
        }
        .map(i64::from)
    }
}

/// A Pro model: `pro` is one of its dash-separated parts (`gpt-6-pro`,
/// `gpt-5-5-pro`), not merely a prefix (`gpt-5-prolite` is not one).
pub fn is_pro_model(model: &str) -> bool {
    model
        .split('-')
        .any(|part| part.eq_ignore_ascii_case("pro"))
}

/// The features a `/f/conversation` turn asks for, from its `system_hints`
/// (top level, or on a message's metadata) and its model.
pub fn requested(body: &[u8]) -> Vec<Feature> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|message| message.get("metadata")?.get("system_hints"));
    let hints: Vec<&str> = std::iter::once(value.get("system_hints"))
        .flatten()
        .chain(messages)
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let pro = value
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(is_pro_model);
    Feature::ALL
        .into_iter()
        .filter(|feature| match feature.hint() {
            Some(hint) => hints.contains(&hint),
            None => pro,
        })
        .collect()
}

/// A user's standing on one capped feature.
#[derive(Debug, Clone, PartialEq)]
pub struct Allowance {
    pub feature: Feature,
    pub limit: i64,
    /// Uses within the window.
    pub used: i64,
    /// The oldest of those uses: the first to fall out of the window.
    pub oldest: Option<DateTime<Utc>>,
}

impl Allowance {
    pub fn remaining(&self) -> i64 {
        (self.limit - self.used).max(0)
    }

    /// When the next use frees up; `now` plus the window when none is used.
    pub fn reset_after(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        self.oldest.unwrap_or(now) + self.feature.window()
    }
}

/// Reports the user's own remaining uses in `/conversation/init`'s
/// `limits_progress`: the smaller of their allowance and the pool's, and
/// when their allowance is the smaller, when it frees up. `None` when the
/// body has no `limits_progress` to rewrite.
pub fn rewrite_limits_progress(
    body: &[u8],
    allowances: &[Allowance],
    now: DateTime<Utc>,
) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let entries = value.get_mut("limits_progress")?.as_array_mut()?;
    for entry in entries.iter_mut() {
        let Some(allowance) = entry
            .get("feature_name")
            .and_then(Value::as_str)
            .and_then(|name| allowances.iter().find(|a| a.feature.name() == name))
        else {
            continue;
        };
        let pool = entry.get("remaining").and_then(Value::as_i64);
        let own = allowance.remaining();
        if pool.is_some_and(|pool| pool <= own) {
            continue;
        }
        entry["remaining"] = json!(own);
        entry["reset_after"] = json!(
            allowance
                .reset_after(now)
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
        );
    }
    serde_json::to_vec(&value).ok()
}

pub fn is_init_path(path: &str) -> bool {
    path.trim_end_matches('/') == "/backend-api/conversation/init"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_names_its_features_in_system_hints() {
        // Captured from the desktop app.
        let image = json!({
            "action": "next",
            "system_hints": ["picture_v2"],
            "messages": [{ "metadata": { "system_hints": ["picture_v2"] } }]
        });
        assert_eq!(requested(image.to_string().as_bytes()), [Feature::ImageGen]);
        let research = json!({
            "action": "next",
            "system_hints": ["plugin:connector_openai_deep_research"],
        });
        assert_eq!(
            requested(research.to_string().as_bytes()),
            [Feature::DeepResearch]
        );
        let plain = json!({ "action": "next", "model": "gpt-5-6-thinking", "system_hints": [] });
        assert!(requested(plain.to_string().as_bytes()).is_empty());
        // A Pro model counts on every message, whatever else it asks for.
        let pro = json!({ "action": "next", "model": "gpt-6-pro", "system_hints": ["picture_v2"] });
        assert_eq!(
            requested(pro.to_string().as_bytes()),
            [Feature::ImageGen, Feature::ProMessage]
        );
        for model in ["gpt-5-5-pro", "gpt-5.6-pro", "o3-pro"] {
            assert!(is_pro_model(model), "{model}");
        }
        for model in ["gpt-5-prolite", "gpt-5-6-thinking", "auto"] {
            assert!(!is_pro_model(model), "{model}");
        }
    }

    #[test]
    fn limits_progress_reports_the_smaller_allowance() {
        let now = DateTime::parse_from_rfc3339("2026-09-27T16:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        // Shape captured from chatgpt.com.
        let body = json!({
            "type": "conversation_detail_metadata",
            "limits_progress": [
                { "feature_name": "deep_research", "remaining": 250,
                  "reset_after": "2026-10-27T14:57:39.889987+00:00" },
                { "feature_name": "image_gen", "remaining": 3,
                  "reset_after": "2026-09-28T14:57:39.890011+00:00" },
                { "feature_name": "file_upload", "remaining": 15,
                  "reset_after": "2026-09-28T16:13:00.269324+00:00" }
            ],
            "default_model_slug": "auto"
        });
        let allowances = [
            Allowance {
                feature: Feature::DeepResearch,
                limit: 10,
                used: 4,
                oldest: Some(now - Duration::days(2)),
            },
            // The pool (3) is smaller than the user's 50: it stays.
            Allowance {
                feature: Feature::ImageGen,
                limit: 50,
                used: 1,
                oldest: None,
            },
        ];
        let rewritten: Value = serde_json::from_slice(
            &rewrite_limits_progress(body.to_string().as_bytes(), &allowances, now).unwrap(),
        )
        .unwrap();
        let progress = &rewritten["limits_progress"];
        assert_eq!(progress[0]["remaining"], 6);
        // The oldest use, two days ago, frees up 30 days after it.
        assert_eq!(
            progress[0]["reset_after"],
            "2026-10-25T16:00:00.000000+00:00"
        );
        assert_eq!(progress[1], body["limits_progress"][1]);
        assert_eq!(progress[2], body["limits_progress"][2]);
        assert_eq!(rewritten["default_model_slug"], "auto");

        // Used up: nothing left until the oldest use falls out.
        let spent = Allowance {
            feature: Feature::DeepResearch,
            limit: 2,
            used: 5,
            oldest: Some(now - Duration::days(29)),
        };
        assert_eq!(spent.remaining(), 0);
        assert_eq!(spent.reset_after(now), now + Duration::days(1));
    }
}
