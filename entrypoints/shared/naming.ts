/** Символы, недопустимые в имени файла Windows/Unix (упрощённо). */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

const DEFAULT_STEM = "image";
const DEFAULT_EXT = ".jpg";

function file_extension_from_pathname(pathname: string): string | null {
    const segment = pathname.split("/").filter(Boolean).pop() ?? "";
    const dot = segment.lastIndexOf(".");
    if (dot <= 0 || dot === segment.length - 1) {
        return null;
    }
    const ext = segment.slice(dot);
    if (!/^\.[a-z0-9]{1,8}$/i.test(ext)) {
        return null;
    }
    return ext.toLowerCase();
}

function sanitize_stem(raw: string): string {
    const cleaned = raw.replace(INVALID_FILENAME_CHARS, "_").replace(/\.+/g, "_").trim();
    return cleaned.length > 0 ? cleaned : DEFAULT_STEM;
}

/**
 * Имя файла из URL страницы картинки: сегмент пути + расширение, символы пути санитизированы.
 * @todo Stage 6 (опционально): учитывать `Content-Type` из ответа `fetch` в SW, если в URL нет валидного ext.
 */
export function suggested_name_from_image_url(absolute_url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(absolute_url);
    } catch {
        return `${DEFAULT_STEM}${DEFAULT_EXT}`;
    }

    const ext = file_extension_from_pathname(parsed.pathname) ?? DEFAULT_EXT;
    const last_segment = parsed.pathname.split("/").filter(Boolean).pop() ?? DEFAULT_STEM;
    const stem_before_dot = last_segment.includes(".")
        ? last_segment.slice(0, last_segment.lastIndexOf("."))
        : last_segment;
    let stem = sanitize_stem(stem_before_dot);
    const max_stem = 200;
    if (stem.length > max_stem) {
        stem = stem.slice(0, max_stem);
    }
    const normalized_ext = ext.startsWith(".") ? ext : `.${ext}`;
    return `${stem}${normalized_ext}`;
}
