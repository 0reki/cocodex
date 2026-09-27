//! Replaces the Codex client's identity inside what it sends with the
//! identity of the upstream login the request is routed to.
//!
//! Codex carries its installation id and turn metadata twice: as headers and
//! inside the request body's `client_metadata` (HTTP `POST /responses` and
//! every WebSocket `response.create`). Its analytics events report its
//! version and machine, and the ChatGPT MCP handshake its version. These are
//! rewritten to what the upstream login's own Codex would send; values are
//! only replaced, never dropped, because a genuine client of that login
//! would send them too. Only the client's type (originator, app-server
//! client name) stays its own: the rest of the body is tied to it.

use std::io;

use bytes::Bytes;
use chrono::{DateTime, NaiveDate, Utc};
use http::HeaderMap;
use http::header::{CONTENT_ENCODING, CONTENT_TYPE, USER_AGENT};
use serde_json::{Value, json};

use crate::interceptor::RequestContext;
use crate::upstream::identity::{
    codex_version_from_user_agent, os_profile, platform_family, presented_client_version,
    presented_sandbox,
};

const INSTALLATION_ID_METADATA_KEY: &str = "x-codex-installation-id";
const TURN_METADATA_KEY: &str = "x-codex-turn-metadata";
/// Codex compresses request bodies with zstd at this level.
const ZSTD_LEVEL: i32 = 3;

/// The identity a request is presented upstream with: the upstream login's
/// installation and OS and the impersonated Codex version, plus the
/// client's own Codex version to tell it from a host app's version.
pub struct PresentedIdentity<'a> {
    pub installation_id: &'a str,
    pub platform: &'a str,
    pub version: &'a str,
    pub client_version: Option<&'a str>,
    /// The gateway's egress timezone and date for `<environment_context>`.
    pub timezone: Option<&'a str>,
    pub current_date: Option<&'a str>,
}

