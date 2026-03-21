export type ImageDomDirtyCallback = () => void;

/**
 * Наблюдение за появлением/сменой `img` (debounce на стороне callback).
 */
export function subscribe_image_dom_changes(
    on_dirty: ImageDomDirtyCallback,
    debounce_ms: number,
): Readonly<{ disconnect(): void }> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
        if (timer !== null) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            on_dirty();
        }, debounce_ms);
    };

    const observer = new MutationObserver((records) => {
        for (const rec of records) {
            if (rec.type === "childList") {
                schedule();
                return;
            }
            if (rec.type === "attributes" && rec.target instanceof HTMLImageElement) {
                const name = rec.attributeName;
                if (name === "src" || name === "srcset") {
                    schedule();
                    return;
                }
            }
        }
    });

    const body = document.body;
    if (body === null) {
        return {
            disconnect() {
                /* no-op */
            },
        };
    }

    observer.observe(body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset"],
    });

    return {
        disconnect() {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            observer.disconnect();
        },
    };
}
