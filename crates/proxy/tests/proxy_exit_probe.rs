//! A hands-on look at what the gateway's own client reports for a pool exit.
//!
//! Ignored by default: it dials real proxies and chatgpt.com. Run it against a
//! pool file to see the error each exit produces, with the whole cause chain
//! rather than the single label the probe records.
//!
//!     COCODEX_POOL=/path/to/proxy-pool.txt \
//!     cargo test --test proxy_exit_probe -- --ignored --nocapture

use std::time::Duration;

use cocodex_proxy::turn_state::proxy_pool;
use cocodex_proxy::turn_state::settings::ProxyEndpoint;

fn chain(error: &reqwest::Error) -> String {
    let mut text = format!("{error}");
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(&format!(" | {cause}"));
        source = cause.source();
    }
    let kinds = [
        ("connect", error.is_connect()),
        ("timeout", error.is_timeout()),
        ("request", error.is_request()),
        ("body", error.is_body()),
        ("decode", error.is_decode()),
    ];
    let kinds: Vec<&str> = kinds
        .iter()
        .filter(|(_, yes)| *yes)
        .map(|(name, _)| *name)
        .collect();
    format!("[{}] {text}", kinds.join(","))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "dials real proxies"]
async fn what_each_exit_reports() {
    let path = std::env::var("COCODEX_POOL").expect("set COCODEX_POOL to a pool file");
    let take: usize = std::env::var("COCODEX_POOL_TAKE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8);
    let endpoint = ProxyEndpoint {
        url_file: path,
        ..ProxyEndpoint::default()
    };
    let exits = proxy_pool::resolve_all(&endpoint).expect("pool file");
    println!("pool holds {} exits", exits.len());

    // One at a time: this is a diagnostic, not a load test.
    for exit in exits.iter().take(take) {
        let client =
            match proxy_pool::client(Some(exit), Duration::from_secs(20), Duration::from_secs(5)) {
                Ok(client) => client,
                Err(error) => {
                    println!("{exit}\n    client: {error}");
                    continue;
                }
            };
        let result = client.get("https://chatgpt.com/robots.txt").send().await;
        match result {
            Ok(response) => println!("{exit}\n    HTTP {}", response.status()),
            Err(error) => println!("{exit}\n    {}", chain(&error)),
        }
    }
}
