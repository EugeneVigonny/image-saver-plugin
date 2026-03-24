import { format_url_for_debug } from "./format_url_for_debug";
import { create_logger } from "./logger";

const log = create_logger("download");

/** Максимальный размер тела ответа (байты). */
export const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** Таймаут загрузки (мс). */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * `fetch` по URL с лимитом размера и таймаутом.
 * @throws {Error} Не-OK HTTP, превышение `DOWNLOAD_MAX_BYTES`, таймаут (`AbortError`).
 */
export async function download_image(url: string): Promise<Blob> {
  log.debug("download_image start", { url: format_url_for_debug(url) });
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort();
  }, DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    const length_header = response.headers.get("content-length");
    if (length_header !== null) {
      const parsed = Number(length_header);
      if (Number.isFinite(parsed) && parsed > DOWNLOAD_MAX_BYTES) {
        throw new Error("Image too large (Content-Length)");
      }
    }
    const blob = await response.blob();
    if (blob.size > DOWNLOAD_MAX_BYTES) {
      throw new Error("Image too large");
    }
    log.debug("download_image done", {
      url: format_url_for_debug(url),
      bytes: blob.size,
      type: blob.type || "(empty)"
    });
    return blob;
  } finally {
    globalThis.clearTimeout(timer);
  }
}
