use axum::{Json, http::StatusCode};

use crate::application::dto::ErrorResponse;

pub fn bad_request(
    code: &str,
    message: impl Into<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let response = ErrorResponse::new(code, message);
    (StatusCode::BAD_REQUEST, Json(serde_json::json!(response)))
}

pub fn payload_too_large(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    let response = ErrorResponse::new("E_PAYLOAD_TOO_LARGE", message);
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        Json(serde_json::json!(response)),
    )
}

pub fn internal_io(message: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    let response = ErrorResponse::new("E_IO", message);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!(response)),
    )
}
