/**
 * Персистентная очередь: загрузка/нормализация снимка, постановка job, чистые преобразования `QueueSnapshot`.
 * Запись в `chrome.storage.local` только через `persist_queue_snapshot`.
 */

import {
    QUEUE_SNAPSHOT_SCHEMA_VERSION,
    storage_keys,
    type JobStatus,
    type QueueSnapshot,
    type QueuedJobRecord,
    type QueueState,
    type SaveJob,
    is_queued_job_record,
} from "./contracts";
import { format_url_for_debug } from "./format_url_for_debug";
import { make_job_dedup_key } from "./job_dedup_key";
import { create_logger } from "./logger";

const log = create_logger("queue_store");

function is_object_record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function is_non_empty_string(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function is_timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function empty_snapshot(): QueueSnapshot {
    const now = Date.now();
    return {
        schema_version: QUEUE_SNAPSHOT_SCHEMA_VERSION,
        jobs: [],
        processing_job_id: null,
        updated_at: now,
    };
}

/** Валидация распарсенного JSON снимка. */
function is_queue_snapshot(value: unknown): value is QueueSnapshot {
    if (!is_object_record(value)) {
        return false;
    }
    if (value["schema_version"] !== QUEUE_SNAPSHOT_SCHEMA_VERSION) {
        return false;
    }
    if (!Array.isArray(value["jobs"])) {
        return false;
    }
    if (!value["jobs"].every((item: unknown) => is_queued_job_record(item))) {
        return false;
    }
    if (!(value["processing_job_id"] === null || is_non_empty_string(value["processing_job_id"]))) {
        return false;
    }
    if (!is_timestamp(value["updated_at"])) {
        return false;
    }
    return true;
}

/** Читает JSON-снимок из storage; при битых данных возвращает пустой снимок. */
export async function load_queue_snapshot(): Promise<QueueSnapshot> {
    const bag = await browser.storage.local.get(storage_keys.queue_snapshot);
    const raw = bag[storage_keys.queue_snapshot];
    if (raw === undefined || raw === null) {
        log.debug("load_queue_snapshot: empty (no key)");
        return empty_snapshot();
    }
    if (typeof raw !== "string") {
        log.warn("queue_snapshot: unexpected type, reset");
        return empty_snapshot();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        log.warn("queue_snapshot: JSON parse error, reset");
        return empty_snapshot();
    }
    if (!is_queue_snapshot(parsed)) {
        log.warn("queue_snapshot: validation failed, reset");
        return empty_snapshot();
    }
    log.debug("load_queue_snapshot: ok", {
        jobs: parsed.jobs.length,
        processing_job_id: parsed.processing_job_id,
    });
    return parsed;
}

/** Сериализует снимок в `storage_keys.queue_snapshot` с обновлением `updated_at`. */
export async function persist_queue_snapshot(snapshot: QueueSnapshot): Promise<void> {
    const normalized: QueueSnapshot = {
        ...snapshot,
        updated_at: Date.now(),
    };
    await browser.storage.local.set({
        [storage_keys.queue_snapshot]: JSON.stringify(normalized),
    });
}

/**
 * После рестарта SW: прерванные стадии снова в `queued`, сброс активного процессора.
 */
export function normalize_interrupted_jobs(snapshot: QueueSnapshot): QueueSnapshot {
    let reset_count = 0;
    const jobs: QueuedJobRecord[] = snapshot.jobs.map((record) => {
        const s = record.status;
        if (s === "downloading" || s === "resizing" || s === "writing") {
            reset_count += 1;
            return {
                job: record.job,
                status: "queued",
            };
        }
        return record;
    });
    if (reset_count > 0 || snapshot.processing_job_id !== null) {
        log.debug("normalize_interrupted_jobs", {
            reset_in_flight_to_queued: reset_count,
            had_processing_job_id: snapshot.processing_job_id !== null,
        });
    }
    return {
        ...snapshot,
        jobs,
        processing_job_id: null,
        updated_at: Date.now(),
    };
}

/** Результат постановки: новый снимок (или исходный при дедупе), id job и флаг дубликата. */
export type EnqueueJobResult = Readonly<{
    snapshot: QueueSnapshot;
    accepted_job_id: string;
    was_duplicate: boolean;
}>;

/**
 * Постановка job: dedup по `url` + `suggested_name`; при дубликате — существующий `job_id`.
 */
export function enqueue_job(snapshot: QueueSnapshot, job: SaveJob): EnqueueJobResult {
    const dedup_key = make_job_dedup_key(job.url, job.suggested_name);
    const existing = snapshot.jobs.find(
        (r) => make_job_dedup_key(r.job.url, r.job.suggested_name) === dedup_key,
    );
    if (existing !== undefined) {
        log.debug("enqueue_job: duplicate", {
            existing_job_id: existing.job.job_id,
            url: format_url_for_debug(job.url),
            suggested_name: job.suggested_name,
        });
        return {
            snapshot,
            accepted_job_id: existing.job.job_id,
            was_duplicate: true,
        };
    }
    const record: QueuedJobRecord = {
        job,
        status: "queued",
    };
    const next: QueueSnapshot = {
        ...snapshot,
        jobs: [...snapshot.jobs, record],
        updated_at: Date.now(),
    };
    log.debug("enqueue_job: new", {
        job_id: job.job_id,
        queue_len_after: next.jobs.length,
        suggested_name: job.suggested_name,
    });
    return {
        snapshot: next,
        accepted_job_id: job.job_id,
        was_duplicate: false,
    };
}

/** Публичный снимок для API. */
export function build_queue_state(snapshot: QueueSnapshot): QueueState {
    return {
        pending_jobs: snapshot.jobs.map((r) => r.job),
        processing_job_id: snapshot.processing_job_id,
        total_jobs: snapshot.jobs.length,
        updated_at: snapshot.updated_at,
    };
}

/** Следующий кандидат FIFO по `created_at` среди `queued`. */
export function peek_next_queued_job(snapshot: QueueSnapshot): QueuedJobRecord | undefined {
    const queued = snapshot.jobs.filter((r) => r.status === "queued");
    if (queued.length === 0) {
        return undefined;
    }
    return [...queued].sort((a, b) => a.job.created_at - b.job.created_at)[0];
}

/** Обновляет `processing_job_id` и `updated_at` (single-consumer lock в SW). */
export function set_processing_job_id(snapshot: QueueSnapshot, job_id: string | null): QueueSnapshot {
    return {
        ...snapshot,
        processing_job_id: job_id,
        updated_at: Date.now(),
    };
}

/** Меняет `status` у записи с данным `job_id`; опционально прикладывает `last_error`. */
export function update_record_status(
    snapshot: QueueSnapshot,
    job_id: string,
    status: JobStatus,
    last_error?: string,
): QueueSnapshot {
    const jobs = snapshot.jobs.map((r) => {
        if (r.job.job_id !== job_id) {
            return r;
        }
        const next: QueuedJobRecord =
            last_error !== undefined
                ? { job: r.job, status, last_error }
                : { job: r.job, status };
        return next;
    });
    return { ...snapshot, jobs, updated_at: Date.now() };
}

/** Удаляет job из `jobs`; сбрасывает `processing_job_id`, если он совпадал. */
export function remove_job(snapshot: QueueSnapshot, job_id: string): QueueSnapshot {
    const jobs = snapshot.jobs.filter((r) => r.job.job_id !== job_id);
    const processing_job_id =
        snapshot.processing_job_id === job_id ? null : snapshot.processing_job_id;
    return {
        ...snapshot,
        jobs,
        processing_job_id,
        updated_at: Date.now(),
    };
}

/** Поиск записи очереди по `job_id`. */
export function get_record_by_job_id(
    snapshot: QueueSnapshot,
    job_id: string,
): QueuedJobRecord | undefined {
    return snapshot.jobs.find((r) => r.job.job_id === job_id);
}
