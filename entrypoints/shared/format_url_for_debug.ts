/** Сжимает URL для `log.debug` (длинный query не печатается целиком). */
export function format_url_for_debug(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 56 ? `${u.pathname.slice(0, 53)}…` : u.pathname;
    const q = u.search.length > 0 ? "?…" : "";
    return `${u.origin}${path}${q}`;
  } catch {
    return url.length > 72 ? `${url.slice(0, 69)}…` : url;
  }
}
