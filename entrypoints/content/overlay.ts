import plus_icon_url from "../../assets/content/plus-svgrepo-com.svg?url";
import ok_icon_url from "../../assets/content/ok-svgrepo-com.svg?url";
import spinner_icon_url from "../../assets/content/spinner-svgrepo-com.svg?url";
import error_icon_url from "../../assets/content/error-svgrepo-com.svg?url";
import { suggested_name_from_image_url } from "../shared/naming";
import { daemon_image_exists, daemon_save_image_from_url } from "../shared/daemon_client";
import { create_logger } from "../shared/logger";
import { IMAGE_SAVER_ROOT_ATTR } from "./constants";
import { make_job_dedup_key } from "../shared/job_dedup_key";
import { resolve_image_url_from_element } from "./resolve_image_url";
import type { OutcomeCacheRegistry } from "./outcome_cache";
import type { SaveImageOptions } from "../shared/daemon_client";

const log = create_logger("content");
const daemon_max_long_edge_key = "daemon_max_long_edge";
const daemon_quality_key = "daemon_quality";
const default_max_long_edge = 1920;
const default_quality = 85;

type OverlayVisual = "idle" | "saving" | "saved" | "error" | "hidden";

export type OverlayDeps = Readonly<{
  outcome_cache: OutcomeCacheRegistry;
  in_flight: Set<string>;
}>;

function error_to_text(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const row = error as { message?: unknown; code?: unknown };
    const message = typeof row.message === "string" ? row.message : "Unknown error";
    const code = typeof row.code === "string" ? row.code : "";
    return code.length > 0 ? `${message} (${code})` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function normalize_max_long_edge(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return default_max_long_edge;
  }
  return Math.min(8192, Math.max(1, Math.round(input)));
}

function normalize_quality(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return default_quality;
  }
  return Math.min(100, Math.max(1, Math.round(input)));
}

async function load_save_image_options(): Promise<SaveImageOptions> {
  const bag = await browser.storage.local.get([daemon_max_long_edge_key, daemon_quality_key]);
  return {
    max_long_edge: normalize_max_long_edge(bag[daemon_max_long_edge_key]),
    quality: normalize_quality(bag[daemon_quality_key])
  };
}

function unwrap_target_image(img: HTMLImageElement): void {
  const wrap = img.closest(`[${IMAGE_SAVER_ROOT_ATTR}]`);
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const wrapped_node = wrap.firstElementChild;
  if (wrapped_node === null) {
    wrap.remove();
    img.classList.remove("image-saver-plugin__target");
    return;
  }
  const parent = wrap.parentNode;
  if (parent === null) {
    return;
  }
  parent.insertBefore(wrapped_node, wrap);
  wrap.remove();
  img.classList.remove("image-saver-plugin__target");
}

function ensure_wrap(img: HTMLImageElement): HTMLElement | null {
  const target: HTMLElement =
    img.parentElement instanceof HTMLPictureElement ? img.parentElement : img;

  const existing = target.parentElement;
  if (existing !== null && existing.getAttribute(IMAGE_SAVER_ROOT_ATTR) !== null) {
    return existing;
  }
  const parent = target.parentNode;
  if (parent === null) {
    return null;
  }
  const wrap = document.createElement("span");
  wrap.setAttribute(IMAGE_SAVER_ROOT_ATTR, "");
  wrap.className = "image-saver-plugin__wrap";
  img.classList.add("image-saver-plugin__target");
  parent.insertBefore(wrap, target);
  wrap.appendChild(target);
  return wrap;
}

function create_icon_layer(src: string, alt: string, extra_class?: string): HTMLImageElement {
  const el = document.createElement("img");
  el.className =
    "image-saver-plugin__icon-layer" + (extra_class !== undefined ? ` ${extra_class}` : "");
  el.src = src;
  el.alt = alt;
  el.setAttribute("data-image-saver-visible", "false");
  return el;
}

/** Обертка вокруг страничного `img`: кнопка «сохранить», визуальные стадии, вызов `queue_save`. */
export class ImageOverlayController {
  private readonly img: HTMLImageElement;
  private readonly deps: OverlayDeps;
  private wrap: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private icon_plus: HTMLImageElement | null = null;
  private icon_ok: HTMLImageElement | null = null;
  private icon_spinner: HTMLImageElement | null = null;
  private icon_error: HTMLImageElement | null = null;
  private bound_click: (ev: MouseEvent) => void;
  private bound_image_load: () => void;
  private visual_state: OverlayVisual = "hidden";

