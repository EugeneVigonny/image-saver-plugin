/**
 * Управляет выводом `create_logger().debug`; `info`/`warn`/`error` не зависят от флага.
 * @remarks В prod: задать `WXT_IMAGE_SAVER_LOG_DEV=true` (см. `vite.envPrefix` в `wxt.config.ts`).
 */
export const LOG_DEV: boolean =
    import.meta.env.PROD !== true || import.meta.env["WXT_IMAGE_SAVER_LOG_DEV"] === "true";
