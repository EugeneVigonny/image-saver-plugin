import {
    create_invalid_message_error,
    runtime_message_types,
    storage_keys,
    type DirectoryAccessStateResult,
    type PopupDirectoryState,
    is_runtime_request_message,
    type RestoreDirectoryAccessResult,
    type QueueState,
    type RuntimeRequestMessage,
    type RuntimeResponse,
    type SaveJob,
} from "./shared/contracts";
import { idb_clear_directory_handle, idb_load_directory_handle } from "./shared/directory_handle_idb";
import { create_logger } from "./shared/logger";

const log = create_logger("background");

type QueueSaveResult = Readonly<{
    accepted_job_id: string;
    queue_state: QueueState;
}>;

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
    const pending_jobs: SaveJob[] = [];

    function build_queue_state(processing_job_id: string | null): QueueState {
        return {
            pending_jobs: [...pending_jobs],
            processing_job_id,
            total_jobs: pending_jobs.length,
            updated_at: Date.now(),
        };
    }

    async function handle_runtime_request(message: RuntimeRequestMessage): Promise<BackgroundResponse> {
        log.debug("handle_runtime_request", { type: message.type });
        switch (message.type) {
            case runtime_message_types.queue_save: {
                pending_jobs.push(message.payload);
                log.info("queue_save accepted", { job_id: message.payload.job_id });
                return {
                    ok: true,
                    data: {
                        accepted_job_id: message.payload.job_id,
                        queue_state: build_queue_state(null),
                    },
                };
            }
            case runtime_message_types.get_queue_state: {
                log.info("get_queue_state", { pending: pending_jobs.length });
                return {
                    ok: true,
                    data: {
                        queue_state: build_queue_state(null),
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

    async function read_saved_directory_name(): Promise<string | null> {
        const result = await browser.storage.local.get(storage_keys.save_dir_meta);
        const meta = result[storage_keys.save_dir_meta] as { name?: unknown } | undefined;
        return typeof meta?.name === "string" ? meta.name : null;
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

    async function get_directory_access_state_use_case(): Promise<BackgroundResponse> {
        try {
            const handle = await read_saved_directory_handle();
            const directory_name = await read_saved_directory_name();
            if (!handle) {
                log.info("get_directory_access_state_use_case", { result: "not_selected" });
                return {
                    ok: true,
                    data: {
                        directory_name: null,
                        permission_state: "not_selected",
                    },
                };
            }
            let permission: PermissionState;
            try {
                permission = await handle.queryPermission({ mode: "readwrite" });
            } catch (query_error) {
                log.warn("queryPermission failed (stale handle?); clearing keys", { query_error });
                await clear_saved_directory();
                return {
                    ok: true,
                    data: {
                        directory_name: null,
                        permission_state: "not_selected",
                    },
                };
            }
            const permission_state = map_permission_state(permission);
            log.info("get_directory_access_state_use_case", {
                permission_state,
                has_directory_name: directory_name !== null,
            });
            return {
                ok: true,
                data: {
                    directory_name,
                    permission_state,
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
