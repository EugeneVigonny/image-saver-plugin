type GalleryCandidateKind = "sample" | "preview" | "thumbnails";

function detect_gallery_kind(pathname: string): GalleryCandidateKind | null {
  const lower = pathname.toLowerCase();
  if (lower.includes("/thumbnails/") || lower.includes("/thumbnail/")) {
    return "thumbnails";
  }
  if (lower.includes("/preview/")) {
    return "preview";
  }
  if (lower.includes("/sample/")) {
    return "sample";
  }
  return null;
}

function normalize_stem(kind: GalleryCandidateKind, stem: string): string {
  const lowered = stem.toLowerCase();
  if (kind === "thumbnails" && lowered.startsWith("thumbnail_")) {
    return stem.slice("thumbnail_".length);
  }
  if ((kind === "preview" || kind === "sample") && lowered.startsWith("sample_")) {
    return stem.slice("sample_".length);
  }
  return stem;
}

function is_valid_stem(value: string): boolean {
  if (value.length === 0 || value.length > 255) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

/**
 * Из gallery URL выделяет канонический stem для backend find.
 * Поддерживает только preview/sample/thumbnails path-паттерны.
 */
export function extract_gallery_stem_from_url(raw_url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw_url);
  } catch {
    return null;
  }
  const kind = detect_gallery_kind(parsed.pathname);
  if (kind === null) {
    return null;
  }

  const file_name = parsed.pathname.split("/").pop() ?? "";
  if (file_name.length === 0) {
    return null;
  }
  const dot_index = file_name.lastIndexOf(".");
  const stem = dot_index > 0 ? file_name.slice(0, dot_index) : file_name;
  const normalized = normalize_stem(kind, stem).trim();
  return is_valid_stem(normalized) ? normalized : null;
}
