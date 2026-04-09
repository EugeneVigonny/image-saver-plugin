#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


READ_CHUNK_SIZE = 1024 * 1024
DEFAULT_PROGRESS_EVERY = 100
DEFAULT_DB_PATH = Path(__file__).resolve().parent / "image-saver-daemon.db"


@dataclass(slots=True)
class Stats:
    scanned: int = 0
    inserted: int = 0
    skipped_duplicates: int = 0
    errors: int = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Recursively import files metadata into image-saver-daemon SQLite database."
    )
    parser.add_argument(
        "source_dir", type=str, help="Path to source directory with files."
    )
    parser.add_argument(
        "--db-path",
        type=str,
        default=str(DEFAULT_DB_PATH),
        help="Path to SQLite database file. Default: image-saver-daemon/image-saver-daemon.db",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=DEFAULT_PROGRESS_EVERY,
        help="Print progress every N scanned files.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def create_log_path() -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path.cwd() / f"log-{timestamp}.NLJSON"


def log_event(log_file, event: dict[str, object]) -> None:
    log_file.write(json.dumps(event, ensure_ascii=False) + "\n")
    log_file.flush()


def compute_md5(file_path: Path) -> str:
    digest = hashlib.md5()
    with file_path.open("rb") as stream:
        while True:
            chunk = stream.read(READ_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def iter_files(source_dir: Path) -> Iterable[Path]:
    for path in source_dir.rglob("*"):
        if path.is_file():
            yield path


def validate_source_dir(source_dir: Path) -> tuple[bool, str]:
    if not source_dir.exists():
        return False, "source directory does not exist"
    if not source_dir.is_dir():
        return False, "source path is not a directory"
    return True, ""


def open_db(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.execute("PRAGMA busy_timeout = 5000;")
    return connection


def insert_file_row(
    connection: sqlite3.Connection,
    *,
    name: str,
    extension: str,
    full_name: str,
    file_path: str,
    file_hash: str,
) -> int:
    cursor = connection.execute(
        """
        INSERT OR IGNORE INTO files (name, extension, full_name, path, hash)
        VALUES (?, ?, ?, ?, ?)
        """,
        (name, extension, full_name, file_path, file_hash),
    )
    connection.commit()
    return cursor.rowcount


def main() -> int:
    args = parse_args()
    start_time = time.time()
    stats = Stats()

    source_dir = Path(args.source_dir).expanduser().resolve()
    db_path = Path(args.db_path).expanduser().resolve()
    progress_every = max(1, args.progress_every)

    log_path = create_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    with log_path.open("a", encoding="utf-8") as log_file:
        is_valid, reason = validate_source_dir(source_dir)
        if not is_valid:
            stats.errors += 1
            log_event(
                log_file,
                {
                    "ts": utc_now_iso(),
                    "event": "error",
                    "stage": "validate_source_dir",
                    "source_dir": str(source_dir),
                    "reason": reason,
                },
            )
            print(f"ERROR: {reason}")
            print(f"log_file={log_path}")
            return 1

        try:
            connection = open_db(db_path)
        except sqlite3.Error as error:
            stats.errors += 1
            log_event(
                log_file,
                {
                    "ts": utc_now_iso(),
                    "event": "error",
                    "stage": "open_db",
                    "db_path": str(db_path),
                    "reason": str(error),
                },
            )
            print(f"ERROR: failed to open database: {error}")
            print(f"log_file={log_path}")
            return 1

        with connection:
            for file_path in iter_files(source_dir):
                stats.scanned += 1

                full_name = file_path.name
                name = file_path.stem
                extension = file_path.suffix.lstrip(".")
                absolute_path = str(file_path.resolve())

                try:
                    file_hash = compute_md5(file_path)
                except OSError as error:
                    stats.errors += 1
                    log_event(
                        log_file,
                        {
                            "ts": utc_now_iso(),
                            "event": "error",
                            "stage": "compute_md5",
                            "full_name": full_name,
                            "path": absolute_path,
                            "reason": str(error),
                        },
                    )
                    continue

                try:
                    rowcount = insert_file_row(
                        connection,
                        name=name,
                        extension=extension,
                        full_name=full_name,
                        file_path=absolute_path,
                        file_hash=file_hash,
                    )
                except sqlite3.Error as error:
                    stats.errors += 1
                    log_event(
                        log_file,
                        {
                            "ts": utc_now_iso(),
                            "event": "error",
                            "stage": "insert_row",
                            "full_name": full_name,
                            "path": absolute_path,
                            "reason": str(error),
                        },
                    )
                    continue

                if rowcount == 1:
                    stats.inserted += 1
                else:
                    stats.skipped_duplicates += 1
                    log_event(
                        log_file,
                        {
                            "ts": utc_now_iso(),
                            "event": "duplicate",
                            "full_name": full_name,
                            "path": absolute_path,
                            "reason": "full_name already exists",
                        },
                    )

                if stats.scanned % progress_every == 0:
                    elapsed = time.time() - start_time
                    print(
                        "progress "
                        f"scanned={stats.scanned} "
                        f"inserted={stats.inserted} "
                        f"skipped_duplicates={stats.skipped_duplicates} "
                        f"errors={stats.errors} "
                        f"elapsed_sec={elapsed:.1f}"
                    )

    elapsed = time.time() - start_time
    print(
        "done "
        f"scanned={stats.scanned} "
        f"inserted={stats.inserted} "
        f"skipped_duplicates={stats.skipped_duplicates} "
        f"errors={stats.errors} "
        f"duration_sec={elapsed:.1f} "
        f"log_file={log_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