impl<'a> PresentedIdentity<'a> {
    /// Set once the interceptor has routed the request to an upstream login.
    pub fn from_ctx(ctx: &'a RequestContext) -> Option<Self> {
        Some(Self {
            installation_id: ctx.upstream_installation_id.as_deref()?,
            platform: ctx.upstream_platform.as_deref()?,
            version: ctx.upstream_client_version.as_deref()?,
            client_version: ctx
                .client_headers
                .get(USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .and_then(codex_version_from_user_agent),
            timezone: ctx.presented_timezone.as_deref(),
            current_date: ctx.presented_current_date.as_deref(),
        })
    }
}

/// Stable install id for one upstream account on one OS, formatted like the
/// random v4 UUID Codex writes to `~/.codex/installation_id`. The same
/// account and OS always yield the same id.
pub fn gateway_installation_id(account_id: &str, platform: &str) -> String {
    use sha2::{Digest, Sha256};

    let platform = platform_family(platform);
    let digest = Sha256::digest(format!("cocodex-install:{platform}:{account_id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes)
        .into_uuid()
        .to_string()
}

/// `x-codex-turn-metadata` with the upstream login's installation id and, when
/// the client ran under a sandbox only another OS has, the sandbox of the
/// machine presented upstream. Every other field, including the client's
/// `workspaces`, is kept as sent.
pub fn rewrite_turn_metadata(raw: &str, identity: &PresentedIdentity<'_>) -> Option<String> {
    let mut value: Value = serde_json::from_str(raw).ok()?;
    let object = value.as_object_mut()?;
    if let Some(existing) = object.get_mut("installation_id") {
        *existing = Value::String(identity.installation_id.to_string());
    }
    if let Some(existing) = object.get_mut("sandbox")
        && let Some(presented) = existing
            .as_str()
            .and_then(|tag| presented_sandbox(identity.platform, tag))
    {
        *existing = Value::String(presented.to_string());
    }
    to_ascii_json_string(&value).ok()
}

/// Rewrites the identity carried in a request body's `client_metadata`.
/// Returns whether anything changed.
pub fn rewrite_client_metadata(body: &mut Value, identity: &PresentedIdentity<'_>) -> bool {
    let Some(metadata) = body
        .get_mut("client_metadata")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let mut changed = false;
    if let Some(existing) = metadata.get_mut(INSTALLATION_ID_METADATA_KEY)
        && existing.as_str() != Some(identity.installation_id)
    {
        *existing = Value::String(identity.installation_id.to_string());
        changed = true;
    }
    if let Some(existing) = metadata.get_mut(TURN_METADATA_KEY)
        && let Some(raw) = existing.as_str()
        && let Some(rewritten) = rewrite_turn_metadata(raw, identity)
        && rewritten != raw
    {
        *existing = Value::String(rewritten);
        changed = true;
    }
    changed
}

/// Sets `object[key]` to `value` when the key is present with another value.
fn replace_string(object: &mut serde_json::Map<String, Value>, key: &str, value: &str) -> bool {
    match object.get_mut(key) {
        Some(existing) if existing.as_str() != Some(value) => {
            *existing = Value::String(value.to_string());
            true
        }
        _ => false,
    }
}

/// Rewrites the version and machine every analytics event reports
/// (`app_server_client` and `runtime` in `codex-rs/analytics`). The client
/// name, id and transport are the client's type and stay; `client_version`
/// follows the User-Agent suffix (the CLI's becomes the presented version,
/// a host app's own is kept).
pub fn rewrite_analytics_events(body: &mut Value, identity: &PresentedIdentity<'_>) -> bool {
    let Some(events) = body.get_mut("events").and_then(Value::as_array_mut) else {
        return false;
    };
    let os = os_profile(identity.platform);
    let mut changed = false;
    for params in events
        .iter_mut()
        .filter_map(|event| event.get_mut("event_params"))
        .filter_map(Value::as_object_mut)
    {
        if let Some(client) = params
            .get_mut("app_server_client")
            .and_then(Value::as_object_mut)
            && let Some(reported) = client.get("client_version").and_then(Value::as_str)
        {
            let presented =
                presented_client_version(reported, identity.client_version, identity.version)
                    .to_string();
            changed |= replace_string(client, "client_version", &presented);
        }
        if let Some(runtime) = params.get_mut("runtime").and_then(Value::as_object_mut) {
            changed |= replace_string(runtime, "codex_rs_version", identity.version);
            changed |= replace_string(runtime, "runtime_os", os.runtime_os);
            changed |= replace_string(runtime, "runtime_os_version", os.runtime_os_version);
            changed |= replace_string(runtime, "runtime_arch", os.runtime_arch);
        }
    }
    changed
}

/// Rewrites the client version in the ChatGPT MCP `initialize` handshake.
pub fn rewrite_mcp_initialize(body: &mut Value, version: &str) -> bool {
    if body.get("method").and_then(Value::as_str) != Some("initialize") {
        return false;
    }
    body.pointer_mut("/params/clientInfo")
        .and_then(Value::as_object_mut)
        .is_some_and(|info| replace_string(info, "version", version))
}

/// A string carrying the environment context contains this marker.
const ENVIRONMENT_MARKER: &str = "<environment_context";

/// Replaces the timezone and date in a Responses request's
/// `<environment_context>` with the gateway's egress locale, so the
/// conversation does not reveal where the user is. The context is a user
/// message inside `input`; every string there that carries the block is
/// rewritten.
pub fn rewrite_environment_context(body: &mut Value, identity: &PresentedIdentity<'_>) -> bool {
    let Some(input) = body.get_mut("input") else {
        return false;
    };
    rewrite_env_in_value(input, identity)
}

fn rewrite_env_in_value(value: &mut Value, identity: &PresentedIdentity<'_>) -> bool {
    match value {
        Value::String(text) if text.contains(ENVIRONMENT_MARKER) => {
            // The user's machine fills these two, revealing its location.
            let tags = [
                ("<timezone>", "</timezone>", identity.timezone),
                ("<current_date>", "</current_date>", identity.current_date),
            ];
            let mut rewritten = text.clone();
            let mut changed = false;
            for (open, close, presented) in tags {
                if let Some(value) = presented {
                    changed |= replace_xml_element_text(&mut rewritten, open, close, value);
                }
            }
            if changed {
                *text = rewritten;
            }
            changed
        }
        // Every element is visited: a later one may also carry the block.
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= rewrite_env_in_value(item, identity);
            }
            changed
        }
        Value::Object(fields) => {
            let mut changed = false;
            for field in fields.values_mut() {
                changed |= rewrite_env_in_value(field, identity);
            }
            changed
        }
        _ => false,
    }
}

/// Replaces the text of every `{open}…{close}` element in `text` with the
/// XML-escaped `value`. Returns whether anything changed.
fn replace_xml_element_text(text: &mut String, open: &str, close: &str, value: &str) -> bool {
    let escaped = xml_escape(value);
    let mut result = String::with_capacity(text.len());
    let mut rest = text.as_str();
    let mut changed = false;
    while let Some(start) = rest.find(open) {
        let after_open = start + open.len();
        let Some(end) = rest[after_open..].find(close) else {
            break;
        };
        let current = &rest[after_open..after_open + end];
        result.push_str(&rest[..after_open]);
        result.push_str(&escaped);
        changed |= current != escaped;
        rest = &rest[after_open + end..];
    }
    if changed {
        result.push_str(rest);
        *text = result;
    }
    changed
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The full Responses body rewrite: the client identity in `client_metadata`
/// and the location in `<environment_context>`.
fn rewrite_responses_body(value: &mut Value, identity: &PresentedIdentity<'_>) -> bool {
    let metadata = rewrite_client_metadata(value, identity);
    let environment = rewrite_environment_context(value, identity);
    metadata || environment
}

/// Rewrites whatever client identity a JSON body sent to `ctx.target_path`
/// carries. MCP needs only the presented version: the `initialize` handshake
/// carries no account or installation identity.
fn rewrite_json_body(value: &mut Value, ctx: &RequestContext) -> bool {
    let path = ctx.target_path.trim_end_matches('/');
    if path.ends_with("/ps/mcp") {
        return ctx
            .upstream_client_version
            .as_deref()
            .is_some_and(|version| rewrite_mcp_initialize(value, version));
    }
    let Some(identity) = PresentedIdentity::from_ctx(ctx) else {
        return false;
    };
    if path.ends_with("/analytics-events/events") {
        rewrite_analytics_events(value, &identity)
    } else {
        rewrite_responses_body(value, &identity)
    }
}

/// Rewrites the client identity in a JSON HTTP body, decoding and
/// re-encoding a zstd body the way Codex compresses it. Bodies that are not
/// JSON, use another encoding, or carry no client identity are returned
/// unchanged.
pub fn rewrite_request_body(ctx: &RequestContext, headers: &HeaderMap, body: Bytes) -> Bytes {
    let is_json = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("json"));
    if !is_json || body.is_empty() {
        return body;
    }
    let zstd = match headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("") | Some("identity") => false,
        Some("zstd") => true,
        Some(_) => return body,
    };
    let decoded = if zstd {
        match zstd::decode_all(body.as_ref()) {
            Ok(decoded) => decoded,
            Err(_) => return body,
        }
    } else {
        body.to_vec()
    };
    let Ok(mut value) = serde_json::from_slice::<Value>(&decoded) else {
        return body;
    };
    if !rewrite_json_body(&mut value, ctx) {
        return body;
    }
    let Ok(encoded) = serde_json::to_vec(&value) else {
        return body;
    };
    if !zstd {
        return Bytes::from(encoded);
    }
    match zstd::encode_all(encoded.as_slice(), ZSTD_LEVEL) {
        Ok(compressed) => Bytes::from(compressed),
        Err(_) => body,
    }
}

