use serde_json::Value;

const JSON_BUFFER_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Responses,
    Images,
    Search,
    Passthrough,
}

impl BackendKind {
    pub fn billable(self) -> bool {
        matches!(self, Self::Responses)
    }
}

pub fn classify_backend_kind(path: &str) -> BackendKind {
    let normalized = path.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") || normalized.contains("/codex/responses/") {
        BackendKind::Responses
    } else if normalized.contains("/codex/images/") {
        BackendKind::Images
    } else if normalized.contains("/alpha/search") {
        BackendKind::Search
    } else {
        BackendKind::Passthrough
    }
}

#[derive(Debug, Clone, Default)]
pub struct UsageStats {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub reasoning_output_tokens: u64,
}

impl UsageStats {
    pub fn to_tokens_info(&self) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        if self.input_tokens > 0 {
            map.insert("input_tokens".into(), self.input_tokens.into());
        }
        if self.output_tokens > 0 {
            map.insert("output_tokens".into(), self.output_tokens.into());
        }
        if self.total_tokens > 0 {
            map.insert("total_tokens".into(), self.total_tokens.into());
        }
        if self.cached_input_tokens > 0 {
            map.insert(
                "cached_input_tokens".into(),
                self.cached_input_tokens.into(),
            );
        }
        if self.cache_write_input_tokens > 0 {
            map.insert(
                "cache_write_input_tokens".into(),
                self.cache_write_input_tokens.into(),
            );
        }
        if self.reasoning_output_tokens > 0 {
            map.insert(
                "reasoning_output_tokens".into(),
                self.reasoning_output_tokens.into(),
            );
        }
        Value::Object(map)
    }
}

#[derive(Debug, Default)]
pub struct RequestObservation {
    pub api_key_id: Option<String>,
    pub owner_user_id: Option<String>,
    pub model: Option<String>,
    pub is_sse: Option<bool>,
    pub sse_buf: String,
    pub json_buf: Vec<u8>,
    pub usage: Option<UsageStats>,
    pub ttfb_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub settled: bool,
}

impl RequestObservation {
    pub fn ingest_chunk(&mut self, chunk: &[u8], elapsed_ms: u64) {
        if self.ttfb_ms.is_none() && !chunk.is_empty() {
            self.ttfb_ms = Some(elapsed_ms);
        }
        if chunk.is_empty() {
            return;
        }
        let sse = self.is_sse.unwrap_or_else(|| looks_like_sse(chunk));
        if sse {
            self.is_sse = Some(true);
            if let Ok(text) = std::str::from_utf8(chunk) {
                self.sse_buf.push_str(text);
                self.drain_sse();
            }
            return;
        }
        self.is_sse = Some(false);
        if self.json_buf.len() < JSON_BUFFER_LIMIT {
            let remaining = JSON_BUFFER_LIMIT.saturating_sub(self.json_buf.len());
            self.json_buf
                .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
    }

    pub fn ingest_text(&mut self, text: &str) {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            ingest_json(self, &value);
            return;
        }
        self.sse_buf.push_str(text);
        if !self.sse_buf.ends_with('\n') {
            self.sse_buf.push('\n');
        }
        self.drain_sse();
    }

    pub fn finish_json_body(&mut self) {
        if self.is_sse == Some(true) {
            if !self.sse_buf.is_empty() {
                let leftover = std::mem::take(&mut self.sse_buf);
                ingest_event_block(self, &leftover);
            }
            return;
        }
        if self.json_buf.is_empty() {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&self.json_buf) {
            ingest_json(self, &value);
        }
    }

    fn drain_sse(&mut self) {
        loop {
            let (idx, skip) = if let Some(idx) = self.sse_buf.find("\r\n\r\n") {
                (idx, 4)
            } else if let Some(idx) = self.sse_buf.find("\n\n") {
                (idx, 2)
            } else {
                break;
            };
            let block: String = self.sse_buf.drain(..idx).collect();
            let _ = self.sse_buf.drain(..skip.min(self.sse_buf.len()));
            ingest_event_block(self, &block);
        }
    }
}

fn looks_like_sse(chunk: &[u8]) -> bool {
    let start = chunk
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    let rest = &chunk[start..];
    rest.starts_with(b"event:") || rest.starts_with(b"data:") || rest.starts_with(b"id:")
}

fn ingest_event_block(obs: &mut RequestObservation, block: &str) {
    for line in block.lines() {
        let line = line.trim();
        let payload = if let Some(rest) = line.strip_prefix("data:") {
            rest.trim()
        } else if line.starts_with('{') {
            line
        } else {
            continue;
        };
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            ingest_json(obs, &value);
        }
    }
}

