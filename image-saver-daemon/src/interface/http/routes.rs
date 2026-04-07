use std::{path::PathBuf, sync::Arc};

use crate::interface::http::{handlers, openapi::ApiDoc};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{get, post},
};
use tokio::sync::RwLock;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AppState {
    pub save_directory: Arc<RwLock<Option<PathBuf>>>,
}

pub fn build_router(state: AppState) -> Router {
    let openapi = ApiDoc::openapi();

    Router::new()
        .route("/v1/health", get(handlers::health_handler))
        .route("/v1/images/exists", get(handlers::image_exists_handler))
        .route("/v1/images/find", get(handlers::find_image_by_name_handler))
        .route(
            "/v1/images/find-batch",
            post(handlers::find_images_batch_handler),
        )
        .route("/v1/images", post(handlers::save_image_handler))
        .route(
            "/v1/save-directory",
            get(handlers::get_save_directory_handler).put(handlers::set_save_directory_handler),
        )
        .merge(SwaggerUi::new("/swagger-ui").url("/api-doc/openapi.json", openapi))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use image::{DynamicImage, GenericImageView, ImageFormat};
    use tokio::sync::RwLock;
    use tower::ServiceExt as _;

    use super::{AppState, build_router};

    fn make_upload_body(file_name: &str, payload: &[u8]) -> (String, String) {
        make_upload_body_with_meta_json(
            file_name,
            &format!("{{\"file_name\":\"{file_name}\"}}"),
            payload,
        )
    }

    fn make_upload_body_with_meta_json(
        file_name: &str,
        meta_json: &str,
        payload: &[u8],
    ) -> (String, String) {
        let boundary = "----image-saver-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{meta_json}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n{}\r\n--{boundary}--\r\n",
            String::from_utf8_lossy(payload)
        );
        (boundary.to_string(), body)
    }

    fn make_upload_body_with_meta_json_bytes(
        file_name: &str,
        meta_json: &str,
        payload: &[u8],
    ) -> (String, Vec<u8>) {
        let boundary = "----image-saver-boundary";
        let head = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{meta_json}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        );
        let tail = format!("\r\n--{boundary}--\r\n");

        let mut body = Vec::with_capacity(head.len() + payload.len() + tail.len());
        body.extend_from_slice(head.as_bytes());
        body.extend_from_slice(payload);
        body.extend_from_slice(tail.as_bytes());
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
    async fn get_save_directory_returns_not_configured_when_missing() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/save-directory")
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
    async fn get_save_directory_returns_current_path() {
        let expected = std::env::temp_dir();
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(expected.clone()))),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/save-directory")
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
            json.get("path").and_then(serde_json::Value::as_str),
            Some(expected.to_string_lossy().as_ref())
        );
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
    async fn find_image_by_name_returns_not_configured_when_directory_is_missing() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/find?name=test")
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
    async fn find_image_by_name_returns_invalid_input_for_bad_name() {
        let state = AppState {
            save_directory: Arc::new(RwLock::new(Some(std::env::temp_dir()))),
        };
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/find?name=..%2Fhack")
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
    async fn find_image_by_name_returns_empty_result_when_no_match() {
        let dir = std::env::temp_dir();
        let state = AppState {
            save_directory: Arc::new(RwLock::new(Some(dir))),
        };
        let app = build_router(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/find?name=missing_router_find_test")
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
            json.get("result").and_then(serde_json::Value::as_array),
            Some(&Vec::new())
        );
    }

    #[tokio::test]
    async fn find_image_by_name_returns_single_and_multiple_matches() {
        let dir = std::env::temp_dir().join("image-saver-router-find-matches");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("must create test dir");
        std::fs::write(dir.join("04df1032d561b14c714fd530a05908de.jpg"), b"a")
            .expect("must create jpg file");
        std::fs::write(dir.join("04df1032d561b14c714fd530a05908de.png"), b"b")
            .expect("must create png file");
        std::fs::write(dir.join("single_match.webp"), b"c").expect("must create webp file");

        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir.clone()))),
        });

        let single_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/find?name=single_match")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");
        assert_eq!(single_response.status(), StatusCode::OK);
        let single_bytes = to_bytes(single_response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let single_json: serde_json::Value =
            serde_json::from_slice(&single_bytes).expect("response must be valid json");
        assert_eq!(
            single_json.get("result"),
            Some(&serde_json::json!(["single_match.webp"]))
        );

        let multi_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/images/find?name=04df1032d561b14c714fd530a05908de")
                    .body(Body::empty())
                    .expect("request builder must be valid"),
            )
            .await
            .expect("router must respond");
        assert_eq!(multi_response.status(), StatusCode::OK);
        let multi_bytes = to_bytes(multi_response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let multi_json: serde_json::Value =
            serde_json::from_slice(&multi_bytes).expect("response must be valid json");
        assert_eq!(
            multi_json.get("result"),
            Some(&serde_json::json!([
                "04df1032d561b14c714fd530a05908de.jpg",
                "04df1032d561b14c714fd530a05908de.png"
            ]))
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn find_batch_returns_not_configured_when_directory_is_missing() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(None)),
        });
        let body = serde_json::json!({ "names": ["abc"] }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images/find-batch")
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
            Some("E_NOT_CONFIGURED")
        );
    }

    #[tokio::test]
    async fn find_batch_returns_invalid_input_for_bad_name() {
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(std::env::temp_dir()))),
        });
        let body = serde_json::json!({ "names": ["..\\hack"] }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images/find-batch")
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
    async fn find_batch_returns_mixed_hits_and_misses() {
        let dir = std::env::temp_dir().join("image-saver-router-find-batch-mixed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("must create test dir");
        std::fs::write(dir.join("hash_a.jpg"), b"a").expect("must create file");
        std::fs::write(dir.join("hash_a.png"), b"b").expect("must create file");
        std::fs::write(dir.join("hash_b.webp"), b"c").expect("must create file");

        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir.clone()))),
        });
        let body = serde_json::json!({ "names": ["hash_a", "missing", "hash_b"] }).to_string();

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/images/find-batch")
                    .header("content-type", "application/json")
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
            json.get("result"),
            Some(&serde_json::json!({
                "hash_a": ["hash_a.jpg", "hash_a.png"],
                "missing": [],
                "hash_b": ["hash_b.webp"]
            }))
        );

        let _ = std::fs::remove_dir_all(dir);
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

    #[tokio::test]
    async fn save_image_returns_unsupported_media_when_options_require_transform() {
        let dir = std::env::temp_dir();
        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir))),
        });
        let meta_json = "{\"file_name\":\"bad.bin\",\"options\":{\"max_long_edge\":128}}";
        let (boundary, body) = make_upload_body_with_meta_json("bad.bin", meta_json, b"not-image");

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

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body must be readable");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("response must be valid json");
        assert_eq!(
            json.get("code").and_then(serde_json::Value::as_str),
            Some("E_UNSUPPORTED_MEDIA")
        );
    }

    #[tokio::test]
    async fn save_image_resizes_jpeg_when_max_long_edge_is_set() {
        let dir = std::env::temp_dir();
        let file_name = "upload_resize_with_options_test.jpg";
        let full_path = dir.join(file_name);
        let _ = std::fs::remove_file(&full_path);

        let source = DynamicImage::new_rgb8(200, 100);
        let mut jpeg_bytes = Vec::new();
        source
            .write_to(
                &mut std::io::Cursor::new(&mut jpeg_bytes),
                ImageFormat::Jpeg,
            )
            .expect("must build jpeg test image");

        let app = build_router(AppState {
            save_directory: Arc::new(RwLock::new(Some(dir.clone()))),
        });
        let meta_json = format!(
            "{{\"file_name\":\"{file_name}\",\"options\":{{\"max_long_edge\":64,\"quality\":70}}}}"
        );
        let (boundary, body) =
            make_upload_body_with_meta_json_bytes(file_name, &meta_json, &jpeg_bytes);

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
        let written = std::fs::read(&full_path).expect("must read output image");
        let format = image::guess_format(&written).expect("must detect format");
        assert_eq!(format, ImageFormat::Jpeg);
        let decoded = image::load_from_memory(&written).expect("must decode output");
        let (w, h) = decoded.dimensions();
        assert_eq!(w.max(h), 64);

        let _ = std::fs::remove_file(full_path);
    }
}
