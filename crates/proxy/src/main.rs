use clap::Parser;
use cocodex_proxy::config::{ProxyArgs, ProxyConfig};
use cocodex_proxy::create_router;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing subscriber with RUST_LOG support (default info)
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cocodex_proxy=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args = ProxyArgs::parse();
    let config = ProxyConfig::from_args(args)?;

    info!(
        bind_addr = %config.bind_addr,
        node_backend_url = %config.node_backend_url,
        upstream_chatgpt_origin = %config.upstream_chatgpt_origin,
        "Starting cocodex-proxy server"
    );

    let app = create_router(config.clone(), None);

    let listener = TcpListener::bind(config.bind_addr).await?;
    info!("Listening on http://{}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("cocodex-proxy shut down gracefully");
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("Shutdown signal received, draining connections...");
}
