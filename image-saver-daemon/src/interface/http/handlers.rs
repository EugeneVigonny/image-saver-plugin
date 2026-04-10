use axum::{
    Json,
    extract::{Multipart, Path, Query, State, multipart::MultipartRejection},
    http::StatusCode,
};
use tracing::{error, info};

use crate::application::{
    commands::save_image::{SaveImageError, save_image},
    commands::set_save_directory::{SetSaveDirectoryError, set_save_directory},
    dto::{
        DeleteImageByIdResponse, ErrorResponse, FindBatchRequest, FindBatchResponse,
        FindImageByNameResponse, GetImageByIdResponse, GetSaveDirectoryResponse,
        ImageExistsResponse, ImagesTableStatusResponse, SaveImageResponse, SetSaveDirectoryRequest,
        SetSaveDirectoryResponse, UploadMeta,
    },
    queries::find_image_by_name::{FindImageByNameError, find_image_by_name},
    queries::find_images_by_names::{FindImagesByNamesError, find_images_by_names},
    queries::health::{HealthResponse, health_response},
    queries::image_exists::{ImageExistsError, image_exists},
};
use crate::infrastructure::sqlite_files;
use crate::interface::http::types::{
    FindImageByNameQuery, ImageExistsQuery, MultipartParts, SaveImageMultipartRequest,
};
use crate::interface::http::{error_mapper, routes::AppState};

#[utoipa::path(
    get,
    path = "/v1/health",
    responses(
        (status = 200, description = "Daemon health status", body = HealthResponse)
    )
)]
pub async fn health_handler() -> Json<HealthResponse> {
    Json(health_response())
}

#[utoipa::path(
    put,
    path = "/v1/save-directory",
    request_body = SetSaveDirectoryRequest,
    responses(
        (status = 200, description = "Save directory configured", body = SetSaveDirectoryResponse),
        (status = 400, description = "Validation error", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
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

#[utoipa::path(
    get,
    path = "/v1/save-directory",
    responses(
        (status = 200, description = "Current save directory", body = GetSaveDirectoryResponse),
        (status = 400, description = "Directory not configured", body = ErrorResponse)
    )
)]
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