fn ingest_json(obs: &mut RequestObservation, value: &Value) {
    if let Some(model) = string_field(value, &["model"]) {
        if obs.model.as_deref() != Some(model) {
            obs.model.get_or_insert_with(|| model.to_string());
        }
    }
    if let Some(response) = value.get("response") {
        ingest_json(obs, response);
    }
    if let Some(usage) = value.get("usage") {
        obs.usage = Some(extract_usage(usage));
    }
    if obs.error_code.is_none() {
        if let Some(error) = value.get("error") {
            obs.error_code = string_field(error, &["code", "type"]).map(ToString::to_string);
            obs.error_message =
                string_field(error, &["message", "detail"]).map(ToString::to_string);
        } else if let Some(code) = string_field(value, &["code"]) {
            let ty = string_field(value, &["type"]).unwrap_or("");
            if ty.contains("error") || value.get("message").is_some() {
                obs.error_code = Some(code.to_string());
                obs.error_message =
                    string_field(value, &["message", "detail"]).map(ToString::to_string);
            }
        }
    }
}

fn extract_usage(usage: &Value) -> UsageStats {
    let input = number_field(usage, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = number_field(
        usage,
        &["output_tokens", "outputTokens", "completion_tokens"],
    );
    let details = usage.get("input_tokens_details").and_then(Value::as_object);
    let output_details = usage
        .get("output_tokens_details")
        .and_then(Value::as_object);
    let cached = number_field(usage, &["cached_input_tokens", "cachedInputTokens"])
        .or_else(|| details.and_then(|d| number_map(d, &["cached_tokens", "cachedTokens"])));
    let cache_write = number_field(
        usage,
        &["cache_write_input_tokens", "cacheWriteInputTokens"],
    )
    .or_else(|| details.and_then(|d| number_map(d, &["cache_write_tokens", "cacheWriteTokens"])));
    let reasoning = number_field(usage, &["reasoning_output_tokens", "reasoningOutputTokens"])
        .or_else(|| {
            output_details.and_then(|d| number_map(d, &["reasoning_tokens", "reasoningTokens"]))
        });
    let total = number_field(usage, &["total_tokens", "totalTokens"])
        .unwrap_or(input.unwrap_or(0) + output.unwrap_or(0));
    UsageStats {
        input_tokens: input.unwrap_or(0),
        output_tokens: output.unwrap_or(0),
        total_tokens: total,
        cached_input_tokens: cached.unwrap_or(0),
        cache_write_input_tokens: cache_write.unwrap_or(0),
        reasoning_output_tokens: reasoning.unwrap_or(0),
    }
}

fn string_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let obj = value.as_object()?;
    for key in keys {
        if let Some(Value::String(s)) = obj.get(*key) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn number_field(value: &Value, keys: &[&str]) -> Option<u64> {
    let obj = value.as_object()?;
    number_map(obj, keys)
}

fn number_map(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    for key in keys {
        match obj.get(*key) {
            Some(Value::Number(n)) => {
                if let Some(v) = n.as_u64() {
                    return Some(v);
                }
                if let Some(v) = n.as_f64() {
                    if v.is_finite() && v >= 0.0 {
                        return Some(v as u64);
                    }
                }
            }
            Some(Value::String(s)) => {
                if let Ok(v) = s.parse::<u64>() {
                    return Some(v);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_codex_paths() {
        assert_eq!(
            classify_backend_kind("/backend-api/codex/responses"),
            BackendKind::Responses
        );
        assert_eq!(
            classify_backend_kind("/backend-api/codex/images/generations"),
            BackendKind::Images
        );
        assert_eq!(
            classify_backend_kind("/backend-api/codex/alpha/search"),
            BackendKind::Search
        );
        assert!(classify_backend_kind("/backend-api/codex/responses").billable());
        assert!(!classify_backend_kind("/backend-api/codex/images/edits").billable());
    }

    #[test]
    fn parses_sse_response_completed_usage() {
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(
            br#"event: response.completed
data: {"type":"response.completed","response":{"model":"gpt-5.4","usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20}}}

"#,
            5,
        );
        assert_eq!(obs.model.as_deref(), Some("gpt-5.4"));
        let usage = obs.usage.expect("usage");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 8);
        assert_eq!(usage.total_tokens, 20);
        assert_eq!(obs.ttfb_ms, Some(5));
    }

    #[test]
    fn parses_json_body_usage() {
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(
            br#"{"model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}"#,
            1,
        );
        obs.finish_json_body();
        assert_eq!(obs.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(obs.usage.expect("usage").total_tokens, 4);
    }
}
