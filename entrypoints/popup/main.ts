import "./style.css";
import {
    runtime_message_types,
    storage_keys,
    type PopupDirectoryState,
    type PopupViewModel,
    type RestoreDirectoryAccessMessage,
    type RestoreDirectoryAccessResult,
    type RuntimeResponse,
    type SaveDirMeta,
} from "@/entrypoints/shared/contracts";
import { create_logger } from "@/entrypoints/shared/logger";
import { idb_load_directory_handle, idb_save_directory_handle } from "@/entrypoints/shared/directory_handle_idb";
import { normalize_runtime_send_message_result } from "@/entrypoints/shared/normalize_runtime_response";
import { send_get_directory_access_state_message } from "@/entrypoints/shared/send_get_directory_access_state_message";

const log = create_logger("popup");

/** Задержка перед `sync_access_state` после жеста: право в SW может обновиться не сразу. */
const sync_after_gesture_delay_ms = 100;

function delay_ms(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

type SelectDirectoryResult = Readonly<{
    directory_name: string;
    permission_state: PopupDirectoryState;
}>;

/**
 * Итог выбора папки: отмена диалога либо обычный `RuntimeResponse` с именем и `permission_state`.
 */
export type SelectDirectoryUseCaseResult =
    | { readonly user_cancelled: true }
    | RuntimeResponse<SelectDirectoryResult>;

function is_user_abort_directory_picker_error(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") {
        return true;
    }
    if (error instanceof Error && error.name === "AbortError") {
        return true;
    }
    return false;
}

type PermissionDescriptor = {
    mode: "read" | "readwrite";
};

type DirectoryHandleLike = FileSystemDirectoryHandle & {
    queryPermission(descriptor?: PermissionDescriptor): Promise<"granted" | "denied" | "prompt">;
    requestPermission(descriptor?: PermissionDescriptor): Promise<"granted" | "denied" | "prompt">;
};

const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;

let view_model: PopupViewModel = {
    directory_name: null,
    permission_state: "not_selected",
    is_busy: false,
    last_error: null,
};

function set_view_model(next: PopupViewModel): void {
    view_model = next;
    render();
}

function set_busy(is_busy: boolean): void {
    set_view_model({
        ...view_model,
        is_busy,
    });
}

function create_error_response(details: string): RuntimeResponse<never> {
    return {
        ok: false,
        error: {
            code: "invalid_message",
            message: "Popup operation failed",
            details,
        },
    };
}

/** Прокси `restore_directory_access` в SW (без user gesture диалог из SW не показать). */
export async function send_restore_directory_access_message(): Promise<
    RuntimeResponse<RestoreDirectoryAccessResult>
> {
    log.debug("send_restore_directory_access_message");
    const message: RestoreDirectoryAccessMessage = {
        type: runtime_message_types.restore_directory_access,
    };
    const raw = await browser.runtime.sendMessage(message);
    const response = normalize_runtime_send_message_result<RestoreDirectoryAccessResult>(
        raw,
        "send_restore_directory_access_message",
    );
    log.info("send_restore_directory_access_message done", { ok: response.ok });
    return response;
}

/**
 * Восстановление read/write по сохранённому handle из IDB.
 * @remarks Только из обработчика клика; обновляет `save_dir_meta.readwrite_at_pick`.
 */
export async function restore_directory_access_popup_use_case(): Promise<
    RuntimeResponse<RestoreDirectoryAccessResult>
> {
    log.info("restore_directory_access_popup_use_case");
    try {
        const raw_handle = await idb_load_directory_handle();
        if (!raw_handle || !(raw_handle instanceof FileSystemDirectoryHandle)) {
            return create_error_response("Папка не выбрана: нет handle в IndexedDB");
        }
        const handle = raw_handle as DirectoryHandleLike;
        if (typeof handle.requestPermission !== "function") {
            return create_error_response("Handle не поддерживает requestPermission");
        }
        const meta_result = await browser.storage.local.get(storage_keys.save_dir_meta);
        const meta = meta_result[storage_keys.save_dir_meta] as SaveDirMeta | undefined;
        const directory_name =
            typeof meta?.name === "string" ? meta.name : (handle.name !== "" ? handle.name : null);

        const permission = await handle.requestPermission({ mode: "readwrite" });
        const permission_state: PopupDirectoryState =
            permission === "granted" ? "granted" : permission === "prompt" ? "prompt" : "denied";

        const readwrite_at_pick: NonNullable<SaveDirMeta["readwrite_at_pick"]> =
            permission === "granted" ? "granted" : permission === "prompt" ? "prompt" : "denied";
        const meta_name =
            typeof meta?.name === "string"
                ? meta.name
                : handle.name !== ""
                  ? handle.name
                  : "selected_directory";
        try {
            await browser.storage.local.set({
                [storage_keys.save_dir_meta]: {
                    name: meta_name,
                    updated_at: Date.now(),
                    readwrite_at_pick,
                } satisfies SaveDirMeta,
            });
        } catch (e) {
            log.warn("restore_directory_access: failed to persist save_dir_meta", { e });
        }

        log.info("restore_directory_access_popup_use_case done", { permission_state });
        return {
            ok: true,
            data: {
                permission_state,
                directory_name,
            },
        };
    } catch (error) {
        const details = error instanceof Error ? error.message : "restore_directory_access failed";
        log.warn("restore_directory_access_popup_use_case failed", { error });
        return create_error_response(details);
    }
}

/**
 * `showDirectoryPicker`, persist handle в IDB и `save_dir_meta` (`readwrite_at_pick`).
 * @remarks Отмена пользователем → `{ user_cancelled: true }` (не ошибка `RuntimeResponse`).
 */
