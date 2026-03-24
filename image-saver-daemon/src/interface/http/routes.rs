use axum::{Json, Router, routing::get};
use tracing::info;

use crate::application::queries::health::{HealthResponse, health_response};

pub fn build_router() -> Router {
    Router::new().route("/v1/health", get(health_handler))
}

async fn health_handler() -> Json<HealthResponse> {
    info!(
        endpoint = "/v1/health",
        method = "GET",
        "health endpoint called"
    );
    Json(health_response())
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt as _;

    use super::build_router;

    #[tokio::test]
    async fn health_endpoint_returns_expected_contract() {
        let app = build_router();

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/health")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), 200);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&body).expect("health response must be valid json");

        assert_eq!(
            json.get("ok").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            json.get("protocol").and_then(serde_json::Value::as_u64),
            Some(1)
        );

        let version_is_non_empty = json
            .get("version")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty());
        assert!(version_is_non_empty);
    }
}
