import "./content.css";
import { daemon_health } from "../shared/daemon_client";
import { create_logger } from "../shared/logger";
import { subscribe_image_dom_changes } from "./image_observer";
import { ImageOverlayController } from "./overlay";
import { OutcomeCacheRegistry } from "./outcome_cache";
import { query_image_elements } from "./query_images";

const log = create_logger("content");

const observer_debounce_ms = 100;

/**
 * Оверлеи на изображениях при `permission_state === "granted"` для папки сохранения.
 * @remarks Подписки: `storage.onChanged`, пинг из SW, `visibilitychange`, `job_status`; снятие на `pagehide`.
 */
export function run_content_app(): void {
  const outcome_cache = new OutcomeCacheRegistry();
  const in_flight = new Set<string>();
  const active = new Map<HTMLImageElement, ImageOverlayController>();

  let overlays_enabled = false;
  let observer: Readonly<{ disconnect(): void }> | null = null;
  const deps = { outcome_cache, in_flight };

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

  const apply_daemon_gate = async (): Promise<void> => {
    let next = false;
    try {
      await daemon_health();
      next = true;
    } catch (error) {
      log.warn("apply_daemon_gate: daemon is unavailable", { error });
      next = false;
    }
    if (next === overlays_enabled) {
      if (next) {
        reconcile();
      }
      return;
    }
    overlays_enabled = next;
    if (!overlays_enabled) {
      log.info("content overlays disabled: daemon unavailable");
      in_flight.clear();
      try {
        await outcome_cache.clear_all();
      } catch (error: unknown) {
        log.warn("outcome cache clear failed", { error });
      }
      teardown_overlays();
      stop_observer();
      return;
    }
    log.info("content overlays enabled: daemon available");
    try {
      await outcome_cache.ensure_loaded();
    } catch (error: unknown) {
      log.warn("outcome cache load failed", { error });
    }
    if (observer === null) {
      observer = subscribe_image_dom_changes(reconcile, observer_debounce_ms);
    }
    reconcile();
    log.debug("apply_daemon_gate: overlays on", { overlay_count: active.size });
  };

  const on_visibility_change = (): void => {
    if (document.visibilityState === "visible") {
      log.debug("content: visibility visible → apply_daemon_gate");
      void apply_daemon_gate();
    }
  };

  void apply_daemon_gate()
    .then(() => {
      document.addEventListener("visibilitychange", on_visibility_change);

      const on_page_hide = (): void => {
        window.removeEventListener("pagehide", on_page_hide);
        document.removeEventListener("visibilitychange", on_visibility_change);
        stop_observer();
        teardown_overlays();
      };
      window.addEventListener("pagehide", on_page_hide);
    })
    .catch((error: unknown) => {
      log.warn("daemon gate failed", { error });
    });
}