  constructor(img: HTMLImageElement, deps: OverlayDeps) {
    this.img = img;
    this.deps = deps;
    this.bound_click = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this.on_click();
    };
    this.bound_image_load = () => {
      void this.refresh();
    };
    this.mount();
  }

  private mount(): void {
    this.wrap = ensure_wrap(this.img);
    if (this.wrap === null) {
      return;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "image-saver-plugin__btn";
    btn.setAttribute("aria-label", "Сохранить изображение");

    this.icon_plus = create_icon_layer(plus_icon_url, "Добавить в очередь");
    this.icon_ok = create_icon_layer(ok_icon_url, "Сохранено");
    this.icon_spinner = create_icon_layer(
      spinner_icon_url,
      "Сохранение…",
      "image-saver-plugin__spinner"
    );
    this.icon_error = create_icon_layer(error_icon_url, "Ошибка сохранения");

    btn.append(this.icon_plus, this.icon_ok, this.icon_spinner, this.icon_error);
    btn.addEventListener("click", this.bound_click);
    this.wrap.appendChild(btn);
    this.button = btn;
    this.img.addEventListener("load", this.bound_image_load);

    void this.refresh();
  }

  /** Пересчитать URL/`saved` после мутаций DOM или storage. */
  async refresh(): Promise<void> {
    if (this.button === null || this.wrap === null) {
      return;
    }
    await this.deps.outcome_cache.ensure_loaded();
    const resolved = resolve_image_url_from_element(this.img, globalThis.location.href);
    if (!resolved.ok) {
      this.set_visual("hidden");
      return;
    }
    const suggested_name = suggested_name_from_image_url(resolved.url);
    const key = make_job_dedup_key(resolved.url, suggested_name);
    if (this.deps.outcome_cache.has_saved(key)) {
      this.set_visual("saved");
      return;
    }
    if (this.deps.in_flight.has(key)) {
      this.set_visual("saving");
      return;
    }
    this.set_visual("saving");
    try {
      const already_exists = await daemon_image_exists(suggested_name);
      if (already_exists) {
        await this.deps.outcome_cache.set_saved(key);
        this.set_visual("saved");
        return;
      }
      this.set_visual("idle");
    } catch (error: unknown) {
      const detail = error_to_text(error);
      this.button.title = detail;
      this.button.setAttribute("aria-label", `Ошибка проверки: ${detail}`);
      this.set_visual("error");
    }
  }

  dispose(): void {
    if (this.button !== null) {
      this.button.removeEventListener("click", this.bound_click);
      this.button.remove();
      this.button = null;
    }
    this.img.removeEventListener("load", this.bound_image_load);
    this.icon_plus = null;
    this.icon_ok = null;
    this.icon_spinner = null;
    this.icon_error = null;
    unwrap_target_image(this.img);
    this.wrap = null;
  }

  private set_visible_layer(which: "plus" | "ok" | "spinner" | "error" | "none"): void {
    const layers = [this.icon_plus, this.icon_ok, this.icon_spinner, this.icon_error] as const;
    for (const layer of layers) {
      if (layer === null) {
        continue;
      }
      layer.setAttribute("data-image-saver-visible", "false");
    }
    const map = {
      plus: this.icon_plus,
      ok: this.icon_ok,
      spinner: this.icon_spinner,
      error: this.icon_error,
      none: null
    } as const;
    const target = map[which];
    if (target !== null) {
      target.setAttribute("data-image-saver-visible", "true");
    }
  }

  private set_visual(state: OverlayVisual): void {
    if (this.button === null || this.wrap === null) {
      return;
    }
    this.visual_state = state;
    this.wrap.classList.remove(
      "image-saver-plugin__wrap--saved",
      "image-saver-plugin__wrap--busy",
      "image-saver-plugin__wrap--unsupported"
    );
    this.button.classList.remove("image-saver-plugin__btn--error");
    this.button.disabled = false;
    this.button.removeAttribute("aria-disabled");
    if (state !== "error") {
      this.button.title = "";
      this.button.setAttribute("aria-label", "Сохранить изображение");
    }

    if (state === "hidden") {
      this.wrap.classList.add("image-saver-plugin__wrap--unsupported");
      this.set_visible_layer("none");
      return;
    }

    if (state === "idle") {
      this.set_visible_layer("plus");
      return;
    }
    if (state === "saving") {
      this.wrap.classList.add("image-saver-plugin__wrap--busy");
      this.set_visible_layer("spinner");
      this.button.disabled = true;
      return;
    }
    if (state === "saved") {
      this.wrap.classList.add("image-saver-plugin__wrap--saved");
      this.set_visible_layer("ok");
      this.button.disabled = true;
      return;
    }
    if (state === "error") {
      this.button.classList.add("image-saver-plugin__btn--error");
      this.set_visible_layer("error");
      this.button.setAttribute("aria-disabled", "true");
    }
  }

  /**
   * `source_page_url` — URL страницы на момент клика.
   */
  private async on_click(): Promise<void> {
    if (this.button === null) {
      return;
    }
    if (this.visual_state === "error") {
      return;
    }
    await this.deps.outcome_cache.ensure_loaded();
    const source_page_url = globalThis.location.href;
    const resolved = resolve_image_url_from_element(this.img, source_page_url);
    if (!resolved.ok) {
      return;
    }
    const suggested_name = suggested_name_from_image_url(resolved.url);
    // `resolved.url` — тот же канонический URL, что в `refresh` / `resolve_image_url` (dedup §6.2).
    const key = make_job_dedup_key(resolved.url, suggested_name);
    if (this.deps.outcome_cache.has_saved(key)) {
      return;
    }
    if (this.deps.in_flight.has(key)) {
      return;
    }

    this.deps.in_flight.add(key);
    this.set_visual("saving");
    try {
      const already_exists = await daemon_image_exists(suggested_name);
      if (already_exists) {
        await this.deps.outcome_cache.set_saved(key);
        this.set_visual("saved");
        return;
      }

      const options = await load_save_image_options();
      await daemon_save_image_from_url({
        file_name: suggested_name,
        image_url: resolved.url,
        options
      });
      await this.deps.outcome_cache.set_saved(key);
      this.set_visual("saved");
      return;
    } catch (error) {
      const detail = error_to_text(error);
      log.warn("save rejected", {
        detail,
        source_page_url,
        error
      });
      this.button.title = detail;
      this.button.setAttribute("aria-label", `Ошибка сохранения: ${detail}`);
      this.set_visual("error");
      await this.deps.outcome_cache.set_failed(key, detail);
    } finally {
      this.deps.in_flight.delete(key);
    }
  }
}
