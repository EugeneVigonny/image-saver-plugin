import {
    runtime_message_types,
    type QueueSaveMessage,
    type RuntimeResponse,
    type SaveJob,
} from "./shared/contracts";
import { create_logger } from "./shared/logger";
import { normalize_runtime_send_message_result } from "./shared/normalize_runtime_response";

const log = create_logger("content");

type QueueSaveAck = Readonly<{
    accepted_job_id: string;
}>;

/** Отправляет в background `queue_save` с валидированным `SaveJob`. */
export async function send_queue_save_message(payload: SaveJob): Promise<RuntimeResponse<QueueSaveAck>> {
    log.debug("send_queue_save_message", { job_id: payload.job_id });
    const message: QueueSaveMessage = {
        type: runtime_message_types.queue_save,
        payload,
    };

    const raw = await browser.runtime.sendMessage(message);
    const response = normalize_runtime_send_message_result<QueueSaveAck>(raw, "send_queue_save_message");
    log.info("send_queue_save_message done", {
        job_id: payload.job_id,
        ok: response.ok,
    });
    return response;
}

export default defineContentScript({
    matches: ["*://*.google.com/*"],
    main() {
        log.info("content script main");
    },
});
