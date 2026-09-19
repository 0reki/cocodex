use clap::Parser;

use crate::runtime::Settings;
use std::net::SocketAddr;

#[derive(Debug, Clone, Parser)]
#[command(
    name = "cocodex-proxy",
    about = "High-performance Codex subscription proxy"
)]
pub struct ProxyArgs {
    /// Host to bind on
    #[arg(long, env = "HOST", default_value = "0.0.0.0")]
    pub host: String,

    /// Port to bind on
    #[arg(long, env = "PROXY_PORT", default_value = "53141")]
    pub port: u16,

    /// Upstream Node.js management server URL
    #[arg(
        long,
        env = "NODE_BACKEND_URL",
        default_value = "http://127.0.0.1:53142"
    )]
    pub node_backend_url: String,

    /// Target ChatGPT upstream origin
    #[arg(long, env = "CHATGPT_ORIGIN", default_value = "https://chatgpt.com")]
    pub upstream_chatgpt_origin: String,

    /// Unix Domain Socket path for IPC with Node.js backend
    #[arg(
        long,
        env = "COCODEX_IPC_SOCKET_PATH",
        default_value = "./data/cocodex-ipc.sock"
    )]
    pub ipc_socket_path: String,

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
    pub node_backend_url: String,
    pub upstream_chatgpt_origin: String,
    pub ipc_socket_path: String,
    pub public_app_url: String,
    pub settings: Settings,
}

impl ProxyConfig {
    pub fn from_args(args: ProxyArgs) -> Result<Self, String> {
        let addr_str = format!("{}:{}", args.host, args.port);
        let bind_addr: SocketAddr = addr_str
            .parse()
            .map_err(|e| format!("Invalid bind address '{addr_str}': {e}"))?;

        let node_backend_url = args.node_backend_url.trim_end_matches('/').to_string();
        let upstream_chatgpt_origin = args
            .upstream_chatgpt_origin
            .trim_end_matches('/')
            .to_string();
        let ipc_socket_path = args.ipc_socket_path;
        let public_app_url = args.public_app_url.trim_end_matches('/').to_string();
        let settings = Settings {
            database_url: args.database_url,
            admin_jwt_secret: args.admin_jwt_secret,
            client_jwt_secret: args.client_jwt_secret,
            config_path: args.config_path,
        };

        Ok(Self {
            bind_addr,
            node_backend_url,
            upstream_chatgpt_origin,
            ipc_socket_path,
            public_app_url,
            settings,
        })
    }
}
