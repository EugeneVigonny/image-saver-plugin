import { create_logger } from "./shared/logger";
import { DefaultImageSourceBlobAdapter } from "./background/default_image_source_blob_adapter";
import type { ImageSourceBlobPort } from "./background/image_source_blob_port";

const log = create_logger("background");

type SaveImageOptions = Readonly<{
  max_long_edge?: number;
  quality?: number;
}>;

type ProxyRequest =
  | { type: "daemon.health" }
  | { type: "daemon.get_save_directory" }
  | { type: "daemon.set_save_directory"; path: string }
  | { type: "daemon.image_exists"; file_name: string }
  | { type: "daemon.find_image_by_name"; name: string }
  | { type: "daemon.find_images_batch"; names: string[] }
  | { type: "daemon.get_image_source_adapters" }
  | { type: "daemon.set_image_source_adapter"; adapter: ImageSourceAdapterKind }
  | {
      type: "daemon.save_image_from_url";
      file_name: string;
      image_url: string;
      source_page_url?: string;
      options?: SaveImageOptions;
    }
  | {
      type: "daemon.save_image";
      file_name: string;
      blob: Blob;
      options?: SaveImageOptions;
    };

type ProxySuccess =
  | { ok: true; type: "daemon.health"; data: { version: string; protocol: number } }
  | { ok: true; type: "daemon.get_save_directory"; data: { path: string | null } }
  | { ok: true; type: "daemon.set_save_directory"; data: { path: string } }
  | { ok: true; type: "daemon.image_exists"; data: { exists: boolean } }
  | { ok: true; type: "daemon.find_image_by_name"; data: { result: string[] } }
  | { ok: true; type: "daemon.find_images_batch"; data: { result: Record<string, string[]> } }
  | {
      ok: true;
      type: "daemon.get_image_source_adapters";
      data: { selected: ImageSourceAdapterKind; available: ImageSourceAdapterKind[] };
    }
  | { ok: true; type: "daemon.set_image_source_adapter"; data: { selected: ImageSourceAdapterKind } }
  | {
      ok: true;
      type: "daemon.save_image_from_url";
      data: { written_path: string; skipped: boolean };
    }
  | { ok: true; type: "daemon.save_image"; data: { written_path: string; skipped: boolean } };

type ProxyFailure = {
  ok: false;
  status: number;
  code?: string;
  message: string;
};

type ProxyResponse = ProxySuccess | ProxyFailure;

const default_daemon_base_url = "http://127.0.0.1:8765";
const daemon_base_url =
  (import.meta.env["WXT_DAEMON_BASE_URL"] as string | undefined)?.trim() || default_daemon_base_url;
const daemon_health_timeout_ms = 2500;
const daemon_image_source_adapter_key = "daemon_image_source_adapter";

type ImageSourceAdapterKind = "default" | "extra";
type AdapterEntry = Readonly<{
  name: ImageSourceAdapterKind;
  create: () => ImageSourceBlobPort;
}>;

const adapter_entries = new Map<ImageSourceAdapterKind, AdapterEntry>([
  [
    "default",
    {
      name: "default",
      create: () => new DefaultImageSourceBlobAdapter()
    }
  ]
]);

let selected_image_source_adapter: ImageSourceAdapterKind = "default";
let image_source_blob_adapter: ImageSourceBlobPort = new DefaultImageSourceBlobAdapter();

function get_available_image_source_adapters(): ImageSourceAdapterKind[] {
  return [...adapter_entries.keys()];
}

function normalize_adapter_kind(value: unknown): ImageSourceAdapterKind {
  if (value === "extra" && adapter_entries.has("extra")) {
    return "extra";
  }
  return "default";
}

function activate_selected_adapter(adapter: ImageSourceAdapterKind): void {
  const entry = adapter_entries.get(adapter) ?? adapter_entries.get("default");
  if (entry === undefined) {
    image_source_blob_adapter = new DefaultImageSourceBlobAdapter();
    selected_image_source_adapter = "default";
    return;
  }
  image_source_blob_adapter = entry.create();
  selected_image_source_adapter = entry.name;
  log.info("image source adapter activated", { adapter: selected_image_source_adapter });
}

async function persist_selected_adapter(adapter: ImageSourceAdapterKind): Promise<void> {
  await browser.storage.local.set({ [daemon_image_source_adapter_key]: adapter });
}

async function load_selected_adapter_from_storage(): Promise<void> {
  const bag = await browser.storage.local.get([daemon_image_source_adapter_key]);
  const normalized = normalize_adapter_kind(bag[daemon_image_source_adapter_key]);
  activate_selected_adapter(normalized);
}

