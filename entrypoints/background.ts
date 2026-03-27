import { create_logger } from "./shared/logger";

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
  | {
      type: "daemon.save_image_from_url";
      file_name: string;
      image_url: string;
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
  method: "GET" | "PUT",
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
    response = await fetch(daemon_url(path), init);
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

  if (request.type === "daemon.save_image_from_url") {
    let image_response: Response;
    try {
      image_response = await fetch(request.image_url);
    } catch (error) {
      return to_transport_error(error, request.image_url);
    }
    if (!image_response.ok) {
      return {
        ok: false,
        status: image_response.status,
        code: "E_NETWORK",
        message: `Image download failed: HTTP ${String(image_response.status)}`
      };
    }
    let image_blob: Blob;
    try {
      image_blob = await image_response.blob();
    } catch (error) {
      return to_transport_error(error, request.image_url);
    }

    const form = new FormData();
    form.append(
      "meta",
      JSON.stringify({
        file_name: request.file_name,
        options: request.options
      })
    );
    form.append("file", image_blob, request.file_name);

    let response: Response;
    try {
      response = await fetch(daemon_url("/v1/images"), { method: "POST", body: form });
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
    response = await fetch(daemon_url("/v1/images"), { method: "POST", body: form });
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
