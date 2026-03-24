use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub enum SetSaveDirectoryError {
    InvalidInput(String),
    Io(String),
}

pub fn set_save_directory(path: &str) -> Result<PathBuf, SetSaveDirectoryError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(SetSaveDirectoryError::InvalidInput(
            "path must not be empty".to_string(),
        ));
    }

    let dir = PathBuf::from(trimmed);
    if !dir.is_absolute() {
        return Err(SetSaveDirectoryError::InvalidInput(
            "path must be absolute".to_string(),
        ));
    }

    let metadata = fs::metadata(&dir).map_err(|error| {
        SetSaveDirectoryError::InvalidInput(format!("path is not accessible: {error}"))
    })?;
    if !metadata.is_dir() {
        return Err(SetSaveDirectoryError::InvalidInput(
            "path must point to an existing directory".to_string(),
        ));
    }

    ensure_writable(&dir)?;
    Ok(dir)
}

fn ensure_writable(dir: &Path) -> Result<(), SetSaveDirectoryError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| SetSaveDirectoryError::Io(format!("time error: {error}")))?;
    let probe_name = format!(
        ".image-saver-write-check-{}-{}.tmp",
        std::process::id(),
        now.as_nanos()
    );
    let probe_path = dir.join(probe_name);

    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe_path)
        .map_err(|error| {
            SetSaveDirectoryError::Io(format!("directory is not writable: {error}"))
        })?;

    file.write_all(b"ok").map_err(|error| {
        SetSaveDirectoryError::Io(format!("failed to write probe file: {error}"))
    })?;
    drop(file);

    fs::remove_file(probe_path).map_err(|error| {
        SetSaveDirectoryError::Io(format!("failed to cleanup probe file: {error}"))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs::File, path::PathBuf};

    use super::{SetSaveDirectoryError, set_save_directory};

    #[test]
    fn rejects_relative_path() {
        let result = set_save_directory("relative/path");
        assert!(matches!(
            result,
            Err(SetSaveDirectoryError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_file_path() {
        let temp_file = std::env::temp_dir().join("image-saver-daemon-not-dir.tmp");
        let _ = File::create(&temp_file).expect("must create temp file");

        let result = set_save_directory(temp_file.to_str().expect("valid temp path"));
        assert!(matches!(
            result,
            Err(SetSaveDirectoryError::InvalidInput(_))
        ));

        let _ = std::fs::remove_file(temp_file);
    }

    #[test]
    fn accepts_existing_writable_directory() {
        let path: PathBuf = std::env::temp_dir();
        let result = set_save_directory(path.to_str().expect("valid temp dir path"));
        assert!(result.is_ok());
    }
}
