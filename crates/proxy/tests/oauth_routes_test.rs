mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use cocodex_proxy::create_router;
use tower::ServiceExt;

/// These checks run before the gateway touches its database, so none is set up.
fn router() -> axum::Router {
    common::pin_codex_version();
    let mut config = common::config(common::offline_settings(), "http://127.0.0.1:1");
    config.public_app_url = "https://console.example.com".to_string();
    create_router(config, None)
}

async fn send(request: Request<Body>) -> (StatusCode, Option<String>, String) {
    let response = router().oneshot(request).await.unwrap();
    let status = response.status();
    let location = response
        .headers()
        .get(header::LOCATION)
        .map(|value| value.to_str().unwrap().to_string());
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, location, String::from_utf8(body.to_vec()).unwrap())
}

async fn authorize(query: &str) -> (StatusCode, Option<String>, String) {
    send(
        Request::builder()
            .uri(format!("/oauth/authorize?{query}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

fn query_param(url: &str, name: &str) -> Option<String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The URL the Codex desktop app's core builds, including parameters the
/// gateway has never heard of.
const DESKTOP_QUERY: &str = "response_type=code\
    &client_id=app_EMoamEEZ73f0CkXaXp7hrann\
    &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback\
    &scope=openid%20profile%20email%20offline_access%20api.connectors.read%20api.connectors.invoke\
    &code_challenge=uU_wRrrQmSBiup1F9u12zlDJ0Ai0ppaL7UQWT8jg25E\
    &code_challenge_method=S256\
    &id_token_add_organizations=true\
    &codex_cli_simplified_flow=true\
    &state=zUF1c-MYgdK5pgqRR04IXfevDWQbRfWp2DVC86LSlGU\
    &originator=Codex%20Desktop\
    &codex_app_version=26.915.4065\
    &codex_streamlined_login=true";

#[tokio::test]
async fn desktop_authorize_request_reaches_the_console_consent_page() {
    let (status, location, _) = authorize(DESKTOP_QUERY).await;

    assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
    let location = location.unwrap();
    assert!(location.starts_with("https://console.example.com/login?next="));
    let next = query_param(&location, "next").unwrap();
    assert_eq!(next, format!("/oauth/complete?{DESKTOP_QUERY}"));
}

#[tokio::test]
async fn fallback_callback_port_is_accepted() {
    let query = DESKTOP_QUERY.replace("localhost%3A1455", "localhost%3A1457");
    let (status, _, _) = authorize(&query).await;
    assert_eq!(status, StatusCode::TEMPORARY_REDIRECT);
}

#[tokio::test]
async fn foreign_redirect_uri_is_refused_without_redirecting() {
    let query = DESKTOP_QUERY.replace(
        "http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
        "https%3A%2F%2Fevil.example%2Fauth%2Fcallback",
    );
    let (status, location, body) = authorize(&query).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(location.is_none());
    assert!(body.contains("redirect_uri"));
}

#[tokio::test]
async fn missing_pkce_is_reported_back_to_the_callback() {
    let query = DESKTOP_QUERY.replace("&code_challenge_method=S256", "");
    let (status, location, _) = authorize(&query).await;

    assert_eq!(status, StatusCode::SEE_OTHER);
    let location = location.unwrap();
    assert!(location.starts_with("http://localhost:1455/auth/callback?"));
    assert_eq!(query_param(&location, "error").unwrap(), "invalid_request");
    assert_eq!(
        query_param(&location, "state").unwrap(),
        "zUF1c-MYgdK5pgqRR04IXfevDWQbRfWp2DVC86LSlGU"
    );
}

#[tokio::test]
async fn non_code_response_type_is_reported_back_to_the_callback() {
    let query = DESKTOP_QUERY.replace("response_type=code", "response_type=token");
    let (_, location, _) = authorize(&query).await;
    assert_eq!(
        query_param(&location.unwrap(), "error").unwrap(),
        "unsupported_response_type"
    );
}

#[tokio::test]
async fn api_key_token_exchange_is_refused_as_unsupported() {
    let (status, _, body) = send(
        Request::builder()
            .method("POST")
            .uri("/oauth/token")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange\
                 &client_id=app_EMoamEEZ73f0CkXaXp7hrann&requested_token=openai-api-key\
                 &subject_token=x&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token",
            ))
            .unwrap(),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("unsupported_grant_type"));
}

#[tokio::test]
async fn revoke_without_a_token_is_a_bad_request() {
    let (status, _, body) = send(
        Request::builder()
            .method("POST")
            .uri("/oauth/revoke")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("token_type_hint=refresh_token"))
            .unwrap(),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("invalid_request"));
}
