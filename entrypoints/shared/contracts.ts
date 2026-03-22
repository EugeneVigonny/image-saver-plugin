/**
 * Контракты `browser.runtime` (запросы/ответы/события), снимок очереди и type guards.
 * Литералы `type` сообщений — только из `runtime_message_types`.
 */

/** Допустимые стадии job в pipeline сохранения. */
export const job_status_values = [
    "queued",
    "downloading",
    "resizing",
    "writing",
    "done",
    "failed",
] as const;

/** Значения `type` для `browser.runtime` сообщений (единый источник строк). */
export const runtime_message_types = {
    queue_save: "queue_save",
    job_status: "job_status",
    get_queue_state: "get_queue_state",
    queue_state: "queue_state",
    get_directory_access_state: "get_directory_access_state",
    restore_directory_access: "restore_directory_access",
} as const;

export type JobStatus = (typeof job_status_values)[number];
export type RuntimeMessageType = (typeof runtime_message_types)[keyof typeof runtime_message_types];

export type SaveJob = Readonly<{
    job_id: string;
    url: string;
    source_page_url: string;
    suggested_name: string;
    created_at: number;
}>;

/**
 * Запись в персистентной очереди (снимок в `chrome.storage.local`).
 * Терминальные `done`/`failed` в хранилище не держим — запись удаляется после завершения pipeline.
 */
export type QueuedJobRecord = Readonly<{
    job: SaveJob;
    status: JobStatus;
    last_error?: string;
}>;

/** Версия схемы снимка очереди; инкремент при несовместимых изменениях. */
export const QUEUE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Снимок очереди (один ключ в `storage.local`).
 * `jobs` — только незавершённые стадии (`queued` … `writing`).
 */
export type QueueSnapshot = Readonly<{
    schema_version: typeof QUEUE_SNAPSHOT_SCHEMA_VERSION;
    jobs: QueuedJobRecord[];
    processing_job_id: string | null;
    updated_at: number;
}>;

/**
 * Публичный снимок для UI / `get_queue_state`.
 * `pending_jobs` — `SaveJob` для записей, ещё не дошедших до терминала (все элементы `jobs` в snapshot).
 * `total_jobs` — `jobs.length` (совпадает с `pending_jobs.length`).
 * `processing_job_id` — job, который сейчас обрабатывает single-consumer (или null).
 */
export type QueueState = Readonly<{
    pending_jobs: SaveJob[];
    processing_job_id: string | null;
    total_jobs: number;
    updated_at: number;
}>;

/** Ответ на `queue_save`: подтверждение id и снимок очереди (единый тип для content + background). */
export type QueueSaveResult = Readonly<{
    accepted_job_id: string;
    queue_state: QueueState;
    /** `true`, если тот же dedup-ключ уже был в незавершённой очереди. */
    was_duplicate?: boolean;
}>;

export type SaveOutcomeOk = Readonly<{
    kind: "ok";
    job_id: string;
    file_name: string;
    completed_at: number;
}>;

export type SaveOutcomeRetryableError = Readonly<{
    kind: "retryable_error";
    job_id: string;
    reason: string;
    retry_after_ms: number;
}>;

export type SaveOutcomeFatalError = Readonly<{
    kind: "fatal_error";
    job_id: string;
    reason: string;
}>;

export type SaveOutcome = SaveOutcomeOk | SaveOutcomeRetryableError | SaveOutcomeFatalError;

export type PermissionState = "unknown" | "granted" | "prompt" | "denied" | "revoked";

/** Состояние выбранной папки в UI popup; `error` — сбой операции, не ответ браузера. */
export type PopupDirectoryState = "not_selected" | "granted" | "prompt" | "denied" | "error";

/** Снимок экрана popup: имя из меты, флаги занятости и ошибки. */
export type PopupViewModel = Readonly<{
    directory_name: string | null;
    permission_state: PopupDirectoryState;
    /** См. `DirectoryAccessStateResult.service_worker_readwrite_granted`. */
    service_worker_readwrite_granted: boolean;
    is_busy: boolean;
    last_error: string | null;
}>;

/** Ключи `chrome.storage.local`; живой handle хранится в IndexedDB, не здесь. */
export const storage_keys = {
    save_dir_handle: "save_dir_handle",
    save_dir_meta: "save_dir_meta",
    /** JSON `QueueSnapshot` — атомарный снимок очереди. */
    queue_snapshot: "image_saver_queue_snapshot_v1",
} as const;

