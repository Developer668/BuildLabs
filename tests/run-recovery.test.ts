import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import { recoverInterruptedRunSandboxes } from "../src/application/run-recovery.js";
import type { SandboxProvider } from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

describe("interrupted run recovery", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("fails interrupted runs and retries Daytona cleanup on later startups", async () => {
    const run = store.createRun(assignment("recovery-cleanup")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-orphan");
    let attempts = 0;
    const provider = {
      deleteSandbox: (sandboxId: string) => {
        expect(sandboxId).toBe("sandbox-orphan");
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("temporary provider failure"))
          : Promise.resolve();
      },
    } as SandboxProvider;

    const first = await recoverInterruptedRunSandboxes(store, provider);
    expect(first).toEqual({
      recoveredRunCount: 1,
      deletedSandboxCount: 0,
      failedSandboxIds: ["sandbox-orphan"],
    });
    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      errorCode: "worker_restarted",
    });

    const second = await recoverInterruptedRunSandboxes(store, provider);
    expect(second).toEqual({
      recoveredRunCount: 0,
      deletedSandboxCount: 1,
      failedSandboxIds: [],
    });
    expect(attempts).toBe(2);

    const third = await recoverInterruptedRunSandboxes(store, provider);
    expect(third).toEqual({
      recoveredRunCount: 0,
      deletedSandboxCount: 0,
      failedSandboxIds: [],
    });
    expect(attempts).toBe(2);
  });
});
