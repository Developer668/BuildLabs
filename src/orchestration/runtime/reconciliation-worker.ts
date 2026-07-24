import type { ReconciliationProjectPage } from "../domain/store.js";

export interface ReconciliationProjectIndex {
  listProjectIdsForReconciliation(
    limit: number,
    afterProjectId?: string,
  ): ReconciliationProjectPage;
}

export interface ReconciliationController {
  reconcileProject(projectId: string, signal?: AbortSignal): Promise<unknown>;
}

export interface ReconciliationCycleResult {
  attempted: number;
  succeeded: number;
  failed: number;
  wrapped: boolean;
}

export interface ReconciliationWorkerOptions {
  index: ReconciliationProjectIndex;
  controller: ReconciliationController;
  intervalMilliseconds: number;
  batchSize: number;
  concurrency: number;
  projectDeadlineMilliseconds?: number;
  onCycle?: (result: ReconciliationCycleResult) => void;
  onCycleError?: (errorName: string) => void;
}

/**
 * Non-overlapping, cursor-based recovery worker. Each tick reads and processes
 * at most `batchSize` opaque IDs, with at most `concurrency` provider workflows
 * in flight. Individual project failures never stop the next project or tick.
 */
export class ReconciliationWorker {
  readonly #index: ReconciliationProjectIndex;
  readonly #controller: ReconciliationController;
  readonly #intervalMilliseconds: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #projectDeadlineMilliseconds: number;
  readonly #onCycle: ((result: ReconciliationCycleResult) => void) | undefined;
  readonly #onCycleError: ((errorName: string) => void) | undefined;
  #afterProjectId: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #activeCycle: Promise<void> | undefined;
  #activeAbortController: AbortController | undefined;
  #running = false;

  constructor(options: ReconciliationWorkerOptions) {
    this.#intervalMilliseconds = boundedInteger(
      options.intervalMilliseconds,
      1_000,
      5 * 60_000,
      "intervalMilliseconds",
    );
    this.#batchSize = boundedInteger(options.batchSize, 1, 1_000, "batchSize");
    this.#concurrency = boundedInteger(
      options.concurrency,
      1,
      Math.min(32, this.#batchSize),
      "concurrency",
    );
    this.#projectDeadlineMilliseconds = boundedInteger(
      options.projectDeadlineMilliseconds ?? 2 * 60_000,
      1,
      90 * 60_000,
      "projectDeadlineMilliseconds",
    );
    this.#index = options.index;
    this.#controller = options.controller;
    this.#onCycle = options.onCycle;
    this.#onCycleError = options.onCycleError;
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#activeAbortController?.abort();
    await this.#activeCycle;
  }

  async runOnce(signal?: AbortSignal): Promise<ReconciliationCycleResult> {
    const page = this.#index.listProjectIdsForReconciliation(
      this.#batchSize,
      this.#afterProjectId,
    );
    const wrapped =
      page.projectIds.length === 0 && this.#afterProjectId !== undefined;
    if (wrapped) {
      this.#afterProjectId = undefined;
      return {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        wrapped: true,
      };
    }

    this.#afterProjectId = page.nextAfterProjectId;
    let succeeded = 0;
    let failed = 0;
    await mapWithConcurrency(
      page.projectIds,
      this.#concurrency,
      async (projectId) => {
        try {
          await reconcileWithDeadline(
            this.#controller,
            projectId,
            this.#projectDeadlineMilliseconds,
            signal,
          );
          succeeded += 1;
        } catch {
          failed += 1;
        }
      },
      signal,
    );
    return {
      attempted: page.projectIds.length,
      succeeded,
      failed,
      wrapped: false,
    };
  }

  #schedule(delayMilliseconds: number): void {
    if (!this.#running) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const abortController = new AbortController();
      this.#activeAbortController = abortController;
      this.#activeCycle = this.runOnce(abortController.signal)
        .then((result) => {
          this.#onCycle?.(result);
        })
        .catch((error: unknown) => {
          this.#onCycleError?.(errorName(error));
        })
        .finally(() => {
          this.#activeAbortController = undefined;
          this.#activeCycle = undefined;
          this.#schedule(this.#intervalMilliseconds);
        });
    }, delayMilliseconds);
    this.#timer.unref();
  }
}

async function reconcileWithDeadline(
  controller: ReconciliationController,
  projectId: string,
  deadlineMilliseconds: number,
  parentSignal?: AbortSignal,
): Promise<void> {
  const deadlineController = new AbortController();
  const operationSignal = parentSignal
    ? AbortSignal.any([parentSignal, deadlineController.signal])
    : deadlineController.signal;
  let timeout: NodeJS.Timeout | undefined;
  let removeParentAbort = (): void => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      deadlineController.abort();
      reject(new Error("Project reconciliation deadline exceeded"));
    }, deadlineMilliseconds);
  });
  const parentAbort = parentSignal
    ? new Promise<never>((_resolve, reject) => {
        const abort = () => {
          deadlineController.abort();
          reject(new Error("Project reconciliation aborted"));
        };
        if (parentSignal.aborted) {
          abort();
          return;
        }
        parentSignal.addEventListener("abort", abort, { once: true });
        removeParentAbort = () =>
          parentSignal.removeEventListener("abort", abort);
      })
    : undefined;
  try {
    await Promise.race([
      controller.reconcileProject(projectId, operationSignal),
      deadline,
      ...(parentAbort ? [parentAbort] : []),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    removeParentAbort();
    deadlineController.abort();
  }
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        if (signal?.aborted) {
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          await action(value);
        }
      }
    },
  );
  await Promise.all(workers);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
