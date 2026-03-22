/** `img` внутри кнопки с иконками `+`/`✓`/спиннер — не целевые картинки страницы. */
function is_overlay_control_image(img: HTMLImageElement): boolean {
    return img.closest(".image-saver-plugin__btn") !== null;
}

/** Трекинг-пиксели и пустые превью. */
function is_likely_tracking_pixel(img: HTMLImageElement): boolean {
    const w = img.naturalWidth > 0 ? img.naturalWidth : img.width;
    const h = img.naturalHeight > 0 ? img.naturalHeight : img.height;
    return w <= 1 && h <= 1;
}

/**
 * Сканирует `img` под `root`, исключая оверлей расширения и микро-изображения.
 */
export function query_image_elements(root: Document | Element): HTMLImageElement[] {
    const nodes = root.querySelectorAll("img");
    const out: HTMLImageElement[] = [];
    for (const node of nodes) {
        if (!(node instanceof HTMLImageElement)) {
            continue;
        }
        if (is_overlay_control_image(node)) {
            continue;
        }
        if (is_likely_tracking_pixel(node)) {
            continue;
        }
        out.push(node);
    }
    return out;
}
