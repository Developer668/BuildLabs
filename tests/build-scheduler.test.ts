import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import {
  BuildScheduler,
  type BuildExecutor,
} from "../src/application/build-scheduler.js";
import type { SlotLease } from "../src/domain/run.js";
import { assignment } from "./fixtures.js";

describe("BuildScheduler", () => {
  let store: SqliteRunStore;
  let scheduler: BuildScheduler;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:", slotCount: 4 });
  });

  afterEach(async () => {
    await scheduler?.stop();
    store.close();
  });

  it("processes a 20-candidate queue without exceeding four active slots", async () => {
    const executor = new ConcurrencyExecutor(store);
    scheduler = new BuildScheduler(store, executor, {
      leaseMilliseconds: 10_000,
      pollMilliseconds: 5,
    });
    const runIds = Array.from(
      { length: 20 },
      (_, index) => store.createRun(assignment(`queue-${index}`)).run.id,
    );

    scheduler.start();
    await waitUntil(
      () => runIds.every((runId) => store.getRun(runId)?.status === "failed"),
      5_000,
    );

    expect(executor.maximumActive).toBe(4);
    expect(executor.started).toHaveLength(20);
    expect(new Set(executor.seenSlots)).toEqual(new Set([1, 2, 3, 4]));
  });
});

class ConcurrencyExecutor implements BuildExecutor {
  active = 0;
  maximumActive = 0;
  readonly started: string[] = [];
  readonly seenSlots: number[] = [];

  constructor(private readonly store: SqliteRunStore) {}

  async execute(runId: string, lease: SlotLease): Promise<void> {
    this.store.startRun(runId, lease);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    this.started.push(runId);
    this.seenSlots.push(lease.slotId);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.store.markFailed(
        runId,
        lease,
        "test_complete",
        "Synthetic scheduler completion",
      );
    } finally {
      this.active -= 1;
      this.store.releaseSlot(lease);
    }
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for scheduler");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
