export type ResolveImageUrlFailureReason = "unsupported_scheme" | "empty" | "invalid_url";

export type ResolveImageUrlResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reason: ResolveImageUrlFailureReason }>;

/**
 * Разрешает URL картинки для постановки в очередь (MVP: только http/https).
 * @param img Целевой элемент.
 * @param base_href Обычно `location.href` страницы.
 */
export function resolve_image_url_from_element(img: HTMLImageElement, base_href: string): ResolveImageUrlResult {
    const raw = (img.currentSrc || img.src || "").trim();
    if (raw.length === 0) {
        return { ok: false, reason: "empty" };
    }

    let parsed: URL;
    try {
        parsed = new URL(raw, base_href);
    } catch {
        return { ok: false, reason: "invalid_url" };
    }

    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
        return { ok: false, reason: "unsupported_scheme" };
    }

    return { ok: true, url: parsed.href };
}
