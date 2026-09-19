//! Model prices (USD per million tokens) and request cost estimation.
//! Defaults can be overridden per model with `OPENAI_MODEL_PRICING_JSON`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::usd::Usd;

fn default_prices() -> Vec<Value> {
    vec![
        json!({ "slug": "gpt-6-astra", "input_price_per_million": "10", "cached_input_price_per_million": "1", "output_price_per_million": "50" }),
        json!({ "slug": "gpt-5.6-sol", "input_price_per_million": "4", "cached_input_price_per_million": "0.4", "output_price_per_million": "20" }),
        json!({ "slug": "daybreak_blue", "input_price_per_million": "4", "cached_input_price_per_million": "0.4", "output_price_per_million": "20" }),
        json!({ "slug": "daybreak_red", "input_price_per_million": "12.5", "cached_input_price_per_million": "1.25", "output_price_per_million": "75" }),
        json!({ "slug": "gpt-5.6-terra", "input_price_per_million": "2", "cached_input_price_per_million": "0.2", "output_price_per_million": "12" }),
        json!({ "slug": "gpt-5.6-luna", "input_price_per_million": "0.2", "cached_input_price_per_million": "0.02", "output_price_per_million": "1.2" }),
        json!({ "slug": "gpt-5.5", "input_price_per_million": "5", "cached_input_price_per_million": "0.5", "output_price_per_million": "30" }),
        json!({ "slug": "gpt-5.4", "input_price_per_million": "2.5", "cached_input_price_per_million": "0.25", "output_price_per_million": "15" }),
        json!({ "slug": "gpt-5.4-mini", "input_price_per_million": "0.75", "cached_input_price_per_million": "0.075", "output_price_per_million": "4.52" }),
        json!({
            "slug": "gpt-image-2",
            "text_input_price_per_million": "5",
            "cached_text_input_price_per_million": "1.25",
            "text_output_price_per_million": "10",
            "image_input_price_per_million": "8",
            "cached_image_input_price_per_million": "2",
            "image_output_price_per_million": "30"
        }),
    ]
}

#[derive(Debug, Clone)]
pub struct Pricing {
    models: HashMap<String, Map<String, Value>>,
}

/// Strips a dated snapshot suffix such as `-2026-01-15`.
fn base_model_id(model: &str) -> &str {
    let bytes = model.as_bytes();
    if bytes.len() > 11 {
        let suffix = &model[model.len() - 11..];
        let b = suffix.as_bytes();
        let dated = b[0] == b'-'
            && b[5] == b'-'
            && b[8] == b'-'
            && [1, 2, 3, 4, 6, 7, 9, 10]
                .iter()
                .all(|i| b[*i].is_ascii_digit());
        if dated {
            return &model[..model.len() - 11];
        }
    }
    model
}

fn optional_tokens(info: &Map<String, Value>, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| match info.get(*key)? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        })
        .filter(|v| v.is_finite())
        .map(|v| v.trunc().max(0.0) as u64)
}

fn tokens(info: &Map<String, Value>, keys: &[&str]) -> u64 {
    optional_tokens(info, keys).unwrap_or(0)
}

