use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

const MAX_BATCH_NAMES: usize = 500;

#[derive(Debug)]
pub enum FindImagesByNamesError {
    NotConfigured,
    InvalidInput(String),
    Io(String),
}

pub fn find_images_by_names(
    save_dir: Option<&Path>,
    names: &[String],
) -> Result<HashMap<String, Vec<String>>, FindImagesByNamesError> {
    if names.is_empty() {
        return Err(FindImagesByNamesError::InvalidInput(
            "names must not be empty".to_string(),
        ));
    }
    if names.len() > MAX_BATCH_NAMES {
        return Err(FindImagesByNamesError::InvalidInput(format!(
            "names count must be <= {MAX_BATCH_NAMES}"
        )));
    }
    let save_dir = save_dir.ok_or(FindImagesByNamesError::NotConfigured)?;

    let mut normalized_to_original: HashMap<String, String> = HashMap::new();
    for raw_name in names {
        let validated = validate_name(raw_name)?;
        let normalized = normalize_stem(validated);
        normalized_to_original
            .entry(normalized)
            .or_insert_with(|| validated.to_string());
    }

    let target: HashSet<String> = normalized_to_original.keys().cloned().collect();
    let mut result: HashMap<String, Vec<String>> = normalized_to_original
        .values()
        .map(|stem| (stem.clone(), Vec::new()))
        .collect();

    let entries = fs::read_dir(save_dir).map_err(|error| {
        FindImagesByNamesError::Io(format!("failed to read save directory: {error}"))
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            FindImagesByNamesError::Io(format!("failed to read save directory entry: {error}"))
        })?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_stem) = path.file_stem().and_then(|row| row.to_str()) else {
            continue;
        };
        let normalized = normalize_stem(file_stem);
        if !target.contains(&normalized) {
            continue;
        }
        let Some(original_stem) = normalized_to_original.get(&normalized) else {
            continue;
        };
        let Some(bucket) = result.get_mut(original_stem) else {
            continue;
        };
        bucket.push(entry.file_name().to_string_lossy().into_owned());
    }

    for values in result.values_mut() {
        values.sort_unstable();
    }
    Ok(result)
}

fn normalize_stem(stem: &str) -> String {
    if cfg!(windows) {
        stem.to_ascii_lowercase()
    } else {
        stem.to_string()
    }
}

fn validate_name(name: &str) -> Result<&str, FindImagesByNamesError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(FindImagesByNamesError::InvalidInput(
            "name must not be empty".to_string(),
        ));
    }
    if trimmed.len() > 255 {
        return Err(FindImagesByNamesError::InvalidInput(
            "name is too long".to_string(),
        ));
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(FindImagesByNamesError::InvalidInput(
            "name must not contain path separators or traversal sequences".to_string(),
        ));
    }
    if trimmed.contains('\0') {
        return Err(FindImagesByNamesError::InvalidInput(
            "name must not contain null byte".to_string(),
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::Path};

    use super::{FindImagesByNamesError, find_images_by_names};

    #[test]
    fn returns_not_configured_when_directory_is_missing() {
        let result = find_images_by_names(None, &[String::from("abc")]);
        assert!(matches!(result, Err(FindImagesByNamesError::NotConfigured)));
    }

    #[test]
    fn rejects_empty_names_list() {
        let dir = std::env::temp_dir();
        let result = find_images_by_names(Some(dir.as_path()), &[]);
        assert!(matches!(
            result,
            Err(FindImagesByNamesError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_invalid_name() {
        let dir = std::env::temp_dir();
        let result = find_images_by_names(Some(dir.as_path()), &[String::from("../hack")]);
        assert!(matches!(
            result,
            Err(FindImagesByNamesError::InvalidInput(_))
        ));
    }

    #[test]
    fn returns_mixed_hit_miss_with_sorted_values() {
        let dir = std::env::temp_dir().join("image-saver-find-batch-mixed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("must create test dir");
        std::fs::write(dir.join("abc.jpg"), b"a").expect("must create file");
        std::fs::write(dir.join("abc.png"), b"b").expect("must create file");
        std::fs::write(dir.join("xyz.webp"), b"c").expect("must create file");

        let result = find_images_by_names(
            Some(Path::new(&dir)),
            &[
                String::from("abc"),
                String::from("missing"),
                String::from("xyz"),
            ],
        )
        .expect("find batch must succeed");

        let mut expected = HashMap::new();
        expected.insert(
            "abc".to_string(),
            vec!["abc.jpg".to_string(), "abc.png".to_string()],
        );
        expected.insert("missing".to_string(), Vec::new());
        expected.insert("xyz".to_string(), vec!["xyz.webp".to_string()]);
        assert_eq!(result, expected);

        let _ = std::fs::remove_dir_all(dir);
    }
}