#[utoipa::path(
    get,
    path = "/v1/images/exists",
    params(ImageExistsQuery),
    responses(
        (status = 200, description = "Image existence checked", body = ImageExistsResponse),
        (status = 400, description = "Invalid input or missing config", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn image_exists_handler(
    State(_state): State<AppState>,
    Query(query): Query<ImageExistsQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images/exists",
        method = "GET",
        "image exists check called"
    );

    match image_exists(Some(std::path::Path::new(".")), &query.file_name) {
        Ok(_) => {}
        Err(ImageExistsError::InvalidInput(message)) => {
            return error_mapper::bad_request("E_INVALID_INPUT", message);
        }
        Err(error) => {
            return error_mapper::internal_io(format!("unexpected validation error: {error:?}"));
        }
    }
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::exists_by_full_name(pool, &query.file_name).await {
        Ok(exists) => {
            let response = ImageExistsResponse { ok: true, exists };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(message) => error_mapper::internal_io(message),
    }
}

#[utoipa::path(
    get,
    path = "/v1/images/find",
    params(FindImageByNameQuery),
    responses(
        (status = 200, description = "Images matched by base name", body = FindImageByNameResponse),
        (status = 400, description = "Invalid input or missing config", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn find_image_by_name_handler(
    State(_state): State<AppState>,
    Query(query): Query<FindImageByNameQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images/find",
        method = "GET",
        "find image by name called"
    );

    match find_image_by_name(Some(std::path::Path::new(".")), &query.name) {
        Ok(_) => {}
        Err(FindImageByNameError::InvalidInput(message)) => {
            return error_mapper::bad_request("E_INVALID_INPUT", message);
        }
        Err(error) => {
            return error_mapper::internal_io(format!("unexpected validation error: {error:?}"));
        }
    }
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::find_by_name(pool, &query.name).await {
        Ok(result) => {
            let response = FindImageByNameResponse { ok: true, result };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(message) => error_mapper::internal_io(message),
    }
}

#[utoipa::path(
    post,
    path = "/v1/images/find-batch",
    request_body = FindBatchRequest,
    responses(
        (status = 200, description = "Batch search result", body = FindBatchResponse),
        (status = 400, description = "Invalid input or missing config", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn find_images_batch_handler(
    State(_state): State<AppState>,
    Json(payload): Json<FindBatchRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    info!(
        endpoint = "/v1/images/find-batch",
        method = "POST",
        "find images batch called"
    );

    match find_images_by_names(Some(std::path::Path::new(".")), &payload.names) {
        Ok(_) => {}
        Err(FindImagesByNamesError::InvalidInput(message)) => {
            return error_mapper::bad_request("E_INVALID_INPUT", message);
        }
        Err(error) => {
            return error_mapper::internal_io(format!("unexpected validation error: {error:?}"));
        }
    }
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::find_by_names(pool, &payload.names).await {
        Ok(result) => {
            let response = FindBatchResponse { ok: true, result };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(message) => error_mapper::internal_io(message),
    }
}

#[utoipa::path(
    post,
    path = "/v1/images",
    request_body(
        content = SaveImageMultipartRequest,
        content_type = "multipart/form-data"
    ),
    responses(
        (status = 200, description = "Image saved", body = SaveImageResponse),
        (status = 400, description = "Invalid input or missing config", body = ErrorResponse),
        (status = 413, description = "Payload too large", body = ErrorResponse),
        (status = 415, description = "Unsupported media type", body = ErrorResponse),
        (status = 500, description = "Image decode or I/O error", body = ErrorResponse)
    )
)]
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
            if let Some(pool) = sqlite_files::pool() {
                let full_name = std::path::Path::new(&meta.file_name)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&meta.file_name)
                    .to_string();
                let name = std::path::Path::new(&full_name)
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                let extension = std::path::Path::new(&full_name)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                let hash = format!("{:x}", md5::compute(&file));
                if let Err(message) = sqlite_files::insert_file(
                    pool,
                    &name,
                    &extension,
                    &full_name,
                    &row.written_path,
                    &hash,
                )
                .await
                {
                    return error_mapper::internal_io(message);
                }
            }
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

#[utoipa::path(
    get,
    path = "/v1/images/{id}",
    params(
        ("id" = i64, Path, description = "Image record id")
    ),
    responses(
        (status = 200, description = "Image metadata by id", body = GetImageByIdResponse),
        (status = 404, description = "Record not found", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn get_image_by_id_handler(Path(id): Path<i64>) -> (StatusCode, Json<serde_json::Value>) {
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::get_file_by_id(pool, id).await {
        Ok(Some(result)) => {
            let response = GetImageByIdResponse { ok: true, result };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Ok(None) => error_mapper::not_found("E_NOT_FOUND", format!("image id {id} not found")),
        Err(message) => error_mapper::internal_io(message),
    }
}

#[utoipa::path(
    delete,
    path = "/v1/images/{id}",
    params(
        ("id" = i64, Path, description = "Image record id")
    ),
    responses(
        (status = 200, description = "Image metadata row deleted", body = DeleteImageByIdResponse),
        (status = 404, description = "Record not found", body = ErrorResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn delete_image_by_id_handler(
    Path(id): Path<i64>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::delete_file_by_id(pool, id).await {
        Ok(true) => {
            let response = DeleteImageByIdResponse {
                ok: true,
                deleted_id: id,
            };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Ok(false) => error_mapper::not_found("E_NOT_FOUND", format!("image id {id} not found")),
        Err(message) => error_mapper::internal_io(message),
    }
}

#[utoipa::path(
    get,
    path = "/v1/images/info",
    responses(
        (status = 200, description = "Images table status", body = ImagesTableStatusResponse),
        (status = 500, description = "I/O error", body = ErrorResponse)
    )
)]
pub async fn images_table_status_handler() -> (StatusCode, Json<serde_json::Value>) {
    let Some(pool) = sqlite_files::pool() else {
        return error_mapper::internal_io("sqlite pool is not initialized");
    };
    match sqlite_files::files_count(pool).await {
        Ok(count) => {
            let response = ImagesTableStatusResponse { ok: true, count };
            (StatusCode::OK, Json(serde_json::json!(response)))
        }
        Err(message) => error_mapper::internal_io(message),
    }
}
