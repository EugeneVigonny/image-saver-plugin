use axum::{
    Json,
    extract::{Multipart, Query, State, multipart::MultipartRejection},
    http::StatusCode,
};
use tracing::{error, info};

use crate::application::{
    commands::save_image::{SaveImageError, save_image},
    commands::set_save_directory::{SetSaveDirectoryError, set_save_directory},
    dto::{
        FindImageByNameResponse, GetSaveDirectoryResponse, ImageExistsResponse, SaveImageResponse,
        SetSaveDirectoryRequest, SetSaveDirectoryResponse, UploadMeta,
    },
    queries::find_image_by_name::{FindImageByNameError, find_image_by_name},
    queries::health::{HealthResponse, health_response},
    queries::image_exists::{ImageExistsError, image_exists},
};
use crate::interface::http::types::{FindImageByNameQuery, ImageExistsQuery, MultipartParts};
use crate::interface::http::{error_mapper, routes::AppState};

pub async fn health_handler() -> Json<HealthResponse> {
    Json(health_response())
}

pub async fn set_save_directory_handler(
    State(state): State<AppState>,
    Json(payload): Json<SetSaveDirectoryRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/save-directory",
        method = "PUT",
        "set save directory called"
    );

    match set_save_directory(&payload.path) {
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
                    error_mapper::internal_io("response serialization failed")
                }
            }
        }
        Err(SetSaveDirectoryError::InvalidInput(message)) => {
            info!(reason = %message, "save directory validation failed");
            error_mapper::bad_request("E_INVALID_INPUT", message)
        }
        Err(SetSaveDirectoryError::Io(message)) => {
            error!(reason = %message, "save directory io validation failed");
            error_mapper::internal_io(message)
        }
    }
}

pub async fn get_save_directory_handler(
    State(state): State<AppState>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/save-directory",
        method = "GET",
        "get save directory called"
    );

    let current = {
        let save_dir_guard = state.save_directory.read().await;
        save_dir_guard.clone()
    };
    match current {
        Some(path) => {
            let response = GetSaveDirectoryResponse {
                ok: true,
                path: path.to_string_lossy().into_owned(),
            };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        None => error_mapper::bad_request("E_NOT_CONFIGURED", "save directory is not configured"),
    }
}

pub async fn image_exists_handler(
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
            error_mapper::bad_request("E_NOT_CONFIGURED", "save directory is not configured")
        }
        Err(ImageExistsError::InvalidInput(message)) => {
            error_mapper::bad_request("E_INVALID_INPUT", message)
        }
        Err(ImageExistsError::Io(message)) => {
            error!(reason = %message, "image exists io check failed");
            error_mapper::internal_io(message)
        }
    }
}

pub async fn find_image_by_name_handler(
    State(state): State<AppState>,
    Query(query): Query<FindImageByNameQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images/find",
        method = "GET",
        "find image by name called"
    );

    let save_dir = {
        let save_dir_guard = state.save_directory.read().await;
        save_dir_guard.clone()
    };

    match find_image_by_name(save_dir.as_deref(), &query.name) {
        Ok(result) => {
            let response = FindImageByNameResponse { ok: true, result };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(FindImageByNameError::NotConfigured) => {
            error_mapper::bad_request("E_NOT_CONFIGURED", "save directory is not configured")
        }
        Err(FindImageByNameError::InvalidInput(message)) => {
            error_mapper::bad_request("E_INVALID_INPUT", message)
        }
        Err(FindImageByNameError::Io(message)) => {
            error!(reason = %message, "find image by name io failed");
            error_mapper::internal_io(message)
        }
    }
}

pub async fn save_image_handler(
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
                return error_mapper::payload_too_large("payload is too large");
            }
            return error_mapper::bad_request("E_INVALID_INPUT", "invalid multipart payload");
        }
    };

    let mut parts = MultipartParts::default();

    loop {
        let next_field = multipart.next_field().await;
        let maybe_field = match next_field {
            Ok(row) => row,
            Err(error) => {
                if error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("body too large")
                {
                    return error_mapper::payload_too_large(error.to_string());
                } else {
                    return error_mapper::bad_request("E_INVALID_INPUT", error.to_string());
                }
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
                    return error_mapper::bad_request("E_INVALID_INPUT", error.to_string());
                }
            };
            let parsed: Result<UploadMeta, _> = serde_json::from_str(&text);
            match parsed {
                Ok(row) => parts.meta = Some(row),
                Err(error) => {
                    return error_mapper::bad_request("E_INVALID_INPUT", error.to_string());
                }
            }
            continue;
        }

        if name == "file" {
            match field.bytes().await {
                Ok(row) => parts.file_bytes = Some(row.to_vec()),
                Err(error) => {
                    if error
                        .to_string()
                        .to_ascii_lowercase()
                        .contains("body too large")
                    {
                        return error_mapper::payload_too_large(error.to_string());
                    } else {
                        return error_mapper::bad_request("E_INVALID_INPUT", error.to_string());
                    }
                }
            }
        }
    }

    let meta = match parts.meta {
        Some(row) => row,
        None => {
            return error_mapper::bad_request(
                "E_INVALID_INPUT",
                "multipart part `meta` is required",
            );
        }
    };
    let file = match parts.file_bytes {
        Some(row) => row,
        None => {
            return error_mapper::bad_request(
                "E_INVALID_INPUT",
                "multipart part `file` is required",
            );
        }
    };

    let save_dir = {
        let save_dir_guard = state.save_directory.read().await;
        save_dir_guard.clone()
    };

    match save_image(
        save_dir.as_deref(),
        &meta.file_name,
        &file,
        meta.options.as_ref(),
    ) {
        Ok(row) => {
            let response = SaveImageResponse {
                ok: true,
                written_path: row.written_path,
                skipped: row.skipped,
            };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(SaveImageError::NotConfigured) => {
            error_mapper::bad_request("E_NOT_CONFIGURED", "save directory is not configured")
        }
        Err(SaveImageError::InvalidInput(message)) => {
            error_mapper::bad_request("E_INVALID_INPUT", message)
        }
        Err(SaveImageError::UnsupportedMediaType(message)) => {
            error_mapper::unsupported_media(message)
        }
        Err(SaveImageError::ImageDecodeFailed(message)) => error_mapper::image_decode(message),
        Err(SaveImageError::Io(message)) => error_mapper::internal_io(message),
    }
}
