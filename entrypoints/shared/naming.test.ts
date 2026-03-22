import { describe, expect, it } from "vitest";
import { suggested_name_from_image_url } from "./naming";

describe("suggested_name_from_image_url", () => {
    it("uses last path segment and extension when URL has ext in final segment", () => {
        const name = suggested_name_from_image_url("https://cdn.example.com/foo/bar/photo.PNG?v=1");
        expect(name).toBe("photo.png");
    });

    it("defaults to .jpg when final segment has no valid extension", () => {
        const name = suggested_name_from_image_url("https://img.example.com/asset/no-ext-here");
        expect(name).toBe("no-ext-here.jpg");
    });

    it("ignores query string for pathname-derived stem (query not in pathname)", () => {
        const name = suggested_name_from_image_url(
            "https://host.example/path/to/file.webp?token=abc&x=1#frag",
        );
        expect(name).toBe("file.webp");
    });

    it("truncates stem to 200 chars", () => {
        const long = "a".repeat(250);
        const name = suggested_name_from_image_url(`https://x.example/p/${long}.gif`);
        expect(name.length).toBe(200 + ".gif".length);
        expect(name.endsWith(".gif")).toBe(true);
        expect(name.startsWith("a".repeat(200))).toBe(true);
    });

    it("sanitizes non-ASCII and invalid filename chars in stem", () => {
        const name = suggested_name_from_image_url("https://x.example/dir/%D0%BA%D0%B0%D1%80%D1%82%D0%B8%D0%BD%D0%BA%D0%B0.png");
        expect(name).toMatch(/\.png$/);
        expect(name).not.toContain("/");
        expect(name).not.toContain("<");
    });

    it("returns default stem+jpg for invalid absolute URL", () => {
        expect(suggested_name_from_image_url("not-a-url")).toBe("image.jpg");
    });

    it("treats trailing dot segment as no extension and falls back to .jpg", () => {
        const name = suggested_name_from_image_url("https://x.example/end.");
        expect(name).toBe("end.jpg");
    });
});