export async function select_directory_use_case(): Promise<SelectDirectoryUseCaseResult> {
    log.info("select_directory_use_case start");
    try {
        const window_with_picker = window as Window & {
            showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
        };
        if (!window_with_picker.showDirectoryPicker) {
            log.warn("select_directory_use_case unsupported");
            return create_error_response("showDirectoryPicker is not supported in this browser");
        }
        const handle = (await window_with_picker.showDirectoryPicker()) as DirectoryHandleLike;
        const permission = await handle.queryPermission({ mode: "readwrite" });
        const permission_state: PopupDirectoryState =
            permission === "granted" ? "granted" : permission === "prompt" ? "prompt" : "denied";
        const directory_name = handle.name ?? "selected_directory";
        const readwrite_at_pick: NonNullable<SaveDirMeta["readwrite_at_pick"]> =
            permission === "granted" ? "granted" : permission === "prompt" ? "prompt" : "denied";
        const meta: SaveDirMeta = {
            name: directory_name,
            updated_at: Date.now(),
            readwrite_at_pick,
        };

        try {
            await idb_save_directory_handle(handle);
            await browser.storage.local.set({
                [storage_keys.save_dir_meta]: meta,
            });
            await browser.storage.local.remove([storage_keys.save_dir_handle]);
        } catch (storage_error) {
            log.error("save directory handle / meta failed", { storage_error });
            return create_error_response(
                storage_error instanceof Error
                    ? `Не удалось сохранить папку: ${storage_error.message}`
                    : "Не удалось сохранить папку (IndexedDB / storage)",
            );
        }

        log.info("select_directory_use_case success", { permission_state });
        return {
            ok: true,
            data: {
                directory_name,
                permission_state,
            },
        };
    } catch (error) {
        if (is_user_abort_directory_picker_error(error)) {
            log.debug("select_directory_use_case: user cancelled directory picker");
            return { user_cancelled: true };
        }
        const details = error instanceof Error ? error.message : "Unknown directory picker error";
        log.warn("select_directory_use_case failed", { details, error });
        return create_error_response(details);
    }
}

async function sync_access_state(): Promise<void> {
    log.debug("sync_access_state");
    const response = await send_get_directory_access_state_message();
    if (!response.ok) {
        log.warn("sync_access_state error", { details: response.error.details });
        set_view_model({
            ...view_model,
            permission_state: "error",
            last_error: response.error.details,
        });
        return;
    }

    log.info("sync_access_state ok", { permission_state: response.data.permission_state });
    set_view_model({
        ...view_model,
        directory_name: response.data.directory_name,
        permission_state: response.data.permission_state,
        last_error: null,
    });
}

async function on_select_directory_click(): Promise<void> {
    if (view_model.is_busy) {
        log.debug("on_select_directory_click skipped (busy)");
        return;
    }
    log.info("on_select_directory_click");
    set_busy(true);
    try {
        const response = await select_directory_use_case();
        if ("user_cancelled" in response) {
            return;
        }
        if (!response.ok) {
            set_view_model({
                ...view_model,
                permission_state: "error",
                last_error: response.error.details,
            });
            return;
        }
        set_view_model({
            ...view_model,
            directory_name: response.data.directory_name,
            permission_state: response.data.permission_state,
            last_error: null,
        });
    } finally {
        set_busy(false);
        await delay_ms(sync_after_gesture_delay_ms);
        await sync_access_state();
    }
}

async function on_restore_access_click(): Promise<void> {
    if (view_model.is_busy) {
        log.debug("on_restore_access_click skipped (busy)");
        return;
    }
    log.info("on_restore_access_click");
    set_busy(true);
    try {
        const response = await restore_directory_access_popup_use_case();
        if (!response.ok) {
            set_view_model({
                ...view_model,
                permission_state: "error",
                last_error: response.error.details,
            });
            return;
        }
        set_view_model({
            ...view_model,
            directory_name: response.data.directory_name,
            permission_state: response.data.permission_state,
            last_error: null,
        });
    } finally {
        set_busy(false);
        await delay_ms(sync_after_gesture_delay_ms);
        await sync_access_state();
    }
}

function render_action_button(): string {
    const disabled_attr = view_model.is_busy ? "disabled" : "";
    if (view_model.permission_state === "not_selected") {
        return `<button id="select-directory" ${disabled_attr}>Выбрать папку</button>`;
    }
    if (view_model.permission_state === "prompt" || view_model.permission_state === "denied") {
        return `<button id="restore-access" ${disabled_attr}>Восстановить доступ</button>`;
    }
    if (view_model.permission_state === "granted") {
        return `<button id="select-directory" ${disabled_attr}>Сменить папку</button>`;
    }
    return `<button id="select-directory" ${disabled_attr}>Выбрать папку повторно</button>`;
}

function render(): void {
    app.innerHTML = `
        <main class="popup-root">
            <h1>Image Saver</h1>
            <p>Состояние доступа: <strong>${view_model.permission_state}</strong></p>
            <p>Текущая папка: <strong>${view_model.directory_name ?? "не выбрана"}</strong></p>
            <div class="popup-actions">
                ${render_action_button()}
            </div>
            ${view_model.last_error ? `<p class="popup-error">${view_model.last_error}</p>` : ""}
        </main>
    `;

    const select_button = document.querySelector<HTMLButtonElement>("#select-directory");
    if (select_button) {
        select_button.addEventListener("click", () => {
            void on_select_directory_click();
        });
    }

    const restore_button = document.querySelector<HTMLButtonElement>("#restore-access");
    if (restore_button) {
        restore_button.addEventListener("click", () => {
            void on_restore_access_click();
        });
    }
}

render();
void sync_access_state();
