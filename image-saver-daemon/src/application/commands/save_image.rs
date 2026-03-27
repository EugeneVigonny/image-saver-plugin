use std::{fs, io::Cursor, path::Path};

use image::{
    DynamicImage, GenericImageView, ImageFormat, codecs::jpeg::JpegEncoder, imageops::FilterType,
};

use crate::application::dto::UploadOptions;

#[derive(Debug)]
pub enum SaveImageError {
    NotConfigured,
    InvalidInput(String),
    UnsupportedMediaType(String),
    ImageDecodeFailed(String),
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveImageResult {
    pub written_path: String,
    pub skipped: bool,
}

pub fn save_image(
    save_dir: Option<&Path>,
    file_name: &str,
    file_bytes: &[u8],
    options: Option<&UploadOptions>,
) -> Result<SaveImageResult, SaveImageError> {
    let save_dir = save_dir.ok_or(SaveImageError::NotConfigured)?;
    let safe_file_name = validate_file_name(file_name)?;
    let target_path = save_dir.join(safe_file_name);

    if target_path.exists() {
        return Ok(SaveImageResult {
            written_path: target_path.to_string_lossy().into_owned(),
            skipped: true,
        });
    }

    let output_bytes = transform_image(file_bytes, options)?;

    fs::write(&target_path, output_bytes)
        .map_err(|error| SaveImageError::Io(format!("failed to write file: {error}")))?;

    Ok(SaveImageResult {
        written_path: target_path.to_string_lossy().into_owned(),
        skipped: false,
    })
}

fn transform_image(
    file_bytes: &[u8],
    options: Option<&UploadOptions>,
) -> Result<Vec<u8>, SaveImageError> {
    if options.is_none() {
        return Ok(file_bytes.to_vec());
    }

    let validated = validate_options(options)?;
    let format = detect_input_format(file_bytes)?;
    let mut image = decode_image(file_bytes, format)?;

    if let Some(max_long_edge) = validated.max_long_edge {
        image = resize_preserving_aspect(image, max_long_edge);
    }

    encode_preserving_format(&image, format, validated.quality)
}

#[derive(Debug, Clone, Copy)]
struct ValidatedOptions {
    max_long_edge: Option<u32>,
    quality: Option<u8>,
}

fn validate_options(options: Option<&UploadOptions>) -> Result<ValidatedOptions, SaveImageError> {
    let Some(options) = options else {
        return Ok(ValidatedOptions {
            max_long_edge: None,
            quality: None,
        });
    };

    if let Some(max_long_edge) = options.max_long_edge
        && !(1..=8192).contains(&max_long_edge)
    {
        return Err(SaveImageError::InvalidInput(
            "options.max_long_edge must be in range 1..=8192".to_string(),
        ));
    }

    if let Some(quality) = options.quality
        && !(1..=100).contains(&quality)
    {
        return Err(SaveImageError::InvalidInput(
            "options.quality must be in range 1..=100".to_string(),
        ));
    }

    Ok(ValidatedOptions {
        max_long_edge: options.max_long_edge,
        quality: options.quality,
    })
}

fn detect_input_format(file_bytes: &[u8]) -> Result<ImageFormat, SaveImageError> {
    image::guess_format(file_bytes).map_err(|error| {
        SaveImageError::UnsupportedMediaType(format!("unsupported image format: {error}"))
    })
}

fn decode_image(file_bytes: &[u8], format: ImageFormat) -> Result<DynamicImage, SaveImageError> {
    image::load_from_memory_with_format(file_bytes, format).map_err(|error| {
        SaveImageError::ImageDecodeFailed(format!("failed to decode image: {error}"))
    })
}

fn resize_preserving_aspect(image: DynamicImage, max_long_edge: u32) -> DynamicImage {
    let (width, height) = image.dimensions();
    let current_long_edge = width.max(height);

    if current_long_edge <= max_long_edge {
        return image;
    }

    let ratio = max_long_edge as f32 / current_long_edge as f32;
    let new_width = (width as f32 * ratio).round().max(1.0) as u32;
    let new_height = (height as f32 * ratio).round().max(1.0) as u32;

    image.resize_exact(new_width, new_height, FilterType::Lanczos3)
}

fn encode_preserving_format(
    image: &DynamicImage,
    format: ImageFormat,
    quality: Option<u8>,
) -> Result<Vec<u8>, SaveImageError> {
    let mut output = Vec::with_capacity(1024);
    match format {
        ImageFormat::Jpeg => {
            let mut cursor = Cursor::new(&mut output);
            let rgb8 = image.to_rgb8();
            let (width, height) = image.dimensions();
            let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality.unwrap_or(85));
            encoder
                .encode(rgb8.as_raw(), width, height, image::ColorType::Rgb8.into())
                .map_err(|error| {
                    SaveImageError::Io(format!("failed to encode jpeg image: {error}"))
                })?;
        }
        _ => {
            image
                .write_to(&mut Cursor::new(&mut output), format)
                .map_err(|error| {
                    SaveImageError::Io(format!("failed to encode transformed image: {error}"))
                })?;
        }
    }
    Ok(output)
}

