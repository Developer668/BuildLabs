import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assignmentDigest,
  BuildAssignmentSchema,
  contractDigest,
  type BuildAssignment,
} from "../../domain/contract.js";
import {
  CANDIDATE_RANKING_POLICY_VERSION,
  CandidateProvenPayloadSchema,
  OutboxEventSchema,
  ProvenArtifactSchema,
  type OutboxEvent,
  type ProvenArtifact,
} from "../../domain/artifact.js";
import {
  EvidenceReceiptSchema,
  type EvidenceReceipt,
} from "../../domain/evidence.js";
import {
  AgentProgressSchema,
  isTerminalStatus,
  RunStageSchema,
  RunStatusSchema,
  type AgentProgress,
  type BuildRun,
  type RecoveredRun,
  type RunEvent,
  type RunStage,
  type SlotLease,
} from "../../domain/run.js";
import { canonicalJson } from "../../lib/canonical-json.js";
import { redactValue } from "../../lib/redaction.js";
import { decideProof } from "../../application/proof-gate.js";
import type {
  CancellationRequest,
  CancellationResult,
  CancellationSource,
  CreateRunResult,
  RunStore,
  VerificationSandboxPurpose,
} from "../../ports/index.js";
import { migrations } from "./migrations.js";

type RowValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, RowValue>;
const CURRENT_PROOF_PROTOCOL_VERSION = 1;

export class IdempotencyConflictError extends Error {
  constructor(assignmentId: string) {
    super(`Assignment ${assignmentId} already exists with different contents`);
    this.name = "IdempotencyConflictError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Build run not found: ${runId}`);
    this.name = "RunNotFoundError";
  }
}

export class StaleLeaseError extends Error {
  constructor(runId: string) {
    super(`Slot lease is missing or stale for run ${runId}`);
    this.name = "StaleLeaseError";
  }
}

export class InvalidRunStateError extends Error {
  constructor(runId: string, message: string) {
    super(`Invalid state for run ${runId}: ${message}`);
    this.name = "InvalidRunStateError";
  }
}

export interface SqliteRunStoreOptions {
  path: string;
  slotCount?: number;
  now?: () => Date;
}

export class SqliteRunStore implements RunStore {
  readonly #database: DatabaseSync;
  readonly #now: () => Date;
  readonly #slotCount: number;

  constructor(options: SqliteRunStoreOptions) {
    if (!Number.isInteger(options.slotCount ?? 4)) {
      throw new TypeError("slotCount must be an integer");
    }
    this.#slotCount = Math.min(4, Math.max(1, options.slotCount ?? 4));
    this.#now = options.now ?? (() => new Date());

    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }

