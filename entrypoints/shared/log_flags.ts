/** Включает `create_logger().debug`: в dev или при `WXT_IMAGE_SAVER_LOG_DEV=true` (см. `wxt.config.ts` `envPrefix`). */
export const LOG_DEV: boolean =
    import.meta.env.PROD !== true || import.meta.env["WXT_IMAGE_SAVER_LOG_DEV"] === "true";