async function try_register_extra_blob_adapter(): Promise<void> {
  const extra_modules = import.meta.glob("./background/extra_image_source_blob_adapter.ts");
  const loader = extra_modules["./background/extra_image_source_blob_adapter.ts"];
  if (loader === undefined) {
    log.info("extra image source adapter is absent; use default adapter");
    return;
  }
  try {
    const row = (await loader()) as {
      ExtraImageSourceBlobAdapter?: new () => ImageSourceBlobPort;
    };
    const ExtraCtor = row.ExtraImageSourceBlobAdapter;
    if (typeof ExtraCtor === "function") {
      adapter_entries.set("extra", { name: "extra", create: () => new ExtraCtor() });
      log.info("extra image source adapter registered");
      return;
    }
    log.warn("extra adapter module loaded without constructor");
  } catch (error: unknown) {
    log.warn("extra image source adapter load failed; use default adapter", { error });
  }
}

function trim_trailing_slash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function daemon_url(path: string): string {
  return `${trim_trailing_slash(daemon_base_url)}${path}`;
}

function to_transport_error(error: unknown, path: string): ProxyFailure {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      ok: false,
      status: 0,
      code: "E_TIMEOUT",
      message: `Daemon request timeout: ${path}`
    };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      status: 0,
      code: "E_NETWORK",
      message: `Network error while calling daemon: ${path}`
    };
  }
  return {
    ok: false,
    status: 0,
    code: "E_NETWORK",
    message: error instanceof Error ? error.message : `Daemon transport error: ${path}`
  };
}

async function parse_json_body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function to_daemon_error(status: number, body: unknown, fallback: string): ProxyFailure {
  if (typeof body === "object" && body !== null) {
    const row = body as Record<string, unknown>;
    const code = typeof row["code"] === "string" ? row["code"] : undefined;
    const message_candidate =
      typeof row["error"] === "string"
        ? row["error"]
        : typeof row["message"] === "string"
          ? row["message"]
          : fallback;
    return code === undefined
      ? { ok: false, status, message: message_candidate }
      : { ok: false, status, code, message: message_candidate };
  }
  return { ok: false, status, message: fallback };
}

