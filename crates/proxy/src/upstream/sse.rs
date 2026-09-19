//! Reading a complete Responses SSE body.

use serde_json::Value;

const TERMINAL_EVENTS: [&str; 5] = [
    "response.completed",
    "response.done",
    "response.failed",
    "response.incomplete",
    "response.cancelled",
];

/// The `response` object of the last terminal event.
pub fn terminal_response(body: &str) -> Option<Value> {
    let normalized = body.replace("\r\n", "\n");
    let blocks: Vec<&str> = normalized.split("\n\n").collect();
    blocks.into_iter().rev().find_map(|block| {
        let data: Vec<&str> = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect();
        if data.is_empty() {
            return None;
        }
        let parsed: Value = serde_json::from_str(&data.join("\n")).ok()?;
        let kind = parsed.get("type")?.as_str()?;
        let response = parsed.get("response")?;
        (TERMINAL_EVENTS.contains(&kind) && response.is_object()).then(|| response.clone())
    })
}

/// Concatenated output text: streamed deltas, or the completed response's
/// `output_text` parts when no delta was sent.
pub fn output_text(body: &str) -> Option<String> {
    let mut result = String::new();
    let mut event = "message".to_string();
    let mut data: Vec<String> = Vec::new();
    let flush = |event: &mut String, data: &mut Vec<String>, result: &mut String| {
        if data.is_empty() {
            *event = "message".into();
            return;
        }
        let joined = data.join("\n");
        data.clear();
        *event = "message".into();
        let Ok(parsed) = serde_json::from_str::<Value>(&joined) else {
            return;
        };
        match parsed.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = parsed.get("delta").and_then(Value::as_str) {
                    result.push_str(delta);
                }
            }
            Some("response.completed") if result.is_empty() => {
                let output = parsed["response"]["output"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for item in output {
                    for part in item["content"].as_array().cloned().unwrap_or_default() {
                        if part["type"] == "output_text"
                            && let Some(text) = part["text"].as_str()
                        {
                            result.push_str(text);
                        }
                    }
                }
            }
            _ => {}
        }
    };
    for raw in body.split('\n') {
        let line = raw.trim_end_matches('\r').trim_end();
        if line.is_empty() {
            flush(&mut event, &mut data, &mut result);
        } else if let Some(name) = line.strip_prefix("event:") {
            event = Some(name.trim())
                .filter(|n| !n.is_empty())
                .unwrap_or("message")
                .to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_string());
        } else if event == "message" {
            data.push(line.to_string());
        }
    }
    flush(&mut event, &mut data, &mut result);
    (!result.is_empty()).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":3}}}\n\n";

    #[test]
    fn reads_text_and_terminal_response() {
        assert_eq!(output_text(BODY).as_deref(), Some("Hello"));
        assert_eq!(terminal_response(BODY).unwrap()["model"], "gpt-5.4");
        assert!(
            terminal_response("data: {\"type\":\"response.created\",\"response\":{}}\n\n")
                .is_none()
        );
    }
}
