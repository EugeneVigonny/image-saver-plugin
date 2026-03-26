use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct SetSaveDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct SetSaveDirectoryResponse {
    pub ok: bool,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct ImageExistsResponse {
    pub ok: bool,
    pub exists: bool,
}

#[derive(Debug, Deserialize)]
pub struct UploadMeta {
    pub file_name: String,
}

#[derive(Debug, Serialize)]
pub struct SaveImageResponse {
    pub ok: bool,
    pub written_path: String,
    pub skipped: bool,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub ok: bool,
    pub code: String,
    pub error: String,
}

impl ErrorResponse {
    #[must_use]
    pub fn new(code: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: code.into(),
            error: error.into(),
        }
    }
}
