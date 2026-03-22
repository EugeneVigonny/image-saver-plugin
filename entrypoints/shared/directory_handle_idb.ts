/**
 * IndexedDB одного origin расширения: живой `FileSystemDirectoryHandle` (в `chrome.storage` не сериализуется).
 */
const db_name = "image_saver_directory_v1";
const store_name = "handles";
const record_key = "save_dir";

function open_db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(db_name, 1);
        request.onerror = () => {
            reject(request.error ?? new Error("indexedDB.open failed"));
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(store_name)) {
                db.createObjectStore(store_name);
            }
        };
        request.onsuccess = () => {
            resolve(request.result);
        };
    });
}

/** Сохраняет выбранную папку для последующего `queryPermission` / записи из SW. */
export async function idb_save_directory_handle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await open_db();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store_name, "readwrite");
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error("idb write transaction failed"));
        };
        tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error("idb write transaction aborted"));
        };
        tx.objectStore(store_name).put(handle, record_key);
    });
}

/** Возвращает handle или `null`, если записи нет или тип не directory handle. */
export async function idb_load_directory_handle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await open_db();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(store_name, "readonly");
        const request = tx.objectStore(store_name).get(record_key);
        request.onerror = () => {
            db.close();
            reject(request.error ?? new Error("idb get failed"));
        };
        request.onsuccess = () => {
            const value: unknown = request.result;
            db.close();
            if (value instanceof FileSystemDirectoryHandle) {
                resolve(value);
                return;
            }
            resolve(null);
        };
    });
}

/** Удаляет сохранённый handle (отзыв доступа / сброс выбора). */
export async function idb_clear_directory_handle(): Promise<void> {
    const db = await open_db();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store_name, "readwrite");
        tx.oncomplete = () => {
            db.close();
            resolve();
        };
        tx.onerror = () => {
            db.close();
            reject(tx.error ?? new Error("idb clear transaction failed"));
        };
        tx.onabort = () => {
            db.close();
            reject(tx.error ?? new Error("idb clear transaction aborted"));
        };
        tx.objectStore(store_name).delete(record_key);
    });
}
