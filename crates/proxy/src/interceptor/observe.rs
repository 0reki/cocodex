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
    /// The model the client asked for: the `response.create` frame's model
    /// on a WebSocket turn, or the request's `x-codex-routing-hint` on HTTP.
    pub requested_model: Option<String>,
    /// The model the `response.completed`/`response.done` event reports as
    /// used. Absent when the response never completed.
    pub completed_model: Option<String>,
    /// The service tier the client asked for (`priority` is Codex's Fast
    /// mode): the `response.create` frame's `service_tier` on a WebSocket
    /// turn, or the `tier=` of `x-codex-routing-hint` on HTTP.
    pub requested_service_tier: Option<String>,
    /// The service tier the upstream events report. It says `default` even
    /// for a Fast turn, so it only stands in when the client sent no tier.
    pub upstream_service_tier: Option<String>,
    /// Length of the opaque `x-codex-turn-state` carried by the upstream
    /// `response.metadata` event, when present.
    pub turn_state_len: Option<usize>,
    pub usage: Option<ResponseUsage>,
    pub ttfb_ms: Option<u64>,
    /// Time to the first generated token: the first output item or delta
    /// event, which (unlike the first byte) excludes `response.created` and
    /// other bookkeeping events sent before the model produces anything.
    pub ttft_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    /// HTTP-like status carried by a WebSocket `error` event.
    pub status: Option<u16>,
    pub terminal: Option<Terminal>,
    /// A plain (non-streaming) body was read to the end. Such a response —
    /// Search, say — has no terminal event and is complete once it arrived.
    pub body_complete: bool,
    /// Whether anything was sent or received for this response.
    pub active: bool,
}

