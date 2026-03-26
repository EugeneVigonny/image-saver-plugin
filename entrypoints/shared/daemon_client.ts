import { create_logger } from "./logger";

const log = create_logger("daemon_client");

const default_daemon_base_url = "http://127.0.0.1:8765";
const daemon_base_url =
  (import.meta.env["WXT_DAEMON_BASE_URL"] as string | undefined)?.trim() || default_daemon_base_url;

export type SaveImageOptions = Readonly<{
  max_long_edge?: number;
  jpeg_quality?: number;
}>;

export type DaemonError = Readonly<{
  status: number;
  code?: string;
  message: string;
}>;

export type DaemonHealth = Readonly<{
  version: string;
  protocol: number;
}>;

export type SaveImageResponse = Readonly<{
  written_path: string;
  skipped: boolean;
}>;

type DaemonJsonOk<T> = Readonly<{ ok: true } & T>;
const daemon_health_timeout_ms = 2500;

function trim_trailing_slash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function daemon_url(path: string): string {
  return `${trim_trailing_slash(daemon_base_url)}${path}`;
}

function to_daemon_error(status: number, body: unknown, fallback: string): DaemonError {
  if (typeof body === "object" && body !== null) {
    const row = body as Record<string, unknown>;
    const code = typeof row["code"] === "string" ? row["code"] : undefined;
    const message_candidate =
      typeof row["error"] === "string"
        ? row["error"]
        : typeof row["message"] === "string"
          ? row["message"]
          : fallback;
    if (code !== undefined) {
      return { status, code, message: message_candidate };
    }
    return { status, message: message_candidate };
  }
  return { status, message: fallback };
}

async function parse_json_body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function build_headers(content_type?: string): Promise<HeadersInit> {
  const headers: Record<string, string> = {};
  if (content_type !== undefined) {
    headers["Content-Type"] = content_type;
  }
  return headers;
}

async function request_json<T>(
  path: string,
  method: "GET" | "PUT",
  body?: unknown,
  signal?: AbortSignal
): Promise<DaemonJsonOk<T>> {
  const headers = await build_headers(body === undefined ? undefined : "application/json");
  const init: RequestInit = {
    method,
    headers
  };
  if (signal !== undefined) {
    init.signal = signal;
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(daemon_url(path), init);
  } catch (error: unknown) {
    throw to_transport_error(error, path);
  }
  const parsed = await parse_json_body(response);
  if (!response.ok) {
    throw to_daemon_error(response.status, parsed, `Daemon request failed: ${path}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["ok"] !== true
  ) {
    throw {
      status: response.status,
      message: `Daemon response has invalid shape: ${path}`
    } satisfies DaemonError;
  }
  return parsed as DaemonJsonOk<T>;
}

export async function daemon_health(): Promise<DaemonHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), daemon_health_timeout_ms);
  try {
    const response = await request_json<{ version: string; protocol: number }>(
      "/v1/health",
      "GET",
      undefined,
      controller.signal
    );
    return {
      version: response.version,
      protocol: response.protocol
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function daemon_set_save_directory(path: string): Promise<string> {
  const response = await request_json<{ path: string }>("/v1/save-directory", "PUT", { path });
  return response.path;
}

export async function daemon_image_exists(file_name: string): Promise<boolean> {
  const response = await request_json<{ exists: boolean }>(
    `/v1/images/exists?file_name=${encodeURIComponent(file_name)}`,
    "GET"
  );
  return response.exists;
}

export async function daemon_save_image_multipart(params: {
  file_name: string;
  blob: Blob;
  options?: SaveImageOptions;
}): Promise<SaveImageResponse> {
  const form = new FormData();
  form.append(
    "meta",
    JSON.stringify({
      file_name: params.file_name,
      options: params.options
    })
  );
  form.append("file", params.blob, params.file_name);

  let response: Response;
  try {
    response = await fetch(daemon_url("/v1/images"), {
      method: "POST",
      body: form
    });
  } catch (error: unknown) {
    throw to_transport_error(error, "/v1/images");
  }
  const parsed = await parse_json_body(response);
  if (!response.ok) {
    throw to_daemon_error(response.status, parsed, "save_image failed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw {
      status: response.status,
      message: "save_image invalid JSON response"
    } satisfies DaemonError;
  }
  const row = parsed as Record<string, unknown>;
  if (
    row["ok"] !== true ||
    typeof row["written_path"] !== "string" ||
    typeof row["skipped"] !== "boolean"
  ) {
    throw {
      status: response.status,
      message: "save_image response shape mismatch"
    } satisfies DaemonError;
  }
  log.info("daemon_save_image_multipart done", {
    file_name: params.file_name,
    bytes: params.blob.size,
    skipped: row["skipped"]
  });
  return {
    written_path: row["written_path"],
    skipped: row["skipped"]
  };
}

function to_transport_error(error: unknown, path: string): DaemonError {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      status: 0,
      code: "E_TIMEOUT",
      message: `Daemon request timeout: ${path}`
    };
  }
  if (error instanceof TypeError) {
    return {
      status: 0,
      code: "E_NETWORK",
      message: `Network error while calling daemon: ${path}`
    };
  }
  return {
    status: 0,
    code: "E_NETWORK",
    message: error instanceof Error ? error.message : `Daemon transport error: ${path}`
  };
}
