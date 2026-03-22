export type ResolveImageUrlFailureReason = "unsupported_scheme" | "empty" | "invalid_url" | "svg" | "sample";

export type ResolveImageUrlResult =
    | Readonly<{ ok: true; url: string }>
    | Readonly<{ ok: false; reason: ResolveImageUrlFailureReason }>;

function pathname_looks_like_svg_file(pathname: string): boolean {
    const p = pathname.toLowerCase();
    return p.endsWith(".svg") || p.endsWith(".svgz");
}

function raw_is_data_svg_xml(raw: string): boolean {
    return /^data:image\/svg\+xml/i.test(raw.trim());
}

/** Превью/плейсхолдеры: подстрока `sample` в исходном src или в разрешённом href. */
function url_contains_sample_token(raw: string, absolute_href: string): boolean {
    return raw.toLowerCase().includes("sample") || absolute_href.toLowerCase().includes("sample");
}

/**
 * Игнор: в `src` или в каноническом http(s) URL есть подстрока `sample` (без учёта регистра).
 * @remarks См. trade-off в `stage-6-naming-and-cache.md` §6.0.
 */
export function is_sample_placeholder_image_element(img: HTMLImageElement, base_href: string): boolean {
    const raw = (img.currentSrc || img.src || "").trim();
    if (raw.length === 0) {
        return false;
    }
    if (raw.toLowerCase().includes("sample")) {
        return true;
    }
    try {
        const parsed = new URL(raw, base_href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return false;
        }
        return parsed.href.toLowerCase().includes("sample");
    } catch {
        return false;
    }
}

/**
 * SVG не сохраняем: расширение пути http(s), `data:image/svg+xml`, `.svgz`.
 * @remarks Для относительных `src` нужен тот же `base_href`, что и у `resolve_image_url_from_element`.
 */
export function is_svg_image_element(img: HTMLImageElement, base_href: string): boolean {
    const raw = (img.currentSrc || img.src || "").trim();
    if (raw.length === 0) {
        return false;
    }
    if (raw_is_data_svg_xml(raw)) {
        return true;
    }
    let parsed: URL;
    try {
        parsed = new URL(raw, base_href);
    } catch {
        return false;
    }
    const scheme = parsed.protocol.toLowerCase();
    if (scheme === "http:" || scheme === "https:") {
        return pathname_looks_like_svg_file(parsed.pathname);
    }
    return false;
}

/** Абсолютный http(s) URL для `SaveJob` или код причины отказа (в т.ч. svg / sample). */
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

    if (url_contains_sample_token(raw, parsed.href)) {
        return { ok: false, reason: "sample" };
    }

    if (pathname_looks_like_svg_file(parsed.pathname)) {
        return { ok: false, reason: "svg" };
    }

    return { ok: true, url: parsed.href };
}