    this.#database = new DatabaseSync(options.path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
  }

  createRun(input: BuildAssignment): CreateRunResult {
    const assignment = BuildAssignmentSchema.parse(input);
    const assignmentHash = assignmentDigest(assignment);
    const existing = this.#database
      .prepare(
        "SELECT id, assignment_hash FROM build_runs WHERE assignment_id = ?",
      )
      .get(assignment.assignmentId) as Row | undefined;

    if (existing) {
      if (existing.assignment_hash !== assignmentHash) {
        throw new IdempotencyConflictError(assignment.assignmentId);
      }
      return {
        run: this.#requireRun(stringColumn(existing.id, "id")),
        created: false,
      };
    }

    const now = this.#timestamp();
    const runId = randomUUID();
    const contractHash = contractDigest(assignment.contract);

    this.#transaction(() => {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO acceptance_contracts(
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
          assignment.contract.contractId,
          assignment.contract.projectId,
          assignment.contract.transcriptSha256,
          canonicalJson(assignment.contract),
          now,
        );

      this.#database
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
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)`,
        )
        .run(
          runId,
          assignment.assignmentId,
          assignmentHash,
          canonicalJson(assignment),
          assignment.projectId,
          assignment.candidateId,
          contractHash,
          now,
          now,
        );

      this.#appendEventStatement(
        runId,
        "run.queued",
        "queued",
        {
          assignmentId: assignment.assignmentId,
          candidateId: assignment.candidateId,
          contractHash,
        },
        now,
      );
    });

    return { run: this.#requireRun(runId), created: true };
  }

  getRun(runId: string): BuildRun | undefined {
    const row = this.#database
      .prepare("SELECT * FROM build_runs WHERE id = ?")
      .get(runId) as Row | undefined;
    return row ? this.#rowToRun(row) : undefined;
  }

  getAssignment(runId: string): BuildAssignment | undefined {
    const row = this.#database
      .prepare("SELECT assignment_json FROM build_runs WHERE id = ?")
      .get(runId) as Row | undefined;
    if (!row) {
      return undefined;
    }
    return BuildAssignmentSchema.parse(
      parseJsonColumn(row.assignment_json, "assignment_json"),
    );
  }

  listQueued(limit: number): BuildRun[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.#database
      .prepare(
        `SELECT * FROM build_runs
         WHERE status = 'queued' AND cancel_requested = 0
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .all(safeLimit) as Row[];
    return rows.map((row) => this.#rowToRun(row));
  }

  listEvents(runId: string, afterSequence: number, limit?: number): RunEvent[] {
    const safeLimit =
      limit === undefined
        ? 1_000
        : Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.#database
      .prepare(
        `SELECT sequence, run_id, event_type, stage, payload_json, created_at
         FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(runId, Math.max(0, Math.floor(afterSequence)), safeLimit) as Row[];

    return rows.map((row) => ({
      sequence: Number(row.sequence),
      runId: stringColumn(row.run_id, "run_id"),
      type: stringColumn(row.event_type, "event_type"),
      stage: RunStageSchema.parse(row.stage),
      payload: parseJsonColumn(row.payload_json, "payload_json"),
      createdAt: stringColumn(row.created_at, "created_at"),
    }));
  }

  getLatestEventSequence(runId: string): number {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS latest_sequence
         FROM run_events
         WHERE run_id = ?`,
      )
      .get(runId) as Row;
    return numberColumn(row.latest_sequence, "latest_sequence");
  }

  listEvidence(runId: string): EvidenceReceipt[] {
    const rows = this.#database
      .prepare(
        `SELECT receipt_json FROM evidence_receipts
         WHERE run_id = ?
         ORDER BY created_at, receipt_id`,
      )
      .all(runId) as Row[];
    return rows.map((row) =>
      EvidenceReceiptSchema.parse(
        parseJsonColumn(row.receipt_json, "receipt_json"),
      ),
    );
  }

  acquireSlot(runId: string, leaseMilliseconds: number): SlotLease | undefined {
    return this.#transaction(() => {
      const run = this.#requireRun(runId);
      if (run.status !== "queued" || run.cancelRequested) {
        return undefined;
      }

      const now = this.#timestamp();
      const slot = this.#database
        .prepare(
          `SELECT slot_id, run_id, fencing_token
           FROM slot_leases
           WHERE slot_id <= ?
             AND (run_id IS NULL OR lease_expires_at <= ?)
           ORDER BY slot_id
           LIMIT 1`,
        )
        .get(this.#slotCount, now) as Row | undefined;

      if (!slot) {
        return undefined;
      }

      if (slot.run_id) {
        this.#failExpiredRun(
          stringColumn(slot.run_id, "slot_leases.run_id"),
          now,
        );
      }

      const fencingToken = Number(slot.fencing_token) + 1;
      const leaseExpiresAt = new Date(
        this.#now().getTime() + leaseMilliseconds,
      ).toISOString();

      this.#database
        .prepare(
          `UPDATE slot_leases
           SET run_id = ?, fencing_token = ?, heartbeat_at = ?, lease_expires_at = ?
           WHERE slot_id = ?`,
        )
        .run(runId, fencingToken, now, leaseExpiresAt, Number(slot.slot_id));

      return {
        slotId: Number(slot.slot_id),
        runId,
        fencingToken,
        leaseExpiresAt,
      };
    });
  }

  heartbeat(lease: SlotLease, leaseMilliseconds: number): SlotLease {
    const now = this.#timestamp();
    const leaseExpiresAt = new Date(
      this.#now().getTime() + leaseMilliseconds,
    ).toISOString();
    const result = this.#database
      .prepare(
        `UPDATE slot_leases
         SET heartbeat_at = ?, lease_expires_at = ?
         WHERE slot_id = ?
           AND run_id = ?
           AND fencing_token = ?
           AND lease_expires_at > ?`,
      )
      .run(
        now,
        leaseExpiresAt,
        lease.slotId,
        lease.runId,
        lease.fencingToken,
        now,
      );

    if (result.changes !== 1) {
      throw new StaleLeaseError(lease.runId);
    }

    return { ...lease, leaseExpiresAt };
  }

  releaseSlot(lease: SlotLease): void {
    this.#database
      .prepare(
        `UPDATE slot_leases
         SET run_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL
         WHERE slot_id = ? AND run_id = ? AND fencing_token = ?`,
      )
      .run(lease.slotId, lease.runId, lease.fencingToken);
  }

  startRun(runId: string, lease: SlotLease): BuildRun {
    return this.#transaction(() => {
      this.#assertLease(runId, lease);
      const run = this.#requireRun(runId);
      if (run.status !== "queued") {
        throw new InvalidRunStateError(
          runId,
          `expected queued, got ${run.status}`,
        );
      }

      const now = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE build_runs
           SET status = 'running',
               stage = 'provisioning',
               slot_id = ?,
               fencing_token = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(lease.slotId, lease.fencingToken, now, runId);
      this.#appendEventStatement(
        runId,
        "run.started",
        "provisioning",
        { slotId: lease.slotId, fencingToken: lease.fencingToken },
        now,
      );
      return this.#requireRun(runId);
    });
  }

  updateStage(
    runId: string,
    lease: SlotLease,
    stage: RunStage,
    payload: unknown = {},
  ): BuildRun {
    const parsedStage = RunStageSchema.parse(stage);
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const now = this.#timestamp();
      this.#database
        .prepare("UPDATE build_runs SET stage = ?, updated_at = ? WHERE id = ?")
        .run(parsedStage, now, runId);
      this.#appendEventStatement(
        runId,
        `stage.${parsedStage}`,
        parsedStage,
        payload,
        now,
      );
      return this.#requireRun(runId);
    });
  }

  recordAgentProgress(
    runId: string,
    lease: SlotLease,
    progress: AgentProgress,
  ): void {
    const parsed = AgentProgressSchema.parse(progress);
    this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (run.stage !== "generating") {
        throw new InvalidRunStateError(
          runId,
          `agent progress requires generating stage, got ${run.stage}`,
        );
      }
      this.#appendEventStatement(
        runId,
        "agent.tool_completed",
        run.stage,
        parsed,
        this.#timestamp(),
      );
    });
  }

  attachSandbox(runId: string, lease: SlotLease, sandboxId: string): BuildRun {
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (run.builderSandboxId && run.builderSandboxId !== sandboxId) {
        throw new InvalidRunStateError(
          runId,
          "builder sandbox id is immutable once set",
        );
      }
      const now = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE build_runs
           SET sandbox_id = ?, builder_sandbox_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(sandboxId, sandboxId, now, runId);
      this.#appendEventStatement(
        runId,
        "sandbox.builder_attached",
        run.stage,
        { sandboxId },
        now,
      );
      return this.#requireRun(runId);
    });
  }

  attachVerificationSandbox(
    runId: string,
    lease: SlotLease,
    sandboxId: string,
    purpose: VerificationSandboxPurpose,
  ): BuildRun {
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (!run.builderSandboxId) {
        throw new InvalidRunStateError(
          runId,
          "builder sandbox is required before verification",
        );
      }
      if (run.builderSandboxId === sandboxId) {
        throw new InvalidRunStateError(
          runId,
          "verification sandbox must be distinct from the builder sandbox",
        );
      }
      const now = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE build_runs
           SET verification_sandbox_id = ?,
               verification_sandbox_purpose = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(sandboxId, purpose, now, runId);
      this.#appendEventStatement(
        runId,
        "sandbox.verification_attached",
        run.stage,
        { sandboxId, purpose },
        now,
      );
      return this.#requireRun(runId);
    });
  }

  promoteVerificationSandbox(
    runId: string,
    lease: SlotLease,
    sandboxId: string,
  ): BuildRun {
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (run.verificationSandboxId !== sandboxId) {
        throw new InvalidRunStateError(
          runId,
          "only the current verification sandbox can be promoted",
        );
      }
      if (run.verificationSandboxPurpose !== "delivery") {
        throw new InvalidRunStateError(
          runId,
          "only a delivery verification sandbox can be promoted",
        );
      }
      const now = this.#timestamp();
      this.#database
        .prepare(
          "UPDATE build_runs SET sandbox_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(sandboxId, now, runId);
      this.#appendEventStatement(
        runId,
        "sandbox.verification_promoted",
        run.stage,
        { sandboxId },
        now,
      );
      return this.#requireRun(runId);
    });
  }

  setRevision(
    runId: string,
    lease: SlotLease,
    revisionHash: string,
    previewPort: number,
  ): BuildRun {
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const now = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE build_runs
           SET revision_hash = ?, preview_port = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(revisionHash, previewPort, now, runId);
      this.#appendEventStatement(
        runId,
        "revision.frozen",
        this.#requireRun(runId).stage,
        { revisionHash, previewPort },
        now,
      );
      return this.#requireRun(runId);
    });
  }

  addEvidence(runId: string, lease: SlotLease, input: EvidenceReceipt): void {
    const receipt = EvidenceReceiptSchema.parse(input);
    this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (receipt.runId !== runId) {
        throw new InvalidRunStateError(runId, "receipt belongs to another run");
      }
      if (run.revisionHash !== receipt.revisionHash) {
        throw new InvalidRunStateError(
          runId,
          "receipt does not cover the current source revision",
        );
      }

      this.#database
        .prepare(
          `INSERT INTO evidence_receipts(
            receipt_id,
            run_id,
            revision_hash,
            kind,
            status,
            receipt_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receipt.receiptId,
          runId,
          receipt.revisionHash,
          receipt.kind,
          receipt.status,
          canonicalJson(receipt),
          receipt.completedAt,
        );
      this.#appendEventStatement(
        runId,
        "evidence.recorded",
        run.stage,
        {
          receiptId: receipt.receiptId,
          revisionHash: receipt.revisionHash,
          kind: receipt.kind,
          status: receipt.status,
        },
        this.#timestamp(),
      );
    });
  }

  recordArtifact(runId: string, lease: SlotLease, input: ProvenArtifact): void {
    const artifact = ProvenArtifactSchema.parse(input);
    this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (artifact.runId !== runId) {
        throw new InvalidRunStateError(runId, "artifact run id does not match");
      }
      if (run.revisionHash !== artifact.revisionHash) {
        throw new InvalidRunStateError(
          runId,
          "artifact does not match the current frozen revision",
        );
      }

      this.#database
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
          artifact.artifactId,
          runId,
          artifact.revisionHash,
          canonicalJson(artifact),
          artifact.createdAt,
        );
      this.#appendEventStatement(
        runId,
        "artifact.recorded",
        run.stage,
        {
          artifactId: artifact.artifactId,
          revisionHash: artifact.revisionHash,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        },
        this.#timestamp(),
      );
    });
  }

  getArtifact(runId: string): ProvenArtifact | undefined {
    const row = this.#database
      .prepare(
        `SELECT artifact.artifact_json
         FROM proven_artifacts AS artifact
         JOIN build_runs AS run ON run.id = artifact.run_id
         WHERE artifact.run_id = ?
           AND artifact.revision_hash = run.revision_hash
           AND run.status = 'passed'
           AND run.proof_protocol_version = ?
           AND run.builder_sandbox_id IS NOT NULL
           AND run.verification_sandbox_id IS NOT NULL
           AND run.builder_sandbox_id <> run.verification_sandbox_id
           AND run.verification_sandbox_purpose = 'delivery'
           AND run.sandbox_id = run.verification_sandbox_id
         ORDER BY artifact.created_at DESC
         LIMIT 1`,
      )
      .get(runId, CURRENT_PROOF_PROTOCOL_VERSION) as Row | undefined;
    return row
      ? ProvenArtifactSchema.parse(
          parseJsonColumn(row.artifact_json, "artifact_json"),
        )
      : undefined;
  }

  listOutbox(
    limit: number,
    projectId?: string,
    runIds?: readonly string[],
  ): OutboxEvent[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const normalizedProjectId = projectId?.trim() || null;
    const normalizedRunIds = runIds
      ? [
          ...new Set(
            runIds.map((runId) => OutboxEventSchema.shape.runId.parse(runId)),
          ),
        ]
      : [];
    if (
      runIds !== undefined &&
      (normalizedRunIds.length < 1 || normalizedRunIds.length > 4)
    ) {
      throw new TypeError("Outbox run filter requires one to four run IDs");
    }
    const runFilter =
      normalizedRunIds.length > 0
        ? `AND run.id IN (${normalizedRunIds.map(() => "?").join(", ")})`
        : "";
    const rows = this.#database
      .prepare(
        `SELECT outbox.event_id, outbox.event_type, outbox.run_id,
                outbox.revision_hash, outbox.trace_id, outbox.payload_json,
                outbox.created_at, outbox.published_at
         FROM outbox
         JOIN build_runs AS run ON run.id = outbox.run_id
         WHERE outbox.published_at IS NULL
           AND outbox.revision_hash = run.revision_hash
           AND run.status = 'passed'
           AND run.proof_protocol_version = ?
           AND run.builder_sandbox_id IS NOT NULL
           AND run.verification_sandbox_id IS NOT NULL
           AND run.builder_sandbox_id <> run.verification_sandbox_id
           AND run.verification_sandbox_purpose = 'delivery'
           AND run.sandbox_id = run.verification_sandbox_id
           AND (? IS NULL OR run.project_id = ?)
           ${runFilter}
         ORDER BY outbox.created_at, outbox.event_id
         LIMIT ?`,
      )
      .all(
        CURRENT_PROOF_PROTOCOL_VERSION,
        normalizedProjectId,
        normalizedProjectId,
        ...normalizedRunIds,
        safeLimit,
      ) as Row[];

    return rows.map((row) => {
      const event = {
        eventId: stringColumn(row.event_id, "event_id"),
        type: stringColumn(row.event_type, "event_type"),
        runId: stringColumn(row.run_id, "run_id"),
        revisionHash: stringColumn(row.revision_hash, "revision_hash"),
        traceId: stringColumn(row.trace_id, "trace_id"),
        payload: parseJsonColumn(row.payload_json, "payload_json"),
        createdAt: stringColumn(row.created_at, "created_at"),
      };
      if (row.published_at) {
        return OutboxEventSchema.parse({
          ...event,
          publishedAt: stringColumn(row.published_at, "published_at"),
        });
      }
      return OutboxEventSchema.parse(event);
    });
  }

  getPendingOutbox(eventId: string): OutboxEvent | undefined {
    const row = this.#database
      .prepare(
        `SELECT outbox.event_id, outbox.event_type, outbox.run_id,
                outbox.revision_hash, outbox.trace_id, outbox.payload_json,
                outbox.created_at
         FROM outbox
         JOIN build_runs AS run ON run.id = outbox.run_id
         WHERE outbox.event_id = ?
           AND outbox.published_at IS NULL
           AND outbox.revision_hash = run.revision_hash
           AND run.status = 'passed'
           AND run.proof_protocol_version = ?
           AND run.builder_sandbox_id IS NOT NULL
           AND run.verification_sandbox_id IS NOT NULL
           AND run.builder_sandbox_id <> run.verification_sandbox_id
           AND run.verification_sandbox_purpose = 'delivery'
           AND run.sandbox_id = run.verification_sandbox_id`,
      )
      .get(eventId, CURRENT_PROOF_PROTOCOL_VERSION) as Row | undefined;
    if (!row) {
      return undefined;
    }
    return OutboxEventSchema.parse({
      eventId: stringColumn(row.event_id, "event_id"),
      type: stringColumn(row.event_type, "event_type"),
      runId: stringColumn(row.run_id, "run_id"),
      revisionHash: stringColumn(row.revision_hash, "revision_hash"),
      traceId: stringColumn(row.trace_id, "trace_id"),
      payload: parseJsonColumn(row.payload_json, "payload_json"),
      createdAt: stringColumn(row.created_at, "created_at"),
    });
  }

  markOutboxPublished(eventId: string): boolean {
    const result = this.#database
      .prepare(
        `UPDATE outbox
         SET published_at = ?
         WHERE event_id = ?
           AND published_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM build_runs AS run
             WHERE run.id = outbox.run_id
               AND outbox.revision_hash = run.revision_hash
               AND run.status = 'passed'
               AND run.proof_protocol_version = ?
               AND run.builder_sandbox_id IS NOT NULL
               AND run.verification_sandbox_id IS NOT NULL
               AND run.builder_sandbox_id <> run.verification_sandbox_id
               AND run.verification_sandbox_purpose = 'delivery'
               AND run.sandbox_id = run.verification_sandbox_id
           )`,
      )
      .run(this.#timestamp(), eventId, CURRENT_PROOF_PROTOCOL_VERSION);
    if (result.changes === 1) {
      return true;
    }
    const current = this.#database
      .prepare("SELECT published_at FROM outbox WHERE event_id = ?")
      .get(eventId) as Row | undefined;
    if (!current) {
      return false;
    }
    if (current.published_at !== null) {
      return true;
    }
    throw new Error(`Pending outbox event not found: ${eventId}`);
  }

  requestCancel(runId: string): BuildRun;
  requestCancel(
    runId: string,
    request: CancellationRequest,
  ): CancellationResult;
  requestCancel(
    runId: string,
    request?: CancellationRequest,
  ): BuildRun | CancellationResult {
    const cancellation = prepareCancellationEvent(request);
    const result = this.#transaction<CancellationResult>(() => {
      const run = this.#requireRun(runId);
      if (isTerminalStatus(run.status)) {
        return {
          changed: false,
          reason: "candidate_is_terminal",
          run,
        };
      }
      if (run.cancelRequested) {
        return {
          changed: false,
          reason: "cancellation_already_requested",
          run,
        };
      }
      if (
        request?.expected &&
        (run.status !== request.expected.status ||
          run.updatedAt !== request.expected.updatedAt)
      ) {
        return {
          changed: false,
          reason: "candidate_state_changed",
          run,
        };
      }
      const now = this.#timestamp();
      const eventPayload = {
        runId,
        source: cancellation.source,
        reasonCode: cancellation.reasonCode,
        ...(cancellation.conversationCorrelationId
          ? {
              conversationCorrelationId: cancellation.conversationCorrelationId,
            }
          : {}),
      };
      if (run.status === "queued") {
        this.#database
          .prepare(
            `UPDATE build_runs
             SET status = 'cancelled',
                 stage = 'complete',
                 cancel_requested = 1,
                 updated_at = ?,
                 completed_at = ?
             WHERE id = ?`,
          )
          .run(now, now, runId);
        this.#appendEventStatement(
          runId,
          "run.cancelled",
          "complete",
          eventPayload,
          now,
        );
      } else {
        this.#database
          .prepare(
            "UPDATE build_runs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
          )
          .run(now, runId);
        this.#appendEventStatement(
          runId,
          "run.cancel_requested",
          run.stage,
          eventPayload,
          now,
        );
      }
      return {
        changed: true,
        reason: "cancellation_requested",
        run: this.#requireRun(runId),
      };
    });
    return request ? result : result.run;
  }

  markPassed(
    runId: string,
    lease: SlotLease,
    revisionHash: string,
    traceId: string,
  ): BuildRun {
    return this.#transaction(() => {
      this.#assertActiveRun(runId, lease);
      const run = this.#requireRun(runId);
      if (run.cancelRequested) {
        throw new InvalidRunStateError(
          runId,
          "cannot pass after cancellation was requested",
        );
      }
      if (run.revisionHash !== revisionHash) {
        throw new InvalidRunStateError(
          runId,
          "cannot pass a revision other than the current frozen revision",
        );
      }
      if (!run.sandboxId || !run.previewPort) {
        throw new InvalidRunStateError(
          runId,
          "sandbox and preview port are required before passing",
        );
      }
      if (
        !run.builderSandboxId ||
        !run.verificationSandboxId ||
        run.builderSandboxId === run.verificationSandboxId ||
        run.verificationSandboxPurpose !== "delivery" ||
        run.sandboxId !== run.verificationSandboxId
      ) {
        throw new InvalidRunStateError(
          runId,
          "a promoted verification sandbox is required before passing",
        );
      }
      const artifact = this.#getRecordedArtifact(runId);
      if (!artifact || artifact.revisionHash !== revisionHash) {
        throw new InvalidRunStateError(
          runId,
          "a proven artifact for the frozen revision is required before passing",
        );
      }
      const assignment = this.getAssignment(runId);
      if (!assignment) {
        throw new InvalidRunStateError(runId, "assignment is missing");
      }
      const decision = decideProof(
        assignment.contract,
        revisionHash,
        this.listEvidence(runId),
      );
      if (!decision.passed) {
        throw new InvalidRunStateError(
          runId,
          `proof gate rejected the candidate: ${decision.reasons.join("; ")}`,
        );
      }

      const now = this.#timestamp();
      this.#database
        .prepare(
          `UPDATE build_runs
           SET status = 'passed',
               stage = 'complete',
               proof_protocol_version = ?,
               updated_at = ?,
               completed_at = ?
           WHERE id = ?`,
        )
        .run(CURRENT_PROOF_PROTOCOL_VERSION, now, now, runId);

      const payload = CandidateProvenPayloadSchema.parse({
        runId,
        projectId: run.projectId,
        candidateId: run.candidateId,
        contractHash: run.contractHash,
        revisionHash,
        sandboxId: run.sandboxId,
        previewPort: run.previewPort,
        artifact,
        traceId,
        ranking: rankingFor(this.listEvidence(runId), traceId),
      });
      this.#database
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
          randomUUID(),
          runId,
          revisionHash,
          traceId,
          canonicalJson(payload),
          now,
        );
      this.#appendEventStatement(
        runId,
        "candidate.proven",
        "complete",
        payload,
        now,
      );
      return this.#requireRun(runId);
    });
  }

  markRejected(runId: string, lease: SlotLease, reasons: string[]): BuildRun {
    return this.#markTerminal(
      runId,
      lease,
      "rejected",
      "proof_gate_rejected",
      reasons.join("; "),
      { reasons },
    );
  }

  markFailed(
    runId: string,
    lease: SlotLease | undefined,
    code: string,
    message: string,
  ): BuildRun {
    return this.#markTerminal(runId, lease, "failed", code, message, { code });
  }

  markCancelled(runId: string, lease: SlotLease): BuildRun {
    return this.#markTerminal(
      runId,
      lease,
      "cancelled",
      "cancelled",
      "Build run cancelled",
      {},
    );
  }

  recoverInterruptedRuns(): RecoveredRun[] {
    return this.#transaction(() => {
      const now = this.#timestamp();
      const interrupted = this.#database
        .prepare(
          `SELECT
             id,
             stage,
             sandbox_id,
             builder_sandbox_id,
             verification_sandbox_id
           FROM build_runs
           WHERE status = 'running'`,
        )
        .all() as Row[];
      const newlyRecoveredIds = new Set(
        interrupted.map((row) => stringColumn(row.id, "id")),
      );

      for (const row of interrupted) {
        const runId = stringColumn(row.id, "id");
        this.#database
          .prepare(
            `UPDATE build_runs
             SET status = 'failed',
                 stage = 'complete',
                 error_code = 'worker_restarted',
                 error_message = 'Worker stopped before a terminal proof decision',
                 updated_at = ?,
                 completed_at = ?
             WHERE id = ?`,
          )
          .run(now, now, runId);
        this.#appendEventStatement(
          runId,
          "run.failed",
          "complete",
          { code: "worker_restarted", previousStage: row.stage },
          now,
        );
      }

      this.#database.exec(
        `UPDATE slot_leases
         SET run_id = NULL, heartbeat_at = NULL, lease_expires_at = NULL`,
      );
      const cleanupCandidates = this.#database
        .prepare(
          `SELECT
             id,
             sandbox_id,
             builder_sandbox_id,
             verification_sandbox_id
           FROM build_runs
           WHERE status = 'failed'
             AND error_code = 'worker_restarted'
             AND recovery_cleanup_completed_at IS NULL`,
        )
        .all() as Row[];
      return cleanupCandidates.map<RecoveredRun>((row) => {
        const runId = stringColumn(row.id, "id");
        return {
          runId,
          sandboxIds: [
            row.sandbox_id,
            row.builder_sandbox_id,
            row.verification_sandbox_id,
          ].filter((value): value is string => typeof value === "string"),
          newlyRecovered: newlyRecoveredIds.has(runId),
        };
      });
    });
  }

  markRecoveryCleanupComplete(runId: string): void {
    this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT status, error_code, recovery_cleanup_completed_at
           FROM build_runs
           WHERE id = ?`,
        )
        .get(runId) as Row | undefined;
      if (!row) {
        throw new RunNotFoundError(runId);
      }
      if (row.recovery_cleanup_completed_at !== null) {
        return;
      }
      if (row.status !== "failed" || row.error_code !== "worker_restarted") {
        throw new InvalidRunStateError(
          runId,
          "recovery cleanup can only complete for an interrupted run",
        );
      }
      this.#database
        .prepare(
          `UPDATE build_runs
           SET recovery_cleanup_completed_at = ?
           WHERE id = ?
             AND recovery_cleanup_completed_at IS NULL`,
        )
        .run(this.#timestamp(), runId);
    });
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      (
        this.#database
          .prepare("SELECT version FROM schema_migrations")
          .all() as Row[]
      ).map((row) => Number(row.version)),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.#transaction(() => {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, this.#timestamp());
      });
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #getRecordedArtifact(runId: string): ProvenArtifact | undefined {
    const row = this.#database
      .prepare(
        `SELECT artifact_json
         FROM proven_artifacts
         WHERE run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId) as Row | undefined;
    return row
      ? ProvenArtifactSchema.parse(
          parseJsonColumn(row.artifact_json, "artifact_json"),
        )
      : undefined;
  }

  #assertLease(runId: string, lease: SlotLease): void {
    if (lease.runId !== runId) {
      throw new StaleLeaseError(runId);
    }
    const row = this.#database
      .prepare(
        `SELECT 1 AS valid
         FROM slot_leases
         WHERE slot_id = ?
           AND run_id = ?
           AND fencing_token = ?
           AND lease_expires_at > ?`,
      )
      .get(lease.slotId, runId, lease.fencingToken, this.#timestamp()) as
      Row | undefined;
    if (!row) {
      throw new StaleLeaseError(runId);
    }
  }

  #assertActiveRun(runId: string, lease: SlotLease): BuildRun {
    this.#assertLease(runId, lease);
    const run = this.#requireRun(runId);
    if (run.status !== "running") {
      throw new InvalidRunStateError(
        runId,
        `expected running, got ${run.status}`,
      );
    }
    return run;
  }

  #requireRun(runId: string): BuildRun {
    const run = this.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }
    return run;
  }

  #markTerminal(
    runId: string,
    lease: SlotLease | undefined,
    status: "cancelled" | "failed" | "rejected",
    code: string,
    message: string,
    payload: unknown,
  ): BuildRun {
    return this.#transaction(() => {
      if (lease) {
        this.#assertActiveRun(runId, lease);
      }
      const run = this.#requireRun(runId);
      if (isTerminalStatus(run.status)) {
        return run;
      }
      if (!lease && run.status === "running") {
        throw new StaleLeaseError(runId);
      }

      const now = this.#timestamp();
      const redactedMessage = redactValue(message);
      this.#database
        .prepare(
          `UPDATE build_runs
           SET status = ?,
               stage = 'complete',
               error_code = ?,
               error_message = ?,
               updated_at = ?,
               completed_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          code,
          typeof redactedMessage === "string"
            ? redactedMessage
            : "Build run failed",
          now,
          now,
          runId,
        );
      this.#appendEventStatement(
        runId,
        `run.${status}`,
        "complete",
        payload,
        now,
      );
      return this.#requireRun(runId);
    });
  }

  #failExpiredRun(runId: string, now: string): void {
    const run = this.getRun(runId);
    if (!run || isTerminalStatus(run.status)) {
      return;
    }
    this.#database
      .prepare(
        `UPDATE build_runs
         SET status = 'failed',
             stage = 'complete',
             error_code = 'lease_expired',
             error_message = 'Worker lease expired before completion',
             updated_at = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(now, now, runId);
    this.#appendEventStatement(
      runId,
      "run.failed",
      "complete",
      { code: "lease_expired" },
      now,
    );
  }

  #appendEventStatement(
    runId: string,
    eventType: string,
    stage: RunStage,
    payload: unknown,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO run_events(
          run_id,
          event_type,
          stage,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        eventType,
        stage,
        canonicalJson(redactValue(payload)),
        createdAt,
      );
  }

  #rowToRun(row: Row): BuildRun {
    const run: BuildRun = {
      id: stringColumn(row.id, "id"),
      assignmentId: stringColumn(row.assignment_id, "assignment_id"),
      assignmentHash: stringColumn(row.assignment_hash, "assignment_hash"),
      projectId: stringColumn(row.project_id, "project_id"),
      candidateId: stringColumn(row.candidate_id, "candidate_id"),
      contractHash: stringColumn(row.contract_hash, "contract_hash"),
      status: RunStatusSchema.parse(row.status),
      stage: RunStageSchema.parse(row.stage),
      cancelRequested: Number(row.cancel_requested) === 1,
      createdAt: stringColumn(row.created_at, "created_at"),
      updatedAt: stringColumn(row.updated_at, "updated_at"),
    };

    if (row.slot_id !== null && row.slot_id !== undefined) {
      run.slotId = Number(row.slot_id);
    }
    if (row.fencing_token !== null && row.fencing_token !== undefined) {
      run.fencingToken = Number(row.fencing_token);
    }
    if (row.sandbox_id) {
      run.sandboxId = stringColumn(row.sandbox_id, "sandbox_id");
    }
    if (row.builder_sandbox_id) {
      run.builderSandboxId = stringColumn(
        row.builder_sandbox_id,
        "builder_sandbox_id",
      );
    }
    if (row.verification_sandbox_id) {
      run.verificationSandboxId = stringColumn(
        row.verification_sandbox_id,
        "verification_sandbox_id",
      );
    }
    if (row.verification_sandbox_purpose) {
      const purpose = stringColumn(
        row.verification_sandbox_purpose,
        "verification_sandbox_purpose",
      );
      if (purpose !== "commands" && purpose !== "delivery") {
        throw new Error(
          `Database column verification_sandbox_purpose contains an invalid value`,
        );
      }
      run.verificationSandboxPurpose = purpose;
    }
    if (row.revision_hash) {
      run.revisionHash = stringColumn(row.revision_hash, "revision_hash");
    }
    if (row.preview_port !== null && row.preview_port !== undefined) {
      run.previewPort = Number(row.preview_port);
    }
    if (row.error_code) {
      run.errorCode = stringColumn(row.error_code, "error_code");
    }
    if (row.error_message) {
      run.errorMessage = stringColumn(row.error_message, "error_message");
    }
    if (row.completed_at) {
      run.completedAt = stringColumn(row.completed_at, "completed_at");
    }
    return run;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

const CANCELLATION_SOURCES = new Set<CancellationSource>([
  "elevenlabs_webhook",
  "internal",
  "operator_api",
  "studio_speech_engine",
]);

function prepareCancellationEvent(request: CancellationRequest | undefined): {
  source: CancellationSource;
  reasonCode:
    | "explicit_operator_cancellation"
    | "operator_api_cancellation"
    | "scheduler_cancellation";
  conversationCorrelationId?: string;
} {
  const requestedSource = request?.source;
  const source =
    requestedSource && CANCELLATION_SOURCES.has(requestedSource)
      ? requestedSource
      : "internal";
  const reasonCode = request?.reasonCode ?? "scheduler_cancellation";
  const conversationCorrelationId =
    request?.conversationCorrelationId &&
    /^[a-f0-9]{64}$/u.test(request.conversationCorrelationId)
      ? request.conversationCorrelationId
      : undefined;
  return {
    source,
    reasonCode,
    ...(conversationCorrelationId ? { conversationCorrelationId } : {}),
  };
}

function rankingFor(receipts: EvidenceReceipt[], traceId: string) {
  const evaluation = receipts
    .filter(
      (receipt) =>
        receipt.kind === "contract-evaluation" &&
        receipt.traceId === traceId &&
        receipt.status === "PASS",
    )
    .sort((left, right) =>
      right.completedAt.localeCompare(left.completedAt),
    )[0];
  if (!evaluation || evaluation.kind !== "contract-evaluation") {
    throw new Error("Passing run is missing its Braintrust ranking score");
  }
  const preferenceSatisfaction =
    evaluation.braintrustScores.preferenceSatisfaction;
  return {
    provider: "braintrust" as const,
    policyVersion: CANDIDATE_RANKING_POLICY_VERSION,
    preferenceSatisfaction,
    scoreTuple: [preferenceSatisfaction] as const,
    traceId,
  };
}

function stringColumn(value: RowValue | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`SQLite column ${name} is not text`);
  }
  return value;
}

function numberColumn(value: RowValue | undefined, name: string): number {
  const parsed =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`Expected integer column ${name}`);
  }
  return parsed;
}

function parseJsonColumn(value: RowValue | undefined, name: string): unknown {
  const text = stringColumn(value, name);
  return JSON.parse(text) as unknown;
}
