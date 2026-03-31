import { create_logger } from "./logger";

const log = create_logger("daemon_client");

export type SaveImageOptions = Readonly<{
  max_long_edge?: number;
  quality?: number;
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

type ProxyRequestMap = {
  "daemon.health": { type: "daemon.health" };
  "daemon.get_save_directory": { type: "daemon.get_save_directory" };
  "daemon.set_save_directory": { type: "daemon.set_save_directory"; path: string };
  "daemon.image_exists": { type: "daemon.image_exists"; file_name: string };
  "daemon.find_image_by_name": { type: "daemon.find_image_by_name"; name: string };
  "daemon.find_images_batch": { type: "daemon.find_images_batch"; names: string[] };
  "daemon.save_image_from_url": {
    type: "daemon.save_image_from_url";
    file_name: string;
    image_url: string;
    source_page_url?: string;
    options?: SaveImageOptions;
  };
  "daemon.save_image": {
    type: "daemon.save_image";
    file_name: string;
    blob: Blob;
    options?: SaveImageOptions;
  };
};

type ProxySuccessMap = {
  "daemon.health": { version: string; protocol: number };
  "daemon.get_save_directory": { path: string | null };
  "daemon.set_save_directory": { path: string };
  "daemon.image_exists": { exists: boolean };
  "daemon.find_image_by_name": { result: string[] };
  "daemon.find_images_batch": { result: Record<string, string[]> };
  "daemon.save_image_from_url": { written_path: string; skipped: boolean };
  "daemon.save_image": { written_path: string; skipped: boolean };
};

type ProxyFailure = { ok: false; status: number; code?: string; message: string };
type ProxySuccess<K extends keyof ProxySuccessMap> = {
  ok: true;
  type: K;
  data: ProxySuccessMap[K];
};

function is_daemon_error(value: unknown): value is DaemonError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row["status"] === "number" && typeof row["message"] === "string";
}

function to_daemon_error_from_failure(failure: ProxyFailure): DaemonError {
  return failure.code === undefined
    ? { status: failure.status, message: failure.message }
    : { status: failure.status, code: failure.code, message: failure.message };
}

export async function daemon_health(): Promise<DaemonHealth> {
  const response = await request_via_background("daemon.health", { type: "daemon.health" });
  return response;
}

export async function daemon_set_save_directory(path: string): Promise<string> {
  const response = await request_via_background("daemon.set_save_directory", {
    type: "daemon.set_save_directory",
    path
  });
  return response.path;
}

export async function daemon_get_save_directory(): Promise<string | null> {
  const response = await request_via_background("daemon.get_save_directory", {
    type: "daemon.get_save_directory"
  });
  return response.path;
}

export async function daemon_image_exists(file_name: string): Promise<boolean> {
  const response = await request_via_background("daemon.image_exists", {
    type: "daemon.image_exists",
    file_name
  });
  return response.exists;
}

export async function daemon_find_image_by_name(name: string): Promise<string[]> {
  const response = await request_via_background("daemon.find_image_by_name", {
    type: "daemon.find_image_by_name",
    name
  });
  return response.result;
}

export async function daemon_find_images_batch(
  names: string[]
): Promise<Record<string, string[]>> {
  const response = await request_via_background("daemon.find_images_batch", {
    type: "daemon.find_images_batch",
    names
  });
  return response.result;
}

export async function daemon_save_image_multipart(params: {
  file_name: string;
  blob: Blob;
  options?: SaveImageOptions;
}): Promise<SaveImageResponse> {
  const request: ProxyRequestMap["daemon.save_image"] = {
    type: "daemon.save_image",
    file_name: params.file_name,
    blob: params.blob
  };
  if (params.options !== undefined) {
    request.options = params.options;
  }
  const response = await request_via_background("daemon.save_image", request);
  log.info("daemon_save_image_multipart done", {
    file_name: params.file_name,
    bytes: params.blob.size,
    skipped: response.skipped
  });
  return {
    written_path: response.written_path,
    skipped: response.skipped
  };
}

export async function daemon_save_image_from_url(params: {
  file_name: string;
  image_url: string;
  source_page_url?: string;
  options?: SaveImageOptions;
}): Promise<SaveImageResponse> {
  const request: ProxyRequestMap["daemon.save_image_from_url"] = {
    type: "daemon.save_image_from_url",
    file_name: params.file_name,
    image_url: params.image_url
  };
  if (params.options !== undefined) {
    request.options = params.options;
  }
  if (params.source_page_url !== undefined) {
    request.source_page_url = params.source_page_url;
  }
  const response = await request_via_background("daemon.save_image_from_url", request);
  log.info("daemon_save_image_from_url done", {
    file_name: params.file_name,
    image_url: params.image_url,
    skipped: response.skipped
  });
  return {
    written_path: response.written_path,
    skipped: response.skipped
  };
}

async function request_via_background<K extends keyof ProxySuccessMap>(
  expected_type: K,
  request: ProxyRequestMap[K]
): Promise<ProxySuccessMap[K]> {
  try {
    const response = (await browser.runtime.sendMessage(request)) as
      | ProxySuccess<K>
      | ProxyFailure
      | null
      | undefined;
    if (typeof response !== "object" || response === null || !("ok" in response)) {
      throw {
        status: 0,
        code: "E_NETWORK",
        message: `Invalid proxy response for ${request.type}`
      } satisfies DaemonError;
    }
    if (!response.ok) {
      throw to_daemon_error_from_failure(response);
    }
    if (response.type !== expected_type) {
      throw {
        status: 0,
        code: "E_NETWORK",
        message: `Proxy response type mismatch for ${request.type}`
      } satisfies DaemonError;
    }
    return response.data;
  } catch (error: unknown) {
    if (is_daemon_error(error)) {
      throw error;
    }
    const transport = to_transport_error(error, request.type);
    throw transport;
  }
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
