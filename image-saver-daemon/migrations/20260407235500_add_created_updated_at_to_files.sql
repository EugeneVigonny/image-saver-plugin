ALTER TABLE files ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE files ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

UPDATE files
SET created_at = datetime('now'),
    updated_at = datetime('now')
WHERE created_at = '' OR updated_at = '';
