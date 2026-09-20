//! Serves the client install scripts with this gateway's URL baked in, so a
//! user only has to run `curl -fsSL https://<gateway>/install.sh | sh`.

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;

use crate::AppState;
use crate::api::{api_error, no_store};

const INSTALL_SH: &str = include_str!("../../../../scripts/install.sh");
const INSTALL_PS1: &str = include_str!("../../../../scripts/install.ps1");

/// The line each script reserves for the gateway to fill in.
const SH_PLACEHOLDER: &str = "GATEWAY_DEFAULT=\"\"";
const PS1_PLACEHOLDER: &str = "$GatewayUrlDefault = \"\"";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/install.sh", get(install_sh))
        .route("/install.ps1", get(install_ps1))
}

async fn install_sh(State(state): State<AppState>, headers: HeaderMap) -> Response {
    render(
        &state,
        &headers,
        INSTALL_SH,
        SH_PLACEHOLDER,
        |origin| format!("GATEWAY_DEFAULT=\"{origin}\""),
        "text/x-shellscript; charset=utf-8",
    )
}

async fn install_ps1(State(state): State<AppState>, headers: HeaderMap) -> Response {
    render(
        &state,
        &headers,
        INSTALL_PS1,
        PS1_PLACEHOLDER,
        |origin| format!("$GatewayUrlDefault = \"{origin}\""),
        "text/plain; charset=utf-8",
    )
}

fn render(
    state: &AppState,
    headers: &HeaderMap,
    script: &str,
    placeholder: &str,
    line: impl Fn(&str) -> String,
    content_type: &'static str,
) -> Response {
    let Some(origin) = gateway_origin(state.public_gateway_url.as_deref(), headers) else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "unknown_gateway_url",
            "Could not determine this gateway's public URL; pass it to the script instead",
        );
    };
    let body = script.replacen(placeholder, &line(&origin), 1);
    no_store(([(header::CONTENT_TYPE, content_type)], body).into_response())
}

/// The origin a client should point Codex at: the configured public URL when
/// there is one, otherwise the host this very request came in on.
fn gateway_origin(configured: Option<&str>, headers: &HeaderMap) -> Option<String> {
    if let Some(configured) = configured {
        return Some(configured.to_string());
    }
    let host = headers.get(header::HOST)?.to_str().ok()?;
    // The host lands inside a double-quoted shell string, so anything that is
    // not a plain authority is refused rather than escaped.
    if host.is_empty() || host.len() > 255 || !host.chars().all(is_authority_char) {
        return None;
    }
    Some(format!("{}://{host}", forwarded_scheme(headers)))
}

fn is_authority_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')
}

/// TLS is usually terminated by a reverse proxy, which says so in this header.
fn forwarded_scheme(headers: &HeaderMap) -> &'static str {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .unwrap_or_default();
    if proto.eq_ignore_ascii_case("https") {
        "https"
    } else {
        "http"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        headers
    }

    #[test]
    fn placeholders_exist_in_the_scripts() {
        assert_eq!(INSTALL_SH.matches(SH_PLACEHOLDER).count(), 1);
        assert_eq!(INSTALL_PS1.matches(PS1_PLACEHOLDER).count(), 1);
    }

    #[test]
    fn configured_url_wins_over_the_host_header() {
        let origin = gateway_origin(
            Some("https://api.cocodex.app"),
            &headers(&[("host", "10.0.0.5:53141")]),
        );
        assert_eq!(origin.as_deref(), Some("https://api.cocodex.app"));
    }

    #[test]
    fn host_header_supplies_the_origin() {
        assert_eq!(
            gateway_origin(None, &headers(&[("host", "gw.example.com:53141")])).as_deref(),
            Some("http://gw.example.com:53141")
        );
        assert_eq!(
            gateway_origin(
                None,
                &headers(&[("host", "gw.example.com"), ("x-forwarded-proto", "https")])
            )
            .as_deref(),
            Some("https://gw.example.com")
        );
    }

    #[test]
    fn a_host_that_is_not_a_plain_authority_is_refused() {
        assert!(gateway_origin(None, &headers(&[("host", "a\"; rm -rf /")])).is_none());
        assert!(gateway_origin(None, &headers(&[("host", "a$(id)b")])).is_none());
        assert!(gateway_origin(None, &headers(&[])).is_none());
    }
}
