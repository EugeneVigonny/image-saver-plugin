import {
    runtime_message_types,
    type QueueSaveMessage,
    type QueueSaveResult,
    type RuntimeResponse,
    type SaveJob,
} from "./contracts";
import { format_url_for_debug } from "./format_url_for_debug";
import { create_logger } from "./logger";
import { normalize_runtime_send_message_result } from "./normalize_runtime_response";

const log = create_logger("content");

/**
 * `queue_save` в SW; ответ нормализуется, если listener отсутствует или форма ответа битая.
 */
export async function send_queue_save_message(payload: SaveJob): Promise<RuntimeResponse<QueueSaveResult>> {
    log.debug("send_queue_save_message", {
        job_id: payload.job_id,
        url: format_url_for_debug(payload.url),
        suggested_name: payload.suggested_name,
    });
    const message: QueueSaveMessage = {
        type: runtime_message_types.queue_save,
        payload,
    };

    const raw = await browser.runtime.sendMessage(message);
    const response = normalize_runtime_send_message_result<QueueSaveResult>(raw, "send_queue_save_message");
    log.info("send_queue_save_message done", {
        job_id: payload.job_id,
        ok: response.ok,
    });
    if (response.ok) {
        log.debug("send_queue_save_message response", {
            job_id: payload.job_id,
            was_duplicate: response.data.was_duplicate,
            accepted_job_id: response.data.accepted_job_id,
            pending_total: response.data.queue_state.total_jobs,
        });
    }
    return response;
}
