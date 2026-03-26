use std::{fs, path::Path};

#[derive(Debug)]
pub enum SaveImageError {
    NotConfigured,
    InvalidInput(String),
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

    fs::write(&target_path, file_bytes)
        .map_err(|error| SaveImageError::Io(format!("failed to write file: {error}")))?;

    Ok(SaveImageResult {
        written_path: target_path.to_string_lossy().into_owned(),
        skipped: false,
    })
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
    use std::path::Path;

    use super::{SaveImageError, save_image};

    #[test]
    fn returns_not_configured_when_save_directory_is_missing() {
        let result = save_image(None, "image.jpg", b"abc");
        assert!(matches!(result, Err(SaveImageError::NotConfigured)));
    }

    #[test]
    fn rejects_invalid_file_name() {
        let dir = std::env::temp_dir();
        let result = save_image(Some(dir.as_path()), "../image.jpg", b"abc");
        assert!(matches!(result, Err(SaveImageError::InvalidInput(_))));
    }

    #[test]
    fn writes_new_file_and_returns_skipped_false() {
        let dir = std::env::temp_dir();
        let file_name = "save_image_new_file_test.jpg";
        let full_path = dir.join(file_name);
        let _ = std::fs::remove_file(&full_path);

        let result = save_image(Some(Path::new(&dir)), file_name, b"abc");
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

        let result = save_image(Some(Path::new(&dir)), file_name, b"new");
        assert!(matches!(result, Ok(ref row) if row.skipped));

        let _ = std::fs::remove_file(full_path);
    }
}
