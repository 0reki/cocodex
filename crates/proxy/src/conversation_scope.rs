//! Keeps each user to their own ChatGPT conversations.
//!
//! Every user assigned to an upstream account shares its ChatGPT history, so
//! the gateway binds a conversation to the user whose request first names
//! it (`conversation_id` in `POST /f/conversation`), lists only that user's
//! conversations, and refuses a conversation that is not theirs.

use std::collections::HashSet;

use serde_json::Value;

/// Where a request names a conversation, and what it means for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationUse {
    /// Starts or continues a turn: an unbound conversation becomes the
    /// user's.
    Turn(String),
    /// Anything else on one conversation: it must already be the user's.
    Access(String),
}

/// A conversation id as ChatGPT issues them: a UUID.
fn is_conversation_id(segment: &str) -> bool {
    segment.len() == 36
        && segment.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// A request that sends turns: `/f/conversation` (and the older
/// `/conversation`) take the conversation in the body.
pub fn is_turn_path(path: &str) -> bool {
    matches!(
        path.trim_end_matches('/'),
        "/backend-api/f/conversation" | "/backend-api/conversation"
    )
}

/// The conversation a path is about: `/conversation/{id}` and anything
/// below it, under `/backend-api` or `/backend-api/f`.
pub fn path_conversation_id(path: &str) -> Option<&str> {
    let mut segments = path.split('/');
    while let Some(segment) = segments.next() {
        if segment == "conversation"
            && let Some(id) = segments.clone().next()
            && is_conversation_id(id)
        {
            return Some(id);
        }
    }
    None
}

/// The top-level `conversation_id` of a JSON request body.
pub fn body_conversation_id(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    value
        .get("conversation_id")?
        .as_str()
        .filter(|id| is_conversation_id(id))
        .map(str::to_string)
}

/// Whether a request's body is worth reading for a conversation id: a
/// ChatGPT (not Codex or WHAM) JSON write.
pub fn may_name_conversation_in_body(method: &http::Method, path: &str) -> bool {
    method != http::Method::GET
        && method != http::Method::HEAD
        && path.starts_with("/backend-api/")
        && !path.starts_with("/backend-api/codex/")
        && !path.starts_with("/backend-api/wham/")
}

/// The conversations a request names, from its path and body.
pub fn conversation_uses(path: &str, body: Option<&[u8]>) -> Vec<ConversationUse> {
    let mut uses = Vec::new();
    if let Some(id) = path_conversation_id(path) {
        uses.push(ConversationUse::Access(id.to_string()));
    }
    if let Some(id) = body.and_then(body_conversation_id) {
        uses.push(if is_turn_path(path) {
            ConversationUse::Turn(id)
        } else {
            ConversationUse::Access(id)
        });
    }
    uses
}

/// Finds the conversation a turn's SSE response names. A new chat's request
/// carries no `conversation_id`: upstream assigns one and reports it in the
/// stream, so that is where the gateway learns it.
#[derive(Debug, Default)]
pub struct ConversationIdScanner {
    /// The tail of the previous chunk, in case the id straddles two.
    carry: String,
    done: bool,
}

impl ConversationIdScanner {
    /// Longest `"conversation_id": "<uuid>"` with some whitespace.
    const CARRY: usize = 96;

    /// Feeds the next chunk; returns the conversation id the first time one
    /// is seen, and nothing after that.
    pub fn push(&mut self, chunk: &[u8]) -> Option<String> {
        if self.done {
            return None;
        }
        let mut text = std::mem::take(&mut self.carry);
        text.push_str(&String::from_utf8_lossy(chunk));
        if let Some(id) = find_conversation_id(&text) {
            self.done = true;
            return Some(id);
        }
        let mut start = text.len().saturating_sub(Self::CARRY);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        self.carry = text[start..].to_string();
        None
    }
}

fn find_conversation_id(text: &str) -> Option<String> {
    const KEY: &str = "\"conversation_id\"";
    let mut rest = text;
    while let Some(at) = rest.find(KEY) {
        rest = &rest[at + KEY.len()..];
        let value = rest.trim_start().strip_prefix(':')?.trim_start();
        if let Some(value) = value.strip_prefix('"')
            && let Some(id) = value.get(..36)
            && is_conversation_id(id)
        {
            return Some(id.to_string());
        }
    }
    None
}

/// Conversation listings: the history and its search.
pub fn is_list_path(path: &str) -> bool {
    matches!(
        path.trim_end_matches('/'),
        "/backend-api/conversations" | "/backend-api/conversations/search"
    )
}

/// Keeps only `owned` conversations in a listing's `items`, and reports
/// `total` as the user's own count. `None` when the body is not a listing.
pub fn filter_listing(body: &[u8], owned: &HashSet<String>) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let object = value.as_object_mut()?;
    let items = object.get_mut("items")?.as_array_mut()?;
    items.retain(|item| {
        item.get("id")
            .or_else(|| item.get("conversation_id"))
            .and_then(Value::as_str)
            .is_some_and(|id| owned.contains(id))
    });
    if object.contains_key("total") {
        object.insert("total".into(), owned.len().into());
    }
    serde_json::to_vec(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MINE: &str = "6ab9293a-fadc-83ea-80b7-004e72636b6d";
    const THEIRS: &str = "6ab9270f-a5b8-83ea-be3e-562f1f943a19";

    #[test]
    fn finds_the_conversation_a_request_names() {
        assert_eq!(
            path_conversation_id(&format!("/backend-api/conversation/{MINE}")),
            Some(MINE)
        );
        assert_eq!(
            path_conversation_id(&format!("/backend-api/f/conversation/{MINE}/stream_status")),
            Some(MINE)
        );
        assert_eq!(path_conversation_id("/backend-api/conversation/init"), None);
        assert_eq!(path_conversation_id("/backend-api/conversations"), None);

        let body = json!({ "action": "next", "conversation_id": MINE }).to_string();
        assert_eq!(
            conversation_uses("/backend-api/f/conversation", Some(body.as_bytes())),
            vec![ConversationUse::Turn(MINE.into())]
        );
        assert_eq!(
            conversation_uses("/backend-api/share/create", Some(body.as_bytes())),
            vec![ConversationUse::Access(MINE.into())]
        );
        // A new chat names none yet.
        let new = json!({ "action": "next", "conversation_id": null }).to_string();
        assert!(conversation_uses("/backend-api/f/conversation", Some(new.as_bytes())).is_empty());
        assert!(!may_name_conversation_in_body(
            &http::Method::POST,
            "/backend-api/codex/responses"
        ));
        assert!(may_name_conversation_in_body(
            &http::Method::POST,
            "/backend-api/f/conversation"
        ));
    }

    #[test]
    fn a_new_chat_is_learned_from_its_stream() {
        let event = format!(
            "data: {{\"type\": \"resume_conversation_token\", \"conversation_id\": \"{MINE}\"}}\n\n"
        );
        // Split right inside the id: the scanner must hold the tail back.
        let (head, tail) = event.split_at(event.find(MINE).unwrap() + 10);
        let mut scanner = ConversationIdScanner::default();
        assert_eq!(
            scanner.push(b"event: delta_encoding\ndata: \"v1\"\n\n"),
            None
        );
        assert_eq!(scanner.push(head.as_bytes()), None);
        assert_eq!(scanner.push(tail.as_bytes()), Some(MINE.to_string()));
        // Only the first one counts.
        assert_eq!(scanner.push(event.as_bytes()), None);

        let mut scanner = ConversationIdScanner::default();
        assert_eq!(scanner.push(br#"{"conversation_id": null}"#), None);
    }

    #[test]
    fn a_listing_keeps_only_the_users_own_conversations() {
        // Shape captured from chatgpt.com.
        let body = json!({
            "items": [
                { "id": MINE, "title": "New chat" },
                { "id": THEIRS, "title": "New chat" }
            ],
            "total": 97, "limit": 100, "offset": 0
        });
        let owned: HashSet<String> = [MINE.to_string(), "other-of-mine".to_string()].into();
        let filtered: Value =
            serde_json::from_slice(&filter_listing(body.to_string().as_bytes(), &owned).unwrap())
                .unwrap();
        assert_eq!(
            filtered["items"],
            json!([{ "id": MINE, "title": "New chat" }])
        );
        assert_eq!(filtered["total"], 2);
        assert_eq!(filtered["limit"], 100);

        // Search results name the conversation as `conversation_id`.
        let search = json!({ "items": [{ "conversation_id": THEIRS }], "cursor": null });
        let filtered: Value =
            serde_json::from_slice(&filter_listing(search.to_string().as_bytes(), &owned).unwrap())
                .unwrap();
        assert_eq!(filtered, json!({ "items": [], "cursor": null }));
    }
}
