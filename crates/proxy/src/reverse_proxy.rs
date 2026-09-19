use axum::body::Body;
use axum::http::header::{HOST, HeaderValue};
use axum::http::{HeaderMap, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use reqwest::Client;
use tracing::{debug, error};
use url::Url;

/// Reverse proxy for directing management/auth/portal traffic to Node.js backend.
#[derive(Clone)]
pub struct NodeReverseProxy {
    client: Client,
    node_backend_url: String,
}

impl NodeReverseProxy {
    pub fn new(node_backend_url: String) -> Self {
        let client = Client::builder()
            .build()
            .expect("Failed to build reqwest client for reverse proxy");

        Self {
            client,
            node_backend_url,
        }
    }

    pub async fn handle_request(&self, req: Request<Body>) -> Response {
        let path = req.uri().path();
        let query = req
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        let target_url_str = format!("{}{path}{query}", self.node_backend_url);

        let target_url = match Url::parse(&target_url_str) {
            Ok(u) => u,
            Err(e) => {
                error!("Invalid reverse proxy URL '{target_url_str}': {e}");
                return (StatusCode::BAD_REQUEST, "Invalid URL").into_response();
            }
        };

        let (parts, body) = req.into_parts();
        let mut forward_headers = HeaderMap::new();

        for (name, val) in &parts.headers {
            let lower = name.as_str().to_ascii_lowercase();
            if is_hop_by_hop_header(&lower) {
                continue;
            }
            forward_headers.insert(name.clone(), val.clone());
        }

        if let Some(host) = target_url.host_str() {
            let port_str = target_url
                .port()
                .map(|p| format!(":{p}"))
                .unwrap_or_default();
            let host_header = format!("{host}{port_str}");
            if let Ok(hv) = HeaderValue::from_str(&host_header) {
                forward_headers.insert(HOST, hv);
            }
        }

        let stream = body.into_data_stream();
        let reqwest_body = reqwest::Body::wrap_stream(stream);

        debug!(target = %target_url_str, "Reverse proxying to Node.js");

        let node_res = self
            .client
            .request(parts.method, target_url)
            .headers(forward_headers)
            .body(reqwest_body)
            .send()
            .await;

        let node_resp = match node_res {
            Ok(resp) => resp,
            Err(err) => {
                error!("Node backend connection error: {err}");
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to connect to Node.js backend: {err}"),
                )
                    .into_response();
            }
        };

        let status = StatusCode::from_u16(node_resp.status().as_u16())
            .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);

        let mut client_resp_headers = HeaderMap::new();
        for (name, val) in node_resp.headers() {
            let lower = name.as_str().to_ascii_lowercase();
            if is_hop_by_hop_header(&lower) {
                continue;
            }
            client_resp_headers.insert(name.clone(), val.clone());
        }

        let client_body = Body::from_stream(node_resp.bytes_stream());
        let mut response = Response::new(client_body);
        *response.status_mut() = status;
        *response.headers_mut() = client_resp_headers;

        response
    }
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "trailer"
    )
}
