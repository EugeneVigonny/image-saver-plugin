/** Корень UI расширения на странице — исключение из сканера `img`. */
export const IMAGE_SAVER_ROOT_ATTR = "data-image-saver-root";

/** Ключ `chrome.storage.session`: исходы сохранений (saved/failed + TTL) для UI. */
export const IMAGE_SAVER_OUTCOME_CACHE_V1 = "image_saver_outcome_cache_v1";

/** TTL записи исхода в session storage (мс). */
export const OUTCOME_CACHE_TTL_MS = 3_600_000;

/** Макс. число записей в outcome cache. */
export const OUTCOME_CACHE_CAP = 2000;

/**
 * Таймаут ожидания терминального `job_status` для сброса спиннера (мс).
 * Исход job всё ещё обработается при позднем сообщении.
 */
export const JOB_UI_TIMEOUT_MS = 120_000;
