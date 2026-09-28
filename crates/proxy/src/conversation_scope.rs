//! Keeps each user to their own ChatGPT conversations and projects.
//!
//! Every user assigned to an upstream account shares its ChatGPT history and
//! projects, so the gateway binds a conversation to the user whose request
//! first names it (`conversation_id` in `POST /f/conversation`, or the one
//! upstream assigns a new chat in its stream) and a project to the user who
//! created it (the `g-p-` id a gizmo write returns). It drops everyone
//! else's from every response that lists them (see [`Listing`]), and
//! refuses a conversation or project that is not the user's. Those from
//! before the gateway bound anything belong to no one.

use std::collections::HashSet;

use serde_json::Value;

pub use crate::db::conversations::Kind;

/// The conversations and projects bound to one user.
#[derive(Debug, Clone, Default)]
pub struct Owned {
    pub conversations: HashSet<String>,
    pub projects: HashSet<String>,
}

/// Where a request names a conversation, and what it means for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationUse {
    /// Starts or continues a turn: an unbound conversation becomes the
    /// user's.
    Turn(String),
    /// Anything else on one conversation: it must already be the user's.
    Access(String),
    /// Anything on one project: it must already be the user's.
    Project(String),
}

/// A ChatGPT project id: `g-p-` and an alphanumeric tail. Custom GPTs
/// (`g-` alone) are the store's, not the login's, and are left alone.
pub fn is_project_id(text: &str) -> bool {
    text.strip_prefix("g-p-").is_some_and(|rest| {
        (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

fn collect_project_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) if is_project_id(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| collect_project_ids(item, out)),
        Value::Object(fields) => fields
            .values()
            .for_each(|field| collect_project_ids(field, out)),
        _ => {}
    }
}

/// The projects a request names: in its path (`/gizmos/g-p-…`), its query
/// (`gizmo_id=g-p-…`) or anywhere in its JSON body
/// (`conversation_mode.gizmo_id`, a move into a project, …).
pub fn project_ids(path: &str, query: Option<&str>, body: Option<&[u8]>) -> Vec<String> {
    let mut ids: Vec<String> = path
        .split('/')
        .filter(|segment| is_project_id(segment))
        .map(str::to_string)
        .collect();
    if let Some(query) = query {
        ids.extend(
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(_, value)| value.into_owned())
                .filter(|value| is_project_id(value)),
        );
    }
    if let Some(value) = body.and_then(|body| serde_json::from_slice::<Value>(body).ok()) {
        collect_project_ids(&value, &mut ids);
    }
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    ids
}

