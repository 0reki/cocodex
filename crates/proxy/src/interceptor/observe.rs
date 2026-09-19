//! Watches upstream traffic to learn what each response cost.
//!
//! An HTTP request carries one response; a Codex WebSocket carries one per
//! `response.create`. Each finished response is settled separately.

use std::time::Instant;

use serde_json::Value;

use crate::billing::usage::{self, ResponseUsage};

const JSON_BUFFER_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Responses,
    Images,
    Search,
    Passthrough,
}

impl BackendKind {
    /// Kinds whose cost is charged to the user and counted against the
    /// upstream quota share. Images and Search are logged but free.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Terminal {
    Completed,
    Incomplete,
    Failed,
    Cancelled,
}

/// What was learned about one response.
#[derive(Debug, Clone)]
pub struct ResponseObservation {
    pub started_at: Instant,
    pub model: Option<String>,
    pub service_tier: Option<String>,
    pub usage: Option<ResponseUsage>,
    pub ttfb_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// HTTP-like status carried by a WebSocket `error` event.
    pub status: Option<u16>,
    pub terminal: Option<Terminal>,
    /// Whether anything was sent or received for this response.
    pub active: bool,
}

impl ResponseObservation {
    pub fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            model: None,
            service_tier: None,
            usage: None,
            ttfb_ms: None,
            error_code: None,
            error_message: None,
            status: None,
            terminal: None,
            active: false,
        }
    }
}

#[derive(Debug)]
pub struct RequestObservation {
    pub owner_user_id: Option<String>,
    pub is_sse: Option<bool>,
    sse_buf: Vec<u8>,
    json_buf: Vec<u8>,
    pub current: ResponseObservation,
    /// Responses that reached a terminal event and await settlement.
    pub finished: Vec<ResponseObservation>,
    /// The upstream body was read to the end (vs. the client leaving early).
    pub upstream_complete: bool,
    pub settled: bool,
    /// A WebSocket carries many responses; HTTP exactly one.
    pub websocket: bool,
}

impl Default for RequestObservation {
    fn default() -> Self {
        Self {
            owner_user_id: None,
            is_sse: None,
            sse_buf: Vec::new(),
            json_buf: Vec::new(),
            current: ResponseObservation::new(Instant::now()),
            finished: Vec::new(),
            upstream_complete: false,
            settled: false,
            websocket: false,
        }
    }
}

impl RequestObservation {
    pub fn record_error(&mut self, code: &str, message: &str) {
        self.current.error_code = Some(code.to_string());
        self.current.error_message = Some(message.to_string());
    }

    /// A client message on a WebSocket; `response.create` starts a response.
    pub fn ingest_client_text(&mut self, text: &str) -> Option<Value> {
        let value: Value = serde_json::from_str(text).ok()?;
        if value.get("type").and_then(Value::as_str) == Some("response.create") {
            if self.current.active && self.current.terminal.is_none() {
                // A new turn while the previous one never finished.
                let unfinished =
                    std::mem::replace(&mut self.current, ResponseObservation::new(Instant::now()));
                self.finished.push(unfinished);
            } else {
                self.current = ResponseObservation::new(Instant::now());
            }
            self.current.active = true;
            let model = value
                .get("model")
                .or_else(|| value.get("response").and_then(|r| r.get("model")))
                .and_then(Value::as_str);
            self.current.model = model.map(str::to_string);
            let tier = value.get("service_tier").and_then(Value::as_str);
            self.current.service_tier = tier.map(str::to_string);
        }
        Some(value)
    }

    pub fn ingest_chunk(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        self.current.active = true;
        if self.current.ttfb_ms.is_none() {
            self.current.ttfb_ms = Some(self.current.started_at.elapsed().as_millis() as u64);
        }
        let sse = self.is_sse.unwrap_or_else(|| looks_like_sse(chunk));
        if sse {
            self.is_sse = Some(true);
            // Buffer bytes: a UTF-8 character may be split across chunks.
            self.sse_buf.extend_from_slice(chunk);
            self.drain_sse();
            return;
        }
        self.is_sse = Some(false);
        let remaining = JSON_BUFFER_LIMIT.saturating_sub(self.json_buf.len());
        self.json_buf
            .extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }

