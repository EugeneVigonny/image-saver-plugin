/** Литерал `type` для пинга content после смены `save_dir_meta` / папки. */
export const DIRECTORY_ACCESS_UPDATED_MESSAGE_TYPE = "image_saver_directory_updated" as const;

/** Сообщение `tabs.sendMessage` / `runtime.onMessage`: обновить directory gate на странице. */
export type DirectoryAccessUpdatedMessage = Readonly<{
    type: typeof DIRECTORY_ACCESS_UPDATED_MESSAGE_TYPE;
}>;

/** Type guard для пинга обновления папки сохранения. */
export function is_directory_access_updated_message(msg: unknown): msg is DirectoryAccessUpdatedMessage {
    return (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: unknown }).type === DIRECTORY_ACCESS_UPDATED_MESSAGE_TYPE
    );
}
