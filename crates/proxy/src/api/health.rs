use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::AppState;
use crate::runtime::NotReady;

pub fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

async fn health(State(state): State<AppState>) -> Response {
    match state.runtime.ready().await {
        Ok(ready) => {
            let settlement = ready.settlements.health().await;
            let ok = settlement["acceptingRequests"].as_bool().unwrap_or(false);
            let status = if ok {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            (status, Json(json!({ "ok": ok, "settlement": settlement }))).into_response()
        }
        Err(NotReady::SetupRequired) => {
            Json(json!({ "ok": true, "ready": false, "setupRequired": true })).into_response()
        }
        Err(NotReady::Database(error)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": error.to_string() })),
        )
            .into_response(),
    }
}
