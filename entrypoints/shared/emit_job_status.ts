import {
    is_non_terminal_job_status,
    runtime_message_types,
    type JobStatusMessage,
    type JobStatusPayload,
} from "./contracts";
import { create_logger } from "./logger";

const log = create_logger("emit_job_status");

/**
 * Content scripts в MV3 **не гарантированно** получают `runtime.sendMessage` из service worker;
 * доставка в content — через `tabs.sendMessage` (см. `notify_tabs_directory_access_changed` в background).
 */
async function deliver_job_status_to_content_tabs(message: JobStatusMessage): Promise<void> {
    try {
        const tabs = await browser.tabs.query({});
        let delivered = 0;
        for (const tab of tabs) {
            if (tab.id === undefined) {
                continue;
            }
            try {
                await browser.tabs.sendMessage(tab.id, message);
                delivered += 1;
            } catch {
                /* нет content script, не http(s), receiver не подписан */
            }
        }
        log.debug("emit_job_status: content tabs", {
            job_id: message.payload.job_id,
            tabs_queried: tabs.length,
            delivered,
        });
    } catch (error) {
        log.debug("emit_job_status: tabs broadcast failed", { job_id: message.payload.job_id, error });
    }
}

/**
 * Широковещательное событие стадии job: extension-страницы через `runtime`, content — через `tabs`.
 * @remarks Ошибки `sendMessage` глотаются — отсутствие подписчиков не должно ломать pipeline.
 */
export async function emit_job_status(payload: JobStatusPayload): Promise<void> {
    log.debug("emit_job_status", {
        job_id: payload.job_id,
        status: payload.status,
        outcome_kind: payload.outcome?.kind,
    });
    const message: JobStatusMessage = {
        type: runtime_message_types.job_status,
        payload,
    };
    try {
        await browser.runtime.sendMessage(message);
    } catch {
        log.debug("emit_job_status: runtime listeners absent", { job_id: payload.job_id });
    }
    /** Прогресс (queued…writing) content не слушает; терминал нужен для outcome-кэша и спиннера. */
    if (!is_non_terminal_job_status(payload.status)) {
        await deliver_job_status_to_content_tabs(message);
    }
}
