import Pica from "pica";
import { create_logger } from "./logger";

const log = create_logger("resize");

/** Длинная сторона выхода (логические px), согласовано с skill (FHD cap). */
export const RESIZE_MAX_LONG_EDGE = 1920;

/**
 * В service worker нет `document`; OffscreenCanvas — нормальный источник тайлов для pica.
 * Не ограничиваемся `features: ["js"]`: иначе почти всегда идёт путь с `getImageData`, ломающийся при RFP / anti-fingerprint.
 */
const pica = new Pica({
    tile: 1024,
    features: ["wasm", "ww", "js"],
    createCanvas(width: number, height: number): HTMLCanvasElement {
        return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
    },
});

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
 * @remarks Цепочка: pica → `drawImage`+`convertToBlob` → исходный `blob`, если canvas заблокирован (RFP).
 */
export async function resize_image_to_jpeg_blob(blob: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(blob);
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
            const message = pica_error instanceof Error ? pica_error.message : String(pica_error);
            log.debug("resize_image_to_jpeg_blob: pica failed, canvas draw", { message });
            try {
                const out = await bitmap_to_jpeg_via_draw(bitmap, target_w, target_h);
                log.debug("resize_image_to_jpeg_blob: path", { strategy: "canvas_draw", out_bytes: out.size });
                return out;
            } catch (draw_error) {
                const draw_msg = draw_error instanceof Error ? draw_error.message : String(draw_error);
                log.warn("canvas JPEG encode failed; saving original download bytes", {
                    message: draw_msg,
                    type: blob.type,
                    size: blob.size,
                });
                log.debug("resize_image_to_jpeg_blob: path", { strategy: "original_blob" });
                return blob;
            }
        }
    } finally {
        bitmap.close();
    }
}
