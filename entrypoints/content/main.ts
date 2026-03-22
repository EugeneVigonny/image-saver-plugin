import "./content.css";
import { storage_keys } from "../shared/contracts";
import { is_directory_access_updated_message } from "../shared/directory_access_ping";
import { create_logger } from "../shared/logger";
import { send_get_directory_access_state_message } from "../shared/send_get_directory_access_state_message";
import { subscribe_image_dom_changes } from "./image_observer";
import { ImageOverlayController } from "./overlay";
import { query_image_elements } from "./query_images";
import { SessionSavedDedupRegistry } from "./session_saved_keys";

const log = create_logger("content");

const observer_debounce_ms = 100;

function is_save_directory_granted(
    response: Awaited<ReturnType<typeof send_get_directory_access_state_message>>,
): boolean {
    return response.ok && response.data.permission_state === "granted";
}

/**
 * Оверлеи на изображениях при `permission_state === "granted"` для папки сохранения.
 * @remarks Подписки: `storage.onChanged`, пинг из SW, `visibilitychange`; снятие на `pagehide`.
 */
export function run_content_app(): void {
    const registry = new SessionSavedDedupRegistry();
    const in_flight = new Set<string>();
    const deps = { registry, in_flight };
    const active = new Map<HTMLImageElement, ImageOverlayController>();

    let overlays_enabled = false;
    let observer: Readonly<{ disconnect(): void }> | null = null;

    const teardown_overlays = (): void => {
        for (const ctrl of active.values()) {
            ctrl.dispose();
        }
        active.clear();
    };

    const stop_observer = (): void => {
        if (observer !== null) {
            observer.disconnect();
            observer = null;
        }
    };

    const reconcile = (): void => {
        if (!overlays_enabled) {
            return;
        }
        const imgs = query_image_elements(document);
        const found = new Set(imgs);

        for (const [img, ctrl] of [...active.entries()]) {
            if (!found.has(img) || !document.contains(img)) {
                ctrl.dispose();
                active.delete(img);
            }
        }

        for (const img of found) {
            if (!active.has(img)) {
                active.set(img, new ImageOverlayController(img, deps));
            } else {
                void active.get(img)!.refresh();
            }
        }
    };

    const apply_directory_gate = async (): Promise<void> => {
        const access = await send_get_directory_access_state_message();
        log.debug("apply_directory_gate: sw", {
            ok: access.ok,
            ...(access.ok
                ? {
                      permission_state: access.data.permission_state,
                      directory_name: access.data.directory_name,
                  }
                : { error: access.error.details }),
            overlays_enabled_now: overlays_enabled,
        });
        const next = is_save_directory_granted(access);
        if (next === overlays_enabled) {
            if (next) {
                reconcile();
            }
            return;
        }
        overlays_enabled = next;
        if (!overlays_enabled) {
            log.info("content overlays disabled: save directory not granted");
            teardown_overlays();
            stop_observer();
            return;
        }
        log.info("content overlays enabled: save directory granted");
        try {
            await registry.ensure_loaded();
        } catch (error: unknown) {
            log.warn("session saved registry load failed", { error });
        }
        if (observer === null) {
            observer = subscribe_image_dom_changes(reconcile, observer_debounce_ms);
        }
        reconcile();
        log.debug("apply_directory_gate: overlays on", { overlay_count: active.size });
    };

    const on_storage_changed = (
        changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
        area: string,
    ): void => {
        if (area !== "local") {
            return;
        }
        if (changes[storage_keys.save_dir_meta] !== undefined) {
            log.debug("content: storage save_dir_meta changed → apply_directory_gate");
            void apply_directory_gate();
        }
    };

    const on_runtime_directory_ping = (message: unknown): boolean | undefined => {
        if (!is_directory_access_updated_message(message)) {
            return undefined;
        }
        log.debug("content: runtime directory ping → apply_directory_gate");
        void apply_directory_gate();
        return undefined;
    };

    const on_visibility_change = (): void => {
        if (document.visibilityState === "visible") {
            log.debug("content: visibility visible → apply_directory_gate");
            void apply_directory_gate();
        }
    };

    browser.storage.onChanged.addListener(on_storage_changed);
    browser.runtime.onMessage.addListener(on_runtime_directory_ping);

    void apply_directory_gate()
        .then(() => {
            document.addEventListener("visibilitychange", on_visibility_change);

            const on_page_hide = (): void => {
                window.removeEventListener("pagehide", on_page_hide);
                document.removeEventListener("visibilitychange", on_visibility_change);
                browser.storage.onChanged.removeListener(on_storage_changed);
                browser.runtime.onMessage.removeListener(on_runtime_directory_ping);
                stop_observer();
                teardown_overlays();
            };
            window.addEventListener("pagehide", on_page_hide);
        })
        .catch((error: unknown) => {
            log.warn("directory gate failed", { error });
        });
}
