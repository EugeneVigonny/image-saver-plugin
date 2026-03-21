import { SESSION_SAVED_DEDUP_KEYS, SESSION_SAVED_KEYS_CAP } from "./constants";

/** Множество успешно сохранённых dedup-ключей за сессию (`chrome.storage.session`). */
export class SessionSavedDedupRegistry {
    private readonly keys = new Set<string>();
    private load_promise: Promise<void> | null = null;

    async ensure_loaded(): Promise<void> {
        if (this.load_promise === null) {
            this.load_promise = this.load_from_storage();
        }
        await this.load_promise;
    }

    private async load_from_storage(): Promise<void> {
        try {
            const bag = await browser.storage.session.get(SESSION_SAVED_DEDUP_KEYS);
            const raw = bag[SESSION_SAVED_DEDUP_KEYS];
            if (!Array.isArray(raw)) {
                return;
            }
            for (const item of raw) {
                if (typeof item === "string") {
                    this.keys.add(item);
                }
            }
        } catch {
            /* session storage может быть недоступен в редких контекстах */
        }
    }

    has(key: string): boolean {
        return this.keys.has(key);
    }

    async remember(key: string): Promise<void> {
        await this.ensure_loaded();
        this.keys.add(key);
        await this.persist();
    }

    private async persist(): Promise<void> {
        let arr = [...this.keys];
        if (arr.length > SESSION_SAVED_KEYS_CAP) {
            arr = arr.slice(-SESSION_SAVED_KEYS_CAP);
            this.keys.clear();
            for (const k of arr) {
                this.keys.add(k);
            }
        }
        try {
            await browser.storage.session.set({ [SESSION_SAVED_DEDUP_KEYS]: arr });
        } catch {
            /* ignore */
        }
    }
}
