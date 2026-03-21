import "./content.css";
import { create_logger } from "../shared/logger";
import { subscribe_image_dom_changes } from "./image_observer";
import { ImageOverlayController } from "./overlay";
import { query_image_elements } from "./query_images";
import { SessionSavedDedupRegistry } from "./session_saved_keys";

const log = create_logger("content");

const observer_debounce_ms = 100;

/**
 * Точка входа content UI: сканирование `img`, оверлеи, observer, teardown на `pagehide`.
 */
export function run_content_app(): void {
    const registry = new SessionSavedDedupRegistry();
    const in_flight = new Set<string>();
    const deps = { registry, in_flight };
    const active = new Map<HTMLImageElement, ImageOverlayController>();

    const reconcile = (): void => {
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

    void registry
        .ensure_loaded()
        .then(() => {
            reconcile();
            const sub = subscribe_image_dom_changes(reconcile, observer_debounce_ms);
            const on_page_hide = (): void => {
                window.removeEventListener("pagehide", on_page_hide);
                sub.disconnect();
                for (const ctrl of active.values()) {
                    ctrl.dispose();
                }
                active.clear();
            };
            window.addEventListener("pagehide", on_page_hide);
        })
        .catch((error: unknown) => {
            log.warn("session saved registry load failed", { error });
            reconcile();
        });
}
