import { daemon_find_images_batch } from "../shared/daemon_client";

const BATCH_WINDOW_MS = 75;
const MAX_BATCH_SIZE = 50;
const MAX_PARALLEL_BATCHES = 2;

type Waiter = Readonly<{
  resolve: (value: string[]) => void;
  reject: (reason?: unknown) => void;
}>;

type TaskState = "pending" | "in_flight";
type StemTask = {
  promise: Promise<string[]>;
  waiters: Waiter[];
  state: TaskState;
};

export class FindBatchQueue {
  private readonly pending_order: string[] = [];
  private readonly tasks = new Map<string, StemTask>();
  private flush_timer: ReturnType<typeof setTimeout> | null = null;
  private active_batches = 0;

  enqueue(stem: string): Promise<string[]> {
    const existing = this.tasks.get(stem);
    if (existing !== undefined) {
      return existing.promise;
    }

    const waiters: Waiter[] = [];
    const promise = new Promise<string[]>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    this.tasks.set(stem, {
      promise,
      waiters,
      state: "pending"
    });
    this.pending_order.push(stem);
    this.schedule_flush();
    return promise;
  }

  private schedule_flush(): void {
    if (this.flush_timer !== null) {
      return;
    }
    this.flush_timer = setTimeout(() => {
      this.flush_timer = null;
      void this.flush();
    }, BATCH_WINDOW_MS);
  }

  private async flush(): Promise<void> {
    while (this.active_batches < MAX_PARALLEL_BATCHES) {
      const stems = this.take_next_chunk();
      if (stems.length === 0) {
        return;
      }
      this.active_batches += 1;
      void this.run_chunk(stems).finally(() => {
        this.active_batches -= 1;
        if (this.pending_order.length > 0) {
          void this.flush();
        }
      });
    }
  }

  private take_next_chunk(): string[] {
    const chunk: string[] = [];
    while (this.pending_order.length > 0 && chunk.length < MAX_BATCH_SIZE) {
      const stem = this.pending_order.shift();
      if (stem === undefined) {
        break;
      }
      const task = this.tasks.get(stem);
      if (task === undefined || task.state !== "pending") {
        continue;
      }
      task.state = "in_flight";
      chunk.push(stem);
      if (chunk.length >= MAX_BATCH_SIZE) {
        break;
      }
    }
    return chunk;
  }

  private async run_chunk(stems: string[]): Promise<void> {
    try {
      const response = await daemon_find_images_batch(stems);
      for (const stem of stems) {
        const task = this.tasks.get(stem);
        if (task === undefined) {
          continue;
        }
        const matches = Array.isArray(response[stem]) ? response[stem] : [];
        for (const waiter of task.waiters) {
          waiter.resolve(matches);
        }
        this.tasks.delete(stem);
      }
    } catch (error: unknown) {
      for (const stem of stems) {
        const task = this.tasks.get(stem);
        if (task === undefined) {
          continue;
        }
        for (const waiter of task.waiters) {
          waiter.reject(error);
        }
        this.tasks.delete(stem);
      }
    }
  }
}

export const find_batch_queue = new FindBatchQueue();
