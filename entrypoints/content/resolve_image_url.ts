export type ResolveImageUrlFailureReason = "unsupported_scheme" | "empty" | "invalid_url";

export type ResolveImageUrlResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reason: ResolveImageUrlFailureReason }>;

/** Абсолютный http(s) URL для `SaveJob` или код причины отказа (пусто / не URL / не http(s)). */
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
