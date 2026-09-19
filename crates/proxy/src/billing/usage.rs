//! Token usage as reported by Codex responses, normalized into the
//! `tokens_info` object stored with each request log.

use serde_json::{Map, Value};

fn number(source: Option<&Map<String, Value>>, keys: &[&str]) -> Option<f64> {
    let source = source?;
    keys.iter().find_map(|key| match source.get(*key)? {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        _ => None,
    })
}

fn count(source: Option<&Map<String, Value>>, keys: &[&str]) -> Option<u64> {
    number(source, keys).map(|value| value.trunc().max(0.0) as u64)
}

fn object<'a>(
    source: Option<&'a Map<String, Value>>,
    keys: &[&str],
) -> Option<&'a Map<String, Value>> {
    let source = source?;
    keys.iter().find_map(|key| source.get(*key)?.as_object())
}

/// Text/image token split used by image models and the image tool.
fn image_usage(usage: Option<&Map<String, Value>>) -> Option<Map<String, Value>> {
    let usage = usage?;
    let input = object(Some(usage), &["input_tokens_details"]);
    let output = object(Some(usage), &["output_tokens_details"]);
    let fields: [(&str, Option<u64>); 10] = [
        (
            "input_tokens",
            count(Some(usage), &["input_tokens", "inputTokens"]),
        ),
        (
            "cached_input_tokens",
            count(Some(usage), &["cached_input_tokens", "cachedInputTokens"])
                .or_else(|| count(input, &["cached_tokens", "cachedTokens"])),
        ),
        (
            "cached_text_input_tokens",
            count(input, &["cached_text_tokens", "cachedTextTokens"]),
        ),
        (
            "cached_image_input_tokens",
            count(input, &["cached_image_tokens", "cachedImageTokens"]),
        ),
        (
            "input_text_tokens",
            count(input, &["text_tokens", "textTokens"]),
        ),
        (
            "input_image_tokens",
            count(input, &["image_tokens", "imageTokens"]),
        ),
        (
            "output_tokens",
            count(Some(usage), &["output_tokens", "outputTokens"]),
        ),
        (
            "output_text_tokens",
            count(output, &["text_tokens", "textTokens"]),
        ),
        (
            "output_image_tokens",
            count(output, &["image_tokens", "imageTokens"]),
        ),
        (
            "total_tokens",
            count(Some(usage), &["total_tokens", "totalTokens"]),
        ),
    ];
    Some(
        fields
            .into_iter()
            .filter_map(|(key, value)| Some((key.to_string(), Value::from(value?))))
            .collect(),
    )
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResponseUsage {
    pub tokens_info: Map<String, Value>,
    pub total_tokens: Option<u64>,
}

impl ResponseUsage {
    pub fn input_tokens(&self) -> u64 {
        self.tokens_info
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    }

    pub fn output_tokens(&self) -> u64 {
        self.tokens_info
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    }
}

/// Normalizes a `usage` object from a response (or `response.usage`).
pub fn extract(usage: &Map<String, Value>) -> ResponseUsage {
    let usage = Some(usage);
    let input_details = object(usage, &["input_tokens_details"]);
    let output_details = object(usage, &["output_tokens_details"]);
    let input = number(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = number(
        usage,
        &["output_tokens", "outputTokens", "completion_tokens"],
    );
    let cached = number(usage, &["cached_input_tokens", "cachedInputTokens"])
        .or_else(|| number(input_details, &["cached_tokens", "cachedTokens"]));
    let cache_write = number(
        usage,
        &["cache_write_input_tokens", "cacheWriteInputTokens"],
    )
    .or_else(|| number(input_details, &["cache_write_tokens", "cacheWriteTokens"]));
    let reasoning = number(usage, &["reasoning_output_tokens", "reasoningOutputTokens"])
        .or_else(|| number(output_details, &["reasoning_tokens", "reasoningTokens"]));
    let total = number(usage, &["total_tokens", "totalTokens"]).or_else(|| {
        let sum = input.unwrap_or(0.0) + output.unwrap_or(0.0);
        (sum > 0.0).then_some(sum)
    });
    let image = image_usage(usage);
    let image_field = |key: &str| image.as_ref().and_then(|map| map.get(key)).cloned();

    let mut tokens_info = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            tokens_info.insert(key.to_string(), value);
        }
    };
    let whole = |value: Option<f64>| value.map(|v| Value::from(v.trunc().max(0.0) as u64));
    put("input_tokens", whole(input));
    put("cached_input_tokens", whole(cached));
    put("cache_write_input_tokens", whole(cache_write));
    put("input_text_tokens", image_field("input_text_tokens"));
    put("input_image_tokens", image_field("input_image_tokens"));
    put(
        "cached_text_input_tokens",
        image_field("cached_text_input_tokens"),
    );
    put(
        "cached_image_input_tokens",
        image_field("cached_image_input_tokens"),
    );
    put("output_tokens", whole(output));
    put("reasoning_output_tokens", whole(reasoning));
    put("output_text_tokens", image_field("output_text_tokens"));
    put("output_image_tokens", image_field("output_image_tokens"));
    put("total_tokens", whole(total));

    let tool_usage = object(usage, &["tool_usage", "toolUsage"]);
    if let Some(image_generation) =
        image_usage(object(tool_usage, &["image_gen", "imageGeneration"]))
    {
        tokens_info.insert("image_generation".into(), Value::Object(image_generation));
    }

    ResponseUsage {
        tokens_info,
        total_tokens: total.map(|v| v.trunc().max(0.0) as u64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_nested_details_and_image_tool() {
        let usage = json!({
            "input_tokens": 100,
            "input_tokens_details": { "cached_tokens": 40 },
            "output_tokens": 20,
            "output_tokens_details": { "reasoning_tokens": 5 },
            "total_tokens": 120,
            "tool_usage": { "image_gen": { "input_tokens": 7, "output_tokens": 1000 } }
        });
        let usage = extract(usage.as_object().unwrap());
        assert_eq!(usage.total_tokens, Some(120));
        assert_eq!(
            Value::Object(usage.tokens_info),
            json!({
                "input_tokens": 100,
                "cached_input_tokens": 40,
                "output_tokens": 20,
                "reasoning_output_tokens": 5,
                "total_tokens": 120,
                "image_generation": { "input_tokens": 7, "output_tokens": 1000 }
            })
        );
    }

    #[test]
    fn totals_fall_back_to_input_plus_output() {
        let usage = extract(
            json!({ "input_tokens": 3, "output_tokens": 2 })
                .as_object()
                .unwrap(),
        );
        assert_eq!(usage.total_tokens, Some(5));
    }
}
