function is_truthy_env_flag(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

/**
 * Debug-логи включены в dev (`import.meta.env.DEV`) или в production при `WXT_IMAGE_SAVER_LOG_DEV`.
 * @remarks В Chrome `console.debug` по умолчанию скрыт (фильтр «Verbose»), поэтому `debug()` пишет через `console.log`.
 */
export const LOG_DEV: boolean =
  import.meta.env.DEV === true || is_truthy_env_flag(import.meta.env["WXT_IMAGE_SAVER_LOG_DEV"]);

/**
 * Логгер: `[image-saver:<scope>]` + уровень в начале текста (`[DEBUG]` … `[ERROR]`, по мотивам Nest).
 * @remarks `debug` зависит от `LOG_DEV`; остальные уровни всегда в консоль.
 */
export function create_logger(scope: string) {
  const prefix = `[image-saver:${scope}]`;

  function format_data(data: unknown): unknown {
    return data === undefined ? "" : data;
  }

  /** Префикс уровня в стиле Nest: `[DEBUG]` в начале текста сообщения. */
  function with_level(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string): string {
    return `[${level}] ${message}`;
  }

  return {
    debug(message: string, data?: unknown): void {
      if (!LOG_DEV) {
        return;
      }
      console.log(prefix, with_level("DEBUG", message), format_data(data));
    },

    info(message: string, data?: unknown): void {
      console.info(prefix, with_level("INFO", message), format_data(data));
    },

    warn(message: string, data?: unknown): void {
      console.warn(prefix, with_level("WARN", message), format_data(data));
    },

    error(message: string, data?: unknown): void {
      console.error(prefix, with_level("ERROR", message), format_data(data));
    }
  } as const;
}
