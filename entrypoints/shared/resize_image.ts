import Pica from "pica";
import { create_logger } from "./logger";

const log = create_logger("resize");

/** Длинная сторона выхода (логические px), согласовано с skill (FHD cap). */
export const RESIZE_MAX_LONG_EDGE = 1920;

/**
 * Pica с `js` тянет `getImageData` на тайлах — в MV3 SW в Chromium это даёт `NotAllowedError`.
 * Используем pica только как запасной путь после нативного `drawImage` + `convertToBlob`.
 * Без `ww` / `wasm`: вложенные Worker и wasm в SW нестабильны.
 */
const pica = new Pica({
    tile: 1024,
    features: ["js"],
    createCanvas(width: number, height: number): HTMLCanvasElement {
        return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
    },
});

function safe_close_bitmap(bitmap: ImageBitmap): void {
    try {
        bitmap.close();
    } catch {
        /* В extension SW `close()` иногда бросает тот же NotAllowedError и отменяет успешный return из try/finally. */
    }
}

async function create_image_bitmap_from_blob(blob: Blob): Promise<ImageBitmap> {
    try {
        return await createImageBitmap(blob);
    } catch (first: unknown) {
        /** Некоторые JPEG с EXIF / цветовыми профилями падают на дефолтном декоде в SW — пробуем «сырой» растр. */
        try {
            return await createImageBitmap(blob, {
                imageOrientation: "none",
                premultiplyAlpha: "premultiply",
                colorSpaceConversion: "none",
            });
        } catch {
            throw first instanceof Error ? first : new Error(String(first));
        }
    }
}

function compute_target_dimensions(
    width: number,
    height: number,
    max_edge: number,
): Readonly<{ target_w: number; target_h: number }> {
    let target_w = width;
    let target_h = height;
    if (width > height && width > max_edge) {
        target_w = max_edge;
        target_h = Math.max(1, Math.round((height * max_edge) / width));
    } else if (height >= width && height > max_edge) {
        target_h = max_edge;
        target_w = Math.max(1, Math.round((width * max_edge) / height));
    }
    return { target_w, target_h };
}

/**
 * Масштабирование без pica: только `drawImage` + `convertToBlob` (без `getImageData` в нашем коде).
 * При строгом RFP может всё же упасть — тогда см. fallback на исходный blob.
 */
async function bitmap_to_jpeg_via_draw(
    bitmap: ImageBitmap,
    target_w: number,
    target_h: number,
): Promise<Blob> {
    const canvas = new OffscreenCanvas(target_w, target_h);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) {
        throw new Error("OffscreenCanvas 2d context is null");
    }
    ctx.drawImage(bitmap, 0, 0, target_w, target_h);
    const out = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.9,
    });
    if (out.size === 0) {
        throw new Error("JPEG encode produced empty blob");
    }
    return out;
}

/**
 * Укладывает длинную сторону в `RESIZE_MAX_LONG_EDGE`, выдаёт JPEG-подобный `Blob`.
 * @remarks Цепочка: pica → `drawImage`+`convertToBlob` → исходный `blob`.
 * Если `createImageBitmap` падает (в SW бывает после перезагрузки вкладки / кэша) — сохраняем сырые байты без resize.
 */
export async function resize_image_to_jpeg_blob(blob: Blob): Promise<Blob> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await create_image_bitmap_from_blob(blob);
    } catch (decode_error: unknown) {
        const message = decode_error instanceof Error ? decode_error.message : String(decode_error);
        log.warn("resize: createImageBitmap failed; saving original download bytes", {
            message,
            type: blob.type,
            size: blob.size,
        });
        return blob;
    }

    try {
        const { width, height } = bitmap;
        const { target_w, target_h } = compute_target_dimensions(width, height, RESIZE_MAX_LONG_EDGE);
        log.debug("resize_image_to_jpeg_blob: source", {
            src_px: { width, height },
            target_px: { width: target_w, height: target_h },
            in_bytes: blob.size,
            in_type: blob.type || "(empty)",
        });

        try {
            const out_draw = await bitmap_to_jpeg_via_draw(bitmap, target_w, target_h);
            log.debug("resize_image_to_jpeg_blob: path", { strategy: "canvas_draw", out_bytes: out_draw.size });
            return out_draw;
        } catch (draw_error) {
            const draw_msg = draw_error instanceof Error ? draw_error.message : String(draw_error);
            log.debug("resize_image_to_jpeg_blob: canvas draw failed, try pica", { message: draw_msg });
            try {
                const dest_canvas = new OffscreenCanvas(target_w, target_h);
                /** `@types/pica` описывает `to` как `HTMLCanvasElement`; в SW — `OffscreenCanvas`. */
                await pica.resize(bitmap, dest_canvas as unknown as HTMLCanvasElement);
                const from_pica = await dest_canvas.convertToBlob({
                    type: "image/jpeg",
                    quality: 0.9,
                });
                if (from_pica.size > 0) {
                    log.debug("resize_image_to_jpeg_blob: path", { strategy: "pica", out_bytes: from_pica.size });
                    return from_pica;
                }
                throw new Error("pica path produced empty JPEG blob");
            } catch (pica_error) {
                const pica_msg = pica_error instanceof Error ? pica_error.message : String(pica_error);
                log.warn("resize: pica failed; saving original download bytes", {
                    message: pica_msg,
                    type: blob.type,
                    size: blob.size,
                });
                log.debug("resize_image_to_jpeg_blob: path", { strategy: "original_blob" });
                return blob;
            }
        }
    } finally {
        safe_close_bitmap(bitmap);
    }
}
