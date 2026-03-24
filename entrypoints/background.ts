import { create_logger } from "./shared/logger";

const log = create_logger("background");

export default defineBackground(() => {
  log.info("background initialized (no runtime queue / no File System Access)");
});
