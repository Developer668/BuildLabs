import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import { observeBuildRunForCustomer } from "../src/application/customer-build-observability.js";
import { assignment, passingEvidence } from "./fixtures.js";

describe("customer build observability", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("reports useful live progress without exposing mutable workspace data", () => {
    const input = assignment("customer-observability");
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-secret-identifier");
    store.updateStage(run.id, lease, "generating", {
      prompt: "private model prompt",
      command: "secret command output",
    });
    store.recordAgentProgress(run.id, lease, {
      step: 1,
      repairRound: 0,
      toolName: "write_files",
      ok: true,
    });
    store.recordAgentProgress(run.id, lease, {
      step: 2,
      repairRound: 1,
      toolName: "run_command",
      ok: false,
    });
    const revision = "a".repeat(64);
    store.setRevision(run.id, lease, revision, 3_000);
    store.addEvidence(
      run.id,
      lease,
      passingEvidence(run.id, revision, input)[0]!,
    );

    const observation = observeBuildRunForCustomer(
      store,
      store.getRun(run.id)!,
    );

    expect(observation).toMatchObject({
      version: 1,
      runId: run.id,
      status: "running",
      stage: "generating",
      slot: { state: "active", number: 1 },
      workspace: {
        state: "live_unverified",
        customerRenderable: false,
      },
      progress: {
        completedToolCalls: 2,
        failedToolCalls: 1,
        lastTool: "run_command",
        repairRound: 1,
      },
      proof: {
        receiptCount: 1,
        passCount: 1,
        provenArtifactAvailable: false,
      },
    });
    expect(observation.timeline.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "workspace" }),
        expect.objectContaining({
          category: "tool",
          tool: "write_files",
          succeeded: true,
        }),
        expect.objectContaining({
          category: "evidence",
          evidenceKind: "artifact",
          evidenceStatus: "PASS",
        }),
      ]),
    );
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("sandbox-secret-identifier");
    expect(serialized).not.toContain("private model prompt");
    expect(serialized).not.toContain("secret command output");
    expect(serialized).not.toContain("preview");
    expect(serialized).not.toContain("artifactId");
    expect(serialized).not.toContain("revisionHash");
  });

  it("paginates only safe events and advances past hidden payloads", () => {
    const run = store.createRun(assignment("customer-observability-page")).run;
    const first = observeBuildRunForCustomer(store, run, { limit: 1 });

    expect(first.timeline.items).toHaveLength(1);
    expect(first.timeline.items[0]).toMatchObject({
      category: "lifecycle",
      stage: "queued",
    });
    expect(first.timeline.hasMore).toBe(false);
    expect(first.timeline.nextAfterSequence).toBe(
      store.getLatestEventSequence(run.id),
    );

    const resumed = observeBuildRunForCustomer(store, run, {
      afterSequence: first.timeline.nextAfterSequence,
    });
    expect(resumed.timeline.items).toEqual([]);
    expect(resumed.timeline.hasMore).toBe(false);
  });
});
