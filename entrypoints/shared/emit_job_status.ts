import { runtime_message_types, type JobStatusMessage, type JobStatusPayload } from "./contracts";
import { create_logger } from "./logger";

const log = create_logger("emit_job_status");

/**
 * Широковещательное событие стадии job подписчикам `runtime.onMessage`.
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
        log.debug("emit_job_status: no listeners or context", { job_id: payload.job_id });
    }
}
