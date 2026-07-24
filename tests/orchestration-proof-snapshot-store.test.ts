import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProofSummarySnapshotConflictError,
  SqliteOrchestrationStore,
} from "../src/orchestration/adapters/sqlite/orchestration-store.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";

const projectId = "11111111-1111-4111-8111-111111111111";

describe("immutable proof-summary snapshot storage", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("encrypts one canonical snapshot and recovers exact retries without rewriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "buildlapse-proof-store-"));
    directories.push(directory);
    const databasePath = join(directory, "orchestration.db");
    const store = new SqliteOrchestrationStore({
      path: databasePath,
      encryptionKey: Buffer.alloc(32, 23),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    createProject(store);
    const canonicalSnapshot = canonicalJson({
      schemaVersion: "buildlapse-proof-summary-v1",
      project: { projectId, title: "Safe project" },
    });
    const input = {
      snapshotId: "proof-summary:immutable-one",
      projectId,
      deploymentReceiptId: "deployment:receipt-one",
      revisionHash: "a".repeat(64),
      snapshotDigest: sha256(canonicalSnapshot),
      canonicalSnapshot,
    };

    const created = store.createProofSummarySnapshot(input);
    expect(created.created).toBe(true);
    expect(created.snapshot).toMatchObject(input);
    const replayed = store.createProofSummarySnapshot(input);
    expect(replayed.created).toBe(false);
    expect(replayed.snapshot).toEqual(created.snapshot);
    expect(store.getProofSummarySnapshot(input.snapshotId)).toEqual(
      created.snapshot,
    );
    expect(() =>
      store.createProofSummarySnapshot({
        ...input,
        snapshotDigest: sha256(
          canonicalJson({
            schemaVersion: "buildlapse-proof-summary-v1",
            project: { projectId, title: "Rewritten project" },
          }),
        ),
        canonicalSnapshot: canonicalJson({
          schemaVersion: "buildlapse-proof-summary-v1",
          project: { projectId, title: "Rewritten project" },
        }),
      }),
    ).toThrow(ProofSummarySnapshotConflictError);
    store.close();

    const bytes = readFileSync(databasePath);
    expect(bytes.includes(Buffer.from(canonicalSnapshot, "utf8"))).toBe(false);

    const raw = new DatabaseSync(databasePath);
    expect(() =>
      raw
        .prepare(
          "UPDATE orchestration_proof_summary_snapshots SET created_at = ? WHERE snapshot_id = ?",
        )
        .run("2027-01-01T00:00:00.000Z", input.snapshotId),
    ).toThrow(/immutable/u);
    expect(() =>
      raw
        .prepare(
          "DELETE FROM orchestration_proof_summary_snapshots WHERE snapshot_id = ?",
        )
        .run(input.snapshotId),
    ).toThrow(/immutable/u);
    raw.close();
  });

  it("revokes a bearer capability through an immutable separate receipt", () => {
    const store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: Buffer.alloc(32, 23),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });
    createProject(store);
    const canonicalSnapshot = canonicalJson({
      schemaVersion: "buildlapse-proof-summary-v1",
      project: { projectId, title: "Safe project" },
    });
    const input = {
      snapshotId: "proof-summary:revoked-one",
      projectId,
      deploymentReceiptId: "deployment:receipt-two",
      revisionHash: "b".repeat(64),
      snapshotDigest: sha256(canonicalSnapshot),
      canonicalSnapshot,
    };
    store.createProofSummarySnapshot(input);

    expect(
      store.revokeProofSummarySnapshot(input.snapshotId, "operator_requested"),
    ).toMatchObject({ revoked: true });
    expect(
      store.revokeProofSummarySnapshot(input.snapshotId, "operator_requested"),
    ).toMatchObject({ revoked: false });
    expect(store.getProofSummarySnapshot(input.snapshotId)).toMatchObject({
      ...input,
      revokedAt: "2026-07-24T12:00:00.000Z",
      revocationReason: "operator_requested",
    });
    store.close();
  });
});

function createProject(store: SqliteOrchestrationStore): void {
  const content = "Build a safe project.";
  store.createProject({
    projectId,
    idempotencyKey: "proof-snapshot-project-intake",
    status: "intake_received",
    intake: {
      kind: "email",
      intakeId: "proof-snapshot-intake",
      receivedAt: "2026-07-24T11:00:00.000Z",
      content,
      contentDigest: sha256(content),
      piiSpans: [],
      source: {
        provider: "resend",
        providerMessageId: "proof-snapshot-message",
        signatureVerified: true,
      },
    },
    customer: {
      profileId: "proof-snapshot-profile",
      researchConsent: {
        granted: false,
        scope: "own_business_only",
      },
    },
  });
}
