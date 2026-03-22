import {
    create_invalid_message_error,
    runtime_message_types,
    storage_keys,
    type DirectoryAccessStateResult,
    type PopupDirectoryState,
    type SaveDirMeta,
    is_runtime_request_message,
    type RestoreDirectoryAccessResult,
    type QueueSaveResult,
    type QueueSnapshot,
    type QueueState,
    type RuntimeRequestMessage,
    type RuntimeResponse,
} from "./shared/contracts";
import {
    DIRECTORY_ACCESS_UPDATED_MESSAGE_TYPE,
    type DirectoryAccessUpdatedMessage,
} from "./shared/directory_access_ping";
import { download_image } from "./shared/download_image";
import { format_url_for_debug } from "./shared/format_url_for_debug";
import { idb_clear_directory_handle, idb_load_directory_handle } from "./shared/directory_handle_idb";
import { emit_job_status } from "./shared/emit_job_status";
import { create_logger } from "./shared/logger";
import {
    build_queue_state,
    enqueue_job,
    load_queue_snapshot,
    normalize_interrupted_jobs,
    peek_next_queued_job,
    persist_queue_snapshot,
    remove_job,
    set_processing_job_id,
    update_record_status,
} from "./shared/queue_store";
import { resize_image_to_jpeg_blob } from "./shared/resize_image";
import { write_blob_to_directory } from "./shared/write_image_to_directory";

const log = create_logger("background");

/** Пока SW «залипает» на `prompt`, content опирается на снимок из popup (`readwrite_at_pick`). */
const trust_popup_readwrite_max_age_ms = 15 * 60 * 1000;

type GetQueueStateResult = Readonly<{
    queue_state: QueueState;
}>;

type BackgroundResponse = RuntimeResponse<
    QueueSaveResult | GetQueueStateResult | DirectoryAccessStateResult | RestoreDirectoryAccessResult
>;

type PermissionDescriptor = {
    mode: "read" | "readwrite";
};

type DirectoryHandleLike = FileSystemDirectoryHandle & {
    queryPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
};

type PermissionState = "granted" | "denied" | "prompt";

function is_directory_handle_like(value: object): value is DirectoryHandleLike {
    const candidate = value as DirectoryHandleLike;
    return (
        typeof candidate.queryPermission === "function" && typeof candidate.requestPermission === "function"
    );
}

async function clear_saved_directory(): Promise<void> {
    try {
        await idb_clear_directory_handle();
    } catch (error) {
        log.warn("idb_clear_directory_handle failed", { error });
    }
    await browser.storage.local.remove([storage_keys.save_dir_handle, storage_keys.save_dir_meta]);
}

