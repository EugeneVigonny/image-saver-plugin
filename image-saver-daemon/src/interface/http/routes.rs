use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, put},
};
use tokio::sync::RwLock;
use tracing::{error, info};

use crate::application::{
    commands::set_save_directory::{SetSaveDirectoryError, set_save_directory},
    dto::{ErrorResponse, ImageExistsResponse, SetSaveDirectoryRequest, SetSaveDirectoryResponse},
    queries::health::{HealthResponse, health_response},
    queries::image_exists::{ImageExistsError, image_exists},
};

#[derive(Debug, Clone)]
pub struct AppState {
    pub save_directory: Arc<RwLock<Option<PathBuf>>>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health_handler))
        .route("/v1/images/exists", get(image_exists_handler))
        .route("/v1/save-directory", put(set_save_directory_handler))
        .with_state(state)
}

async fn health_handler() -> Json<HealthResponse> {
    info!(
        endpoint = "/v1/health",
        method = "GET",
        "health endpoint called"
    );
    Json(health_response())
}

async fn set_save_directory_handler(
    State(state): State<AppState>,
    Json(request): Json<SetSaveDirectoryRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/save-directory",
        method = "PUT",
        "set save directory called"
    );

    match set_save_directory(&request.path) {
        Ok(path) => {
            let mut write_guard = state.save_directory.write().await;
            *write_guard = Some(path.clone());

            let response = SetSaveDirectoryResponse {
                ok: true,
                path: path.to_string_lossy().into_owned(),
            };
            match serde_json::to_value(response) {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(error) => {
                    error!(%error, "failed to serialize success response");
                    let fail = ErrorResponse::new("E_IO", "response serialization failed");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::to_value(fail).unwrap_or_else(|_| {
                            serde_json::json!({"ok": false, "code": "E_IO", "error": "internal error"})
                        })),
                    )
                }
            }
        }
        Err(SetSaveDirectoryError::InvalidInput(message)) => {
            info!(reason = %message, "save directory validation failed");
            let response = ErrorResponse::new("E_INVALID_INPUT", message);
            (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
        }
        Err(SetSaveDirectoryError::Io(message)) => {
            error!(reason = %message, "save directory io validation failed");
            let response = ErrorResponse::new("E_IO", message);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(response)),
            )
        }
    }
}

#[derive(Debug, serde::Deserialize)]
struct ImageExistsQuery {
    file_name: String,
}

async fn image_exists_handler(
    State(state): State<AppState>,
    Query(query): Query<ImageExistsQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images/exists",
        method = "GET",
        "image exists check called"
    );

    let save_dir = {
        let save_dir_guard = state.save_directory.read().await;
        save_dir_guard.clone()
    };
    match image_exists(save_dir.as_deref(), &query.file_name) {
        Ok(exists) => {
            let response = ImageExistsResponse { ok: true, exists };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(ImageExistsError::NotConfigured) => {
            let response =
                ErrorResponse::new("E_NOT_CONFIGURED", "save directory is not configured");
            (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
        }
        Err(ImageExistsError::InvalidInput(message)) => {
            let response = ErrorResponse::new("E_INVALID_INPUT", message);
            (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
        }
        Err(ImageExistsError::Io(message)) => {
            error!(reason = %message, "image exists io check failed");
            let response = ErrorResponse::new("E_IO", message);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!(response)),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tokio::sync::RwLock;
    use tower::ServiceExt as _;

    use super::{AppState, build_router};

    #[tokio::test]
    async fn health_endpoint_returns_expected_contract() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });

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

    #[tokio::test]
    async fn set_save_directory_returns_200_for_valid_path() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });
        let valid_path = std::env::temp_dir().to_string_lossy().into_owned();
        let body = serde_json::json!({ "path": valid_path }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/save-directory")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn set_save_directory_returns_400_for_relative_path() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });
        let body = serde_json::json!({ "path": "relative/path" }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/save-directory")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("response must be valid json");
        assert_eq!(
            json.get("code").and_then(serde_json::Value::as_str),
            Some("E_INVALID_INPUT")
        );
    }

    #[tokio::test]
    async fn set_save_directory_persists_path_in_state() {
        let state = AppState {
            save_directory: Arc::new(RwLock::new(None)),
        };
        let app = build_router(state.clone());
        let expected = std::env::temp_dir();
        let body = serde_json::json!({ "path": expected.to_string_lossy() }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/v1/save-directory")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::OK);

        let guard = state.save_directory.read().await;
        assert_eq!(guard.clone(), Some(expected));
    }

    #[tokio::test]
    async fn image_exists_returns_not_configured_when_directory_is_missing() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/exists?file_name=test.jpg")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("response must be valid json");
        assert_eq!(
            json.get("code").and_then(serde_json::Value::as_str),
            Some("E_NOT_CONFIGURED")
        );
    }

    #[tokio::test]
    async fn image_exists_returns_false_for_missing_file() {
        let state = AppState {
            save_directory: Arc::new(RwLock::new(Some(std::env::temp_dir()))),
        };
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/exists?file_name=missing_router_test_file.jpg")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("response must be valid json");
        assert_eq!(
            json.get("exists").and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[tokio::test]
    async fn image_exists_returns_invalid_input_for_bad_filename() {
        let state = AppState {
            save_directory: Arc::new(RwLock::new(Some(std::env::temp_dir()))),
        };
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/exists?file_name=..%2Fhack.jpg")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("response must be valid json");
        assert_eq!(
            json.get("code").and_then(serde_json::Value::as_str),
            Some("E_INVALID_INPUT")
        );
    }
}