async function request_json<T>(
  path: string,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
  signal?: AbortSignal
): Promise<T | ProxyFailure> {
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  if (signal !== undefined) {
    init.signal = signal;
  }

  let response: Response;
  try {
    const target_url = daemon_url(path);
    log.debug("proxy fetch -> daemon", { method, path, target_url });
    response = await fetch(target_url, init);
  } catch (error) {
    return to_transport_error(error, path);
  }
  const parsed = await parse_json_body(response);
  if (!response.ok) {
    return to_daemon_error(response.status, parsed, `Daemon request failed: ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>)["ok"] !== true) {
    return {
      ok: false,
      status: response.status,
      code: "E_TRANSPORT",
      message: `Daemon response has invalid shape: ${path}`
    };
  }
  return parsed as T;
}

async function handle_proxy_request(request: ProxyRequest): Promise<ProxyResponse> {
  if (request.type === "daemon.health") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), daemon_health_timeout_ms);
    try {
      const result = await request_json<{ ok: true; version: string; protocol: number }>(
        "/v1/health",
        "GET",
        undefined,
        controller.signal
      );
      if ("ok" in result && result.ok === false) {
        return result;
      }
      return { ok: true, type: "daemon.health", data: { version: result.version, protocol: result.protocol } };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (request.type === "daemon.get_save_directory") {
    const result = await request_json<{ ok: true; path: string }>("/v1/save-directory", "GET");
    if ("ok" in result && result.ok === false) {
      if (result.code === "E_NOT_CONFIGURED") {
        return { ok: true, type: "daemon.get_save_directory", data: { path: null } };
      }
      return result;
    }
    return { ok: true, type: "daemon.get_save_directory", data: { path: result.path } };
  }

  if (request.type === "daemon.set_save_directory") {
    const result = await request_json<{ ok: true; path: string }>(
      "/v1/save-directory",
      "PUT",
      { path: request.path }
    );
    if ("ok" in result && result.ok === false) {
      return result;
    }
    return { ok: true, type: "daemon.set_save_directory", data: { path: result.path } };
  }

  if (request.type === "daemon.image_exists") {
    const result = await request_json<{ ok: true; exists: boolean }>(
      `/v1/images/exists?file_name=${encodeURIComponent(request.file_name)}`,
      "GET"
    );
    if ("ok" in result && result.ok === false) {
      return result;
    }
    return { ok: true, type: "daemon.image_exists", data: { exists: result.exists } };
  }

  if (request.type === "daemon.find_image_by_name") {
    const result = await request_json<{ ok: true; result: string[] }>(
      `/v1/images/find?name=${encodeURIComponent(request.name)}`,
      "GET"
    );
    if ("ok" in result && result.ok === false) {
      return result;
    }
    return { ok: true, type: "daemon.find_image_by_name", data: { result: result.result } };
  }

  if (request.type === "daemon.find_images_batch") {
    const result = await request_json<{ ok: true; result: Record<string, string[]> }>(
      "/v1/images/find-batch",
      "POST",
      { names: request.names }
    );
    if ("ok" in result && result.ok === false) {
      return result;
    }
    return { ok: true, type: "daemon.find_images_batch", data: { result: result.result } };
  }

  if (request.type === "daemon.get_image_source_adapters") {
    return {
      ok: true,
      type: "daemon.get_image_source_adapters",
      data: {
        selected: selected_image_source_adapter,
        available: get_available_image_source_adapters()
      }
    };
  }

  if (request.type === "daemon.set_image_source_adapter") {
    const normalized = normalize_adapter_kind(request.adapter);
    activate_selected_adapter(normalized);
    try {
      await persist_selected_adapter(normalized);
    } catch (error: unknown) {
      log.warn("persist_selected_adapter failed", { error, adapter: normalized });
    }
    return {
      ok: true,
      type: "daemon.set_image_source_adapter",
      data: { selected: selected_image_source_adapter }
    };
  }

  if (request.type === "daemon.save_image_from_url") {
    const download_input =
      request.source_page_url === undefined
        ? { image_url: request.image_url }
        : { image_url: request.image_url, source_page_url: request.source_page_url };
    const blob_result = await image_source_blob_adapter.download(download_input);
    if (!blob_result.ok) {
      return blob_result;
    }

    const form = new FormData();
    form.append(
      "meta",
      JSON.stringify({
        file_name: request.file_name,
        options: request.options
      })
    );
    form.append("file", blob_result.blob, request.file_name);

    let response: Response;
    try {
      const target_url = daemon_url("/v1/images");
      log.debug("proxy fetch -> daemon multipart", {
        method: "POST",
        path: "/v1/images",
        target_url
      });
      response = await fetch(target_url, { method: "POST", body: form });
    } catch (error) {
      return to_transport_error(error, "/v1/images");
    }
    const parsed = await parse_json_body(response);
    if (!response.ok) {
      return to_daemon_error(response.status, parsed, "save_image failed");
    }
    if (typeof parsed !== "object" || parsed === null) {
      return {
        ok: false,
        status: response.status,
        code: "E_TRANSPORT",
        message: "save_image invalid JSON response"
      };
    }
    const row = parsed as Record<string, unknown>;
    if (
      row["ok"] !== true ||
      typeof row["written_path"] !== "string" ||
      typeof row["skipped"] !== "boolean"
    ) {
      return {
        ok: false,
        status: response.status,
        code: "E_TRANSPORT",
        message: "save_image response shape mismatch"
      };
    }
    return {
      ok: true,
      type: "daemon.save_image_from_url",
      data: { written_path: row["written_path"], skipped: row["skipped"] }
    };
  }

  const form = new FormData();
  form.append(
    "meta",
    JSON.stringify({
      file_name: request.file_name,
      options: request.options
    })
  );
  form.append("file", request.blob, request.file_name);

  let response: Response;
  try {
    const target_url = daemon_url("/v1/images");
    log.debug("proxy fetch -> daemon multipart", {
      method: "POST",
      path: "/v1/images",
      target_url
    });
    response = await fetch(target_url, { method: "POST", body: form });
  } catch (error) {
    return to_transport_error(error, "/v1/images");
  }
  const parsed = await parse_json_body(response);
  if (!response.ok) {
    return to_daemon_error(response.status, parsed, "save_image failed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, status: response.status, code: "E_TRANSPORT", message: "save_image invalid JSON response" };
  }
  const row = parsed as Record<string, unknown>;
  if (row["ok"] !== true || typeof row["written_path"] !== "string" || typeof row["skipped"] !== "boolean") {
    return { ok: false, status: response.status, code: "E_TRANSPORT", message: "save_image response shape mismatch" };
  }
  return {
    ok: true,
    type: "daemon.save_image",
    data: { written_path: row["written_path"], skipped: row["skipped"] }
  };
}

export default defineBackground(() => {
  log.info("background initialized");
  void (async () => {
    await try_register_extra_blob_adapter();
    await load_selected_adapter_from_storage();
  })().catch((error: unknown) => {
    log.warn("image source adapter init failed", { error });
    activate_selected_adapter("default");
  });
  const maybe_chrome_runtime = (
    globalThis as unknown as {
      chrome?: {
        runtime?: {
          onMessage?: {
            addListener: (
              callback: (
                message: unknown,
                sender: unknown,
                sendResponse: (response: ProxyResponse) => void
              ) => boolean | void
            ) => void;
          };
        };
      };
    }
  ).chrome?.runtime;

  if (maybe_chrome_runtime?.onMessage !== undefined) {
    maybe_chrome_runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (typeof message !== "object" || message === null || !("type" in message)) {
        return undefined;
      }
      const req = message as { type?: unknown };
      if (typeof req.type !== "string" || !req.type.startsWith("daemon.")) {
        return undefined;
      }
      void handle_proxy_request(message as ProxyRequest).then((response) => sendResponse(response));
      return true;
    });
    return;
  }

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      return undefined;
    }
    const req = message as { type?: unknown };
    if (typeof req.type !== "string" || !req.type.startsWith("daemon.")) {
      return undefined;
    }
    return handle_proxy_request(message as ProxyRequest);
  });
});
