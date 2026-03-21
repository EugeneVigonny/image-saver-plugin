/**
 * Стабильный ключ идемпотентности job на клиенте (совпадает с логикой background при расширении).
 * Разделитель `\u0000` не встречается в URL и имени файла.
 */
export function make_job_dedup_key(canonical_url: string, suggested_name: string): string {
    return `${canonical_url}\u0000${suggested_name}`;
}
