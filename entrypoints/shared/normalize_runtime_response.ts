import { create_invalid_message_error, type RuntimeResponse } from "./contracts";

function is_runtime_response_shape(value: unknown): value is RuntimeResponse<unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        "ok" in value &&
        typeof (value as { ok: unknown }).ok === "boolean"
    );
}

/**
 * Приводит сырой ответ `sendMessage` к `RuntimeResponse`; иначе `ok: false` с подсказкой в `details`.
 * @param context Метка вызова для диагностики (попадает в `error.details`).
 */
export function normalize_runtime_send_message_result<T>(
    raw: unknown,
    context: string,
): RuntimeResponse<T> {
    if (is_runtime_response_shape(raw)) {
        return raw as RuntimeResponse<T>;
    }

    const hint =
        raw === undefined
            ? "undefined (нет ответа от background — SW не готов, нет listener или Chrome async)"
            : `invalid shape (${typeof raw})`;

    return {
        ok: false,
        error: create_invalid_message_error(`${context}: ${hint}`),
    };
}