/// A write under `/gizmos` that names no project creates one (e.g.
/// `POST /gizmos/snorlax/upsert`); its response says which.
pub fn may_create_project(method: &http::Method, path: &str) -> bool {
    method != http::Method::GET
        && method != http::Method::HEAD
        && path.starts_with("/backend-api/gizmos/")
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

/// The conversation a path is about: `/conversation/{id}` or
/// `/conversations/{id}` and anything below it, under `/backend-api` or
/// `/backend-api/f`.
pub fn path_conversation_id(path: &str) -> Option<&str> {
    let mut segments = path.split('/');
    while let Some(segment) = segments.next() {
        if matches!(segment, "conversation" | "conversations")
            && let Some(id) = segments.clone().next()
            && is_conversation_id(id)
        {
            return Some(id);
        }
    }
    None
}

/// A write to the whole history (`PATCH /conversations` archives or deletes
/// every conversation): on a shared login it would take everyone's.
pub fn is_bulk_write(method: &http::Method, path: &str) -> bool {
    method != http::Method::GET
        && method != http::Method::HEAD
        && path.trim_end_matches('/') == "/backend-api/conversations"
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

/// The conversations and projects a request names, from its path, query and
/// body.
pub fn conversation_uses(
    path: &str,
    query: Option<&str>,
    body: Option<&[u8]>,
) -> Vec<ConversationUse> {
    let mut uses: Vec<ConversationUse> = project_ids(path, query, body)
        .into_iter()
        .map(ConversationUse::Project)
        .collect();
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

/// Finds the id a response names: the conversation of a turn's SSE stream
/// (a new chat's request carries no `conversation_id`; upstream assigns one
/// and reports it there), or the project a gizmo write creates.
#[derive(Debug)]
pub struct IdScanner {
    kind: Kind,
    /// The tail of the previous chunk, in case the id straddles two.
    carry: String,
    done: bool,
}

impl IdScanner {
    /// Longest `"conversation_id": "<uuid>"` with some whitespace, or a
    /// quoted project id.
    const CARRY: usize = 96;

    pub fn new(kind: Kind) -> Self {
        Self {
            kind,
            carry: String::new(),
            done: false,
        }
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// Feeds the next chunk; returns the id the first time one is seen, and
    /// nothing after that.
    pub fn push(&mut self, chunk: &[u8]) -> Option<String> {
        if self.done {
            return None;
        }
        let mut text = std::mem::take(&mut self.carry);
        text.push_str(&String::from_utf8_lossy(chunk));
        let found = match self.kind {
            Kind::Conversation => find_conversation_id(&text),
            Kind::Project => find_project_id(&text),
        };
        if let Some(id) = found {
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

/// The first complete quoted project id.
fn find_project_id(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find("\"g-p-") {
        rest = &rest[at + 1..];
        if let Some(end) = rest.find('"')
            && is_project_id(&rest[..end])
        {
            return Some(rest[..end].to_string());
        }
    }
    None
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

/// A response that lists conversations of the upstream login, and where in
/// it they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listing {
    /// `{items: [...], total?}`: the history, its search, shared links and
    /// a project's conversations.
    Items,
    /// `[...]`: `POST /conversations/batch`, whole conversations by id.
    Batch,
    /// `{items: [{conversations: {items: [...]}}]}`: the projects sidebar.
    Sidebar,
    /// `{items: [...]}` mixing conversations with other sources: the global
    /// search.
    Search,
    /// `[...]`: pinned conversations.
    Pins,
    /// Anything else about projects: the rest of `/gizmos` and the other
    /// pins. Only other users' projects are dropped from it.
    Projects,
}

/// The listing a request gets back, if any.
pub fn listing_of(method: &http::Method, path: &str, query: Option<&str>) -> Option<Listing> {
    let path = path.trim_end_matches('/');
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    if method == http::Method::POST {
        return (path == "/backend-api/conversations/batch").then_some(Listing::Batch);
    }
    if method != http::Method::GET {
        return None;
    }
    match segments.as_slice() {
        ["backend-api", "conversations"]
        | ["backend-api", "conversations", "search"]
        | ["backend-api", "shared_conversations"]
        | ["backend-api", "gizmos", _, "conversations"] => Some(Listing::Items),
        ["backend-api", "gizmos", "snorlax", "sidebar"] => Some(Listing::Sidebar),
        ["backend-api", "global", "search"] => Some(Listing::Search),
        ["backend-api", "pins"] => Some(
            if query.is_some_and(|query| {
                url::form_urlencoded::parse(query.as_bytes())
                    .any(|(key, value)| key == "item_type" && value == "conversation")
            }) {
                Listing::Pins
            } else {
                Listing::Projects
            },
        ),
        ["backend-api", "gizmos", ..] => Some(Listing::Projects),
        _ => None,
    }
}

/// The conversation a listed entry is, by the first id-shaped field of
/// `conversation_id`, `payload.conversation_id`, `conversation.id` and `id`
/// (a shared link's own `id` is not its conversation's).
fn listed_conversation(item: &Value) -> Option<&str> {
    [
        item.get("conversation_id"),
        item.pointer("/payload/conversation_id"),
        item.pointer("/conversation/id"),
        item.get("id"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .find(|id| is_conversation_id(id))
}

/// Keeps the entries that are one of `owned`; an entry naming no
/// conversation goes too.
fn retain_owned(items: &mut Vec<Value>, owned: &HashSet<String>) {
    items.retain(|item| listed_conversation(item).is_some_and(|id| owned.contains(id)));
}

/// Whether a global search result is a conversation (the others are files,
/// connectors and the like, and stay).
fn is_conversation_result(item: &Value) -> bool {
    item.get("source_type").and_then(Value::as_str) == Some("conversation")
        || item.pointer("/payload/kind").and_then(Value::as_str) == Some("conversation")
}

/// Whether a value names a project that is not the user's.
fn names_foreign_project(value: &Value, owned: &HashSet<String>) -> bool {
    match value {
        Value::String(text) => is_project_id(text) && !owned.contains(text),
        Value::Array(items) => items.iter().any(|item| names_foreign_project(item, owned)),
        Value::Object(fields) => fields
            .values()
            .any(|field| names_foreign_project(field, owned)),
        _ => false,
    }
}

/// Drops, from every list in `value`, the entries that name a project that
/// is not the user's: a project, its pin, a search hit in it.
fn prune_projects(value: &mut Value, owned: &HashSet<String>) {
    match value {
        Value::Array(items) => {
            items.retain(|item| !names_foreign_project(item, owned));
            items
                .iter_mut()
                .for_each(|item| prune_projects(item, owned));
        }
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|field| prune_projects(field, owned)),
        _ => {}
    }
}

fn filter_value(listing: Listing, value: &mut Value, owned: &Owned) -> Option<()> {
    let projects = &owned.projects;
    let owned = &owned.conversations;
    match listing {
        Listing::Batch | Listing::Pins => retain_owned(value.as_array_mut()?, owned),
        Listing::Items => {
            let object = value.as_object_mut()?;
            retain_owned(object.get_mut("items")?.as_array_mut()?, owned);
            if object.contains_key("total") {
                object.insert("total".into(), owned.len().into());
            }
        }
        Listing::Sidebar => {
            for project in value.get_mut("items")?.as_array_mut()? {
                if let Some(items) = project
                    .pointer_mut("/conversations/items")
                    .and_then(Value::as_array_mut)
                {
                    retain_owned(items, owned);
                }
            }
        }
        Listing::Search => value.get_mut("items")?.as_array_mut()?.retain(|item| {
            !is_conversation_result(item)
                || listed_conversation(item).is_some_and(|id| owned.contains(id))
        }),
        Listing::Projects => {}
    }
    prune_projects(value, projects);
    Some(())
}

/// Keeps only the user's own conversations and projects in a listing. A
/// body that cannot be read (`readable` is false for a compressed one) or is
/// not the listing expected comes back empty rather than unfiltered; one
/// only about projects that is not JSON at all has nothing to filter.
pub fn filter_listing(listing: Listing, body: &[u8], owned: &Owned, readable: bool) -> Vec<u8> {
    let value = readable
        .then(|| serde_json::from_slice::<Value>(body).ok())
        .flatten();
    if value.is_none() && readable && listing == Listing::Projects {
        return body.to_vec();
    }
    let filtered = value.and_then(|mut value| {
        filter_value(listing, &mut value, owned)?;
        serde_json::to_vec(&value).ok()
    });
    filtered.unwrap_or_else(|| {
        match listing {
            Listing::Batch | Listing::Pins => "[]",
            Listing::Items => r#"{"items":[],"total":0,"cursor":null}"#,
            Listing::Sidebar | Listing::Search | Listing::Projects => {
                r#"{"items":[],"cursor":null}"#
            }
        }
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MINE: &str = "6ab9293a-fadc-83ea-80b7-004e72636b6d";
    const THEIRS: &str = "6ab9270f-a5b8-83ea-be3e-562f1f943a19";
    const MY_PROJECT: &str = "g-p-6a8f0c1e2d3b4a5968778695a4b3c2d1";
    const THEIR_PROJECT: &str = "g-p-0123456789abcdef0123456789abcdef";

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
            conversation_uses("/backend-api/f/conversation", None, Some(body.as_bytes())),
            vec![ConversationUse::Turn(MINE.into())]
        );
        assert_eq!(
            conversation_uses("/backend-api/share/create", None, Some(body.as_bytes())),
            vec![ConversationUse::Access(MINE.into())]
        );
        // A new chat names none yet.
        let new = json!({ "action": "next", "conversation_id": null }).to_string();
        assert!(
            conversation_uses("/backend-api/f/conversation", None, Some(new.as_bytes())).is_empty()
        );
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
        let mut scanner = IdScanner::new(Kind::Conversation);
        assert_eq!(
            scanner.push(b"event: delta_encoding\ndata: \"v1\"\n\n"),
            None
        );
        assert_eq!(scanner.push(head.as_bytes()), None);
        assert_eq!(scanner.push(tail.as_bytes()), Some(MINE.to_string()));
        // Only the first one counts.
        assert_eq!(scanner.push(event.as_bytes()), None);

        let mut scanner = IdScanner::new(Kind::Conversation);
        assert_eq!(scanner.push(br#"{"conversation_id": null}"#), None);
    }

    #[test]
    fn a_listing_keeps_only_the_users_own_conversations() {
        let owned = Owned {
            conversations: [MINE.to_string(), "other-of-mine".to_string()].into(),
            projects: [MY_PROJECT.to_string()].into(),
        };
        let filter = |listing, body: Value| -> Value {
            serde_json::from_slice(&filter_listing(
                listing,
                body.to_string().as_bytes(),
                &owned,
                true,
            ))
            .unwrap()
        };

        // Shape captured from chatgpt.com.
        let history = json!({
            "items": [
                { "id": MINE, "title": "New chat" },
                { "id": THEIRS, "title": "New chat" }
            ],
            "total": 97, "limit": 100, "offset": 0
        });
        let filtered = filter(Listing::Items, history);
        assert_eq!(
            filtered["items"],
            json!([{ "id": MINE, "title": "New chat" }])
        );
        assert_eq!(filtered["total"], 2);
        assert_eq!(filtered["limit"], 100);

        // Search results and shared links name the conversation as
        // `conversation_id`; a shared link's own `id` is not it.
        let shared = json!({ "items": [
            { "id": MINE, "conversation_id": THEIRS },
            { "id": THEIRS, "conversation_id": MINE }
        ] });
        assert_eq!(
            filter(Listing::Items, shared)["items"],
            json!([{ "id": THEIRS, "conversation_id": MINE }])
        );

        // Whole conversations by id.
        let batch = json!([{ "id": THEIRS, "mapping": {} }, { "id": MINE, "mapping": {} }]);
        assert_eq!(
            filter(Listing::Batch, batch),
            json!([{ "id": MINE, "mapping": {} }])
        );

        // The projects sidebar lists each project's conversations.
        let sidebar = json!({ "items": [{
            "gizmo": { "gizmo": { "id": "g-p-1" } },
            "conversations": { "items": [{ "id": THEIRS }, { "id": MINE }], "cursor": null }
        }], "cursor": null });
        assert_eq!(
            filter(Listing::Sidebar, sidebar)["items"][0]["conversations"]["items"],
            json!([{ "id": MINE }])
        );

        // The global search keeps its other sources.
        let hit = |id: &str| {
            json!({ "id": "x".repeat(94), "source_type": "conversation",
                    "payload": { "kind": "conversation", "conversation_id": id } })
        };
        let file = json!({ "id": "file-1", "source_type": "file", "payload": { "kind": "file" } });
        let search = json!({ "items": [hit(THEIRS), hit(MINE), file.clone()], "cursor": null });
        assert_eq!(
            filter(Listing::Search, search)["items"],
            json!([hit(MINE), file])
        );

        // Anything unexpected comes back empty, never unfiltered.
        let garbled = filter_listing(Listing::Batch, b"\x1f\x8b gzip", &owned, true);
        assert_eq!(garbled, b"[]");
        let compressed = serde_json::to_vec(&json!([{ "id": MINE }])).unwrap();
        assert_eq!(
            filter_listing(Listing::Batch, &compressed, &owned, false),
            b"[]"
        );
        assert_eq!(
            filter(Listing::Items, json!({ "unexpected": [{ "id": THEIRS }] }))["items"],
            json!([])
        );
    }

    #[test]
    fn listings_are_recognised_by_method_path_and_query() {
        let get = http::Method::GET;
        let post = http::Method::POST;
        let cases = [
            (
                &get,
                "/backend-api/conversations",
                None,
                Some(Listing::Items),
            ),
            (
                &get,
                "/backend-api/conversations/search",
                Some("query=x"),
                Some(Listing::Items),
            ),
            (
                &get,
                "/backend-api/shared_conversations",
                None,
                Some(Listing::Items),
            ),
            (
                &get,
                "/backend-api/gizmos/g-p-abc/conversations",
                Some("limit=5"),
                Some(Listing::Items),
            ),
            (
                &get,
                "/backend-api/gizmos/snorlax/sidebar",
                None,
                Some(Listing::Sidebar),
            ),
            (
                &get,
                "/backend-api/global/search",
                Some("q=x"),
                Some(Listing::Search),
            ),
            (
                &get,
                "/backend-api/pins",
                Some("item_type=conversation"),
                Some(Listing::Pins),
            ),
            (
                &get,
                "/backend-api/pins",
                Some("item_type=gizmo"),
                Some(Listing::Projects),
            ),
            (
                &get,
                "/backend-api/gizmos/g-p-abc",
                None,
                Some(Listing::Projects),
            ),
            (
                &post,
                "/backend-api/conversations/batch",
                None,
                Some(Listing::Batch),
            ),
            (&get, "/backend-api/me", None, None),
        ];
        for (method, path, query, expected) in cases {
            assert_eq!(listing_of(method, path, query), expected, "{method} {path}");
        }

        assert_eq!(
            path_conversation_id(&format!("/backend-api/conversations/{MINE}")),
            Some(MINE)
        );
        assert!(is_bulk_write(
            &http::Method::PATCH,
            "/backend-api/conversations"
        ));
        assert!(!is_bulk_write(&get, "/backend-api/conversations"));
        assert!(!is_bulk_write(&post, "/backend-api/conversations/batch"));
    }
    #[test]
    fn projects_are_named_learned_and_filtered() {
        // Named in the path, the query or anywhere in the body.
        let body = json!({
            "conversation_id": MINE,
            "conversation_mode": { "kind": "gizmo_interaction", "gizmo_id": MY_PROJECT }
        })
        .to_string();
        assert_eq!(
            conversation_uses("/backend-api/f/conversation", None, Some(body.as_bytes())),
            vec![
                ConversationUse::Project(MY_PROJECT.into()),
                ConversationUse::Turn(MINE.into())
            ]
        );
        assert_eq!(
            project_ids(
                &format!("/backend-api/gizmos/{THEIR_PROJECT}/conversations"),
                Some(&format!("gizmo_id={THEIR_PROJECT}&limit=5")),
                None
            ),
            vec![THEIR_PROJECT.to_string()]
        );
        // Custom GPTs are not projects.
        assert!(!is_project_id("g-2fkFE8rbu"));
        assert!(may_create_project(
            &http::Method::POST,
            "/backend-api/gizmos/snorlax/upsert"
        ));

        // A created project is learned from the response.
        let created = format!(
            r#"{{"resource":{{"gizmo":{{"id":"{MY_PROJECT}","organization_id":"org-1"}}}}}}"#
        );
        let (head, tail) = created.split_at(created.find("g-p-").unwrap() + 6);
        let mut scanner = IdScanner::new(Kind::Project);
        assert_eq!(scanner.push(head.as_bytes()), None);
        assert_eq!(scanner.push(tail.as_bytes()), Some(MY_PROJECT.to_string()));

        // Other users' projects drop out of the sidebar, pins and search.
        let owned = Owned {
            conversations: [MINE.to_string()].into(),
            projects: [MY_PROJECT.to_string()].into(),
        };
        let project = |id: &str| {
            json!({ "gizmo": { "gizmo": { "id": id, "gizmo_type": "snorlax" } },
                    "conversations": { "items": [], "cursor": null } })
        };
        let sidebar =
            json!({ "items": [project(THEIR_PROJECT), project(MY_PROJECT)], "cursor": null });
        let filtered: Value = serde_json::from_slice(&filter_listing(
            Listing::Sidebar,
            sidebar.to_string().as_bytes(),
            &owned,
            true,
        ))
        .unwrap();
        assert_eq!(filtered["items"], json!([project(MY_PROJECT)]));

        let pins = json!([
            { "item_type": "gizmo", "item_id": THEIR_PROJECT },
            { "item_type": "gizmo", "item_id": "g-2fkFE8rbu" }
        ]);
        let filtered: Value = serde_json::from_slice(&filter_listing(
            Listing::Projects,
            pins.to_string().as_bytes(),
            &owned,
            true,
        ))
        .unwrap();
        assert_eq!(
            filtered,
            json!([{ "item_type": "gizmo", "item_id": "g-2fkFE8rbu" }])
        );
        // Not JSON: nothing to filter.
        assert_eq!(
            filter_listing(Listing::Projects, b"PNG", &owned, true),
            b"PNG"
        );
    }
}
