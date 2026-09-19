use clap::Parser;
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
}

#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub bind_addr: SocketAddr,
    pub node_backend_url: String,
    pub upstream_chatgpt_origin: String,
    pub ipc_socket_path: String,
    pub public_app_url: String,
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

        Ok(Self {
            bind_addr,
            node_backend_url,
            upstream_chatgpt_origin,
            ipc_socket_path,
            public_app_url,
        })
    }
}