impl Pricing {
    pub fn from_env() -> Result<Pricing, String> {
        let mut models: HashMap<String, Map<String, Value>> = default_prices()
            .into_iter()
            .filter_map(|value| {
                let map = value.as_object()?.clone();
                Some((map.get("slug")?.as_str()?.to_string(), map))
            })
            .collect();
        let raw = std::env::var("OPENAI_MODEL_PRICING_JSON").unwrap_or_default();
        if !raw.trim().is_empty() {
            let overrides: Vec<Value> = serde_json::from_str(raw.trim())
                .map_err(|_| "OPENAI_MODEL_PRICING_JSON must be a JSON array".to_string())?;
            for (index, item) in overrides.into_iter().enumerate() {
                let slug = item
                    .get("slug")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|slug| !slug.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        format!(
                            "OPENAI_MODEL_PRICING_JSON[{index}].slug must be a non-empty string"
                        )
                    })?;
                let entry = models.entry(slug.clone()).or_default();
                if let Some(fields) = item.as_object() {
                    entry.extend(fields.clone());
                }
                entry.insert("slug".into(), Value::String(slug));
            }
        }
        Ok(Pricing { models })
    }

    fn find(&self, model: &str) -> Option<&Map<String, Value>> {
        let model = model.trim();
        self.models
            .get(base_model_id(model))
            .or_else(|| self.models.get(model))
    }

    fn rate(prices: &Map<String, Value>, key: &str) -> Option<Usd> {
        prices
            .get(key)
            .and_then(Usd::from_json)
            .filter(|rate| rate.0 >= 0)
    }

    fn text_cost(&self, model: &str, info: &Map<String, Value>) -> Option<Usd> {
        let prices = self.find(model)?;
        let input_rate = Self::rate(prices, "input_price_per_million");
        let cached_rate = Self::rate(prices, "cached_input_price_per_million").or(input_rate);
        let output_rate = Self::rate(prices, "output_price_per_million");

        let input = tokens(info, &["input_tokens", "inputTokens"]);
        let details = info.get("input_tokens_details").and_then(Value::as_object);
        let cached = optional_tokens(info, &["cached_input_tokens", "cachedInputTokens"])
            .or_else(|| details.and_then(|d| optional_tokens(d, &["cached_tokens"])))
            .unwrap_or(0)
            .min(input);
        let cache_write =
            optional_tokens(info, &["cache_write_input_tokens", "cacheWriteInputTokens"])
                .or_else(|| details.and_then(|d| optional_tokens(d, &["cache_write_tokens"])))
                .unwrap_or(0)
                .min(input - cached);
        let billable_input = input - cached - cache_write;
        let output = tokens(info, &["output_tokens", "outputTokens"]);

        let mut weighted = 0i128;
        let mut priced = false;
        for (count, rate) in [
            (billable_input, input_rate),
            (cached, cached_rate),
            (output, output_rate),
        ] {
            if let Some(rate) = rate
                && count > 0
            {
                weighted += Usd::per_million(count, rate);
                priced = true;
            }
        }
        priced.then(|| Usd::divide(weighted, 1_000_000))
    }

    fn image_cost(&self, info: &Map<String, Value>) -> Option<Usd> {
        let prices = self.find("gpt-image-2")?;
        let text_in = Self::rate(prices, "text_input_price_per_million");
        let cached_text_in = Self::rate(prices, "cached_text_input_price_per_million").or(text_in);
        let text_out = Self::rate(prices, "text_output_price_per_million");
        let image_in = Self::rate(prices, "image_input_price_per_million");
        let cached_image_in =
            Self::rate(prices, "cached_image_input_price_per_million").or(image_in);
        let image_out = Self::rate(prices, "image_output_price_per_million");

        let declared_in = tokens(info, &["input_tokens", "inputTokens"]);
        let text_input = tokens(info, &["input_text_tokens", "inputTextTokens"]);
        let mut image_input = tokens(info, &["input_image_tokens", "inputImageTokens"]);
        image_input += declared_in.saturating_sub(text_input + image_input);
        let declared_out = tokens(info, &["output_tokens", "outputTokens"]);
        let text_output = tokens(info, &["output_text_tokens", "outputTextTokens"]);
        let mut image_output = tokens(info, &["output_image_tokens", "outputImageTokens"]);
        image_output += declared_out.saturating_sub(text_output + image_output);

        let cached_total = tokens(info, &["cached_input_tokens", "cachedInputTokens"])
            .min(text_input + image_input);
        let mut cached_text =
            tokens(info, &["cached_text_input_tokens", "cachedTextInputTokens"]).min(text_input);
        let mut cached_image = tokens(
            info,
            &["cached_image_input_tokens", "cachedImageInputTokens"],
        )
        .min(image_input);
        let unassigned = cached_total.saturating_sub(cached_text + cached_image);
        let remaining = (text_input + image_input).saturating_sub(cached_text + cached_image);
        if unassigned > 0 && remaining > 0 {
            let image_share = (image_input - cached_image)
                .min(unassigned * (image_input - cached_image) / remaining);
            cached_image += image_share;
            cached_text += (text_input - cached_text).min(unassigned - image_share);
        }

        let mut weighted = 0i128;
        let mut priced = false;
        for (count, rate) in [
            (text_input - cached_text, text_in),
            (cached_text, cached_text_in),
            (image_input - cached_image, image_in),
            (cached_image, cached_image_in),
            (text_output, text_out),
            (image_output, image_out),
        ] {
            if let Some(rate) = rate
                && count > 0
            {
                weighted += Usd::per_million(count, rate);
                priced = true;
            }
        }
        priced.then(|| Usd::divide(weighted, 1_000_000))
    }

    /// Estimated upstream cost, or `None` when the model has no price.
    pub fn estimate(&self, model: Option<&str>, info: &Map<String, Value>) -> Option<Usd> {
        let model = model.map(str::trim).unwrap_or("");
        let primary = if base_model_id(model) == "gpt-image-2" {
            self.image_cost(info)
        } else if model.is_empty() {
            None
        } else {
            self.text_cost(model, info)
        };
        let tool = info
            .get("image_generation")
            .and_then(Value::as_object)
            .and_then(|usage| self.image_cost(usage));
        match (primary, tool) {
            (None, None) => None,
            (a, b) => Some(Usd(a.unwrap_or_default().0 + b.unwrap_or_default().0)),
        }
    }
}

