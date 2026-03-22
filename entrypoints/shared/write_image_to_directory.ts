import { create_logger } from "./logger";

const log = create_logger("fs_write");

/**
 * Подбирает уникальное имя файла в каталоге (`name_1.ext`, если `name.ext` занят).
 */
export async function pick_unique_filename(
    directory: FileSystemDirectoryHandle,
    base_name: string,
): Promise<string> {
    const existing = new Set<string>();
    for await (const entry of directory.values()) {
        if (entry.kind === "file") {
            existing.add(entry.name);
        }
    }
    if (!existing.has(base_name)) {
        return base_name;
    }
    const dot = base_name.lastIndexOf(".");
    const stem = dot > 0 ? base_name.slice(0, dot) : base_name;
    const ext = dot > 0 ? base_name.slice(dot) : "";
    let index = 1;
    let candidate = `${stem}_${String(index)}${ext}`;
    while (existing.has(candidate)) {
        index += 1;
        candidate = `${stem}_${String(index)}${ext}`;
    }
    return candidate;
}

/**
 * Создаёт файл в каталоге и пишет `blob`.
 * @remarks Имя может отличаться от `suggested_name` после `pick_unique_filename`.
 */
export async function write_blob_to_directory(
    directory: FileSystemDirectoryHandle,
    suggested_name: string,
    blob: Blob,
): Promise<string> {
    log.debug("write_blob_to_directory", {
        suggested_name,
        bytes: blob.size,
        type: blob.type || "(empty)",
    });
    const name = await pick_unique_filename(directory, suggested_name);
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
        await writable.write(blob);
    } finally {
        await writable.close();
    }
    log.debug("write_blob_to_directory: done", { name });
    return name;
}
