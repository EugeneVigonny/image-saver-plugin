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
pub struct GetSaveDirectoryResponse {
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
    /// Target file name in save directory (base name only, without path separators).
    pub file_name: String,
    /// Optional transform settings applied before write.
    ///
    /// If omitted, backend stores original bytes as-is.
    pub options: Option<UploadOptions>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadOptions {
    /// Resize image so the longer side is at most this value.
    ///
    /// Expected range: `1..=8192`.
    pub max_long_edge: Option<u32>,
    /// Lossy quality for formats that support it (e.g. JPEG/WebP).
    ///
    /// Expected range: `1..=100`. Ignored for non-lossy encoders.
    pub quality: Option<u8>,
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