impl ResponseObservation {
    pub fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            requested_model: None,
            completed_model: None,
            requested_service_tier: None,
            upstream_service_tier: None,
            turn_state_len: None,
            usage: None,
            ttfb_ms: None,
            ttft_ms: None,
            error_code: None,
            error_message: None,
            status: None,
            terminal: None,
            body_complete: false,
            active: false,
        }
    }

    /// The tier the response is recorded and billed at: the one the client
    /// asked for, else what the upstream reported.
    pub fn service_tier(&self) -> Option<&str> {
        self.requested_service_tier
            .as_deref()
            .or(self.upstream_service_tier.as_deref())
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
    /// A turn state an upstream event carried, waiting to be taken into the
    /// gateway's own cache (see `crate::turn_state`).
    captured_turn_state: Option<String>,
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
            captured_turn_state: None,
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
            self.current.requested_model = model.map(str::to_string);
            let tier = value
                .get("service_tier")
                .or_else(|| value.get("response").and_then(|r| r.get("service_tier")))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|tier| !tier.is_empty());
            self.current.requested_service_tier = tier.map(str::to_string);
        }
        Some(value)
    }

    /// Seeds the requested model of an HTTP response, whose request body the
    /// observation never sees; taken from `x-codex-routing-hint`.
    pub fn set_requested_model(&mut self, model: &str) {
        if self.current.requested_model.is_none() && !model.is_empty() {
            self.current.requested_model = Some(model.to_string());
        }
    }

    /// Seeds the requested tier of an HTTP response, taken like the model
    /// from `x-codex-routing-hint`.
    pub fn set_requested_service_tier(&mut self, tier: &str) {
        let tier = tier.trim();
        if self.current.requested_service_tier.is_none() && !tier.is_empty() {
            self.current.requested_service_tier = Some(tier.to_string());
        }
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
            return;
        }
        if !self.json_buf.is_empty()
            && let Ok(value) = serde_json::from_slice::<Value>(&std::mem::take(&mut self.json_buf))
        {
            self.ingest_event(&value);
        }
        if self.is_sse == Some(false) && self.upstream_complete && self.current.active {
            self.current.body_complete = true;
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
        if current.ttft_ms.is_none() && is_generation_event(kind) {
            current.ttft_ms = Some(current.started_at.elapsed().as_millis() as u64);
        }
        let response = value.get("response").filter(|r| r.is_object());
        for source in [Some(value), response].into_iter().flatten() {
            if let Some(tier) = string(source, "service_tier") {
                current.upstream_service_tier = Some(tier.to_string());
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
        // The turn state travels in the metadata event's relayed headers.
        if (kind == "response.metadata" || kind == "codex.response.metadata")
            && let Some(state) = value
                .get("headers")
                .and_then(Value::as_object)
                .and_then(turn_state)
        {
            current.turn_state_len = Some(state.len());
            self.captured_turn_state = Some(state);
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
        // The completed event reports the model that actually served the turn.
        if matches!(terminal, Some(Terminal::Completed)) {
            let model = [Some(value), response]
                .into_iter()
                .flatten()
                .find_map(|source| string(source, "model"));
            if let Some(model) = model {
                current.completed_model = Some(model.to_string());
            }
        }
        if let Some(terminal) = terminal {
            current.terminal = Some(terminal);
            let done = std::mem::replace(current, ResponseObservation::new(Instant::now()));
            self.finished.push(done);
        }
    }

    /// The turn state the last upstream event carried, once.
    pub fn take_captured_turn_state(&mut self) -> Option<String> {
        self.captured_turn_state.take()
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

/// The `x-codex-turn-state` header value in a metadata event's relayed
/// `headers` object (the name is matched case-insensitively).
fn turn_state(headers: &serde_json::Map<String, Value>) -> Option<String> {
    headers.iter().find_map(|(name, value)| {
        name.eq_ignore_ascii_case(crate::upstream::client::TURN_STATE_HEADER)
            .then(|| value.as_str().map(str::to_string))
            .flatten()
    })
}

/// An event carrying model output: an output item starting (reasoning
/// included, whose tokens count as output) or any streamed delta.
fn is_generation_event(kind: &str) -> bool {
    kind == "response.output_item.added"
        || (kind.starts_with("response.") && kind.ends_with(".delta"))
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
        // Housekeeping traffic is passthrough and never logged or settled.
        for path in [
            "/backend-api/codex/analytics-events/events",
            "/backend-api/codex/models",
            "/backend-api/ps/mcp",
            "/backend-api/ps/plugins/list",
            "/backend-api/wham/usage",
        ] {
            assert_eq!(
                classify_backend_kind(path),
                BackendKind::Passthrough,
                "{path}"
            );
        }
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
        assert_eq!(all[0].completed_model.as_deref(), Some("gpt-5.4"));
        // With no tier in the request, the upstream's report stands in.
        assert_eq!(all[0].service_tier(), Some("priority"));
        assert_eq!(all[0].usage.as_ref().unwrap().total_tokens, Some(20));

        // Bytes after the terminal event do not start another response.
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(b"data: {\"type\":\"response.completed\",\"response\":{}}\n\n");
        obs.ingest_chunk(b"data: [DONE]\n\n");
        assert_eq!(obs.take_all().len(), 1);
    }

    #[test]
    fn ttft_waits_for_generated_output() {
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(b"data: {\"type\":\"response.created\",\"response\":{}}\n\n");
        obs.ingest_chunk(b"data: {\"type\":\"response.in_progress\",\"response\":{}}\n\n");
        assert!(obs.current.ttfb_ms.is_some());
        assert_eq!(obs.current.ttft_ms, None);
        // Pretend the model spent a while before producing anything.
        obs.current.started_at -= std::time::Duration::from_millis(500);
        obs.ingest_chunk(b"data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\"}}\n\n");
        obs.current.started_at -= std::time::Duration::from_millis(500);
        obs.ingest_chunk(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n");
        obs.ingest_chunk(b"data: {\"type\":\"response.completed\",\"response\":{}}\n\n");
        let all = obs.take_all();
        let ttft = all[0].ttft_ms.unwrap();
        assert!((500..1000).contains(&ttft), "{ttft}");
        assert!(all[0].ttfb_ms.unwrap() < 500);
    }

    #[test]
    fn requested_tier_wins_over_upstream_echo() {
        // Fast on a WebSocket turn: the upstream still reports `default`.
        let mut obs = RequestObservation {
            websocket: true,
            ..Default::default()
        };
        obs.ingest_client_text(
            r#"{"type":"response.create","model":"gpt-6-astra","service_tier":"priority"}"#,
        );
        obs.ingest_text(r#"{"type":"response.created","response":{"service_tier":"auto"}}"#);
        obs.ingest_text(
            r#"{"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":1,"output_tokens":1}}}"#,
        );
        // The next turn without a tier falls back to the upstream's report.
        obs.ingest_client_text(r#"{"type":"response.create","model":"gpt-6-astra"}"#);
        obs.ingest_text(
            r#"{"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":1,"output_tokens":1}}}"#,
        );
        let all = obs.take_all();
        assert_eq!(all[0].service_tier(), Some("priority"));
        assert_eq!(all[0].upstream_service_tier.as_deref(), Some("default"));
        assert_eq!(all[1].service_tier(), Some("default"));

        // HTTP: the tier comes from the routing hint.
        let mut obs = RequestObservation::default();
        obs.set_requested_service_tier("priority");
        obs.ingest_chunk(
            b"data: {\"type\":\"response.completed\",\"response\":{\"service_tier\":\"default\"}}\n\n",
        );
        assert_eq!(obs.take_all()[0].service_tier(), Some("priority"));
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
    fn plain_body_is_complete_once_read() {
        // A Search response has no usage and no terminal event.
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(br#"{"results":[]}"#);
        obs.upstream_complete = true;
        obs.finish_body();
        let all = obs.take_all();
        assert!(all[0].body_complete);
        assert_eq!(all[0].terminal, None);

        // The client left before the body ended.
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(br#"{"results":["#);
        obs.finish_body();
        assert!(!obs.take_all()[0].body_complete);

        // A stream that ended without a terminal event is not complete.
        let mut obs = RequestObservation::default();
        obs.ingest_chunk(b"data: {\"type\":\"response.created\",\"response\":{}}\n\n");
        obs.upstream_complete = true;
        obs.finish_body();
        assert!(!obs.take_all()[0].body_complete);
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
        // No completed event yet, but the requested model is known.
        assert_eq!(all[2].requested_model.as_deref(), Some("gpt-5.5"));
        assert_eq!(all[2].completed_model, None);
    }

    #[test]
    fn records_turn_state_length_from_metadata() {
        let mut obs = RequestObservation {
            websocket: true,
            ..Default::default()
        };
        obs.ingest_client_text(r#"{"type":"response.create","model":"gpt-5.4"}"#);
        obs.set_requested_model("gpt-5.4");
        obs.ingest_text(
            r#"{"type":"codex.response.metadata","headers":{"x-codex-turn-state":"abcde"}}"#,
        );
        obs.ingest_text(
            r#"{"type":"response.completed","response":{"model":"gpt-5.4-mini","usage":{"input_tokens":1,"output_tokens":1}}}"#,
        );
        let all = obs.take_all();
        assert_eq!(all[0].turn_state_len, Some(5));
        assert_eq!(all[0].requested_model.as_deref(), Some("gpt-5.4"));
        // The completed event's model is the one actually used.
        assert_eq!(all[0].completed_model.as_deref(), Some("gpt-5.4-mini"));
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
