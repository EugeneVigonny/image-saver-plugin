use crate::application::dto::UploadMeta;

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ImageExistsQuery {
    pub(crate) file_name: String,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct FindImageByNameQuery {
    pub(crate) name: String,
}

#[derive(Debug, Default)]
pub(crate) struct MultipartParts {
    pub(crate) meta: Option<UploadMeta>,
    pub(crate) file_bytes: Option<Vec<u8>>,
}