export default defineBackground(() => {
    /** Кэш снимка очереди (single writer в SW). */
    let cached_snapshot: QueueSnapshot | null = null;
    let is_processing_queue = false;

    async function get_snapshot(): Promise<QueueSnapshot> {
        if (cached_snapshot === null) {
            let snapshot = await load_queue_snapshot();
            snapshot = normalize_interrupted_jobs(snapshot);
            await persist_queue_snapshot(snapshot);
            cached_snapshot = snapshot;
        }
        return cached_snapshot;
    }

    async function save_snapshot(snapshot: QueueSnapshot): Promise<void> {
        cached_snapshot = snapshot;
        await persist_queue_snapshot(snapshot);
    }

    async function process_queue_loop(): Promise<void> {
        if (is_processing_queue) {
            log.debug("process_queue_loop: skip (already running)");
            return;
        }
        is_processing_queue = true;
        log.debug("process_queue_loop: start pass");
        try {
            for (;;) {
                const snapshot = await get_snapshot();
                const next = peek_next_queued_job(snapshot);
                if (next === undefined) {
                    log.debug("process_queue_loop: idle");
                    break;
                }
                const job_id = next.job.job_id;
                log.debug("process_queue_loop: job", {
                    job_id,
                    url: format_url_for_debug(next.job.url),
                    suggested_name: next.job.suggested_name,
                    queued_total: snapshot.jobs.filter((r) => r.status === "queued").length,
                });
                let working = set_processing_job_id(snapshot, job_id);
                working = update_record_status(working, job_id, "downloading");
                await save_snapshot(working);
                await emit_job_status({
                    job_id,
                    status: "downloading",
                    updated_at: Date.now(),
                });

                try {
                    const blob = await download_image(next.job.url);
                    log.debug("process_queue_loop: downloaded", {
                        job_id,
                        bytes: blob.size,
                        type: blob.type || "(empty)",
                    });
                    working = await get_snapshot();
                    working = update_record_status(working, job_id, "resizing");
                    await save_snapshot(working);
                    await emit_job_status({
                        job_id,
                        status: "resizing",
                        updated_at: Date.now(),
                    });

                    const jpeg_blob = await resize_image_to_jpeg_blob(blob);
                    log.debug("process_queue_loop: after resize", {
                        job_id,
                        bytes: jpeg_blob.size,
                        type: jpeg_blob.type || "(empty)",
                    });
                    working = await get_snapshot();
                    working = update_record_status(working, job_id, "writing");
                    await save_snapshot(working);
                    await emit_job_status({
                        job_id,
                        status: "writing",
                        updated_at: Date.now(),
                    });

                    const directory = await read_saved_directory_handle();
                    if (directory === null) {
                        throw new Error("Save directory not selected");
                    }
                    const permission = await settle_readwrite_permission(directory);
                    /**
                     * Запись и `getFileHandle` в SW требуют **фактического** `queryPermission === "granted"`.
                     * `is_readwrite_effective_in_extension` (мета popup при «залипшем» `prompt`) — только для UI content/popup;
                     * при `prompt` браузер всё равно режет FS API → NotAllowedError на `getFileHandle`.
                     */
                    if (permission !== "granted") {
                        throw new Error(
                            "Directory read/write is not granted in the service worker (open the extension popup once to refresh permission).",
                        );
                    }

                    const file_name = await write_blob_to_directory(directory, next.job.suggested_name, jpeg_blob);
                    const completed_at = Date.now();
                    working = await get_snapshot();
                    working = remove_job(working, job_id);
                    working = set_processing_job_id(working, null);
                    await save_snapshot(working);
                    await emit_job_status({
                        job_id,
                        status: "done",
                        updated_at: completed_at,
                        outcome: {
                            kind: "ok",
                            job_id,
                            file_name,
                            completed_at,
                        },
                    });
                    log.info("job completed", { job_id, file_name });
                    log.debug("process_queue_loop: job done", { job_id, file_name });
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    log.warn("job failed", { job_id, reason });
                    let failed_snap = await get_snapshot();
                    failed_snap = remove_job(failed_snap, job_id);
                    failed_snap = set_processing_job_id(failed_snap, null);
                    await save_snapshot(failed_snap);
                    await emit_job_status({
                        job_id,
                        status: "failed",
                        updated_at: Date.now(),
                        outcome: {
                            kind: "fatal_error",
                            job_id,
                            reason,
                        },
                    });
                }
            }
        } finally {
            is_processing_queue = false;
            log.debug("process_queue_loop: end pass");
        }
    }

    async function handle_runtime_request(message: RuntimeRequestMessage): Promise<BackgroundResponse> {
        log.debug("handle_runtime_request", { type: message.type });
        switch (message.type) {
            case runtime_message_types.queue_save: {
                log.debug("queue_save: payload", {
                    job_id: message.payload.job_id,
                    url: format_url_for_debug(message.payload.url),
                    suggested_name: message.payload.suggested_name,
                    created_at: message.payload.created_at,
                });
                const snapshot = await get_snapshot();
                const { snapshot: next, accepted_job_id, was_duplicate } = enqueue_job(snapshot, message.payload);
                await save_snapshot(next);
                log.info("queue_save accepted", { job_id: accepted_job_id, was_duplicate });
                void process_queue_loop();
                return {
                    ok: true,
                    data: {
                        accepted_job_id,
                        queue_state: build_queue_state(next),
                        was_duplicate,
                    },
                };
            }
            case runtime_message_types.get_queue_state: {
                const snapshot = await get_snapshot();
                log.debug("get_queue_state", {
                    pending: snapshot.jobs.length,
                    processing_job_id: snapshot.processing_job_id,
                });
                return {
                    ok: true,
                    data: {
                        queue_state: build_queue_state(snapshot),
                    },
                };
            }
            case runtime_message_types.get_directory_access_state: {
                log.info("get_directory_access_state");
                return get_directory_access_state_use_case();
            }
            case runtime_message_types.restore_directory_access: {
                log.info("restore_directory_access");
                return restore_directory_access_use_case();
            }
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    async function read_saved_directory_handle(): Promise<DirectoryHandleLike | null> {
        let handle: unknown;
        try {
            handle = await idb_load_directory_handle();
        } catch (error) {
            log.warn("idb_load_directory_handle failed", { error });
            handle = null;
        }
        if (handle && typeof handle === "object" && is_directory_handle_like(handle)) {
            return handle;
        }
        const legacy = await browser.storage.local.get(storage_keys.save_dir_handle);
        if (legacy[storage_keys.save_dir_handle] !== undefined) {
            log.info("removing legacy save_dir_handle from chrome.storage.local (use IndexedDB only)");
            await browser.storage.local.remove([storage_keys.save_dir_handle]);
        }
        return null;
    }

    async function read_save_dir_meta(): Promise<SaveDirMeta | null> {
        const result = await browser.storage.local.get(storage_keys.save_dir_meta);
        const raw = result[storage_keys.save_dir_meta];
        if (raw === null || raw === undefined || typeof raw !== "object") {
            return null;
        }
        const row = raw as Record<string, unknown>;
        if (typeof row["name"] !== "string") {
            return null;
        }
        const name = row["name"];
        const updated_at = typeof row["updated_at"] === "number" ? row["updated_at"] : Date.now();
        const rp = row["readwrite_at_pick"];
        const readwrite_at_pick =
            rp === "granted" || rp === "prompt" || rp === "denied"
                ? (rp as NonNullable<SaveDirMeta["readwrite_at_pick"]>)
                : undefined;
        if (readwrite_at_pick !== undefined) {
            return { name, updated_at, readwrite_at_pick };
        }
        return { name, updated_at };
    }

    /**
     * После записи меты в storage handle в IDB может стать виден SW с задержкой (другая вкладка БД).
     */
    async function read_saved_directory_handle_after_meta_set(): Promise<DirectoryHandleLike | null> {
        const max_attempts = 15;
        const pause_ms = 40;
        for (let attempt = 0; attempt < max_attempts; attempt++) {
            const h = await read_saved_directory_handle();
            if (h !== null) {
                return h;
            }
            await new Promise<void>((resolve) => {
                setTimeout(resolve, pause_ms);
            });
        }
        return null;
    }

    /**
     * Сразу после жеста в popup `queryPermission` в service worker часто кратко остаётся `prompt`;
     * повторяем с паузой (см. `sync_after_gesture_delay_ms` в popup).
     */
    async function settle_readwrite_permission(handle: DirectoryHandleLike): Promise<PermissionState> {
        let permission = await handle.queryPermission({ mode: "readwrite" });
        if (permission !== "prompt") {
            return permission;
        }
        const max_rounds = 10;
        const pause_ms = 50;
        for (let round = 0; round < max_rounds; round++) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, pause_ms);
            });
            permission = await handle.queryPermission({ mode: "readwrite" });
            if (permission !== "prompt") {
                log.info("settle_readwrite_permission: resolved after wait", { round });
                return permission;
            }
        }
        return permission;
    }

    function map_permission_state(permission: PermissionState | null): PopupDirectoryState {
        if (permission === "granted") {
            return "granted";
        }
        if (permission === "prompt") {
            return "prompt";
        }
        if (permission === "denied") {
            return "denied";
        }
        return "not_selected";
    }

    /**
     * Только для **отображения** состояния (content/popup): «как будто granted», если popup недавно подтвердил readwrite.
     * Для **записи на диск** из SW см. строгую проверку `permission === "granted"` в `process_queue_loop`.
     */
    function is_readwrite_effective_in_extension(
        raw_sw_permission: PermissionState,
        meta_row: SaveDirMeta | null,
    ): boolean {
        if (raw_sw_permission === "granted") {
            return true;
        }
        return (
            raw_sw_permission === "prompt" &&
            meta_row?.readwrite_at_pick === "granted" &&
            Date.now() - meta_row.updated_at < trust_popup_readwrite_max_age_ms
        );
    }

    async function get_directory_access_state_use_case(): Promise<BackgroundResponse> {
        try {
            const meta_row = await read_save_dir_meta();
            const directory_name = meta_row?.name ?? null;
            let handle = await read_saved_directory_handle();
            if (!handle && directory_name !== null) {
                log.info("get_directory_access_state_use_case: idb handle missing while meta exists, retrying");
                handle = await read_saved_directory_handle_after_meta_set();
            }
            if (!handle) {
                log.info("get_directory_access_state_use_case", { result: "not_selected" });
                return {
                    ok: true,
                    data: {
                        directory_name: null,
                        permission_state: "not_selected",
                        service_worker_readwrite_granted: false,
                    },
                };
            }
            let permission: PermissionState;
            try {
                permission = await settle_readwrite_permission(handle);
            } catch (query_error) {
                log.warn("queryPermission failed (stale handle?); clearing keys", { query_error });
                await clear_saved_directory();
                return {
                    ok: true,
                    data: {
                        directory_name: null,
                        permission_state: "not_selected",
                        service_worker_readwrite_granted: false,
                    },
                };
            }
            log.debug("get_directory_access_state_use_case: raw_sw", {
                raw_permission: permission,
                directory_name,
                readwrite_at_pick: meta_row?.readwrite_at_pick,
                meta_age_ms: meta_row !== null ? Date.now() - meta_row.updated_at : null,
            });
            let permission_state = map_permission_state(permission);
            if (permission_state === "prompt" && is_readwrite_effective_in_extension(permission, meta_row)) {
                log.info("get_directory_access_state_use_case: trust readwrite_at_pick while SW reports prompt", {
                    age_ms: meta_row !== null ? Date.now() - meta_row.updated_at : 0,
                });
                permission_state = "granted";
            }
            const service_worker_readwrite_granted = permission === "granted";
            log.info("get_directory_access_state_use_case", {
                permission_state,
                service_worker_readwrite_granted,
                has_directory_name: directory_name !== null,
            });
            return {
                ok: true,
                data: {
                    directory_name,
                    permission_state,
                    service_worker_readwrite_granted,
                },
            };
        } catch (error) {
            const details =
                error instanceof Error
                    ? `Failed to read directory access state: ${error.message}`
                    : "Failed to read directory access state";
            log.warn("get_directory_access_state_use_case failed", { error });
            return {
                ok: false,
                error: create_invalid_message_error(details),
            };
        }
    }

    async function restore_directory_access_use_case(): Promise<BackgroundResponse> {
        log.warn(
            "restore_directory_access in service worker is unsupported: requestPermission requires user gesture (popup)",
        );
        return {
            ok: false,
            error: create_invalid_message_error(
                "restore_directory_access must run in extension popup (user gesture required for requestPermission)",
            ),
        };
    }

    void (async () => {
        await get_snapshot();
        void process_queue_loop();
    })();

    async function notify_tabs_directory_access_changed(): Promise<void> {
        const message: DirectoryAccessUpdatedMessage = {
            type: DIRECTORY_ACCESS_UPDATED_MESSAGE_TYPE,
        };
        try {
            const tabs = await browser.tabs.query({});
            let delivered = 0;
            for (const tab of tabs) {
                if (tab.id === undefined) {
                    continue;
                }
                try {
                    await browser.tabs.sendMessage(tab.id, message);
                    delivered += 1;
                } catch {
                    /* не http(s), нет content script или нет receiver */
                }
            }
            log.debug("notify_tabs_directory_access_changed", {
                tabs_queried: tabs.length,
                content_pings_delivered: delivered,
            });
        } catch (error) {
            log.warn("notify_tabs_directory_access_changed failed", { error });
        }
    }

    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || changes[storage_keys.save_dir_meta] === undefined) {
            return;
        }
        log.debug("storage.onChanged: save_dir_meta → ping content tabs");
        void notify_tabs_directory_access_changed();
    });

    browser.runtime.onMessage.addListener(
        (message: unknown, _sender, send_response): boolean | undefined => {
            if (typeof send_response !== "function") {
                log.warn("onMessage without send_response; async reply unsupported");
                return undefined;
            }

            void (async () => {
                try {
                    if (!is_runtime_request_message(message)) {
                        const error = create_invalid_message_error(
                            "Expected valid runtime request (queue_save, get_queue_state, get_directory_access_state, restore_directory_access)",
                        );
                        log.warn("rejected runtime message", { error, message });
                        send_response({
                            ok: false,
                            error,
                        } satisfies BackgroundResponse);
                        return;
                    }

                    const result = await handle_runtime_request(message);
                    send_response(result);
                } catch (error) {
                    log.error("onMessage handler failed", { error });
                    send_response({
                        ok: false,
                        error: create_invalid_message_error(
                            error instanceof Error ? error.message : "Unexpected background error",
                        ),
                    } satisfies BackgroundResponse);
                }
            })();

            return true;
        },
    );
});
