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

async function write_blob_to_file_handle(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
    const writable = await handle.createWritable();
    try {
        /** В SW надёжнее писать `BufferSource`, чем `Blob` (меньше сюрпризов с clone). */
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await writable.write(bytes);
    } finally {
        try {
            await writable.close();
        } catch {
            /* Chromium SW: `close()` иногда бросает NotAllowedError после успешного write */
        }
    }
}

/**
 * Создаёт файл в каталоге и пишет `blob`.
 * @remarks Если файл с **точным** `suggested_name` уже есть — запись не выполняется (идемпотентность).
 * Не вызываем `directory.values()`: обход каталога в MV3 service worker даёт
 * `NotAllowedError` после перезагрузки страницы; имя уже уникально, если файла нет (`getFileHandle` create:false).
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
    try {
        await directory.getFileHandle(suggested_name, { create: false });
        log.debug("write_blob_to_directory: already on disk, skip write", { suggested_name });
        return suggested_name;
    } catch {
        /* файла нет — создаём только этот путь, без полного листинга каталога */
    }
    const handle = await directory.getFileHandle(suggested_name, { create: true });
    await write_blob_to_file_handle(handle, blob);
    log.debug("write_blob_to_directory: done", { name: suggested_name });
    return suggested_name;
}