/// Priority ("fast") processing is billed at a model-specific multiple.
pub fn apply_service_tier(
    cost: Option<Usd>,
    service_tier: Option<&str>,
    model: Option<&str>,
) -> Option<Usd> {
    let cost = cost?;
    if !service_tier.is_some_and(|tier| tier.trim().eq_ignore_ascii_case("priority")) {
        return Some(cost);
    }
    let model = model
        .map(|m| base_model_id(m.trim()).to_lowercase())
        .unwrap_or_default();
    let (numerator, denominator) = if model == "gpt-6-astra"
        || model == "gpt-5.5"
        || model == "gpt-5.6"
        || model.starts_with("gpt-5.6-")
    {
        (5, 2)
    } else if model == "gpt-5.4" {
        (2, 1)
    } else {
        (1, 1)
    };
    Some(Usd::divide(cost.0 * numerator, denominator))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn text_cost_matches_node() {
        let pricing = Pricing::from_env().unwrap();
        // 1000 uncached input at 2.5, 1000 cached at 0.25, 500 output at 15 (per 1M).
        let cost = pricing
            .estimate(
                Some("gpt-5.4-2026-01-01"),
                &info(json!({ "input_tokens": 2000, "cached_input_tokens": 1000, "output_tokens": 500 })),
            )
            .unwrap();
        assert_eq!(cost.to_string(), "0.01025000");
        assert!(
            pricing
                .estimate(Some("unknown-model"), &info(json!({ "input_tokens": 5 })))
                .is_none()
        );
    }

    #[test]
    fn image_tool_usage_is_added() {
        let pricing = Pricing::from_env().unwrap();
        let cost = pricing
            .estimate(
                Some("gpt-5.4"),
                &info(json!({ "output_tokens": 0, "image_generation": { "output_tokens": 1000 } })),
            )
            .unwrap();
        assert_eq!(cost.to_string(), "0.03000000");
    }

    #[test]
    fn priority_tier_multiplies() {
        let cost = Some(Usd::parse("1").unwrap());
        assert_eq!(
            apply_service_tier(cost, Some("priority"), Some("gpt-5.5"))
                .unwrap()
                .to_string(),
            "2.50000000"
        );
        assert_eq!(
            apply_service_tier(cost, Some("default"), Some("gpt-5.5"))
                .unwrap()
                .to_string(),
            "1.00000000"
        );
        assert_eq!(
            apply_service_tier(cost, Some("priority"), Some("gpt-5.4"))
                .unwrap()
                .to_string(),
            "2.00000000"
        );
    }
}
