import { run_content_app } from "./content/main";
import { create_logger } from "./shared/logger";

const log = create_logger("content");

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    log.info("content script main");
    log.debug("content script context", {
      href:
        typeof location.href === "string" && location.href.length > 120
          ? `${location.href.slice(0, 117)}…`
          : location.href
    });
    run_content_app();
  }
});