/// Rewrites a WebSocket `response.create` text frame; other frames are
/// returned unchanged.
pub fn rewrite_ws_client_text(text: &str, identity: &PresentedIdentity<'_>) -> Option<String> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("response.create") {
        return None;
    }
    rewrite_responses_body(&mut value, identity).then(|| value.to_string())
}

/// Replaces the `client_version` query parameter (sent on `/models`) with
/// the version the gateway presents, leaving the rest of the query as is.
pub fn rewrite_client_version_query(query: &str, version: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(version.as_bytes()).collect();
    query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some(("client_version", _)) => format!("client_version={encoded}"),
            _ => pair.to_string(),
        })
        .collect::<Vec<_>>()
        .join("&")
}

/// Replaces the upstream login's identity with the client's own in what
/// upstream sends back: `/wham/usage` reports the login's `user_id`,
/// `account_id` and email, and every Responses event its user id as
/// `safety_identifier`. The client only ever sees the identity its gateway
/// token carries.
///
/// Works on raw bytes so a JSON body or SSE stream keeps its exact shape;
/// a value split across chunks is held back until the next one.
#[derive(Debug, Default)]
pub struct IdentitySwap {
    /// (upstream value, client value), both as they appear inside a JSON
    /// string.
    pairs: Vec<(Vec<u8>, Vec<u8>)>,
    longest: usize,
    carry: Vec<u8>,
}

impl IdentitySwap {
    /// `pairs` maps upstream values to client values; empty or equal pairs
    /// are ignored.
    pub fn new(pairs: &[(String, String)]) -> Self {
        let mut pairs: Vec<(Vec<u8>, Vec<u8>)> = pairs
            .iter()
            .filter(|(upstream, client)| !upstream.is_empty() && upstream != client)
            .map(|(upstream, client)| (json_fragment(upstream), json_fragment(client)))
            .collect();
        // At one position, the longest value wins.
        pairs.sort_by_key(|(upstream, _)| std::cmp::Reverse(upstream.len()));
        let longest = pairs
            .iter()
            .map(|(upstream, _)| upstream.len())
            .max()
            .unwrap_or(0);
        Self {
            pairs,
            longest,
            carry: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// Replaces every value in a complete message (a WebSocket text frame).
    pub fn swap_text(&self, text: &str) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let (swapped, _, changed) = self.replace(text.as_bytes(), text.len());
        changed.then(|| String::from_utf8(swapped).ok()).flatten()
    }

    /// Feeds the next chunk of a stream; returns what can be sent on. Bytes
    /// that may start a value are kept until the next chunk or `finish`.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.is_empty() {
            return chunk.to_vec();
        }
        let mut buffer = std::mem::take(&mut self.carry);
        buffer.extend_from_slice(chunk);
        // A value starting before `safe` ends inside the buffer, so it has
        // been seen whole; one starting later may continue in the next chunk.
        let safe = buffer.len().saturating_sub(self.longest - 1);
        let (out, consumed, _) = self.replace(&buffer, safe);
        self.carry = buffer[consumed..].to_vec();
        out
    }

    /// The bytes still held back at the end of the stream.
    pub fn finish(&mut self) -> Vec<u8> {
        let rest = std::mem::take(&mut self.carry);
        self.replace(&rest, rest.len()).0
    }

    /// Replaces values starting before `limit`; returns the output, how
    /// many input bytes it covers, and whether anything was replaced.
    fn replace(&self, input: &[u8], limit: usize) -> (Vec<u8>, usize, bool) {
        let mut out = Vec::with_capacity(input.len());
        let mut position = 0;
        let mut changed = false;
        while position < limit {
            let hit = self
                .pairs
                .iter()
                .find(|(upstream, _)| input[position..].starts_with(upstream));
            match hit {
                Some((upstream, client)) => {
                    out.extend_from_slice(client);
                    position += upstream.len();
                    changed = true;
                }
                None => {
                    out.push(input[position]);
                    position += 1;
                }
            }
        }
        (out, position, changed)
    }
}

/// `value` as it appears between the quotes of a JSON string.
fn json_fragment(value: &str) -> Vec<u8> {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or_default()
        .as_bytes()
        .to_vec()
}

/// Serializes JSON with non-ASCII string content escaped as `\uXXXX`,
/// matching Codex `to_ascii_json_string` so rewritten metadata stays valid
/// as a header value and byte-compatible with a genuine client.
fn to_ascii_json_string(value: &Value) -> serde_json::Result<String> {
    use serde::Serialize;

    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, AsciiJsonFormatter);
    value.serialize(&mut serializer)?;
    String::from_utf8(bytes)
        .map_err(|err| serde_json::Error::io(io::Error::new(io::ErrorKind::InvalidData, err)))
}

struct AsciiJsonFormatter;

impl serde_json::ser::Formatter for AsciiJsonFormatter {
    fn write_string_fragment<W>(&mut self, writer: &mut W, fragment: &str) -> io::Result<()>
    where
        W: ?Sized + io::Write,
    {
        let mut start = 0;
        for (index, ch) in fragment.char_indices() {
            if ch.is_ascii() {
                continue;
            }
            if start < index {
                writer.write_all(&fragment.as_bytes()[start..index])?;
            }
            let mut utf16 = [0; 2];
            for code_unit in ch.encode_utf16(&mut utf16) {
                write!(writer, "\\u{code_unit:04x}")?;
            }
            start = index + ch.len_utf8();
        }
        if start < fragment.len() {
            writer.write_all(&fragment.as_bytes()[start..])?;
        }
        Ok(())
    }
}

