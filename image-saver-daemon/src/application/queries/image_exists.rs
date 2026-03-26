use std::{fs, path::Path};

#[derive(Debug)]
pub enum ImageExistsError {
    NotConfigured,
    InvalidInput(String),
    Io(String),
}

pub fn image_exists(save_dir: Option<&Path>, file_name: &str) -> Result<bool, ImageExistsError> {
    let file_name = validate_file_name(file_name)?;
    let save_dir = save_dir.ok_or(ImageExistsError::NotConfigured)?;
    let file_path = save_dir.join(file_name);

    match fs::metadata(file_path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ImageExistsError::Io(format!(
            "failed to check file existence: {error}"
        ))),
    }
}

fn validate_file_name(file_name: &str) -> Result<&str, ImageExistsError> {
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        return Err(ImageExistsError::InvalidInput(
            "file_name must not be empty".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(ImageExistsError::InvalidInput(
            "file_name must not contain path separators or traversal sequences".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(ImageExistsError::InvalidInput(
            "file_name must not contain null byte".to_string(),
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ImageExistsError, image_exists};

    #[test]
    fn returns_not_configured_when_directory_is_missing() {
        let result = image_exists(None, "test.jpg");
        assert!(matches!(result, Err(ImageExistsError::NotConfigured)));
    }

    #[test]
    fn rejects_invalid_file_name() {
        let base_dir = std::env::temp_dir();
        let result = image_exists(Some(base_dir.as_path()), "../hack.jpg");
        assert!(matches!(result, Err(ImageExistsError::InvalidInput(_))));
    }

    #[test]
    fn returns_false_for_missing_file() {
        let base_dir = std::env::temp_dir();
        let result = image_exists(Some(base_dir.as_path()), "missing_file_for_exists_test.jpg");
        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn returns_true_for_existing_file() {
        let base_dir = std::env::temp_dir();
        let file_name = "existing_file_for_exists_test.jpg";
        let full_path = base_dir.join(file_name);
        std::fs::write(&full_path, b"x").expect("must create test file");

        let result = image_exists(Some(Path::new(&base_dir)), file_name);
        assert!(matches!(result, Ok(true)));

        let _ = std::fs::remove_file(full_path);
    }
}
