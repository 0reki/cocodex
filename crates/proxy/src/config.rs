use clap::Parser;

use crate::runtime::Settings;
use std::net::SocketAddr;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "cocodex",
    about = "Codex subscription gateway and console backend"
)]
pub struct ProxyArgs {
    /// Host to bind on
    #[arg(long, env = "HOST", default_value = "0.0.0.0")]
    pub host: String,

    /// Port to bind on (`PROXY_PORT` is accepted as a legacy name)
    #[arg(long, env = "PORT")]
    pub port: Option<u16>,

    /// Target ChatGPT upstream origin
    #[arg(long, env = "CHATGPT_ORIGIN", default_value = "https://chatgpt.com")]
    pub upstream_chatgpt_origin: String,

    /// OpenAI auth origin used for upstream logins and token refresh
    #[arg(
        long,
        env = "OPENAI_AUTH_ORIGIN",
        default_value = "https://auth.openai.com"
    )]
    pub upstream_auth_origin: String,

    /// Public frontend application URL for OAuth redirects
    #[arg(long, env = "PUBLIC_APP_URL", default_value = "http://localhost:53332")]
    pub public_app_url: String,

    /// Postgres URL; falls back to the Setup config file
    #[arg(long, env = "DATABASE_URL", hide_env_values = true)]
    pub database_url: Option<String>,

    /// Portal JWT secret; falls back to the Setup config file
    #[arg(long, env = "ADMIN_JWT_SECRET", hide_env_values = true)]
    pub admin_jwt_secret: Option<String>,

    /// Codex client JWT secret; defaults to the portal secret
    #[arg(long, env = "CODEX_CLIENT_JWT_SECRET", hide_env_values = true)]
    pub client_jwt_secret: Option<String>,

    /// Setup config file written by the first-run wizard
    #[arg(
        long,
        env = "COCODEX_CONFIG_PATH",
        default_value = "./data/config.json"
    )]
    pub config_path: std::path::PathBuf,
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub bind_addr: SocketAddr,
    pub upstream_chatgpt_origin: String,
    pub upstream_auth_origin: String,
    pub public_app_url: String,
    pub settings: Settings,
}

impl ProxyConfig {
    pub fn from_args(args: ProxyArgs) -> Result<Self, String> {
        let port = match args.port {
            Some(port) => port,
            None => match std::env::var("PROXY_PORT") {
                Ok(value) => value
                    .trim()
                    .parse()
                    .map_err(|e| format!("Invalid PROXY_PORT '{value}': {e}"))?,
                Err(_) => 53141,
            },
        };
        let addr_str = format!("{}:{port}", args.host);
        let bind_addr: SocketAddr = addr_str
            .parse()
            .map_err(|e| format!("Invalid bind address '{addr_str}': {e}"))?;

        // Fail at startup rather than on the first request.
        crate::billing::pricing::Pricing::from_env()?;
        crate::upstream::identity::VersionResolver::from_env(reqwest::Client::new())?;

        Ok(Self {
            bind_addr,
            upstream_chatgpt_origin: args
                .upstream_chatgpt_origin
                .trim_end_matches('/')
                .to_string(),
            upstream_auth_origin: args.upstream_auth_origin.trim_end_matches('/').to_string(),
            public_app_url: args.public_app_url.trim_end_matches('/').to_string(),
            settings: Settings {
                database_url: args.database_url,
                admin_jwt_secret: args.admin_jwt_secret,
                client_jwt_secret: args.client_jwt_secret,
                config_path: args.config_path,
            },
        })
    }
}
