import { create_logger } from "../shared/logger";
import type {
  BlobDownloadResult,
  DownloadImageBlobInput,
  ImageSourceBlobPort
} from "./image_source_blob_port";

const log = create_logger("default_image_source_blob_adapter");

function to_transport_error(error: unknown, path: string): BlobDownloadResult {
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

async function read_text_safely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function body_looks_like_captcha(html_or_text: string): boolean {
  const lower = html_or_text.toLowerCase();
  return (
    lower.includes("captcha") ||
    lower.includes("please enter the captcha") ||
    lower.includes("cloudflare") ||
    lower.includes("attention required")
  );
}

export class DefaultImageSourceBlobAdapter implements ImageSourceBlobPort {
  async download(input: DownloadImageBlobInput): Promise<BlobDownloadResult> {
    let image_response: Response;
    try {
      const image_request_init: RequestInit = {
        credentials: "include",
        referrerPolicy: "strict-origin-when-cross-origin"
      };
      if (input.source_page_url !== undefined && input.source_page_url.length > 0) {
        image_request_init.referrer = input.source_page_url;
      }
      log.debug("default adapter fetch -> image source", {
        image_url: input.image_url,
        source_page_url: input.source_page_url
      });
      image_response = await fetch(input.image_url, image_request_init);
    } catch (error) {
      return to_transport_error(error, input.image_url);
    }

    if (!image_response.ok) {
      const content_type = image_response.headers.get("content-type") ?? "";
      const body_text = await read_text_safely(image_response.clone());
      const is_captcha = image_response.status === 403 && body_looks_like_captcha(body_text);
      log.warn("default adapter image source fetch rejected", {
        status: image_response.status,
        image_url: input.image_url,
        content_type,
        captcha_detected: is_captcha
      });
      return {
        ok: false,
        status: image_response.status,
        code: is_captcha ? "E_SOURCE_CAPTCHA" : "E_NETWORK",
        message: is_captcha
          ? "Image source requires CAPTCHA. Open image in browser and complete verification."
          : `Image download failed: HTTP ${String(image_response.status)}`
      };
    }

    try {
      const blob = await image_response.blob();
      return { ok: true, blob };
    } catch (error) {
      return to_transport_error(error, input.image_url);
    }
  }
}
