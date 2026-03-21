import { run_content_app } from "./content/main";
import { send_queue_save_message } from "./shared/send_queue_save_message";
import { create_logger } from "./shared/logger";

export { send_queue_save_message };

const log = create_logger("content");

export default defineContentScript({
    matches: ["<all_urls>"],
    main() {
        log.info("content script main");
        run_content_app();
    },
});
