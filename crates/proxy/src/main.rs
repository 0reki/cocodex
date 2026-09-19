use clap::Parser;
use cocodex_proxy::config::{ProxyArgs, ProxyConfig};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same precedence as the Node backend: real environment, then
    // `.env.local`, then `.env`. Loaded before any thread is spawned.
    for file in [".env.local", ".env"] {
        let _ = dotenvy::from_filename(file);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(serve())
}

async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing subscriber with RUST_LOG support (default info)
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cocodex=info,cocodex_proxy=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args = ProxyArgs::parse();
    let config = ProxyConfig::from_args(args)?;

    info!(
        bind_addr = %config.bind_addr,
        upstream_chatgpt_origin = %config.upstream_chatgpt_origin,
        "Starting cocodex server"
    );

    let (app, runtime) = cocodex_proxy::build(config.clone(), None);

    let listener = TcpListener::bind(config.bind_addr).await?;
    info!("Listening on http://{}", config.bind_addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("flushing pending settlements");
    runtime.shutdown().await;
    info!("cocodex shut down gracefully");
    Ok(())
}

/// Ctrl-C, or SIGTERM from docker/systemd.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("Shutdown signal received, draining connections...");
}