/// Responses relayed exactly as upstream sent them. `/celsius/ws/user` hands
/// the webview the address and signed credentials of upstream's own
/// WebSocket, which name the login; swapping its identity in them would
/// break the connection they are for.
pub fn relays_verbatim(path: &str) -> bool {
    path.starts_with("/backend-api/celsius/ws/")
}

/// The client's own profile, shown in place of the upstream login's on the
/// ChatGPT profile endpoints the desktop app's webview reads.
#[derive(Debug, Clone, Default)]
pub struct ClientProfile {
    pub name: String,
    pub email: String,
    /// How the client signed in, from its gateway token.
    pub amr: Vec<String>,
    /// The client's country (Cloudflare's `CF-IPCountry` for its request).
    pub country: Option<String>,
    /// When the client's portal user was created (loaded for the endpoints
    /// that report it).
    pub created_at: Option<DateTime<Utc>>,
    /// The client's account id, from which its stand-in `pthdnu` is derived.
    pub account_id: String,
    /// The client's own usage (loaded for `/wham/profiles/me`).
    pub usage: Option<crate::db::logs::ProfileUsage>,
}

impl ClientProfile {
    /// ChatGPT's default username is the email's local part.
    fn username(&self) -> &str {
        self.email.split('@').next().unwrap_or_default()
    }

    /// The Auth0 default avatar ChatGPT gives an account without a picture:
    /// the name's first two letters.
    fn picture(&self) -> String {
        let initials: String = self
            .name
            .chars()
            .chain(self.username().chars())
            .filter(char::is_ascii_alphanumeric)
            .take(2)
            .collect::<String>()
            .to_ascii_lowercase();
        format!("https://cdn.auth0.com/avatars/{initials}.png")
    }

    /// `pthdnu` is a keyed hash chatgpt.com derives from the account; the
    /// gateway cannot reproduce the key, so each client gets a stable hash
    /// of its own account in the same shape.
    fn pthdnu(&self) -> String {
        use sha2::{Digest, Sha256};
        hex::encode(Sha256::digest(
            format!("cocodex-pthdnu:{}", self.account_id).as_bytes(),
        ))
    }
}

/// The client's identity values in a request path or query become the
/// upstream login's: the webview asks e.g. `/subscriptions?account_id=…`
/// with the account id its gateway token carries. `pairs` is
/// `RequestContext::identity_swap` (upstream value, client value).
pub fn to_upstream_identity(text: &str, pairs: &[(String, String)]) -> String {
    let mut pairs: Vec<&(String, String)> = pairs
        .iter()
        .filter(|(upstream, client)| !client.is_empty() && upstream != client)
        .collect();
    // At one position, the longest value wins.
    pairs.sort_by_key(|(_, client)| std::cmp::Reverse(client.len()));
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'outer: while !rest.is_empty() {
        for (upstream, client) in &pairs {
            if let Some(after) = rest.strip_prefix(client.as_str()) {
                out.push_str(upstream);
                rest = after;
                continue 'outer;
            }
        }
        let next = rest.chars().next().map_or(1, char::len_utf8);
        out.push_str(&rest[..next]);
        rest = &rest[next..];
    }
    out
}

/// The ChatGPT endpoints whose body describes the upstream login's person
/// or account beyond its ids: `IdentitySwap` handles ids and email, these
/// are rewritten field by field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileEndpoint {
    /// `/me`: name, picture, phone, sign-in methods, country, creation time.
    Me,
    /// `/profiles/me`: the public profile.
    Profile,
    /// `/wham/profiles/me`: the Codex profile page, with usage stats.
    CodexProfile,
    /// `/accounts/check/…`: account creation time and `pthdnu`.
    AccountsCheck,
}

impl ProfileEndpoint {
    pub fn of(path: &str) -> Option<Self> {
        let path = path.trim_end_matches('/');
        match path {
            "/backend-api/me" => Some(Self::Me),
            "/backend-api/profiles/me" => Some(Self::Profile),
            "/backend-api/wham/profiles/me" => Some(Self::CodexProfile),
            _ if path.starts_with("/backend-api/accounts/check/") => Some(Self::AccountsCheck),
            _ => None,
        }
    }

    /// Whether the rewrite needs the portal user's creation time.
    pub fn needs_created_at(self) -> bool {
        matches!(self, Self::Me | Self::AccountsCheck)
    }
}

