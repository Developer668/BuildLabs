import type { SlotLease } from "../domain/run.js";
import type {
  CancellationRequest,
  CancellationResult,
  RunStore,
} from "../ports/index.js";
export interface BuildExecutor {
  execute(runId: string, lease: SlotLease, signal?: AbortSignal): Promise<void>;
}

export interface BuildSchedulerOptions {
  leaseMilliseconds: number;
  pollMilliseconds?: number;
}

interface ActiveRun {
  controller: AbortController;
  completion: Promise<void>;
}

export class BuildScheduler {
  readonly #active = new Map<string, ActiveRun>();
  readonly #leaseMilliseconds: number;
  readonly #pollMilliseconds: number;
  #pollTimer: NodeJS.Timeout | undefined;
  #stopped = true;
  #ticking = false;

  constructor(
    private readonly store: RunStore,
    private readonly executor: BuildExecutor,
    options: BuildSchedulerOptions,
  ) {
    this.#leaseMilliseconds = options.leaseMilliseconds;
    this.#pollMilliseconds = options.pollMilliseconds ?? 250;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  start(): void {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;
    this.store.recoverInterruptedRuns();
    this.#pollTimer = setInterval(() => {
      this.wake();
    }, this.#pollMilliseconds);
    this.#pollTimer.unref();
    this.wake();
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    for (const active of this.#active.values()) {
      active.controller.abort(new Error("Build scheduler stopped"));
    }
    await Promise.allSettled(
      [...this.#active.values()].map((active) => active.completion),
    );
  }

  wake(): void {
    if (this.#stopped || this.#ticking) {
      return;
    }
    this.#ticking = true;
    try {
      const available = Math.max(0, 4 - this.#active.size);
      for (const run of this.store.listQueued(available)) {
        if (this.#active.has(run.id)) {
          continue;
        }
        const lease = this.store.acquireSlot(run.id, this.#leaseMilliseconds);
        if (!lease) {
          break;
        }
        this.#dispatch(run.id, lease);
      }
    } finally {
      this.#ticking = false;
    }
  }

  cancel(
    runId: string,
    request: CancellationRequest = {
      source: "internal",
      reasonCode: "scheduler_cancellation",
    },
  ): CancellationResult {
    const result = this.store.requestCancel(runId, request);
    if (result.changed) {
      this.#active
        .get(runId)
        ?.controller.abort(new Error("Build run cancelled"));
    }
    return result;
  }

  #dispatch(runId: string, initialLease: SlotLease): void {
    const controller = new AbortController();
    let lease = initialLease;
    const heartbeatInterval = Math.max(
      1_000,
      Math.floor(this.#leaseMilliseconds / 3),
    );
    const heartbeat = setInterval(() => {
      try {
        const run = this.store.getRun(runId);
        if (run?.cancelRequested) {
          controller.abort(new Error("Build run cancelled"));
          return;
        }
        lease = this.store.heartbeat(lease, this.#leaseMilliseconds);
      } catch (error) {
        controller.abort(
          error instanceof Error ? error : new Error("Slot heartbeat failed"),
        );
      }
    }, heartbeatInterval);
    heartbeat.unref();

    const completion = this.executor
      .execute(runId, lease, controller.signal)
      .finally(() => {
        clearInterval(heartbeat);
        this.#active.delete(runId);
        if (!this.#stopped) {
          this.wake();
        }
      });
    this.#active.set(runId, { controller, completion });
  }
}