/** Снимок read/write сразу после жеста в popup; SW может ещё долго отдавать `prompt` для того же handle. */
export type SaveDirReadwriteSnapshot = "granted" | "prompt" | "denied";

export type SaveDirMeta = Readonly<{
    name: string;
    updated_at: number;
    readwrite_at_pick?: SaveDirReadwriteSnapshot;
}>;

export type QueueSaveMessage = Readonly<{
    type: typeof runtime_message_types.queue_save;
    payload: SaveJob;
}>;

export type JobStatusPayload = Readonly<{
    job_id: string;
    status: JobStatus;
    updated_at: number;
    outcome?: SaveOutcome;
}>;

export type JobStatusMessage = Readonly<{
    type: typeof runtime_message_types.job_status;
    payload: JobStatusPayload;
}>;

export type GetQueueStateMessage = Readonly<{
    type: typeof runtime_message_types.get_queue_state;
}>;

export type GetDirectoryAccessStateMessage = Readonly<{
    type: typeof runtime_message_types.get_directory_access_state;
}>;

export type RestoreDirectoryAccessMessage = Readonly<{
    type: typeof runtime_message_types.restore_directory_access;
}>;

export type QueueStateMessage = Readonly<{
    type: typeof runtime_message_types.queue_state;
    payload: QueueState;
}>;

export type DirectoryAccessStateResult = Readonly<{
    directory_name: string | null;
    /** UI/оптимистично: «доверие» к `readwrite_at_pick` при `prompt` в SW. */
    permission_state: PopupDirectoryState;
    /**
     * Фактический `queryPermission('readwrite')` в service worker после settle.
     * Запись на диск и `getFileHandle` возможны только при `true`.
     */
    service_worker_readwrite_granted: boolean;
}>;

export type RestoreDirectoryAccessResult = Readonly<{
    permission_state: PopupDirectoryState;
    directory_name: string | null;
}>;

export type RuntimeRequestMessage =
    | QueueSaveMessage
    | GetQueueStateMessage
    | GetDirectoryAccessStateMessage
    | RestoreDirectoryAccessMessage;
export type RuntimeEventMessage = JobStatusMessage | QueueStateMessage;
export type RuntimeMessage = RuntimeRequestMessage | RuntimeEventMessage;

/** Ошибка валидации на границе runtime (сообщение / ответ не по контракту). */
export type RuntimeValidationError = Readonly<{
    code: "invalid_message";
    message: string;
    details: string;
}>;

export type RuntimeResponseOk<TData> = Readonly<{
    ok: true;
    data: TData;
}>;

export type RuntimeResponseError = Readonly<{
    ok: false;
    error: RuntimeValidationError;
}>;

/** Унифицированный ответ use-case и `sendMessage`: успех с `data` или `ok: false` с `error`. */
export type RuntimeResponse<TData> = RuntimeResponseOk<TData> | RuntimeResponseError;