/// Replaces the upstream login's personal fields in a profile endpoint's
/// JSON body with the client's. These hold short free-form values (a name
/// like "kk"), timestamps and usage that cannot be swapped as raw bytes.
/// `None` when the body is not the expected JSON object.
pub fn rewrite_profile_body(
    endpoint: ProfileEndpoint,
    body: &[u8],
    profile: &ClientProfile,
) -> Option<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(body).ok()?;
    let object = value.as_object_mut()?;
    // Only fields upstream sent, and not null, are replaced.
    fn set(object: &mut serde_json::Map<String, Value>, key: &str, new: Value) {
        if let Some(slot) = object.get_mut(key)
            && !slot.is_null()
        {
            *slot = new;
        }
    }
    let created = profile.created_at;
    match endpoint {
        ProfileEndpoint::Me => {
            set(object, "name", profile.name.as_str().into());
            set(object, "picture", profile.picture().into());
            set(object, "phone_number", Value::Null);
            set(object, "first_name", Value::Null);
            set(object, "amr", json!(profile.amr));
            if object.contains_key("country") {
                object.insert("country".into(), json!(profile.country));
            }
            if let Some(created) = created {
                set(object, "created", created.timestamp().into());
                if let Some(orgs) = object
                    .get_mut("orgs")
                    .and_then(|orgs| orgs.get_mut("data"))
                    .and_then(Value::as_array_mut)
                {
                    // The personal org is made a moment before its user.
                    for org in orgs.iter_mut().filter_map(Value::as_object_mut) {
                        set(org, "created", (created.timestamp() - 1).into());
                    }
                }
            }
        }
        ProfileEndpoint::Profile | ProfileEndpoint::CodexProfile => {
            let key = if endpoint == ProfileEndpoint::Profile {
                "profile_details"
            } else {
                "profile"
            };
            let details = object.get_mut(key)?.as_object_mut()?;
            set(details, "username", profile.username().into());
            set(details, "display_name", profile.name.as_str().into());
            set(details, "profile_picture_url", profile.picture().into());
            if endpoint == ProfileEndpoint::CodexProfile
                && let Some(usage) = &profile.usage
            {
                let today = Utc::now().date_naive();
                object.insert("stats".into(), profile_stats(usage, today));
            }
        }
        ProfileEndpoint::AccountsCheck => {
            let accounts = object.get_mut("accounts")?.as_object_mut()?;
            for entry in accounts.values_mut() {
                let Some(account) = entry.get_mut("account").and_then(Value::as_object_mut) else {
                    continue;
                };
                set(account, "pthdnu", profile.pthdnu().into());
                if let Some(created) = created {
                    set(
                        account,
                        "created_time",
                        created
                            .to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
                            .into(),
                    );
                }
            }
        }
    }
    let pretty = body.windows(2).any(|pair| pair == b"\n ");
    if pretty {
        serde_json::to_vec_pretty(&value).ok()
    } else {
        serde_json::to_vec(&value).ok()
    }
}

