import {
    runtime_message_types,
    type QueueSaveMessage,
    type RuntimeResponse,
    type SaveJob,
} from "./shared/contracts";

type QueueSaveAck = Readonly<{
    accepted_job_id: string;
}>;

/**
 * Отправляет в background типизированный запрос на добавление job в очередь.
 */
export async function send_queue_save_message(payload: SaveJob): Promise<RuntimeResponse<QueueSaveAck>> {
    const message: QueueSaveMessage = {
        type: runtime_message_types.queue_save,
        payload,
    };

    const response = await browser.runtime.sendMessage(message);
    return response as RuntimeResponse<QueueSaveAck>;
}

export default defineContentScript({
    matches: ["*://*.google.com/*"],
    main() {
        console.log("Hello content.");
    },
});
