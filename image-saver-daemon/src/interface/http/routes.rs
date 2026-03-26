use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Query, State, multipart::MultipartRejection},
    http::StatusCode,
    routing::{get, post, put},
};
use tokio::sync::RwLock;
use tracing::{error, info};

use crate::application::{
    commands::save_image::{SaveImageError, save_image},
    commands::set_save_directory::{SetSaveDirectoryError, set_save_directory},
    dto::{
        ErrorResponse, ImageExistsResponse, SaveImageResponse, SetSaveDirectoryRequest,
        SetSaveDirectoryResponse, UploadMeta,
    },
    queries::health::{HealthResponse, health_response},
    queries::image_exists::{ImageExistsError, image_exists},
};

const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AppState {
    pub save_directory: Arc<RwLock<Option<PathBuf>>>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/health", get(health_handler))
        .route("/v1/images/exists", get(image_exists_handler))
        .route("/v1/images", post(save_image_handler))
        .route("/v1/save-directory", put(set_save_directory_handler))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
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

async fn save_image_handler(
    State(state): State<AppState>,
    multipart: Result<Multipart, MultipartRejection>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images",
        method = "POST",
        "save image called"
    );

    let mut multipart = match multipart {
        Ok(row) => row,
        Err(rejection) => {
            if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                let response = ErrorResponse::new("E_PAYLOAD_TOO_LARGE", "payload is too large");
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(serde_json::json!(response)),
                );
            }
            let response = ErrorResponse::new("E_INVALID_INPUT", "invalid multipart payload");
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)));
        }
    };

    let mut upload_meta: Option<UploadMeta> = None;
    let mut file_bytes: Option<Vec<u8>> = None;

    loop {
        let next_field = multipart.next_field().await;
        let maybe_field = match next_field {
            Ok(row) => row,
            Err(error) => {
                let status = if error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("body too large")
                {
                    StatusCode::PAYLOAD_TOO_LARGE
                } else {
                    StatusCode::BAD_REQUEST
                };
                let code = if status == StatusCode::PAYLOAD_TOO_LARGE {
                    "E_PAYLOAD_TOO_LARGE"
                } else {
                    "E_INVALID_INPUT"
                };
                let response = ErrorResponse::new(code, error.to_string());
                return (status, Json(serde_json::json!(response)));
            }
        };

        let Some(field) = maybe_field else {
            break;
        };
        let name = field.name().unwrap_or_default().to_string();

        if name == "meta" {
            let text = match field.text().await {
                Ok(row) => row,
                Err(error) => {
                    let response = ErrorResponse::new("E_INVALID_INPUT", error.to_string());
                    return (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)));
                }
            };
            let parsed: Result<UploadMeta, _> = serde_json::from_str(&text);
            match parsed {
                Ok(row) => upload_meta = Some(row),
                Err(error) => {
                    let response = ErrorResponse::new("E_INVALID_INPUT", error.to_string());
                    return (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)));
                }
            }
            continue;
        }

        if name == "file" {
            match field.bytes().await {
                Ok(row) => file_bytes = Some(row.to_vec()),
                Err(error) => {
                    let status = if error
                        .to_string()
                        .to_ascii_lowercase()
                        .contains("body too large")
                    {
                        StatusCode::PAYLOAD_TOO_LARGE
                    } else {
                        StatusCode::BAD_REQUEST
                    };
                    let code = if status == StatusCode::PAYLOAD_TOO_LARGE {
                        "E_PAYLOAD_TOO_LARGE"
                    } else {
                        "E_INVALID_INPUT"
                    };
                    let response = ErrorResponse::new(code, error.to_string());
                    return (status, Json(serde_json::json!(response)));
                }
            }
        }
    }

    let meta = match upload_meta {
        Some(row) => row,
        None => {
            let response =
                ErrorResponse::new("E_INVALID_INPUT", "multipart part `meta` is required");
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)));
        }
    };
    let file = match file_bytes {
        Some(row) => row,
        None => {
            let response =
                ErrorResponse::new("E_INVALID_INPUT", "multipart part `file` is required");
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)));
        }
    };

    let save_dir = {
        let save_dir_guard = state.save_directory.read().await;
        save_dir_guard.clone()
    };

    match save_image(save_dir.as_deref(), &meta.file_name, &file) {
        Ok(row) => {
            let response = SaveImageResponse {
                ok: true,
                written_path: row.written_path,
                skipped: row.skipped,
            };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(SaveImageError::NotConfigured) => {
            let response =
                ErrorResponse::new("E_NOT_CONFIGURED", "save directory is not configured");
            (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
        }
        Err(SaveImageError::InvalidInput(message)) => {
            let response = ErrorResponse::new("E_INVALID_INPUT", message);
            (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
        }
        Err(SaveImageError::Io(message)) => {
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
        http::{Request, StatusCode, header},
    };
    use tokio::sync::RwLock;
    use tower::ServiceExt as _;

    use super::{AppState, build_router};

    fn make_upload_body(file_name: &str, payload: &[u8]) -> (String, String) {
        let boundary = "----image-saver-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{{\"file_name\":\"{file_name}\"}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n{}\r\n--{boundary}--\r\n",
            String::from_utf8_lossy(payload)
        );
        (boundary.to_string(), body)
    }

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

    #[tokio::test]
    async fn save_image_returns_not_configured_when_directory_is_missing() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });
        let (boundary, body) = make_upload_body("upload_no_config.jpg", b"abc");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn save_image_writes_file_and_returns_skipped_false() {
        let dir = std::env::temp_dir();
        let file_name = "upload_happy_path_test.jpg";
        let full_path = dir.join(file_name);
        let _ = std::fs::remove_file(&full_path);

        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir.clone()))),
        });
        let (boundary, body) = make_upload_body(file_name, b"abc");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
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
            json.get("skipped").and_then(serde_json::Value::as_bool),
            Some(false)
        );
        assert!(full_path.exists());
        let _ = std::fs::remove_file(full_path);
    }

    #[tokio::test]
    async fn save_image_returns_skipped_true_for_existing_file() {
        let dir = std::env::temp_dir();
        let file_name = "upload_skip_existing_test.jpg";
        let full_path = dir.join(file_name);
        std::fs::write(&full_path, b"old").expect("must create test file");

        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir.clone()))),
        });
        let (boundary, body) = make_upload_body(file_name, b"new");

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
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
            json.get("skipped").and_then(serde_json::Value::as_bool),
            Some(true)
        );
        let _ = std::fs::remove_file(full_path);
    }

    #[tokio::test]
    async fn save_image_returns_invalid_input_when_meta_is_missing() {
        let dir = std::env::temp_dir();
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir))),
        });
        let boundary = "----image-saver-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.jpg\"\r\nContent-Type: application/octet-stream\r\n\r\nabc\r\n--{boundary}--\r\n"
        );

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images")
                    .header(
                        header::CONTENT_TYPE,
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(Body::from(body))
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