/// The Codex profile page's `stats`, from the client's own usage. The
/// gateway records no threads, skills or reasoning effort, so those read as
/// a fresh account's.
pub fn profile_stats(usage: &crate::db::logs::ProfileUsage, today: NaiveDate) -> Value {
    use chrono::Datelike;

    let days = &usage.daily_tokens;
    let lifetime: i64 = days.iter().map(|(_, tokens)| tokens).sum();
    let peak = days.iter().map(|(_, tokens)| *tokens).max().unwrap_or(0);

    // Consecutive days with usage; the current run may end today or, before
    // today's first request, yesterday.
    let mut longest = 0;
    let mut run = 0;
    let mut previous: Option<NaiveDate> = None;
    for (day, _) in days {
        run = match previous {
            Some(previous) if previous.succ_opt() == Some(*day) => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        previous = Some(*day);
    }
    let current = match previous {
        Some(last) if last == today || last.succ_opt() == Some(today) => run,
        _ => 0,
    };

    let mut cumulative = 0;
    let daily: Vec<Value> = days
        .iter()
        .map(|(day, tokens)| json!({ "start_date": day.to_string(), "tokens": tokens }))
        .collect();
    let cumulative_daily: Vec<Value> = days
        .iter()
        .map(|(day, tokens)| {
            cumulative += tokens;
            json!({ "start_date": day.to_string(), "tokens": cumulative })
        })
        .collect();
    // Weeks start on Monday.
    let mut weekly: Vec<(NaiveDate, i64)> = Vec::new();
    for (day, tokens) in days {
        let monday = *day - chrono::Duration::days(i64::from(day.weekday().num_days_from_monday()));
        match weekly.last_mut() {
            Some((week, sum)) if *week == monday => *sum += tokens,
            _ => weekly.push((monday, *tokens)),
        }
    }
    let weekly: Vec<Value> = weekly
        .into_iter()
        .map(|(week, tokens)| json!({ "start_date": week.to_string(), "tokens": tokens }))
        .collect();
    let fast = if usage.responses > 0 {
        usage.priority_responses as f64 * 100.0 / usage.responses as f64
    } else {
        0.0
    };
    json!({
        "lifetime_tokens": lifetime,
        "peak_daily_tokens": peak,
        "current_streak_days": current,
        "longest_streak_days": longest,
        "total_threads": 0,
        "longest_running_turn_sec": usage.longest_latency_ms / 1000,
        "fast_mode_usage_percentage": fast,
        "total_skills_used": 0,
        "unique_skills_used": 0,
        "most_used_reasoning_effort": null,
        "most_used_reasoning_effort_percentage": 0.0,
        "daily_usage_buckets": daily,
        "cumulative_daily_usage_buckets": cumulative_daily,
        "weekly_usage_buckets": weekly,
        "top_invocations": [],
        "workspace_rank": null,
        "workspace_total_user_count": null
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const INSTALL: &str = "11111111-2222-4333-8444-555555555555";

    fn identity() -> PresentedIdentity<'static> {
        PresentedIdentity {
            installation_id: INSTALL,
            platform: "linux",
            version: "0.156.0",
            client_version: Some("0.155.1"),
            timezone: Some("America/New_York"),
            current_date: Some("2026-09-19"),
        }
    }

    #[test]
    fn installation_id_is_a_stable_v4_uuid_per_account_and_os() {
        let windows_a = gateway_installation_id("acct-a", "windows");
        let parsed = uuid::Uuid::parse_str(&windows_a).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.get_variant(), uuid::Variant::RFC4122);
        assert_eq!(windows_a, gateway_installation_id("acct-a", "windows"));
        assert_ne!(windows_a, gateway_installation_id("acct-b", "windows"));
        assert_ne!(windows_a, gateway_installation_id("acct-a", "linux"));
        // Platform spellings of the same OS share one installation.
        assert_eq!(
            gateway_installation_id("acct-a", "darwin"),
            gateway_installation_id("acct-a", "macos")
        );
        assert_eq!(
            gateway_installation_id("acct-a", "all"),
            gateway_installation_id("acct-a", "linux")
        );
    }

    #[test]
    fn turn_metadata_keeps_the_client_fields_and_replaces_identity() {
        let raw = json!({
            "installation_id": "client-install",
            "session_id": "sess",
            "thread_id": "thread",
            "turn_id": "turn",
            "sandbox": "seccomp",
            "workspaces": { "/home/alice/repo": { "latest_git_commit_hash": "abc" } },
            "workspace_kind": "desktop-project",
            "model": "gpt-5.4"
        })
        .to_string();
        let rewritten = rewrite_turn_metadata(&raw, &identity()).unwrap();
        // Only the installation id is replaced; the client's workspaces and
        // every other field are kept in order.
        assert_eq!(
            rewritten,
            format!(
                r#"{{"installation_id":"{INSTALL}","session_id":"sess","thread_id":"thread","turn_id":"turn","sandbox":"seccomp","workspaces":{{"/home/alice/repo":{{"latest_git_commit_hash":"abc"}}}},"workspace_kind":"desktop-project","model":"gpt-5.4"}}"#
            )
        );
    }

    #[test]
    fn turn_metadata_sandbox_follows_the_presented_machine() {
        // A macOS client is served by the Linux login, so the turn it reports
        // cannot have run under seatbelt.
        let rewritten = rewrite_turn_metadata(
            r#"{"installation_id":"client-install","turn_id":"t","sandbox":"seatbelt"}"#,
            &identity(),
        )
        .unwrap();
        assert_eq!(
            rewritten,
            format!(r#"{{"installation_id":"{INSTALL}","turn_id":"t","sandbox":"seccomp"}}"#)
        );
    }

    #[test]
    fn turn_metadata_without_installation_id_does_not_gain_one() {
        let rewritten = rewrite_turn_metadata(r#"{"turn_id":"t","sandbox":"none"}"#, &identity());
        assert_eq!(
            rewritten.as_deref(),
            Some(r#"{"turn_id":"t","sandbox":"none"}"#)
        );
    }

    #[test]
    fn turn_metadata_escapes_non_ascii_like_codex() {
        let raw = r#"{"agent_name":"Agentlarım 🚀"}"#;
        assert_eq!(
            rewrite_turn_metadata(raw, &identity()).as_deref(),
            Some("{\"agent_name\":\"Agentlar\\u0131m \\ud83d\\ude80\"}")
        );
    }

    fn body_with_identity() -> Value {
        json!({
            "model": "gpt-5.4",
            "input": [],
            "client_metadata": {
                "x-codex-installation-id": "client-install",
                "session_id": "sess",
                "x-codex-turn-metadata": r#"{"installation_id":"client-install","turn_id":"t","workspaces":{"/r":{}}}"#
            }
        })
    }

    #[test]
    fn client_metadata_identity_is_replaced() {
        let mut body = body_with_identity();
        assert!(rewrite_client_metadata(&mut body, &identity()));
        assert_eq!(body["client_metadata"]["x-codex-installation-id"], INSTALL);
        assert_eq!(body["client_metadata"]["session_id"], "sess");
        assert_eq!(
            body["client_metadata"]["x-codex-turn-metadata"],
            format!(
                r#"{{"installation_id":"{INSTALL}","turn_id":"t","workspaces":{{"/r":{{}}}}}}"#
            )
        );
        // Already rewritten: nothing left to change.
        assert!(!rewrite_client_metadata(&mut body, &identity()));
    }

    fn json_headers(encoding: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, "application/json".parse().unwrap());
        if let Some(encoding) = encoding {
            headers.insert(CONTENT_ENCODING, encoding.parse().unwrap());
        }
        headers
    }

    const RESPONSES: &str = "/backend-api/codex/responses";

    /// A request to `path` routed to an upstream login on `platform`.
    fn routed(path: &str) -> RequestContext {
        let request = http::Request::builder()
            .uri(path)
            .header(
                "user-agent",
                "codex-tui/0.155.1 (Debian 13.0.0; x86_64) xterm-256color (codex-tui; 0.155.1)",
            )
            .body(axum::body::Body::empty())
            .unwrap();
        let mut ctx = RequestContext::new(&request);
        ctx.upstream_installation_id = Some(INSTALL.into());
        ctx.upstream_platform = Some("linux".into());
        ctx.upstream_client_version = Some("0.156.0".into());
        ctx.presented_timezone = Some("America/New_York".into());
        ctx.presented_current_date = Some("2026-09-19".into());
        ctx
    }

    #[test]
    fn plain_and_zstd_bodies_are_rewritten() {
        let original = serde_json::to_vec(&body_with_identity()).unwrap();
        let ctx = routed(RESPONSES);

        let plain = rewrite_request_body(&ctx, &json_headers(None), Bytes::from(original.clone()));
        let plain: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(plain["client_metadata"]["x-codex-installation-id"], INSTALL);

        let compressed = zstd::encode_all(original.as_slice(), 3).unwrap();
        let rewritten =
            rewrite_request_body(&ctx, &json_headers(Some("zstd")), Bytes::from(compressed));
        let decoded: Value =
            serde_json::from_slice(&zstd::decode_all(rewritten.as_ref()).unwrap()).unwrap();
        assert_eq!(
            decoded["client_metadata"]["x-codex-installation-id"],
            INSTALL
        );
        assert_eq!(decoded["model"], "gpt-5.4");
    }

    #[test]
    fn bodies_without_identity_or_json_are_untouched() {
        let ctx = routed(RESPONSES);
        let body = Bytes::from_static(br#"{"model":"gpt-5.4","input":"hi"}"#);
        assert_eq!(
            rewrite_request_body(&ctx, &json_headers(None), body.clone()),
            body
        );
        let mut form = HeaderMap::new();
        form.insert(CONTENT_TYPE, "multipart/form-data".parse().unwrap());
        let raw = Bytes::from(serde_json::to_vec(&body_with_identity()).unwrap());
        assert_eq!(rewrite_request_body(&ctx, &form, raw.clone()), raw);
        assert_eq!(
            rewrite_request_body(&ctx, &json_headers(Some("gzip")), raw.clone()),
            raw
        );
    }

    #[test]
    fn analytics_events_report_the_presented_codex_version() {
        // Shape captured from Codex 0.155.1 on Linux.
        let body = json!({ "events": [{
            "event_type": "codex_turn_event",
            "event_params": {
                "thread_id": "th",
                "app_server_client": {
                    "product_client_id": "codex-tui",
                    "client_name": "codex-tui",
                    "client_version": "0.155.1",
                    "rpc_transport": "in_process",
                    "experimental_api_enabled": true
                },
                "runtime": {
                    "codex_rs_version": "0.155.1",
                    "runtime_os": "linux",
                    "runtime_os_version": "24.4.0",
                    "runtime_arch": "x86_64"
                },
                "model": "gpt-5.4"
            }
        }]});
        let rewritten = rewrite_request_body(
            &routed("/backend-api/codex/analytics-events/events"),
            &json_headers(None),
            Bytes::from(serde_json::to_vec(&body).unwrap()),
        );
        let rewritten: Value = serde_json::from_slice(&rewritten).unwrap();
        let mut expected = body.clone();
        let params = &mut expected["events"][0]["event_params"];
        params["app_server_client"]["client_version"] = json!("0.156.0");
        params["runtime"]["codex_rs_version"] = json!("0.156.0");
        // The routed login is Linux: the presented machine is the gateway's.
        params["runtime"]["runtime_os_version"] = json!("13.0.0");
        assert_eq!(rewritten, expected);
    }

    #[test]
    fn analytics_from_a_host_app_keep_its_own_version() {
        let mut body = json!({ "events": [{ "event_params": {
            "app_server_client": {
                "product_client_id": "Codex Desktop",
                "client_name": "Codex Desktop",
                "client_version": "26.915.1",
                "rpc_transport": "stdio"
            },
            "runtime": { "codex_rs_version": "0.155.1", "runtime_os": "linux", "runtime_arch": "aarch64" }
        }}]});
        assert!(rewrite_analytics_events(&mut body, &identity()));
        let params = &body["events"][0]["event_params"];
        assert_eq!(params["app_server_client"]["client_name"], "Codex Desktop");
        assert_eq!(params["app_server_client"]["client_version"], "26.915.1");
        assert_eq!(params["app_server_client"]["rpc_transport"], "stdio");
        assert_eq!(params["runtime"]["codex_rs_version"], "0.156.0");
        assert_eq!(params["runtime"]["runtime_os"], "linux");
        assert_eq!(params["runtime"]["runtime_arch"], "x86_64");
    }

    #[test]
    fn mcp_initialize_reports_the_presented_version() {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "clientInfo": { "name": "codex-mcp-client", "title": "Codex", "version": "0.155.1" }
            }
        });
        // Only the presented version matters to the handshake.
        let request = http::Request::builder()
            .uri("/backend-api/ps/mcp")
            .body(axum::body::Body::empty())
            .unwrap();
        let mut ctx = RequestContext::new(&request);
        ctx.upstream_client_version = Some("0.156.0".into());
        let rewritten = rewrite_request_body(
            &ctx,
            &json_headers(None),
            Bytes::from(serde_json::to_vec(&body).unwrap()),
        );
        let rewritten: Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(rewritten["params"]["clientInfo"]["version"], "0.156.0");
        assert_eq!(
            rewritten["params"]["clientInfo"]["name"],
            "codex-mcp-client"
        );

        let mut call = json!({ "jsonrpc": "2.0", "method": "tools/list", "params": {} });
        assert!(!rewrite_mcp_initialize(&mut call, "0.156.0"));
    }

    #[test]
    fn only_response_create_frames_are_rewritten() {
        let id = identity();
        let mut create = body_with_identity();
        create["type"] = json!("response.create");
        let rewritten = rewrite_ws_client_text(&create.to_string(), &id).unwrap();
        let rewritten: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            rewritten["client_metadata"]["x-codex-installation-id"],
            INSTALL
        );

        let mut other = body_with_identity();
        other["type"] = json!("response.cancel");
        assert!(rewrite_ws_client_text(&other.to_string(), &id).is_none());
        assert!(rewrite_ws_client_text("not json", &id).is_none());
    }

    #[test]
    fn client_version_query_is_replaced_in_place() {
        assert_eq!(
            rewrite_client_version_query("client_version=0.1.0", "0.154.0"),
            "client_version=0.154.0"
        );
        assert_eq!(
            rewrite_client_version_query("a=1&client_version=0.1.0&b=x%20y", "0.154.0"),
            "a=1&client_version=0.154.0&b=x%20y"
        );
        assert_eq!(rewrite_client_version_query("a=1", "0.154.0"), "a=1");
    }

    /// A Responses input carrying the environment context, as Codex renders
    /// it inside a user message.
    fn body_with_environment(timezone: &str, date: &str) -> Value {
        let context = format!(
            "\n  <cwd>/home/alice/repo</cwd>\n  <shell>zsh</shell>\n  \
             <current_date>{date}</current_date>\n  <timezone>{timezone}</timezone>\n"
        );
        json!({
            "model": "gpt-5.4",
            "input": [
                { "type": "message", "role": "user", "content": [
                    { "type": "input_text", "text": "hello" }
                ]},
                { "type": "message", "role": "user", "content": [
                    { "type": "input_text",
                      "text": format!("<environment_context>{context}</environment_context>") }
                ]}
            ]
        })
    }

    #[test]
    fn environment_context_location_becomes_the_gateways() {
        let mut body = body_with_environment("Asia/Shanghai", "2026-01-01");
        assert!(rewrite_environment_context(&mut body, &identity()));
        let text = body["input"][1]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("<timezone>America/New_York</timezone>"),
            "{text}"
        );
        assert!(
            text.contains("<current_date>2026-09-19</current_date>"),
            "{text}"
        );
        // The rest of the context, including the user's paths, is untouched.
        assert!(text.contains("<cwd>/home/alice/repo</cwd>"));
        assert!(text.contains("<shell>zsh</shell>"));
        assert!(!text.contains("Asia/Shanghai"));
        // Ordinary input text without the block is never touched.
        assert_eq!(body["input"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn environment_context_with_matching_values_is_left_alone() {
        let mut body = body_with_environment("America/New_York", "2026-09-19");
        assert!(!rewrite_environment_context(&mut body, &identity()));
    }

    #[test]
    fn responses_body_rewrites_both_identity_and_location() {
        let mut body = body_with_environment("Europe/Paris", "2026-01-01");
        body["client_metadata"] = json!({
            "x-codex-installation-id": "client-install"
        });
        let rewritten = rewrite_request_body(
            &routed(RESPONSES),
            &json_headers(None),
            Bytes::from(serde_json::to_vec(&body).unwrap()),
        );
        let rewritten: Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(
            rewritten["client_metadata"]["x-codex-installation-id"],
            INSTALL
        );
        let text = rewritten["input"][1]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("<timezone>America/New_York</timezone>"));
        assert!(!text.contains("Europe/Paris"));
    }

    fn swap() -> IdentitySwap {
        IdentitySwap::new(&[
            ("user-UPSTREAM".into(), "user-client".into()),
            ("acct-upstream".into(), "acct-client".into()),
            ("owner@x.com".into(), "alice@example.com".into()),
            ("same".into(), "same".into()),
        ])
    }

    #[test]
    fn identity_swap_rewrites_whole_messages() {
        // Shapes captured from chatgpt.com.
        let usage = r#"{"user_id":"user-UPSTREAM","account_id":"acct-upstream","email":"owner@x.com","plan_type":"plus"}"#;
        assert_eq!(
            swap().swap_text(usage).unwrap(),
            r#"{"user_id":"user-client","account_id":"acct-client","email":"alice@example.com","plan_type":"plus"}"#
        );
        let created =
            r#"{"type":"response.created","response":{"safety_identifier":"user-UPSTREAM"}}"#;
        assert_eq!(
            swap().swap_text(created).unwrap(),
            r#"{"type":"response.created","response":{"safety_identifier":"user-client"}}"#
        );
        assert!(
            swap()
                .swap_text(r#"{"type":"response.output_text.delta"}"#)
                .is_none()
        );
        assert!(IdentitySwap::new(&[]).swap_text("user-UPSTREAM").is_none());
    }

    #[test]
    fn identity_swap_handles_values_split_across_chunks() {
        let stream = "data: {\"safety_identifier\":\"user-UPSTREAM\"}\n\ndata: {\"email\":\"owner@x.com\"}\n\n";
        let expected = stream
            .replace("user-UPSTREAM", "user-client")
            .replace("owner@x.com", "alice@example.com");
        // Every split point, in chunks of every size.
        for size in 1..=stream.len() {
            let mut swap = swap();
            let mut out = Vec::new();
            for chunk in stream.as_bytes().chunks(size) {
                out.extend(swap.push(chunk));
            }
            out.extend(swap.finish());
            assert_eq!(
                String::from_utf8(out).unwrap(),
                expected,
                "chunk size {size}"
            );
        }
    }

    #[test]
    fn profile_stats_are_the_clients_own_usage() {
        let day = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
        let usage = crate::db::logs::ProfileUsage {
            daily_tokens: vec![
                (day("2026-09-01"), 10), // Tuesday
                (day("2026-09-02"), 20),
                (day("2026-09-03"), 30),
                (day("2026-09-08"), 5), // the next Tuesday
                (day("2026-09-26"), 7),
                (day("2026-09-27"), 3),
            ],
            longest_latency_ms: 61_999,
            responses: 8,
            priority_responses: 2,
        };
        let stats = profile_stats(&usage, day("2026-09-27"));
        assert_eq!(stats["lifetime_tokens"], 75);
        assert_eq!(stats["peak_daily_tokens"], 30);
        assert_eq!(stats["longest_streak_days"], 3);
        assert_eq!(stats["current_streak_days"], 2);
        assert_eq!(stats["longest_running_turn_sec"], 61);
        assert_eq!(stats["fast_mode_usage_percentage"], 25.0);
        assert_eq!(
            stats["weekly_usage_buckets"],
            json!([
                { "start_date": "2026-08-31", "tokens": 60 },
                { "start_date": "2026-09-07", "tokens": 5 },
                { "start_date": "2026-09-21", "tokens": 10 }
            ])
        );
        assert_eq!(stats["cumulative_daily_usage_buckets"][5]["tokens"], 75);
        assert_eq!(
            stats["daily_usage_buckets"][3],
            json!({ "start_date": "2026-09-08", "tokens": 5 })
        );
        // A streak that ended before yesterday is over.
        let stats = profile_stats(&usage, day("2026-09-29"));
        assert_eq!(stats["current_streak_days"], 0);
        // No usage at all: a fresh account.
        let empty = profile_stats(&Default::default(), day("2026-09-29"));
        assert_eq!(empty["lifetime_tokens"], 0);
        assert_eq!(empty["daily_usage_buckets"], json!([]));
    }

    #[test]
    fn identity_swap_escapes_client_values_for_json() {
        let swap = IdentitySwap::new(&[("owner@x.com".into(), "a\"b@x.com".into())]);
        assert_eq!(
            swap.swap_text(r#"{"email":"owner@x.com"}"#).unwrap(),
            r#"{"email":"a\"b@x.com"}"#
        );
    }
}
