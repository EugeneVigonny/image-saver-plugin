/** Корень UI расширения на странице — исключение из сканера `img`. */
export const IMAGE_SAVER_ROOT_ATTR = "data-image-saver-root";

/** Ключ `chrome.storage.session`: список ключей dedup успешно сохранённых за сессию браузера. */
export const SESSION_SAVED_DEDUP_KEYS = "image_saver_saved_dedup_keys_v1";

/** Макс. число ключей в session storage (защита от разрастания). */
export const SESSION_SAVED_KEYS_CAP = 2000;
