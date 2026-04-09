use std::collections::HashMap;
use std::sync::OnceLock;

use sqlx::{Row, SqlitePool};

use crate::application::dto::StoredFileRecord;

static SQLITE_POOL: OnceLock<SqlitePool> = OnceLock::new();

pub fn set_pool(pool: SqlitePool) -> Result<(), String> {
    SQLITE_POOL
        .set(pool)
        .map_err(|_| "sqlite pool already initialized".to_string())
}

pub fn pool() -> Option<&'static SqlitePool> {
    SQLITE_POOL.get()
}

pub async fn get_file_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<Option<StoredFileRecord>, String> {
    sqlx::query_as::<_, StoredFileRecord>(
        "SELECT id, name, extension, full_name, path, hash FROM files WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|error| format!("failed to read file by id from sqlite: {error}"))
}

pub async fn files_count(pool: &SqlitePool) -> Result<i64, String> {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM files")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("failed to count files in sqlite: {error}"))
}

pub async fn exists_by_full_name(pool: &SqlitePool, full_name: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT EXISTS(SELECT 1 FROM files WHERE full_name = ?) AS value")
        .bind(full_name)
        .fetch_one(pool)
        .await
        .map_err(|error| format!("failed to check file existence in sqlite: {error}"))?;
    let value: i64 = row.get("value");
    Ok(value != 0)
}

pub async fn find_by_name(pool: &SqlitePool, name: &str) -> Result<Vec<String>, String> {
    sqlx::query_scalar::<_, String>(
        "SELECT full_name FROM files WHERE name = ? ORDER BY full_name ASC",
    )
    .bind(name)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to find files by name in sqlite: {error}"))
}

pub async fn find_by_names(
    pool: &SqlitePool,
    names: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut result: HashMap<String, Vec<String>> = names
        .iter()
        .map(|name| (name.clone(), Vec::new()))
        .collect();

    if names.is_empty() {
        return Ok(result);
    }

    let placeholders = std::iter::repeat_n("?", names.len())
        .collect::<Vec<_>>()
        .join(", ");
    let query = format!(
        "SELECT name, full_name FROM files WHERE name IN ({placeholders}) ORDER BY name ASC, full_name ASC"
    );

    let mut sql_query = sqlx::query(&query);
    for name in names {
        sql_query = sql_query.bind(name);
    }

    let rows = sql_query
        .fetch_all(pool)
        .await
        .map_err(|error| format!("failed to find files by names in sqlite: {error}"))?;

    for row in rows {
        let name: String = row.get("name");
        let full_name: String = row.get("full_name");
        if let Some(bucket) = result.get_mut(&name) {
            bucket.push(full_name);
        }
    }

    Ok(result)
}

pub async fn insert_file(
    pool: &SqlitePool,
    name: &str,
    extension: &str,
    full_name: &str,
    path: &str,
    hash: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT OR REPLACE INTO files (name, extension, full_name, path, hash) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(name)
    .bind(extension)
    .bind(full_name)
    .bind(path)
    .bind(hash)
    .execute(pool)
    .await
    .map_err(|error| format!("failed to insert file metadata into sqlite: {error}"))?;
    Ok(())
}
