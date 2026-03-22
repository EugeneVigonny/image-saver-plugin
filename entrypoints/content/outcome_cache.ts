import { IMAGE_SAVER_OUTCOME_CACHE_V1, OUTCOME_CACHE_CAP, OUTCOME_CACHE_TTL_MS } from "./constants";

export type OutcomeCacheRow = Readonly<{
    dedup_key: string;
    status: "saved" | "failed";
    updated_at: number;
    reason?: string;
}>;

function is_outcome_row(value: unknown): value is OutcomeCacheRow {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const o = value as Record<string, unknown>;
    if (typeof o["dedup_key"] !== "string" || o["dedup_key"].length === 0) {
        return false;
    }
    if (o["status"] !== "saved" && o["status"] !== "failed") {
        return false;
    }
    if (typeof o["updated_at"] !== "number" || !Number.isFinite(o["updated_at"])) {
        return false;
    }
    if (o["reason"] !== undefined && typeof o["reason"] !== "string") {
        return false;
    }
    return true;
}

/**
 * Session-кэш терминальных исходов сохранения по dedup-ключу (TTL + лимит записей).
 * @remarks Не вызывать `set_saved` при успешном ответе `queue_save` — только после `job_status`.
 */
export class OutcomeCacheRegistry {
    private readonly by_key = new Map<
        string,
        { status: "saved" | "failed"; updated_at: number; reason?: string }
    >();
    private load_promise: Promise<void> | null = null;

    async ensure_loaded(): Promise<void> {
        if (this.load_promise === null) {
            this.load_promise = this.load_from_storage();
        }
        await this.load_promise;
        this.prune_expired_sync(Date.now());
    }

    private async load_from_storage(): Promise<void> {
        try {
            const bag = await browser.storage.session.get(IMAGE_SAVER_OUTCOME_CACHE_V1);
            const raw = bag[IMAGE_SAVER_OUTCOME_CACHE_V1];
            if (!Array.isArray(raw)) {
                return;
            }
            const now = Date.now();
            for (const item of raw) {
                if (!is_outcome_row(item)) {
                    continue;
                }
                if (now - item.updated_at > OUTCOME_CACHE_TTL_MS) {
                    continue;
                }
                const row: { status: "saved" | "failed"; updated_at: number; reason?: string } = {
                    status: item.status,
                    updated_at: item.updated_at,
                };
                if (item.reason !== undefined) {
                    row.reason = item.reason;
                }
                this.by_key.set(item.dedup_key, row);
            }
        } catch {
            /* session может быть недоступен */
        }
    }

    private prune_expired_sync(now: number): void {
        for (const [k, v] of [...this.by_key.entries()]) {
            if (now - v.updated_at > OUTCOME_CACHE_TTL_MS) {
                this.by_key.delete(k);
            }
        }
    }

    /** Удаляет просроченные записи и синхронизирует storage. */
    async prune_expired(): Promise<void> {
        await this.ensure_loaded();
        const before = this.by_key.size;
        this.prune_expired_sync(Date.now());
        if (this.by_key.size !== before) {
            await this.persist();
        }
    }

    has_saved(dedup_key: string): boolean {
        const now = Date.now();
        this.prune_expired_sync(now);
        const entry = this.by_key.get(dedup_key);
        return entry !== undefined && entry.status === "saved";
    }

    async set_saved(dedup_key: string): Promise<void> {
        await this.ensure_loaded();
        const now = Date.now();
        this.by_key.set(dedup_key, { status: "saved", updated_at: now });
        this.prune_expired_sync(now);
        await this.persist();
    }

    async set_failed(dedup_key: string, reason?: string): Promise<void> {
        await this.ensure_loaded();
        const now = Date.now();
        const row: { status: "failed"; updated_at: number; reason?: string } = {
            status: "failed",
            updated_at: now,
        };
        if (reason !== undefined) {
            row.reason = reason;
        }
        this.by_key.set(dedup_key, row);
        this.prune_expired_sync(now);
        await this.persist();
    }

    async clear_all(): Promise<void> {
        this.by_key.clear();
        this.load_promise = null;
        try {
            await browser.storage.session.remove(IMAGE_SAVER_OUTCOME_CACHE_V1);
        } catch {
            /* ignore */
        }
    }

    private async persist(): Promise<void> {
        const now = Date.now();
        this.prune_expired_sync(now);
        let rows: OutcomeCacheRow[] = [...this.by_key.entries()].map(([dedup_key, v]) => {
            const base: OutcomeCacheRow = {
                dedup_key,
                status: v.status,
                updated_at: v.updated_at,
            };
            if (v.reason !== undefined) {
                return { ...base, reason: v.reason };
            }
            return base;
        });
        rows.sort((a, b) => a.updated_at - b.updated_at);
        if (rows.length > OUTCOME_CACHE_CAP) {
            rows = rows.slice(-OUTCOME_CACHE_CAP);
            this.by_key.clear();
            for (const r of rows) {
                const row: { status: "saved" | "failed"; updated_at: number; reason?: string } = {
                    status: r.status,
                    updated_at: r.updated_at,
                };
                if (r.reason !== undefined) {
                    row.reason = r.reason;
                }
                this.by_key.set(r.dedup_key, row);
            }
        }
        try {
            await browser.storage.session.set({ [IMAGE_SAVER_OUTCOME_CACHE_V1]: rows });
        } catch {
            /* ignore */
        }
    }
}