fn validate_file_name(file_name: &str) -> Result<&str, SaveImageError> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err(SaveImageError::InvalidInput(
            "file_name must not be empty".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(SaveImageError::InvalidInput(
            "file_name must not contain path separators or traversal sequences".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(SaveImageError::InvalidInput(
            "file_name must not contain null byte".to_string(),
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};

    use image::{DynamicImage, GenericImageView, ImageFormat};

    use crate::application::dto::UploadOptions;

    use super::{SaveImageError, save_image};

    #[test]
    fn returns_not_configured_when_save_directory_is_missing() {
        let result = save_image(None, "image.jpg", b"abc", None);
        assert!(matches!(result, Err(SaveImageError::NotConfigured)));
    }

    #[test]
    fn rejects_invalid_file_name() {
        let dir = std::env::temp_dir();
        let result = save_image(Some(dir.as_path()), "../image.jpg", b"abc", None);
        assert!(matches!(result, Err(SaveImageError::InvalidInput(_))));
    }

    #[test]
    fn writes_new_file_and_returns_skipped_false() {
        let dir = std::env::temp_dir();
        let file_name = "save_image_new_file_test.jpg";
        let full_path = dir.join(file_name);
        let _ = std::fs::remove_file(&full_path);

        let result = save_image(Some(Path::new(&dir)), file_name, b"abc", None);
        assert!(matches!(result, Ok(ref row) if !row.skipped));
        assert!(full_path.exists());

        let _ = std::fs::remove_file(full_path);
    }

    #[test]
    fn returns_skipped_true_when_file_exists() {
        let dir = std::env::temp_dir();
        let file_name = "save_image_existing_file_test.jpg";
        let full_path = dir.join(file_name);
        std::fs::write(&full_path, b"old").expect("must create test file");

        let result = save_image(Some(Path::new(&dir)), file_name, b"new", None);
        assert!(matches!(result, Ok(ref row) if row.skipped));

        let _ = std::fs::remove_file(full_path);
    }

    #[test]
    fn rejects_out_of_range_quality_option() {
        let dir = std::env::temp_dir();
        let options = UploadOptions {
            max_long_edge: None,
            quality: Some(0),
        };

        let result = save_image(Some(dir.as_path()), "image.jpg", b"abc", Some(&options));
        assert!(matches!(result, Err(SaveImageError::InvalidInput(_))));
    }

    #[test]
    fn resizes_jpeg_preserving_format() {
        let dir = std::env::temp_dir();
        let file_name = "save_image_resize_test.jpg";
        let full_path: PathBuf = dir.join(file_name);
        let _ = std::fs::remove_file(&full_path);

        let source = DynamicImage::new_rgb8(200, 100);
        let mut jpeg_bytes = Vec::new();
        source
            .write_to(&mut Cursor::new(&mut jpeg_bytes), ImageFormat::Jpeg)
            .expect("must build jpeg bytes");

        let options = UploadOptions {
            max_long_edge: Some(50),
            quality: Some(75),
        };
        let result = save_image(
            Some(Path::new(&dir)),
            file_name,
            &jpeg_bytes,
            Some(&options),
        );
        assert!(matches!(result, Ok(ref row) if !row.skipped));

        let written = std::fs::read(&full_path).expect("must read output file");
        let format = image::guess_format(&written).expect("must detect output format");
        assert_eq!(format, ImageFormat::Jpeg);

        let decoded = image::load_from_memory(&written).expect("must decode output image");
        let (w, h) = decoded.dimensions();
        assert_eq!(w.max(h), 50);

        let _ = std::fs::remove_file(full_path);
    }

    #[test]
    fn returns_unsupported_media_type_for_unknown_bytes() {
        let dir = std::env::temp_dir();
        let options = UploadOptions {
            max_long_edge: Some(100),
            quality: None,
        };

        let result = save_image(
            Some(dir.as_path()),
            "unknown.bin",
            b"not-image",
            Some(&options),
        );
        assert!(matches!(
            result,
            Err(SaveImageError::UnsupportedMediaType(_))
        ));
    }
}
