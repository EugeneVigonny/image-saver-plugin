use std::{fs, path::Path};

#[derive(Debug)]
pub enum FindImageByNameError {
    NotConfigured,
    InvalidInput(String),
    #[allow(dead_code)]
    Io(String),
}

pub fn find_image_by_name(
    save_dir: Option<&Path>,
    name: &str,
) -> Result<Vec<String>, FindImageByNameError> {
    let stem = validate_name(name)?;
    let save_dir = save_dir.ok_or(FindImageByNameError::NotConfigured)?;
    let mut matches = Vec::new();

    let entries = fs::read_dir(save_dir).map_err(|error| {
        FindImageByNameError::Io(format!("failed to read save directory: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            FindImageByNameError::Io(format!("failed to read save directory entry: {error}"))
        })?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path_matches_stem(&path, stem) {
            matches.push(entry.file_name().to_string_lossy().into_owned());
        }
    }

    matches.sort_unstable();
    Ok(matches)
}

fn path_matches_stem(path: &Path, expected_stem: &str) -> bool {
    let Some(stem) = path.file_stem().and_then(|row| row.to_str()) else {
        return false;
    };

    if cfg!(windows) {
        stem.eq_ignore_ascii_case(expected_stem)
    } else {
        stem == expected_stem
    }
}

fn validate_name(name: &str) -> Result<&str, FindImageByNameError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(FindImageByNameError::InvalidInput(
            "name must not be empty".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(FindImageByNameError::InvalidInput(
            "name must not contain path separators or traversal sequences".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(FindImageByNameError::InvalidInput(
            "name must not contain null byte".to_string(),
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{FindImageByNameError, find_image_by_name};

    #[test]
    fn returns_not_configured_when_directory_is_missing() {
        let result = find_image_by_name(None, "abc");
        assert!(matches!(result, Err(FindImageByNameError::NotConfigured)));
    }

    #[test]
    fn rejects_invalid_name() {
        let base_dir = std::env::temp_dir();
        let result = find_image_by_name(Some(base_dir.as_path()), "../hack");
        assert!(matches!(result, Err(FindImageByNameError::InvalidInput(_))));
    }

    #[test]
    fn returns_empty_when_no_match() {
        let base_dir = std::env::temp_dir();
        let result = find_image_by_name(Some(base_dir.as_path()), "missing_find_test_stem");
        assert!(matches!(result, Ok(row) if row.is_empty()));
    }

    #[test]
    fn returns_single_match() {
        let dir = std::env::temp_dir().join("image-saver-find-single");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("must create test dir");
        let file_name = "find_stem_single_case.png";
        std::fs::write(dir.join(file_name), b"x").expect("must create test file");

        let result = find_image_by_name(Some(Path::new(&dir)), "find_stem_single_case")
            .expect("find must succeed");
        assert_eq!(result, vec![file_name.to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn returns_multiple_matches_sorted() {
        let dir = std::env::temp_dir().join("image-saver-find-multi");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("must create test dir");
        std::fs::write(dir.join("same_stem.webp"), b"a").expect("must create webp");
        std::fs::write(dir.join("same_stem.jpg"), b"b").expect("must create jpg");
        std::fs::write(dir.join("other_name.png"), b"c").expect("must create other");

        let result =
            find_image_by_name(Some(Path::new(&dir)), "same_stem").expect("find must succeed");
        assert_eq!(
            result,
            vec!["same_stem.jpg".to_string(), "same_stem.webp".to_string()]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ignores_directories_even_if_name_matches() {
        let dir = std::env::temp_dir().join("image-saver-find-dir-filter");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("target_stem")).expect("must create nested dir");

        let result =
            find_image_by_name(Some(Path::new(&dir)), "target_stem").expect("find must succeed");
        assert!(result.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn returns_io_when_directory_is_unreadable() {
        let missing = PathBuf::from("Z:/definitely/missing/path/for/find-image-tests");
        let result = find_image_by_name(Some(missing.as_path()), "stem");
        assert!(matches!(result, Err(FindImageByNameError::Io(_))));
    }
}
