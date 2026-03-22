import { is_job_status_message, type JobStatusPayload } from "../shared/contracts";
import { create_logger } from "../shared/logger";
import { JOB_UI_TIMEOUT_MS } from "./constants";
import type { OutcomeCacheRegistry } from "./outcome_cache";

const log = create_logger("content");

export type JobOutcomeHubParams = Readonly<{
    outcome_cache: OutcomeCacheRegistry;
    in_flight: Set<string>;
    reconcile: () => void;
}>;

export type JobOutcomeHub = Readonly<{
    register_pending_save: (accepted_job_id: string, dedup_key: string) => void;
    handle_runtime_message: (message: unknown) => void;
    dispose: () => void;
}>;

function is_terminal_payload(payload: JobStatusPayload): boolean {
    return payload.status === "done" || payload.status === "failed";
}

function is_success_done(payload: JobStatusPayload): boolean {
    return payload.status === "done" && payload.outcome?.kind === "ok";
}

export function create_job_outcome_hub(params: JobOutcomeHubParams): JobOutcomeHub {
    const job_id_to_dedup = new Map<string, string>();
    const timeout_handles = new Map<string, ReturnType<typeof setTimeout>>();

    const clear_ui_timer = (job_id: string): void => {
        const handle = timeout_handles.get(job_id);
        if (handle !== undefined) {
            clearTimeout(handle);
            timeout_handles.delete(job_id);
        }
    };

    const apply_terminal = async (job_id: string, dedup_key: string, payload: JobStatusPayload): Promise<void> => {
        clear_ui_timer(job_id);
        job_id_to_dedup.delete(job_id);
        params.in_flight.delete(dedup_key);

        if (is_success_done(payload)) {
            await params.outcome_cache.set_saved(dedup_key);
        } else {
            const reason =
                payload.status === "failed"
                    ? "failed"
                    : payload.outcome?.kind === "fatal_error" || payload.outcome?.kind === "retryable_error"
                      ? payload.outcome.reason
                      : "unknown";
            await params.outcome_cache.set_failed(dedup_key, reason);
        }
        params.reconcile();
    };

    return {
        register_pending_save(accepted_job_id: string, dedup_key: string): void {
            job_id_to_dedup.set(accepted_job_id, dedup_key);
            clear_ui_timer(accepted_job_id);
            const handle = setTimeout(() => {
                timeout_handles.delete(accepted_job_id);
                if (!job_id_to_dedup.has(accepted_job_id)) {
                    return;
                }
                log.warn("job_status UI timeout: clearing in_flight", {
                    accepted_job_id,
                    dedup_key,
                });
                params.in_flight.delete(dedup_key);
                params.reconcile();
            }, JOB_UI_TIMEOUT_MS);
            timeout_handles.set(accepted_job_id, handle);
        },

        handle_runtime_message(message: unknown): void {
            if (!is_job_status_message(message)) {
                return;
            }
            const payload = message.payload;
            if (!is_terminal_payload(payload)) {
                return;
            }
            const dedup_key = job_id_to_dedup.get(payload.job_id);
            if (dedup_key === undefined) {
                return;
            }
            void apply_terminal(payload.job_id, dedup_key, payload);
        },

        dispose(): void {
            for (const h of timeout_handles.values()) {
                clearTimeout(h);
            }
            timeout_handles.clear();
            job_id_to_dedup.clear();
        },
    };
}