function is_object_record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function is_non_empty_string(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function is_timestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function is_job_status(value: unknown): value is JobStatus {
    return typeof value === "string" && job_status_values.includes(value as JobStatus);
}

function is_save_outcome_ok(value: unknown): value is SaveOutcomeOk {
    if (!is_object_record(value)) {
        return false;
    }

    return (
        value["kind"] === "ok" &&
        is_non_empty_string(value["job_id"]) &&
        is_non_empty_string(value["file_name"]) &&
        is_timestamp(value["completed_at"])
    );
}

function is_save_outcome_retryable_error(value: unknown): value is SaveOutcomeRetryableError {
    if (!is_object_record(value)) {
        return false;
    }

    return (
        value["kind"] === "retryable_error" &&
        is_non_empty_string(value["job_id"]) &&
        is_non_empty_string(value["reason"]) &&
        is_timestamp(value["retry_after_ms"])
    );
}

function is_save_outcome_fatal_error(value: unknown): value is SaveOutcomeFatalError {
    if (!is_object_record(value)) {
        return false;
    }

    return (
        value["kind"] === "fatal_error" &&
        is_non_empty_string(value["job_id"]) &&
        is_non_empty_string(value["reason"])
    );
}

/** Type guard: итог pipeline (`kind` discriminant). */
export function is_save_outcome(value: unknown): value is SaveOutcome {
    return (
        is_save_outcome_ok(value) ||
        is_save_outcome_retryable_error(value) ||
        is_save_outcome_fatal_error(value)
    );
}

/** Статусы, при которых job ещё в очереди / pipeline (не терминал). */
export function is_non_terminal_job_status(status: JobStatus): boolean {
    return status === "queued" || status === "downloading" || status === "resizing" || status === "writing";
}

/** Type guard: запись персистентной очереди. */
export function is_queued_job_record(value: unknown): value is QueuedJobRecord {
    if (!is_object_record(value)) {
        return false;
    }

    return is_save_job(value["job"]) && is_job_status(value["status"]) && is_non_terminal_job_status(value["status"]);
}

/** Type guard: payload job до бизнес-логики (непустые строки, валидный `created_at`). */
export function is_save_job(value: unknown): value is SaveJob {
    if (!is_object_record(value)) {
        return false;
    }

    return (
        is_non_empty_string(value["job_id"]) &&
        is_non_empty_string(value["url"]) &&
        is_non_empty_string(value["source_page_url"]) &&
        is_non_empty_string(value["suggested_name"]) &&
        is_timestamp(value["created_at"])
    );
}

function is_job_status_payload(value: unknown): value is JobStatusPayload {
    if (!is_object_record(value)) {
        return false;
    }

    if (
        !is_non_empty_string(value["job_id"]) ||
        !is_job_status(value["status"]) ||
        !is_timestamp(value["updated_at"])
    ) {
        return false;
    }

    if (value["outcome"] === undefined) {
        return true;
    }

    return is_save_outcome(value["outcome"]);
}

function is_queue_state(value: unknown): value is QueueState {
    if (!is_object_record(value)) {
        return false;
    }

    return (
        Array.isArray(value["pending_jobs"]) &&
        value["pending_jobs"].every((pending_job) => is_save_job(pending_job)) &&
        (value["processing_job_id"] === null || is_non_empty_string(value["processing_job_id"])) &&
        typeof value["total_jobs"] === "number" &&
        Number.isInteger(value["total_jobs"]) &&
        value["total_jobs"] >= 0 &&
        is_timestamp(value["updated_at"])
    );
}

/** Type guard: сообщение `queue_save` с валидным `SaveJob`. */
export function is_queue_save_message(value: unknown): value is QueueSaveMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.queue_save && is_save_job(value["payload"]);
}

/** Type guard: событие `job_status` и payload стадии. */
export function is_job_status_message(value: unknown): value is JobStatusMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.job_status && is_job_status_payload(value["payload"]);
}

/** Type guard: запрос `get_queue_state` без payload. */
export function is_get_queue_state_message(value: unknown): value is GetQueueStateMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.get_queue_state;
}

/** Type guard: запрос актуального доступа к сохранённой папке (чтение из SW). */
export function is_get_directory_access_state_message(
    value: unknown,
): value is GetDirectoryAccessStateMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.get_directory_access_state;
}

/**
 * Type guard: запрос `restore_directory_access`.
 * @remarks В Chromium `requestPermission` из SW без жеста не поднимает диалог — вызывать из popup.
 */
export function is_restore_directory_access_message(
    value: unknown,
): value is RestoreDirectoryAccessMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.restore_directory_access;
}

/** Type guard: событие `queue_state` с валидным snapshot очереди. */
export function is_queue_state_message(value: unknown): value is QueueStateMessage {
    if (!is_object_record(value)) {
        return false;
    }

    return value["type"] === runtime_message_types.queue_state && is_queue_state(value["payload"]);
}

/** Type guard: допустимый входящий запрос в обработчик `onMessage` background. */
export function is_runtime_request_message(value: unknown): value is RuntimeRequestMessage {
    return (
        is_queue_save_message(value) ||
        is_get_queue_state_message(value) ||
        is_get_directory_access_state_message(value) ||
        is_restore_directory_access_message(value)
    );
}

/** Собирает `RuntimeValidationError` с кодом `invalid_message` для ответа из background. */
export function create_invalid_message_error(details: string): RuntimeValidationError {
    return {
        code: "invalid_message",
        message: "Runtime message validation failed",
        details,
    };
}
