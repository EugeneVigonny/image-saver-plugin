import "./style.css";
import {
  daemon_health,
  daemon_set_save_directory,
  type DaemonError
} from "@/entrypoints/shared/daemon_client";
import { create_logger } from "@/entrypoints/shared/logger";

const log = create_logger("popup");
const daemon_save_directory_key = "daemon_save_directory";

type PopupViewModel = Readonly<{
  is_busy: boolean;
  daemon_online: boolean;
  directory_path: string;
  last_error: string | null;
  protocol: number | null;
  version: string | null;
}>;

const app = document.querySelector<HTMLDivElement>("#app") as HTMLDivElement;

let view_model: PopupViewModel = {
  is_busy: false,
  daemon_online: false,
  directory_path: "",
  last_error: null,
  protocol: null,
  version: null
};

function daemon_error_to_text(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const row = error as DaemonError;
    return row.code ? `${row.message} (${row.code})` : row.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function set_view_model(next: PopupViewModel): void {
  view_model = next;
  render();
}

function set_busy(is_busy: boolean): void {
  view_model = {
    ...view_model,
    is_busy
  };
  apply_busy_state();
}

function apply_busy_state(): void {
  const path_input = document.querySelector<HTMLInputElement>("#daemon-directory-path");
  const save_button = document.querySelector<HTMLButtonElement>("#save-settings");

  if (path_input !== null) {
    path_input.disabled = view_model.is_busy;
  }
  if (save_button !== null) {
    save_button.disabled = view_model.is_busy;
  }
}

async function load_local_settings(): Promise<void> {
  const bag = await browser.storage.local.get([daemon_save_directory_key]);
  set_view_model({
    ...view_model,
    directory_path:
      typeof bag[daemon_save_directory_key] === "string" ? bag[daemon_save_directory_key] : ""
  });
}

async function sync_health(): Promise<void> {
  try {
    const health = await daemon_health();
    set_view_model({
      ...view_model,
      daemon_online: true,
      protocol: health.protocol,
      version: health.version,
      last_error: null
    });
  } catch (error) {
    set_view_model({
      ...view_model,
      daemon_online: false,
      protocol: null,
      version: null,
      last_error: daemon_error_to_text(error)
    });
  }
}

async function on_save_settings_click(): Promise<void> {
  if (view_model.is_busy) {
    return;
  }
  set_busy(true);
  try {
    const path_input = document.querySelector<HTMLInputElement>("#daemon-directory-path");
    const directory_path = path_input?.value.trim() ?? "";

    await browser.storage.local.set({
      [daemon_save_directory_key]: directory_path
    });

    if (directory_path.length > 0) {
      await daemon_set_save_directory(directory_path);
    }

    set_view_model({
      ...view_model,
      directory_path,
      last_error: null
    });
    await sync_health();
  } catch (error) {
    const details = daemon_error_to_text(error);
    log.warn("on_save_settings_click failed", { details, error });
    set_view_model({
      ...view_model,
      last_error: details
    });
  } finally {
    set_busy(false);
  }
}

function render(): void {
  const disabled_attr = view_model.is_busy ? "disabled" : "";
  app.innerHTML = `
        <main class="popup-root">
            <h1>Image Saver</h1>
            <p>Демон: <strong>${view_model.daemon_online ? "online" : "offline"}</strong></p>
            <p>Версия: <strong>${view_model.version ?? "—"}</strong>, protocol: <strong>${view_model.protocol ?? "—"}</strong></p>
            <label>
                <p>Папка сохранения (absolute path)</p>
                <input id="daemon-directory-path" value="${view_model.directory_path}" ${disabled_attr} />
            </label>
            <div class="popup-actions">
                <button id="save-settings" ${disabled_attr}>Сохранить настройки</button>
            </div>
            ${view_model.last_error ? `<p class="popup-error">${view_model.last_error}</p>` : ""}
        </main>
    `;

  const save_button = document.querySelector<HTMLButtonElement>("#save-settings");
  if (save_button !== null) {
    save_button.addEventListener("click", () => {
      void on_save_settings_click();
    });
  }
}

render();

void (async () => {
  await load_local_settings();
  await sync_health();
})().catch((error: unknown) => {
  log.warn("popup init failed", { error });
});
