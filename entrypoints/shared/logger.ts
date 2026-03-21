import { LOG_DEV } from "./log_flags";

/**
 * Логгер с префиксом `[image-saver:<scope>]`.
 * @remarks `debug` зависит от `LOG_DEV`; остальные уровни всегда в консоль.
 */
export function create_logger(scope: string) {
    const prefix = `[image-saver:${scope}]`;

    function format_data(data: unknown): unknown {
        return data === undefined ? "" : data;
    }

    return {
        debug(message: string, data?: unknown): void {
            if (!LOG_DEV) {
                return;
            }
            console.debug(prefix, message, format_data(data));
        },

        info(message: string, data?: unknown): void {
            console.info(prefix, message, format_data(data));
        },

        warn(message: string, data?: unknown): void {
            console.warn(prefix, message, format_data(data));
        },

        error(message: string, data?: unknown): void {
            console.error(prefix, message, format_data(data));
        },
    } as const;
}
