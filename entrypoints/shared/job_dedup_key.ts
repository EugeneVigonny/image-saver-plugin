/** Ключ дедупликации постановки в очередь по паре URL + имя файла (разделитель `\u0000`). */
export function make_job_dedup_key(canonical_url: string, suggested_name: string): string {
    return `${canonical_url}\u0000${suggested_name}`;
}
