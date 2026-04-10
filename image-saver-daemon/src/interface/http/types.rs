use crate::application::dto::UploadMeta;
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct ImageExistsQuery {
    #[param(example = "photo.jpg")]
    pub(crate) file_name: String,
}

#[derive(Debug, serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct FindImageByNameQuery {
    #[param(example = "04df1032d561b14c714fd530a05908de")]
    pub(crate) name: String,
}

#[derive(Debug, serde::Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct ImagesPageQuery {
    #[param(example = 1, minimum = 1)]
    pub(crate) page: Option<u64>,
}

#[derive(Debug, Default)]
pub(crate) struct MultipartParts {
    pub(crate) meta: Option<UploadMeta>,
    pub(crate) file_bytes: Option<Vec<u8>>,
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize, ToSchema)]
pub(crate) struct SaveImageMultipartRequest {
    /// JSON string with fields matching `UploadMeta`.
    #[schema(value_type = String, example = r#"{"file_name":"photo.jpg","options":{"max_long_edge":128,"quality":80}}"#)]
    pub(crate) meta: String,
    /// Binary file payload.
    #[schema(value_type = String, format = Binary)]
    pub(crate) file: String,
}
