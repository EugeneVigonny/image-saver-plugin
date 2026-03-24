/**
 * Ключ дедупликации постановки в очередь: канонический **`url` + `suggested_name`** (разделитель `\u0000`).
 *
 * Два разных job с одинаковой парой считаются одним логическим сохранением: `enqueue_job` в
 * Dedup-ключ для идемпотентного поведения оверлея/кэша при повторных кликах.
 *
 * @param canonical_url Тот же URL, что отдаёт `resolve_image_url` / уходит в `SaveJob.url`.
 * @param suggested_name Имя из `suggested_name_from_image_url` (или эквивалент из background).
 */
export function make_job_dedup_key(canonical_url: string, suggested_name: string): string {
  return `${canonical_url}\u0000${suggested_name}`;
}
