import plus_icon_url from "../../assets/content/plus-svgrepo-com.svg?url";
import ok_icon_url from "../../assets/content/ok-svgrepo-com.svg?url";
import spinner_icon_url from "../../assets/content/spinner-svgrepo-com.svg?url";
import { suggested_name_from_image_url } from "../shared/naming";
import { send_queue_save_message } from "../shared/send_queue_save_message";
import type { SaveJob } from "../shared/contracts";
import { create_logger } from "../shared/logger";
import { IMAGE_SAVER_ROOT_ATTR } from "./constants";
import { make_job_dedup_key } from "./dedup";
import { resolve_image_url_from_element } from "./resolve_image_url";
import type { SessionSavedDedupRegistry } from "./session_saved_keys";

const log = create_logger("content");

type OverlayVisual = "idle" | "saving" | "saved" | "hidden";

export type OverlayDeps = Readonly<{
    registry: SessionSavedDedupRegistry;
    in_flight: Set<string>;
}>;

function unwrap_target_image(img: HTMLImageElement): void {
    const wrap = img.parentElement;
    if (wrap === null || wrap.getAttribute(IMAGE_SAVER_ROOT_ATTR) === null) {
        return;
    }
    const parent = wrap.parentNode;
    if (parent === null) {
        return;
    }
    parent.insertBefore(img, wrap);
    wrap.remove();
    img.classList.remove("image-saver-plugin__target");
}

function ensure_wrap(img: HTMLImageElement): HTMLElement | null {
    const existing = img.parentElement;
    if (existing !== null && existing.getAttribute(IMAGE_SAVER_ROOT_ATTR) !== null) {
        return existing;
    }
    const parent = img.parentNode;
    if (parent === null) {
        return null;
    }
    const wrap = document.createElement("span");
    wrap.setAttribute(IMAGE_SAVER_ROOT_ATTR, "");
    wrap.className = "image-saver-plugin__wrap";
    img.classList.add("image-saver-plugin__target");
    parent.insertBefore(wrap, img);
    wrap.appendChild(img);
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
    private bound_click: (ev: MouseEvent) => void;
    private error_clear_timer: ReturnType<typeof setTimeout> | null = null;

    constructor(img: HTMLImageElement, deps: OverlayDeps) {
        this.img = img;
        this.deps = deps;
        this.bound_click = (ev: MouseEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            void this.on_click();
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
        this.icon_spinner = create_icon_layer(spinner_icon_url, "Сохранение…", "image-saver-plugin__spinner");

        btn.append(this.icon_plus, this.icon_ok, this.icon_spinner);
        btn.addEventListener("click", this.bound_click);
        this.wrap.appendChild(btn);
        this.button = btn;

        void this.refresh();
    }

    /** Пересчитать URL/`saved` после мутаций DOM или storage. */
    async refresh(): Promise<void> {
        if (this.button === null || this.wrap === null) {
            return;
        }
        await this.deps.registry.ensure_loaded();
        const resolved = resolve_image_url_from_element(this.img, globalThis.location.href);
        if (!resolved.ok) {
            this.set_visual("hidden");
            return;
        }
        const suggested_name = suggested_name_from_image_url(resolved.url);
        const key = make_job_dedup_key(resolved.url, suggested_name);
        if (this.deps.registry.has(key)) {
            this.set_visual("saved");
            return;
        }
        if (this.deps.in_flight.has(key)) {
            this.set_visual("saving");
            return;
        }
        this.set_visual("idle");
    }

    dispose(): void {
        if (this.error_clear_timer !== null) {
            clearTimeout(this.error_clear_timer);
            this.error_clear_timer = null;
        }
        if (this.button !== null) {
            this.button.removeEventListener("click", this.bound_click);
            this.button.remove();
            this.button = null;
        }
        this.icon_plus = null;
        this.icon_ok = null;
        this.icon_spinner = null;
        unwrap_target_image(this.img);
        this.wrap = null;
    }

    private set_visible_layer(which: "plus" | "ok" | "spinner" | "none"): void {
        const layers = [this.icon_plus, this.icon_ok, this.icon_spinner] as const;
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
            none: null,
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
        this.wrap.classList.remove(
            "image-saver-plugin__wrap--saved",
            "image-saver-plugin__wrap--busy",
            "image-saver-plugin__wrap--unsupported",
        );
        this.button.classList.remove("image-saver-plugin__btn--error");
        this.button.disabled = false;

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
        }
    }

    /**
     * `source_page_url` — URL страницы на момент клика (контракт stage 4).
     */
    private async on_click(): Promise<void> {
        if (this.button === null) {
            return;
        }
        await this.deps.registry.ensure_loaded();
        const source_page_url = globalThis.location.href;
        const resolved = resolve_image_url_from_element(this.img, source_page_url);
        if (!resolved.ok) {
            return;
        }
        const suggested_name = suggested_name_from_image_url(resolved.url);
        const key = make_job_dedup_key(resolved.url, suggested_name);
        if (this.deps.registry.has(key)) {
            return;
        }
        if (this.deps.in_flight.has(key)) {
            return;
        }

        this.deps.in_flight.add(key);
        this.set_visual("saving");
        try {
            const job: SaveJob = {
                job_id: crypto.randomUUID(),
                url: resolved.url,
                source_page_url,
                suggested_name,
                created_at: Date.now(),
            };
            const response = await send_queue_save_message(job);
            if (response.ok) {
                await this.deps.registry.remember(key);
                this.set_visual("saved");
            } else {
                const detail = response.error.message;
                log.warn("queue_save rejected", { detail });
                this.button.title = detail;
                this.button.classList.add("image-saver-plugin__btn--error");
                this.set_visual("idle");
                if (this.error_clear_timer !== null) {
                    clearTimeout(this.error_clear_timer);
                }
                this.error_clear_timer = setTimeout(() => {
                    this.error_clear_timer = null;
                    if (this.button !== null) {
                        this.button.title = "";
                        this.button.classList.remove("image-saver-plugin__btn--error");
                    }
                }, 2500);
            }
        } finally {
            this.deps.in_flight.delete(key);
        }
    }
}
