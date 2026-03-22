import {
    runtime_message_types,
    type DirectoryAccessStateResult,
    type GetDirectoryAccessStateMessage,
    type RuntimeResponse,
} from "./contracts";
import { create_logger } from "./logger";
import { normalize_runtime_send_message_result } from "./normalize_runtime_response";

const log = create_logger("runtime");

/**
 * Состояние сохранённой папки из SW (`queryPermission` + доверие к `readwrite_at_pick` в meta при «залипшем» prompt).
 */
export async function send_get_directory_access_state_message(): Promise<
    RuntimeResponse<DirectoryAccessStateResult>
> {
    log.debug("send_get_directory_access_state_message");
    const message: GetDirectoryAccessStateMessage = {
        type: runtime_message_types.get_directory_access_state,
    };
    const raw = await browser.runtime.sendMessage(message);
    const response = normalize_runtime_send_message_result<DirectoryAccessStateResult>(
        raw,
        "send_get_directory_access_state_message",
    );
    log.info("send_get_directory_access_state_message done", { ok: response.ok });
    if (response.ok) {
        log.debug("send_get_directory_access_state_message data", {
            permission_state: response.data.permission_state,
            directory_name: response.data.directory_name,
        });
    } else {
        log.debug("send_get_directory_access_state_message error", { details: response.error.details });
    }
    return response;
}
