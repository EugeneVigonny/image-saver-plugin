import {
    create_invalid_message_error,
    is_runtime_request_message,
    runtime_message_types,
    type QueueState,
    type RuntimeRequestMessage,
    type RuntimeResponse,
    type SaveJob,
} from "./shared/contracts";

type QueueSaveResult = Readonly<{
    accepted_job_id: string;
    queue_state: QueueState;
}>;

type GetQueueStateResult = Readonly<{
    queue_state: QueueState;
}>;

type BackgroundResponse = RuntimeResponse<QueueSaveResult | GetQueueStateResult>;

export default defineBackground(() => {
    const pending_jobs: SaveJob[] = [];

    function build_queue_state(processing_job_id: string | null): QueueState {
        return {
            pending_jobs: [...pending_jobs],
            processing_job_id,
            total_jobs: pending_jobs.length,
            updated_at: Date.now(),
        };
    }

    function handle_runtime_request(message: RuntimeRequestMessage): BackgroundResponse {
        switch (message.type) {
            case runtime_message_types.queue_save: {
                pending_jobs.push(message.payload);
                return {
                    ok: true,
                    data: {
                        accepted_job_id: message.payload.job_id,
                        queue_state: build_queue_state(null),
                    },
                };
            }
            case runtime_message_types.get_queue_state: {
                return {
                    ok: true,
                    data: {
                        queue_state: build_queue_state(null),
                    },
                };
            }
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    browser.runtime.onMessage.addListener((message: unknown) => {
        if (!is_runtime_request_message(message)) {
            const error = create_invalid_message_error(
                "Expected queue_save|get_queue_state with valid payload",
            );
            console.warn("[background] rejected runtime message", { error, message });
            return Promise.resolve({
                ok: false,
                error,
            } satisfies BackgroundResponse);
        }

        return Promise.resolve(handle_runtime_request(message));
    });
});
