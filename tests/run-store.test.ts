import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrations } from "../src/adapters/sqlite/migrations.js";
import {
  IdempotencyConflictError,
  InvalidRunStateError,
  SqliteRunStore,
  StaleLeaseError,
} from "../src/adapters/sqlite/run-store.js";
import { assignmentDigest, contractDigest } from "../src/domain/contract.js";
import type { SlotLease } from "../src/domain/run.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";
import { artifact, assignment, passingEvidence } from "./fixtures.js";

describe("SqliteRunStore", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:", slotCount: 4 });
  });

  afterEach(() => {
    store.close();
  });

  it("is idempotent for identical assignments and rejects key reuse", () => {
    const input = assignment("idempotent");
    const first = store.createRun(input);
    const second = store.createRun(input);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    const changed = structuredClone(input);
    changed.buildPrompt = "Different request under the same idempotency key.";
    expect(() => store.createRun(changed)).toThrow(IdempotencyConflictError);
  });

  it("leases no more than four concurrent build slots", () => {
    const leases: SlotLease[] = [];
    for (let index = 0; index < 5; index += 1) {
      const run = store.createRun(assignment(`slot-${index}`)).run;
      const lease = store.acquireSlot(run.id, 30_000);
      if (lease) {
        leases.push(lease);
      }
    }
    expect(leases).toHaveLength(4);
    expect(new Set(leases.map((lease) => lease.slotId)).size).toBe(4);
  });

  it("rejects a stale fencing token", () => {
    const run = store.createRun(assignment("stale")).run;
    const lease = store.acquireSlot(run.id, 30_000);
    expect(lease).toBeDefined();
    store.releaseSlot(lease!);
    expect(() => store.startRun(run.id, lease!)).toThrow(StaleLeaseError);
  });

  it("fails interrupted runs on restart instead of silently requeueing them", () => {
    const run = store.createRun(assignment("restart")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    expect(store.recoverInterruptedRuns()).toEqual([
      {
        runId: run.id,
        sandboxIds: [],
        newlyRecovered: true,
      },
    ]);
    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      stage: "complete",
      errorCode: "worker_restarted",
    });
  });

  it("will not emit candidate.proven without independently complete proof", () => {
    const run = store.createRun(assignment("no-proof")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-test");
    store.attachVerificationSandbox(
      run.id,
      lease,
      "sandbox-verifier",
      "delivery",
    );
    store.promoteVerificationSandbox(run.id, lease, "sandbox-verifier");
    const revision = "c".repeat(64);
    store.setRevision(run.id, lease, revision, 3000);
    store.recordArtifact(run.id, lease, artifact(run.id, revision));
    expect(store.getArtifact(run.id)).toBeUndefined();

    expect(() =>
      store.markPassed(run.id, lease, revision, "trace-test"),
    ).toThrow(InvalidRunStateError);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("atomically records a proven artifact and outbox handoff", () => {
    const input = assignment("proven");
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-test");
    store.attachVerificationSandbox(
      run.id,
      lease,
      "sandbox-verifier",
      "delivery",
    );
    store.promoteVerificationSandbox(run.id, lease, "sandbox-verifier");
    const revision = "d".repeat(64);
    store.setRevision(run.id, lease, revision, 3000);
    for (const receipt of passingEvidence(run.id, revision, input)) {
      store.addEvidence(run.id, lease, receipt);
    }
    const provenArtifact = artifact(run.id, revision);
    store.recordArtifact(run.id, lease, provenArtifact);

    const passed = store.markPassed(run.id, lease, revision, "trace-test");
    expect(passed.status).toBe("passed");
    const events = store.listOutbox(10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "candidate.proven",
      runId: run.id,
      revisionHash: revision,
    });
    expect(events[0]!.payload).toMatchObject({
      artifact: {
        artifactId: provenArtifact.artifactId,
        dockerfilePath: "Dockerfile",
      },
      ranking: {
        provider: "braintrust",
        policyVersion: "braintrust-preference-v1",
        preferenceSatisfaction: 1,
        scoreTuple: [1],
        traceId: "trace-test",
      },
      sandboxId: "sandbox-verifier",
      previewPort: 3000,
    });

    store.markOutboxPublished(events[0]!.eventId);
    expect(store.listOutbox(10)).toHaveLength(0);
    expect(store.markOutboxPublished(events[0]!.eventId)).toBe(true);
    expect(store.markOutboxPublished(randomUUID())).toBe(false);
  });

  it("persists only bounded agent progress under the active lease", () => {
    const run = store.createRun(assignment("agent-progress")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.updateStage(run.id, lease, "generating");

    store.recordAgentProgress(run.id, lease, {
      step: 1,
      repairRound: 0,
      toolName: "write_files",
      ok: true,
    });

    expect(store.listEvents(run.id, 0).at(-1)).toMatchObject({
      type: "agent.tool_completed",
      stage: "generating",
      payload: {
        step: 1,
        repairRound: 0,
        toolName: "write_files",
        ok: true,
      },
    });
    expect(() =>
      store.recordAgentProgress(run.id, lease, {
        step: 201,
        repairRound: 0,
        toolName: "write_file",
        ok: true,
      }),
    ).toThrow();
  });

  it("paginates durable events and exposes the latest sequence without replay", () => {
    const run = store.createRun(assignment("event-pages")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.updateStage(run.id, lease, "generating");

    const firstPage = store.listEvents(run.id, 0, 2);
    expect(firstPage).toHaveLength(2);
    const secondPage = store.listEvents(run.id, firstPage.at(-1)!.sequence, 2);

    expect(secondPage).toHaveLength(1);
    expect(store.getLatestEventSequence(run.id)).toBe(secondPage[0]!.sequence);
  });

  it("filters pending proof events to the exact active run identities", () => {
    const prove = (suffix: string) => {
      const input = assignment(suffix);
      const run = store.createRun(input).run;
      const lease = store.acquireSlot(run.id, 30_000)!;
      store.startRun(run.id, lease);
      store.attachSandbox(run.id, lease, `sandbox-${suffix}`);
      store.attachVerificationSandbox(
        run.id,
        lease,
        `sandbox-verifier-${suffix}`,
        "delivery",
      );
      store.promoteVerificationSandbox(
        run.id,
        lease,
        `sandbox-verifier-${suffix}`,
      );
      const revision = suffix.repeat(64).slice(0, 64);
      store.setRevision(run.id, lease, revision, 3000);
      for (const receipt of passingEvidence(run.id, revision, input)) {
        store.addEvidence(run.id, lease, receipt);
      }
      store.recordArtifact(run.id, lease, artifact(run.id, revision));
      store.markPassed(run.id, lease, revision, "trace-test");
      return run.id;
    };
    const obsoleteRunId = prove("a");
    const activeRunId = prove("b");

    expect(
      store.listOutbox(10, "project-mission-peak", [activeRunId]),
    ).toHaveLength(1);
    expect(
      store.listOutbox(10, "project-mission-peak", [activeRunId])[0]?.runId,
    ).toBe(activeRunId);
    expect(
      store.listOutbox(10, "project-mission-peak", [obsoleteRunId])[0]?.runId,
    ).toBe(obsoleteRunId);
    expect(() => store.listOutbox(10, "project-mission-peak", [])).toThrow(
      "one to four run IDs",
    );
  });

  it("rejects an expired lease even before another worker reclaims it", () => {
    store.close();
    let now = new Date("2026-07-23T12:00:00.000Z");
    store = new SqliteRunStore({
      path: ":memory:",
      now: () => now,
    });
    const run = store.createRun(assignment("expired")).run;
    const lease = store.acquireSlot(run.id, 10_000)!;
    now = new Date("2026-07-23T12:00:11.000Z");

    expect(() => store.startRun(run.id, lease)).toThrow(StaleLeaseError);
    expect(() => store.heartbeat(lease, 10_000)).toThrow(StaleLeaseError);
  });

  it("cannot pass after cancellation is requested", () => {
    const input = assignment("cancel-race");
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-test");
    store.attachVerificationSandbox(
      run.id,
      lease,
      "sandbox-verifier",
      "delivery",
    );
    store.promoteVerificationSandbox(run.id, lease, "sandbox-verifier");
    const revision = "9".repeat(64);
    store.setRevision(run.id, lease, revision, 3000);
    for (const receipt of passingEvidence(run.id, revision, input)) {
      store.addEvidence(run.id, lease, receipt);
    }
    store.recordArtifact(run.id, lease, artifact(run.id, revision));
    store.requestCancel(run.id);

    expect(() =>
      store.markPassed(run.id, lease, revision, "trace-test"),
    ).toThrow(InvalidRunStateError);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("cannot treat the untrusted builder as a verification sandbox", () => {
    const run = store.createRun(assignment("builder-is-not-verifier")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-builder");

    expect(() =>
      store.attachVerificationSandbox(
        run.id,
        lease,
        "sandbox-builder",
        "delivery",
      ),
    ).toThrow(InvalidRunStateError);
  });

  it("cannot promote a disposable command verifier for delivery", () => {
    const run = store.createRun(assignment("command-is-not-delivery")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "sandbox-builder");
    store.attachVerificationSandbox(
      run.id,
      lease,
      "sandbox-command-verifier",
      "commands",
    );

    expect(() =>
      store.promoteVerificationSandbox(
        run.id,
        lease,
        "sandbox-command-verifier",
      ),
    ).toThrow(InvalidRunStateError);
  });

  it("records a running cancellation request only once", () => {
    const run = store.createRun(assignment("cancel-idempotent")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);

    store.requestCancel(run.id);
    const eventCount = store.listEvents(run.id, 0).length;
    const duplicate = store.requestCancel(run.id);

    expect(duplicate.cancelRequested).toBe(true);
    expect(store.listEvents(run.id, 0)).toHaveLength(eventCount);
  });

  it("applies cancellation CAS and persists bounded redacted correlation", () => {
    const run = store.createRun(assignment("cancel-cas")).run;
    const conversationCorrelationId = sha256("studio-conversation:cancel-cas");
    const stale = store.requestCancel(run.id, {
      source: "studio_speech_engine",
      reasonCode: "explicit_operator_cancellation",
      conversationCorrelationId,
      expected: {
        status: "running",
        updatedAt: run.updatedAt,
      },
    });

    expect(stale).toMatchObject({
      changed: false,
      reason: "candidate_state_changed",
      run: { cancelRequested: false },
    });
    expect(store.listEvents(run.id, 0)).toHaveLength(1);

    const secret = `fw_${"x".repeat(32)}`;
    const cancellation = store.requestCancel(run.id, {
      source: "studio_speech_engine",
      reasonCode: "explicit_operator_cancellation",
      conversationCorrelationId,
      expected: {
        status: "queued",
        updatedAt: run.updatedAt,
      },
    });

    expect(cancellation).toMatchObject({
      changed: true,
      reason: "cancellation_requested",
      run: { cancelRequested: true, status: "cancelled" },
    });
    const event = store
      .listEvents(run.id, 0)
      .find((candidate) => candidate.type === "run.cancelled");
    expect(event?.payload).toMatchObject({
      runId: run.id,
      source: "studio_speech_engine",
      conversationCorrelationId,
      reasonCode: "explicit_operator_cancellation",
    });
    const payloadJson = JSON.stringify(event?.payload);
    expect(payloadJson).not.toContain(secret);
    expect(payloadJson).not.toContain("alice@example.com");
    expect(Buffer.byteLength(payloadJson, "utf8")).toBeLessThan(800);
  });
});

describe("SqliteRunStore migrations", () => {
  it("quarantines v2 passed output without deleting its source records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildlapse-v2-migration-"));
    const databasePath = join(directory, "buildlapse.sqlite");
    const legacy = seedLegacyV2Pass(databasePath);
    let store: SqliteRunStore | undefined;

    try {
      store = new SqliteRunStore({ path: databasePath });

      expect(store.getRun(legacy.runId)).toMatchObject({
        status: "rejected",
        stage: "complete",
        builderSandboxId: legacy.sandboxId,
        errorCode: "legacy_proof_quarantined",
      });
      expect(store.getArtifact(legacy.runId)).toBeUndefined();
      expect(store.listOutbox(10)).toHaveLength(0);
      expect(() => store!.markOutboxPublished(legacy.eventId)).toThrow(
        "Pending outbox event not found",
      );
      expect(
        store
          .listEvents(legacy.runId, 0)
          .find((event) => event.type === "run.proof_quarantined"),
      ).toMatchObject({
        stage: "complete",
        payload: {
          code: "legacy_proof_quarantined",
          requiredProofProtocolVersion: 1,
        },
      });

      store.close();
      store = undefined;

      const raw = new DatabaseSync(databasePath);
      try {
        expect(
          raw
            .prepare(
              `SELECT proof_protocol_version
               FROM build_runs
               WHERE id = ?`,
            )
            .get(legacy.runId),
        ).toMatchObject({ proof_protocol_version: 0 });
        expect(
          raw
            .prepare(
              `SELECT artifact_json
               FROM proven_artifacts
               WHERE run_id = ?`,
            )
            .get(legacy.runId),
        ).toMatchObject({ artifact_json: legacy.artifactJson });
        expect(
          raw
            .prepare(
              `SELECT payload_json, published_at
               FROM outbox
               WHERE event_id = ?`,
            )
            .get(legacy.eventId),
        ).toMatchObject({
          payload_json: legacy.payloadJson,
          published_at: null,
        });
        expect(
          raw
            .prepare(
              `SELECT name
               FROM schema_migrations
               WHERE version = 5`,
            )
            .get(),
        ).toEqual({ name: "three-sandbox-proof-protocol" });
      } finally {
        raw.close();
      }
    } finally {
      store?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function seedLegacyV2Pass(path: string): {
  artifactJson: string;
  eventId: string;
  payloadJson: string;
  runId: string;
  sandboxId: string;
} {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of migrations.filter(
      (candidate) => candidate.version <= 2,
    )) {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations(version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, "2026-07-23T12:00:00.000Z");
    }

    const input = assignment("legacy-v2");
    const runId = randomUUID();
    const eventId = randomUUID();
    const revisionHash = sha256("legacy builder revision");
    const sandboxId = "legacy-builder-sandbox";
    const contractHash = contractDigest(input.contract);
    const provenArtifact = artifact(runId, revisionHash);
    const traceId = "legacy-braintrust-trace";
    const payload = {
      runId,
      projectId: input.projectId,
      candidateId: input.candidateId,
      contractHash,
      revisionHash,
      sandboxId,
      previewPort: input.contract.verification.previewPort,
      artifact: provenArtifact,
      traceId,
      ranking: {
        provider: "braintrust",
        preferenceSatisfaction: 1,
        traceId,
      },
    };
    const artifactJson = canonicalJson(provenArtifact);
    const payloadJson = canonicalJson(payload);

    database
      .prepare(
        `INSERT INTO acceptance_contracts(
          contract_hash,
          contract_id,
          project_id,
          transcript_sha256,
          contract_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        contractHash,
        input.contract.contractId,
        input.projectId,
        input.contract.transcriptSha256,
        canonicalJson(input.contract),
        input.requestedAt,
      );
    database
      .prepare(
        `INSERT INTO build_runs(
          id,
          assignment_id,
          assignment_hash,
          assignment_json,
          project_id,
          candidate_id,
          contract_hash,
          status,
          stage,
          sandbox_id,
          revision_hash,
          preview_port,
          created_at,
          updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'passed', 'complete', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.assignmentId,
        assignmentDigest(input),
        canonicalJson(input),
        input.projectId,
        input.candidateId,
        contractHash,
        sandboxId,
        revisionHash,
        input.contract.verification.previewPort,
        input.requestedAt,
        input.requestedAt,
        input.requestedAt,
      );
    database
      .prepare(
        `INSERT INTO proven_artifacts(
          artifact_id,
          run_id,
          revision_hash,
          artifact_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        provenArtifact.artifactId,
        runId,
        revisionHash,
        artifactJson,
        provenArtifact.createdAt,
      );
    database
      .prepare(
        `INSERT INTO outbox(
          event_id,
          event_type,
          run_id,
          revision_hash,
          trace_id,
          payload_json,
          created_at
        ) VALUES (?, 'candidate.proven', ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        runId,
        revisionHash,
        traceId,
        payloadJson,
        input.requestedAt,
      );

    return { artifactJson, eventId, payloadJson, runId, sandboxId };
  } finally {
    database.close();
  }
}
