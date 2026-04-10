use utoipa::OpenApi;

use crate::application::dto::{
    DeleteImageByIdResponse, ErrorResponse, FindBatchRequest, FindBatchResponse,
    FindImageByNameResponse, GetImageByIdResponse, GetSaveDirectoryResponse, ImageExistsResponse,
    ImagesTableStatusResponse, SaveImageResponse, SetSaveDirectoryRequest,
    SetSaveDirectoryResponse, StoredFileRecord, UploadMeta, UploadOptions,
};
use crate::application::queries::health::HealthResponse;
use crate::interface::http::handlers;
use crate::interface::http::types::SaveImageMultipartRequest;

#[derive(OpenApi)]
#[openapi(
    paths(
        handlers::health_handler,
        handlers::set_save_directory_handler,
        handlers::get_save_directory_handler,
        handlers::image_exists_handler,
        handlers::find_image_by_name_handler,
        handlers::find_images_batch_handler,
        handlers::get_image_by_id_handler,
        handlers::delete_image_by_id_handler,
        handlers::images_table_status_handler,
        handlers::save_image_handler
    ),
    components(
        schemas(
            HealthResponse,
            SetSaveDirectoryRequest,
            SetSaveDirectoryResponse,
            GetSaveDirectoryResponse,
            ImageExistsResponse,
            FindImageByNameResponse,
            FindBatchRequest,
            FindBatchResponse,
            UploadMeta,
            UploadOptions,
            SaveImageResponse,
            StoredFileRecord,
            GetImageByIdResponse,
            DeleteImageByIdResponse,
            ImagesTableStatusResponse,
            ErrorResponse,
            SaveImageMultipartRequest
        )
    ),
    tags(
        (name = "image-saver-daemon", description = "Image Saver daemon HTTP API")
    )
)]
pub struct ApiDoc;
