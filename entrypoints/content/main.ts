import "./content.css";
import { daemon_health } from "../shared/daemon_client";
import { create_logger } from "../shared/logger";
import { subscribe_image_dom_changes } from "./image_observer";
import { ImageOverlayController } from "./overlay";
import { OutcomeCacheRegistry } from "./outcome_cache";
import { query_image_elements } from "./query_images";

const log = create_logger("content");

const observer_debounce_ms = 100;
const daemon_gate_retry_ms = 3000;
const daemon_save_directory_key = "daemon_save_directory";

/**
 * Оверлеи на изображениях при `permission_state === "granted"` для папки сохранения.
 * @remarks Подписки: `storage.onChanged`, пинг из SW, `visibilitychange`, `job_status`; снятие на `pagehide`.
 */
export function run_content_app(): void {
  const outcome_cache = new OutcomeCacheRegistry();
  const in_flight = new Set<string>();
  const active = new Map<HTMLImageElement, ImageOverlayController>();
  const observed_signatures = new Map<HTMLImageElement, string>();

  let overlays_enabled = false;
  let observer: Readonly<{ disconnect(): void }> | null = null;
  let gate_retry_timer: ReturnType<typeof setTimeout> | null = null;
  const deps = { outcome_cache, in_flight };

  const image_signature = (img: HTMLImageElement): string => {
    const current_src = img.currentSrc ?? "";
    const src = img.getAttribute("src") ?? "";
    const srcset = img.getAttribute("srcset") ?? "";
    return `${current_src}||${src}||${srcset}`;
  };

  const teardown_overlays = (): void => {
    for (const ctrl of active.values()) {
      ctrl.dispose();
    }
    active.clear();
    observed_signatures.clear();
  };

  const stop_observer = (): void => {
    if (observer !== null) {
      observer.disconnect();
      observer = null;
    }
  };

  const clear_gate_retry = (): void => {
    if (gate_retry_timer !== null) {
      clearTimeout(gate_retry_timer);
      gate_retry_timer = null;
    }
  };

  const schedule_gate_retry = (): void => {
    if (gate_retry_timer !== null) {
      return;
    }
    gate_retry_timer = setTimeout(() => {
      gate_retry_timer = null;
      void apply_daemon_gate();
    }, daemon_gate_retry_ms);
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
        observed_signatures.delete(img);
      }
    }

    for (const img of found) {
      const next_signature = image_signature(img);
      if (!active.has(img)) {
        active.set(img, new ImageOverlayController(img, deps));
        observed_signatures.set(img, next_signature);
      } else {
        const prev_signature = observed_signatures.get(img);
        if (prev_signature !== next_signature) {
          observed_signatures.set(img, next_signature);
          void active.get(img)!.refresh();
        }
      }
    }
  };

  const has_configured_directory = async (): Promise<boolean> => {
    const bag = await browser.storage.local.get([daemon_save_directory_key]);
    const raw = bag[daemon_save_directory_key];
    return typeof raw === "string" && raw.trim().length > 0;
  };

  const apply_daemon_gate = async (): Promise<void> => {
    let next = false;
    try {
      const has_directory = await has_configured_directory();
      if (!has_directory) {
        next = false;
      } else {
        await daemon_health();
        next = true;
      }
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
      const has_directory = await has_configured_directory();
      if (!has_directory) {
        clear_gate_retry();
        log.info("content overlays disabled: save directory is not configured");
      } else {
        log.info("content overlays disabled: daemon unavailable");
        schedule_gate_retry();
      }
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
    clear_gate_retry();
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

  const on_storage_changed = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area: string
  ): void => {
    if (area !== "local" || changes[daemon_save_directory_key] === undefined) {
      return;
    }
    void apply_daemon_gate();
  };

  void apply_daemon_gate()
    .then(() => {
      document.addEventListener("visibilitychange", on_visibility_change);
      browser.storage.onChanged.addListener(on_storage_changed);

      const on_page_hide = (): void => {
        window.removeEventListener("pagehide", on_page_hide);
        document.removeEventListener("visibilitychange", on_visibility_change);
        browser.storage.onChanged.removeListener(on_storage_changed);
        clear_gate_retry();
        stop_observer();
        teardown_overlays();
      };
      window.addEventListener("pagehide", on_page_hide);
    })
    .catch((error: unknown) => {
      log.warn("daemon gate failed", { error });
    });
}