    /// An upstream WebSocket text frame (one JSON event).
    pub fn ingest_text(&mut self, text: &str) {
        self.current.active = true;
        if self.current.ttfb_ms.is_none() {
            self.current.ttfb_ms = Some(self.current.started_at.elapsed().as_millis() as u64);
        }
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            self.ingest_event(&value);
        }
    }

    /// Parses whatever is buffered once the body ended.
    pub fn finish_body(&mut self) {
        if self.is_sse == Some(true) {
            let leftover = std::mem::take(&mut self.sse_buf);
            self.ingest_block(&String::from_utf8_lossy(&leftover));
        } else if !self.json_buf.is_empty()
            && let Ok(value) = serde_json::from_slice::<Value>(&std::mem::take(&mut self.json_buf))
        {
            self.ingest_event(&value);
        }
    }

    fn drain_sse(&mut self) {
        let find = |haystack: &[u8], needle: &[u8]| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        };
        loop {
            let (index, skip) = match (
                find(&self.sse_buf, b"\r\n\r\n"),
                find(&self.sse_buf, b"\n\n"),
            ) {
                (Some(a), Some(b)) if a < b => (a, 4),
                (_, Some(b)) => (b, 2),
                (Some(a), None) => (a, 4),
                (None, None) => break,
            };
            let block: Vec<u8> = self.sse_buf.drain(..index + skip).collect();
            self.ingest_block(&String::from_utf8_lossy(&block[..index]));
        }
    }

    fn ingest_block(&mut self, block: &str) {
        let data: Vec<&str> = block
            .lines()
            .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
            .map(str::trim_start)
            .collect();
        let payload = data.join("\n");
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&payload) {
            self.ingest_event(&value);
        }
    }

    fn ingest_event(&mut self, value: &Value) {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let current = &mut self.current;
        let response = value.get("response").filter(|r| r.is_object());
        for source in [Some(value), response].into_iter().flatten() {
            if let Some(model) = string(source, "model") {
                current.model = Some(model.to_string());
            }
            if let Some(tier) = string(source, "service_tier") {
                current.service_tier = Some(tier.to_string());
            }
            if let Some(usage) = source.get("usage").and_then(Value::as_object) {
                current.usage = Some(usage::extract(usage));
            }
            if current.error_code.is_none()
                && let Some(error) = source.get("error").filter(|e| e.is_object())
            {
                current.error_code = string(error, "code")
                    .or_else(|| string(error, "type"))
                    .map(str::to_string);
                current.error_message = string(error, "message").map(str::to_string);
            }
        }
        if kind == "error" {
            current.status = value
                .get("status")
                .and_then(Value::as_u64)
                .and_then(|s| u16::try_from(s).ok());
        }
        let terminal = match kind {
            "response.completed" | "response.done" => Some(Terminal::Completed),
            "response.incomplete" => Some(Terminal::Incomplete),
            "response.failed" | "error" => Some(Terminal::Failed),
            "response.cancelled" => Some(Terminal::Cancelled),
            // Non-streaming JSON bodies carry the whole response.
            "" if value.get("usage").is_some() || value.get("object").is_some() => {
                Some(Terminal::Completed)
            }
            _ => None,
        };
        if let Some(terminal) = terminal {
            current.terminal = Some(terminal);
            let done = std::mem::replace(current, ResponseObservation::new(Instant::now()));
            self.finished.push(done);
        }
    }

    /// Everything to settle: finished responses plus an unfinished one.
    pub fn take_all(&mut self) -> Vec<ResponseObservation> {
        let mut all = std::mem::take(&mut self.finished);
        if !self.websocket && !all.is_empty() {
            // Trailing bytes after the terminal event are not a new response.
            all.truncate(1);
            return all;
        }
        if self.current.active {
            all.push(std::mem::replace(
                &mut self.current,
                ResponseObservation::new(Instant::now()),
            ));
        }
        all
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn looks_like_sse(chunk: &[u8]) -> bool {
    let start = chunk
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    let rest = &chunk[start..];
    rest.starts_with(b"event:")
        || rest.starts_with(b"data:")
        || rest.starts_with(b":")
        || rest.starts_with(b"id:")
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
        assert!(!classify_backend_kind("/backend-api/codex/images/generations").billable());
        assert!(!classify_backend_kind("/backend-api/codex/models").billable());
    }

    #[test]
    fn parses_sse_response_completed_usage() {
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(
            b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"model\":\"gpt-5.4\"}}\n\n\
event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.4\",\"service_tier\":\"priority\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"total_tokens\":20}}}\n\n",
        );
        let all = obs.take_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].terminal, Some(Terminal::Completed));
        assert_eq!(all[0].model.as_deref(), Some("gpt-5.4"));
        assert_eq!(all[0].service_tier.as_deref(), Some("priority"));
        assert_eq!(all[0].usage.as_ref().unwrap().total_tokens, Some(20));

        // Bytes after the terminal event do not start another response.
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(b"data: {\"type\":\"response.completed\",\"response\":{}}\n\n");
        obs.ingest_chunk(b"data: [DONE]\n\n");
        assert_eq!(obs.take_all().len(), 1);
    }

    #[test]
    fn parses_json_body_usage() {
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(
            br#"{"model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}"#,
        );
        obs.finish_body();
        let all = obs.take_all();
        assert_eq!(all[0].usage.as_ref().unwrap().total_tokens, Some(4));
        assert_eq!(all[0].terminal, Some(Terminal::Completed));
    }

    #[test]
    fn websocket_turns_are_separate_responses() {
        let mut obs = RequestObservation {
            websocket: true,
            ..Default::default()
        };
        for turn in 0..2 {
            obs.ingest_client_text(r#"{"type":"response.create","model":"gpt-5.4"}"#);
            obs.ingest_text(&format!(
                r#"{{"type":"response.completed","response":{{"usage":{{"input_tokens":{},"output_tokens":1}}}}}}"#,
                10 + turn
            ));
        }
        obs.ingest_client_text(r#"{"type":"response.create","model":"gpt-5.5"}"#);
        obs.ingest_text(r#"{"type":"response.output_text.delta","delta":"x"}"#);
        let all = obs.take_all();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].usage.as_ref().unwrap().input_tokens(), 10);
        assert_eq!(all[1].usage.as_ref().unwrap().input_tokens(), 11);
        assert_eq!(all[2].terminal, None);
        assert_eq!(all[2].model.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn websocket_error_event_carries_status() {
        let mut obs = RequestObservation {
            websocket: true,
            ..Default::default()
        };
        obs.ingest_client_text(r#"{"type":"response.create","model":"gpt-5.4"}"#);
        obs.ingest_text(r#"{"type":"error","status":429,"error":{"code":"rate_limit_exceeded","message":"slow down"}}"#);
        let all = obs.take_all();
        assert_eq!(all[0].status, Some(429));
        assert_eq!(all[0].error_code.as_deref(), Some("rate_limit_exceeded"));
        assert_eq!(all[0].terminal, Some(Terminal::Failed));
    }
}
