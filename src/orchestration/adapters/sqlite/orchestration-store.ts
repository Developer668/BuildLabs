import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CreateProjectInputSchema,
  OrchestrationIdSchema,
  OrchestrationSha256Schema,
  ProjectAggregateSchema,
  ProjectEventInputSchema,
  ProjectEventSchema,
  TimestampSchema,
  type CreateProjectInput,
  type CreateProjectResult,
  type ProjectAggregate,
  type ProjectEvent,
  type ProjectEventInput,
  type ProjectLifecycleStatus,
} from "../../domain/project.js";
import type {
  CustomerDashboardLoginConsumption,
  InboundMailEnvelope,
  InboundMailEnvelopeFailure,
  InboundMailEnvelopeInput,
  OrchestrationProjectStore,
  ProofSummarySnapshot,
  ProofSummarySnapshotCreateResult,
  ProofSummarySnapshotInput,
  ProofSummarySnapshotRevocationResult,
  ReconciliationProjectPage,
  VerifiedInboxEvent,
  WebhookSecurityAuditProvider,
  WebhookSecurityFailureCode,
  WebhookSecurityFailureInput,
  WebhookSecurityFailureRecordResult,
  WebhookSecurityFailureSummary,
  WebhookSecurityFailureSummaryGroup,
} from "../../domain/store.js";
import { canonicalJson, sha256 } from "../../../lib/canonical-json.js";
import { orchestrationMigrations } from "./migrations.js";

type RowValue = string | number | bigint | Uint8Array | null;
type Row = Record<string, RowValue>;

interface ProjectIndex {
  projectId: string;
  idempotencyKey: string;
  idempotencyDigest: string;
  status: ProjectLifecycleStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface EncryptedValue {
  nonce: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

const WebhookProviderSchema = OrchestrationIdSchema.refine(
  (provider) => /^[a-z][a-z0-9_-]*$/.test(provider),
  "Webhook provider must be a lowercase provider identifier",
);
const DEFAULT_SECURITY_AUDIT_RECEIPT_LIMIT = 10_000;
const MAX_SECURITY_AUDIT_RECEIPT_LIMIT = 100_000;
// Four provider/code groups can be summed without exceeding JS safe integers.
const MAX_SECURITY_AUDIT_OVERFLOW_OBSERVATIONS_PER_GROUP = 1_000_000_000_000_000;
const MAX_PROOF_SUMMARY_SNAPSHOT_BYTES = 64 * 1_024;
const PROOF_SUMMARY_REVOCATION_REASONS = [
  "operator_requested",
  "capability_compromised",
  "privacy_request",
  "security_policy",
] as const;
const WEBHOOK_SECURITY_AUDIT_PROVIDERS = ["resend", "stripe"] as const;
const WEBHOOK_SECURITY_FAILURE_CODES = [
  "invalid_signature_headers",
  "webhook_verification_failed",
] as const;
const RECONCILABLE_PROJECT_STATUSES = [
  "intake_received",
  "needs_clarification",
  "proposal_drafting",
  "awaiting_customer_revision",
  "awaiting_payment",
  "paid",
  "building",
  "verifying",
  "preview_ready",
  "revision_pending",
  "deploying",
  "deployment_verification_failed",
  "delivering",
] as const satisfies readonly ProjectLifecycleStatus[];

export class OrchestrationIdempotencyConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Orchestration idempotency key was reused: ${idempotencyKey}`);
    this.name = "OrchestrationIdempotencyConflictError";
  }
}

export class CustomerDashboardLoginConflictError extends Error {
  constructor() {
    super(
      "Customer dashboard login capability was already consumed or expired",
    );
    this.name = "CustomerDashboardLoginConflictError";
  }
}

export class ProjectAlreadyExistsError extends Error {
  constructor(projectId: string) {
    super(`Orchestration project already exists: ${projectId}`);
    this.name = "ProjectAlreadyExistsError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Orchestration project not found: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class OptimisticConcurrencyError extends Error {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(
    projectId: string,
    expectedRevision: number,
    actualRevision: number,
  ) {
    super(
      `Stale orchestration project revision for ${projectId}: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "OptimisticConcurrencyError";
    this.projectId = projectId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class InvalidAggregateRevisionError extends Error {
  constructor(projectId: string, aggregateRevision: number, expected: number) {
    super(
      `Project ${projectId} carries revision ${aggregateRevision}; save expected ${expected}`,
    );
    this.name = "InvalidAggregateRevisionError";
  }
}

export class InboxConflictError extends Error {
  constructor(provider: string, eventId: string) {
    super(
      `Webhook ${provider}/${eventId} was replayed with different contents`,
    );
    this.name = "InboxConflictError";
  }
}

export class InboundMailEnvelopeConflictError extends Error {
  constructor(eventId: string) {
    super(`Inbound Resend envelope identity was reused: ${eventId}`);
    this.name = "InboundMailEnvelopeConflictError";
  }
}

export class ProofSummarySnapshotConflictError extends Error {
  constructor(snapshotId: string) {
    super(`Proof summary snapshot identity was reused: ${snapshotId}`);
    this.name = "ProofSummarySnapshotConflictError";
  }
}

export class ProofSummarySnapshotNotFoundError extends Error {
  constructor() {
    super("Proof summary snapshot was not found");
    this.name = "ProofSummarySnapshotNotFoundError";
  }
}

export class ProofSummarySnapshotRevocationConflictError extends Error {
  constructor() {
    super("Proof summary snapshot revocation conflicts with prior evidence");
    this.name = "ProofSummarySnapshotRevocationConflictError";
  }
}

export class ProofSummarySnapshotDecryptionError extends Error {
  constructor(snapshotId: string, options?: ErrorOptions) {
    super(
      `Encrypted proof summary snapshot failed authentication: ${snapshotId}`,
      options,
    );
    this.name = "ProofSummarySnapshotDecryptionError";
  }
}

export class AggregateDecryptionError extends Error {
  constructor(projectId: string, options?: ErrorOptions) {
    super(
      `Encrypted orchestration aggregate failed authentication: ${projectId}`,
      {
        ...options,
      },
    );
    this.name = "AggregateDecryptionError";
  }
}

export interface SqliteOrchestrationStoreOptions {
  path: string;
  /**
   * A separately managed 32-byte key. It is never persisted by this adapter.
   */
  encryptionKey: Buffer;
  now?: () => Date;
  /**
   * Hard cap for unique invalid-webhook fingerprints. Once full, subsequent
   * observations increment one finite provider/code overflow summary instead
   * of creating attacker-controlled rows.
   */
  securityAuditReceiptLimit?: number;
}

export class SqliteOrchestrationStore implements OrchestrationProjectStore {
  readonly #database: DatabaseSync;
  readonly #encryptionKey: Buffer;
  readonly #now: () => Date;
  readonly #securityAuditReceiptLimit: number;
  #closed = false;

  constructor(options: SqliteOrchestrationStoreOptions) {
    if (!Buffer.isBuffer(options.encryptionKey)) {
      throw new TypeError("encryptionKey must be a Buffer");
    }
    if (options.encryptionKey.length !== 32) {
      throw new TypeError(
        "encryptionKey must contain exactly 32 bytes for AES-256-GCM",
      );
    }
    if (options.path.length === 0) {
      throw new TypeError("SQLite path cannot be empty");
    }

    this.#encryptionKey = Buffer.from(options.encryptionKey);
    this.#now = options.now ?? (() => new Date());
    this.#securityAuditReceiptLimit = parseSecurityAuditReceiptLimit(
      options.securityAuditReceiptLimit ?? DEFAULT_SECURITY_AUDIT_RECEIPT_LIMIT,
    );

    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true });
    }

    this.#database = new DatabaseSync(options.path);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA secure_delete = ON");
    this.#migrate();
  }

  createProject(input: CreateProjectInput): CreateProjectResult {
    const parsed = CreateProjectInputSchema.parse(input);
    const idempotencyDigest = sha256(
      canonicalJson({
        projectId: parsed.projectId ?? null,
        status: parsed.status,
        intake: parsed.intake,
        customer: parsed.customer,
      }),
    );

    return this.#transaction(() => {
      const existingByKey = this.#database
        .prepare(
          `SELECT *
           FROM orchestration_projects
           WHERE idempotency_key = ?`,
        )
        .get(parsed.idempotencyKey) as Row | undefined;

      if (existingByKey) {
        const existingDigest = stringColumn(
          existingByKey.idempotency_digest,
          "idempotency_digest",
        );
        if (existingDigest !== idempotencyDigest) {
          throw new OrchestrationIdempotencyConflictError(
            parsed.idempotencyKey,
          );
        }
        return {
          project: this.#rowToProject(existingByKey),
          created: false,
        };
      }

      const projectId = parsed.projectId ?? randomUUID();
      const existingByProject = this.#database
        .prepare(
          `SELECT project_id
           FROM orchestration_projects
           WHERE project_id = ?`,
        )
        .get(projectId) as Row | undefined;
      if (existingByProject) {
        throw new ProjectAlreadyExistsError(projectId);
      }

      const timestamp = this.#timestamp();
      const project = ProjectAggregateSchema.parse({
        projectId,
        revision: 0,
        status: parsed.status,
        intake: parsed.intake,
        customer: parsed.customer,
        proposals: [],
        checkoutSessions: [],
        payments: [],
        buildBatches: [],
        provenCandidates: [],
        previews: [],
        deployments: [],
        messages: [],
        effects: [],
        errors: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const index: ProjectIndex = {
        projectId,
        idempotencyKey: parsed.idempotencyKey,
        idempotencyDigest,
        status: project.status,
        revision: project.revision,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      const encrypted = this.#encrypt(project, index);

      this.#database
        .prepare(
          `INSERT INTO orchestration_projects(
            project_id,
            idempotency_key,
            idempotency_digest,
            status,
            revision,
            created_at,
            updated_at,
            has_pending_dashboard_login,
            encryption_nonce,
            encryption_tag,
            encrypted_aggregate
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          index.projectId,
          index.idempotencyKey,
          index.idempotencyDigest,
          index.status,
          index.revision,
          index.createdAt,
          index.updatedAt,
          hasPendingDashboardLoginEffect(project) ? 1 : 0,
          encrypted.nonce,
          encrypted.tag,
          encrypted.ciphertext,
        );

      this.#appendEvent(
        projectId,
        0,
        {
          type: "project.created",
          actor: "system",
          payload: { status: project.status },
        },
        timestamp,
      );
      return { project, created: true };
    });
  }

  getProject(projectId: string): ProjectAggregate | undefined {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    const row = this.#database
      .prepare(
        `SELECT *
         FROM orchestration_projects
         WHERE project_id = ?`,
      )
      .get(parsedProjectId) as Row | undefined;
    return row ? this.#rowToProject(row) : undefined;
  }

  createProofSummarySnapshot(
    input: ProofSummarySnapshotInput,
  ): ProofSummarySnapshotCreateResult {
    const parsed = parseProofSummarySnapshotInput(input);
    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT snapshot.*, revocation.reason AS revocation_reason,
                  revocation.revoked_at
           FROM orchestration_proof_summary_snapshots AS snapshot
           LEFT JOIN orchestration_proof_summary_revocations AS revocation
             ON revocation.snapshot_id = snapshot.snapshot_id
           WHERE snapshot.snapshot_id = ?
              OR (
                snapshot.project_id = ?
                AND snapshot.deployment_receipt_id = ?
                AND snapshot.revision_hash = ?
              )
           LIMIT 1`,
        )
        .get(
          parsed.snapshotId,
          parsed.projectId,
          parsed.deploymentReceiptId,
          parsed.revisionHash,
        ) as Row | undefined;
      if (existing) {
        const snapshot = this.#rowToProofSummarySnapshot(existing);
        if (!sameProofSummarySnapshotInput(snapshot, parsed)) {
          throw new ProofSummarySnapshotConflictError(parsed.snapshotId);
        }
        return { snapshot, created: false };
      }

      const createdAt = this.#timestamp();
      const encrypted = this.#encryptProofSummarySnapshot(parsed, createdAt);
      this.#database
        .prepare(
          `INSERT INTO orchestration_proof_summary_snapshots(
            snapshot_id,
            project_id,
            deployment_receipt_id,
            revision_hash,
            snapshot_digest,
            created_at,
            encryption_nonce,
            encryption_tag,
            encrypted_snapshot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.snapshotId,
          parsed.projectId,
          parsed.deploymentReceiptId,
          parsed.revisionHash,
          parsed.snapshotDigest,
          createdAt,
          encrypted.nonce,
          encrypted.tag,
          encrypted.ciphertext,
        );
      return {
        snapshot: {
          ...parsed,
          createdAt,
        },
        created: true,
      };
    });
  }

  getProofSummarySnapshot(
    snapshotId: string,
  ): ProofSummarySnapshot | undefined {
    const parsedSnapshotId = OrchestrationIdSchema.parse(snapshotId);
    const row = this.#database
      .prepare(
        `SELECT snapshot.*, revocation.reason AS revocation_reason,
                revocation.revoked_at
         FROM orchestration_proof_summary_snapshots AS snapshot
         LEFT JOIN orchestration_proof_summary_revocations AS revocation
           ON revocation.snapshot_id = snapshot.snapshot_id
         WHERE snapshot.snapshot_id = ?`,
      )
      .get(parsedSnapshotId) as Row | undefined;
    return row ? this.#rowToProofSummarySnapshot(row) : undefined;
  }

  revokeProofSummarySnapshot(
    snapshotId: string,
    reason: NonNullable<ProofSummarySnapshot["revocationReason"]>,
  ): ProofSummarySnapshotRevocationResult {
    const parsedSnapshotId = OrchestrationIdSchema.parse(snapshotId);
    const parsedReason = parseProofSummaryRevocationReason(reason);
    return this.#transaction(() => {
      const snapshot = this.#database
        .prepare(
          `SELECT snapshot_id
           FROM orchestration_proof_summary_snapshots
           WHERE snapshot_id = ?`,
        )
        .get(parsedSnapshotId) as Row | undefined;
      if (!snapshot) {
        throw new ProofSummarySnapshotNotFoundError();
      }
      const existing = this.#database
        .prepare(
          `SELECT reason, revoked_at
           FROM orchestration_proof_summary_revocations
           WHERE snapshot_id = ?`,
        )
        .get(parsedSnapshotId) as Row | undefined;
      if (existing) {
        if (stringColumn(existing.reason, "reason") !== parsedReason) {
          throw new ProofSummarySnapshotRevocationConflictError();
        }
        return {
          revoked: false,
          revokedAt: stringColumn(existing.revoked_at, "revoked_at"),
        };
      }
      const revokedAt = this.#timestamp();
      this.#database
        .prepare(
          `INSERT INTO orchestration_proof_summary_revocations(
            snapshot_id,
            reason,
            revoked_at
          ) VALUES (?, ?, ?)`,
        )
        .run(parsedSnapshotId, parsedReason, revokedAt);
      return { revoked: true, revokedAt };
    });
  }

  saveProject(
    project: ProjectAggregate,
    expectedRevision: number,
    event: ProjectEventInput,
    inbox?: VerifiedInboxEvent,
    customerDashboardLogin?: CustomerDashboardLoginConsumption,
  ): ProjectAggregate {
    const parsed = ProjectAggregateSchema.parse(project);
    const parsedEvent = ProjectEventInputSchema.parse(event);
    const parsedInbox = inbox ? parseVerifiedInboxEvent(inbox) : undefined;
    const parsedCustomerDashboardLogin = customerDashboardLogin
      ? {
          tokenDigest: OrchestrationSha256Schema.parse(
            customerDashboardLogin.tokenDigest,
          ),
          projectId: OrchestrationIdSchema.parse(
            customerDashboardLogin.projectId,
          ),
          expiresAt: TimestampSchema.parse(customerDashboardLogin.expiresAt),
        }
      : undefined;
    if (
      parsedCustomerDashboardLogin &&
      parsedCustomerDashboardLogin.projectId !== parsed.projectId
    ) {
      throw new TypeError(
        "Customer dashboard login must belong to the saved project",
      );
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError(
        "expectedRevision must be a non-negative safe integer",
      );
    }
    if (parsed.revision !== expectedRevision) {
      throw new InvalidAggregateRevisionError(
        parsed.projectId,
        parsed.revision,
        expectedRevision,
      );
    }

    return this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
           FROM orchestration_projects
           WHERE project_id = ?`,
        )
        .get(parsed.projectId) as Row | undefined;
      if (!row) {
        throw new ProjectNotFoundError(parsed.projectId);
      }

      if (
        parsedCustomerDashboardLogin &&
        !this.consumeCustomerDashboardLogin(
          parsedCustomerDashboardLogin.tokenDigest,
          parsedCustomerDashboardLogin.projectId,
          parsedCustomerDashboardLogin.expiresAt,
        )
      ) {
        throw new CustomerDashboardLoginConflictError();
      }
      if (parsedInbox && !this.#recordInboxInCurrentTransaction(parsedInbox)) {
        if (parsedCustomerDashboardLogin) {
          throw new CustomerDashboardLoginConflictError();
        }
        return this.#rowToProject(row);
      }

      const currentIndex = rowToProjectIndex(row);
      if (currentIndex.revision !== expectedRevision) {
        throw new OptimisticConcurrencyError(
          parsed.projectId,
          expectedRevision,
          currentIndex.revision,
        );
      }

      const timestamp = this.#timestamp();
      const next = ProjectAggregateSchema.parse({
        ...parsed,
        revision: expectedRevision + 1,
        createdAt: currentIndex.createdAt,
        updatedAt: timestamp,
      });
      const nextIndex: ProjectIndex = {
        ...currentIndex,
        status: next.status,
        revision: next.revision,
        updatedAt: next.updatedAt,
      };
      const encrypted = this.#encrypt(next, nextIndex);

      const result = this.#database
        .prepare(
          `UPDATE orchestration_projects
           SET status = ?,
               revision = ?,
               updated_at = ?,
               has_pending_dashboard_login = ?,
               encryption_nonce = ?,
               encryption_tag = ?,
               encrypted_aggregate = ?
           WHERE project_id = ? AND revision = ?`,
        )
        .run(
          nextIndex.status,
          nextIndex.revision,
          nextIndex.updatedAt,
          hasPendingDashboardLoginEffect(next) ? 1 : 0,
          encrypted.nonce,
          encrypted.tag,
          encrypted.ciphertext,
          nextIndex.projectId,
          expectedRevision,
        );
      if (result.changes !== 1) {
        const current = this.#database
          .prepare(
            "SELECT revision FROM orchestration_projects WHERE project_id = ?",
          )
          .get(parsed.projectId) as Row | undefined;
        if (!current) {
          throw new ProjectNotFoundError(parsed.projectId);
        }
        throw new OptimisticConcurrencyError(
          parsed.projectId,
          expectedRevision,
          numberColumn(current.revision, "revision"),
        );
      }

      this.#appendEvent(next.projectId, next.revision, parsedEvent, timestamp);
      return next;
    });
  }

  recordInbox(provider: string, eventId: string, digest: string): boolean {
    const parsed = parseVerifiedInboxEvent({ provider, eventId, digest });

    return this.#transaction(() =>
      this.#recordInboxInCurrentTransaction(parsed),
    );
  }

  consumeCustomerDashboardLogin(
    tokenDigest: string,
    projectId: string,
    expiresAt: string,
  ): boolean {
    const parsedDigest = OrchestrationSha256Schema.parse(tokenDigest);
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    const parsedExpiresAt = TimestampSchema.parse(expiresAt);
    const consumedAt = this.#timestamp();
    if (Date.parse(parsedExpiresAt) <= Date.parse(consumedAt)) {
      return false;
    }
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO orchestration_customer_dashboard_logins(
          token_digest,
          project_id,
          expires_at,
          consumed_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(parsedDigest, parsedProjectId, parsedExpiresAt, consumedAt);
    return result.changes === 1;
  }

  hasConsumedCustomerDashboardLogin(
    tokenDigest: string,
    projectId: string,
  ): boolean {
    const parsedDigest = OrchestrationSha256Schema.parse(tokenDigest);
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    return Boolean(
      this.#database
        .prepare(
          `SELECT 1 AS present
           FROM orchestration_customer_dashboard_logins
           WHERE token_digest = ? AND project_id = ?`,
        )
        .get(parsedDigest, parsedProjectId),
    );
  }

  recordWebhookSecurityFailure(
    input: WebhookSecurityFailureInput,
  ): WebhookSecurityFailureRecordResult {
    const parsed = parseWebhookSecurityFailure(input);
    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT 1 AS present
           FROM orchestration_webhook_security_audit
           WHERE provider = ?
             AND body_digest = ?
             AND header_digest = ?
             AND failure_code = ?`,
        )
        .get(
          parsed.provider,
          parsed.bodyDigest,
          parsed.headerDigest,
          parsed.failureCode,
        ) as Row | undefined;
      if (existing) {
        return { outcome: "duplicate" };
      }

      const retained = this.#database
        .prepare(
          `SELECT COUNT(*) AS receipt_count
           FROM orchestration_webhook_security_audit`,
        )
        .get() as Row;
      const receiptCount = nonnegativeInteger(
        retained.receipt_count,
        "receipt_count",
      );
      const observedAt = this.#timestamp();
      if (receiptCount < this.#securityAuditReceiptLimit) {
        this.#database
          .prepare(
            `INSERT INTO orchestration_webhook_security_audit(
              provider,
              body_digest,
              header_digest,
              failure_code,
              observed_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.provider,
            parsed.bodyDigest,
            parsed.headerDigest,
            parsed.failureCode,
            observedAt,
          );
        return { outcome: "recorded" };
      }

      this.#database
        .prepare(
          `INSERT INTO orchestration_webhook_security_audit_overflow(
            provider,
            failure_code,
            observation_count,
            first_observed_at,
            last_observed_at
          ) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(provider, failure_code) DO UPDATE SET
            observation_count = MIN(
              observation_count + 1,
              ${MAX_SECURITY_AUDIT_OVERFLOW_OBSERVATIONS_PER_GROUP}
            ),
            last_observed_at = MAX(last_observed_at, excluded.last_observed_at)`,
        )
        .run(parsed.provider, parsed.failureCode, observedAt, observedAt);
      return { outcome: "overflow_summarized" };
    });
  }

  summarizeWebhookSecurityFailures(): WebhookSecurityFailureSummary {
    const receiptRows = this.#database
      .prepare(
        `SELECT
           provider,
           failure_code,
           COUNT(*) AS receipt_count,
           MIN(observed_at) AS first_observed_at,
           MAX(observed_at) AS last_observed_at
         FROM orchestration_webhook_security_audit
         GROUP BY provider, failure_code`,
      )
      .all() as Row[];
    const overflowRows = this.#database
      .prepare(
        `SELECT
           provider,
           failure_code,
           observation_count,
           first_observed_at,
           last_observed_at
         FROM orchestration_webhook_security_audit_overflow`,
      )
      .all() as Row[];
    const groups = new Map<string, WebhookSecurityFailureSummaryGroup>();

    for (const row of receiptRows) {
      const provider = parseWebhookSecurityAuditProvider(
        stringColumn(row.provider, "provider"),
      );
      const failureCode = parseWebhookSecurityFailureCode(
        stringColumn(row.failure_code, "failure_code"),
      );
      groups.set(webhookSecurityGroupKey(provider, failureCode), {
        provider,
        failureCode,
        retainedReceiptCount: nonnegativeInteger(
          row.receipt_count,
          "receipt_count",
        ),
        overflowObservationCount: 0,
        firstObservedAt: parseStoredTimestamp(
          stringColumn(row.first_observed_at, "first_observed_at"),
          "first_observed_at",
        ),
        lastObservedAt: parseStoredTimestamp(
          stringColumn(row.last_observed_at, "last_observed_at"),
          "last_observed_at",
        ),
      });
    }

    for (const row of overflowRows) {
      const provider = parseWebhookSecurityAuditProvider(
        stringColumn(row.provider, "provider"),
      );
      const failureCode = parseWebhookSecurityFailureCode(
        stringColumn(row.failure_code, "failure_code"),
      );
      const key = webhookSecurityGroupKey(provider, failureCode);
      const firstObservedAt = parseStoredTimestamp(
        stringColumn(row.first_observed_at, "first_observed_at"),
        "first_observed_at",
      );
      const lastObservedAt = parseStoredTimestamp(
        stringColumn(row.last_observed_at, "last_observed_at"),
        "last_observed_at",
      );
      const existing = groups.get(key);
      groups.set(key, {
        provider,
        failureCode,
        retainedReceiptCount: existing?.retainedReceiptCount ?? 0,
        overflowObservationCount: nonnegativeInteger(
          row.observation_count,
          "observation_count",
        ),
        firstObservedAt:
          existing && existing.firstObservedAt < firstObservedAt
            ? existing.firstObservedAt
            : firstObservedAt,
        lastObservedAt:
          existing && existing.lastObservedAt > lastObservedAt
            ? existing.lastObservedAt
            : lastObservedAt,
      });
    }

    const sortedGroups = [...groups.values()].sort((left, right) =>
      webhookSecurityGroupKey(left.provider, left.failureCode).localeCompare(
        webhookSecurityGroupKey(right.provider, right.failureCode),
      ),
    );
    return {
      receiptLimit: this.#securityAuditReceiptLimit,
      retainedReceiptCount: sortedGroups.reduce(
        (total, group) => total + group.retainedReceiptCount,
        0,
      ),
      overflowObservationCount: sortedGroups.reduce(
        (total, group) => total + group.overflowObservationCount,
        0,
      ),
      groups: sortedGroups,
    };
  }

  hasVerifiedInboxEvent(
    provider: string,
    eventId: string,
    digest: string,
  ): boolean {
    const parsed = parseVerifiedInboxEvent({ provider, eventId, digest });
    const row = this.#database
      .prepare(
        `SELECT payload_digest
         FROM orchestration_webhook_inbox
         WHERE provider = ? AND event_id = ?`,
      )
      .get(parsed.provider, parsed.eventId) as Row | undefined;
    if (!row) {
      return false;
    }
    if (stringColumn(row.payload_digest, "payload_digest") !== parsed.digest) {
      throw new InboxConflictError(parsed.provider, parsed.eventId);
    }
    return true;
  }

  stageInboundMailEnvelope(
    input: InboundMailEnvelopeInput,
  ): InboundMailEnvelope {
    const parsed = parseInboundMailEnvelopeInput(input);
    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT *
           FROM orchestration_inbound_mail_envelopes
           WHERE provider = ? AND event_id = ?`,
        )
        .get(parsed.provider, parsed.eventId) as Row | undefined;
      if (existing) {
        const envelope = rowToInboundMailEnvelope(existing);
        if (!sameInboundMailEnvelopeIdentity(envelope, parsed)) {
          throw new InboundMailEnvelopeConflictError(parsed.eventId);
        }
        return envelope;
      }

      const project = this.#database
        .prepare(
          `SELECT project_id
           FROM orchestration_projects
           WHERE project_id = ?`,
        )
        .get(parsed.projectId) as Row | undefined;
      if (!project) {
        throw new ProjectNotFoundError(parsed.projectId);
      }

      const updatedAt = this.#timestamp();
      this.#database
        .prepare(
          `INSERT INTO orchestration_inbound_mail_envelopes(
            provider,
            event_id,
            event_digest,
            project_id,
            email_id,
            identity_digest,
            status,
            attempts,
            next_attempt_at,
            last_error_code,
            received_at,
            updated_at,
            processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL)`,
        )
        .run(
          parsed.provider,
          parsed.eventId,
          parsed.eventDigest,
          parsed.projectId,
          parsed.emailId,
          parsed.identityDigest,
          parsed.receivedAt,
          updatedAt,
        );
      return {
        ...parsed,
        status: "pending",
        attempts: 0,
        updatedAt,
      };
    });
  }

  claimPendingInboundMailEnvelopes(
    projectId: string,
    readyAt: string,
    leaseUntil: string,
    limit: number,
  ): InboundMailEnvelope[] {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    const parsedReadyAt = parseTimestamp(readyAt, "readyAt");
    const parsedLeaseUntil = parseTimestamp(leaseUntil, "leaseUntil");
    if (Date.parse(parsedLeaseUntil) <= Date.parse(parsedReadyAt)) {
      throw new RangeError("Inbound mail claim lease must end after readyAt");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Inbound mail claim limit must be from 1 to 100");
    }

    return this.#transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT *
           FROM orchestration_inbound_mail_envelopes
           WHERE project_id = ?
             AND status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY received_at, event_id
           LIMIT ?`,
        )
        .all(parsedProjectId, parsedReadyAt, limit) as Row[];
      const claimed: InboundMailEnvelope[] = [];
      for (const row of rows) {
        const envelope = rowToInboundMailEnvelope(row);
        const result = this.#database
          .prepare(
            `UPDATE orchestration_inbound_mail_envelopes
             SET attempts = attempts + 1,
                 next_attempt_at = ?,
                 updated_at = ?
             WHERE provider = ?
               AND event_id = ?
               AND status = 'pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
          )
          .run(
            parsedLeaseUntil,
            parsedReadyAt,
            envelope.provider,
            envelope.eventId,
            parsedReadyAt,
          );
        if (result.changes === 1) {
          claimed.push({
            ...envelope,
            attempts: envelope.attempts + 1,
            nextAttemptAt: parsedLeaseUntil,
            updatedAt: parsedReadyAt,
          });
        }
      }
      return claimed;
    });
  }

  completeInboundMailEnvelope(
    provider: "resend",
    eventId: string,
    eventDigest: string,
    processedAt: string,
  ): void {
    const identity = parseVerifiedInboxEvent({
      provider,
      eventId,
      digest: eventDigest,
    });
    const parsedProcessedAt = parseTimestamp(processedAt, "processedAt");
    this.#transaction(() => {
      const row = this.#requireInboundMailEnvelope(
        identity.provider,
        identity.eventId,
      );
      const envelope = rowToInboundMailEnvelope(row);
      if (envelope.eventDigest !== identity.digest) {
        throw new InboundMailEnvelopeConflictError(identity.eventId);
      }
      if (envelope.status === "processed") {
        return;
      }
      this.#database
        .prepare(
          `UPDATE orchestration_inbound_mail_envelopes
           SET status = 'processed',
               next_attempt_at = NULL,
               last_error_code = NULL,
               updated_at = ?,
               processed_at = ?
           WHERE provider = ? AND event_id = ?`,
        )
        .run(
          parsedProcessedAt,
          parsedProcessedAt,
          identity.provider,
          identity.eventId,
        );
    });
  }

  recordInboundMailEnvelopeFailure(failure: InboundMailEnvelopeFailure): void {
    const identity = parseVerifiedInboxEvent({
      provider: failure.provider,
      eventId: failure.eventId,
      digest: failure.eventDigest,
    });
    const failedAt = parseTimestamp(failure.failedAt, "failedAt");
    const errorCode = parseSafeErrorCode(failure.errorCode);
    const nextAttemptAt =
      failure.nextAttemptAt === undefined
        ? undefined
        : parseTimestamp(failure.nextAttemptAt, "nextAttemptAt");
    if (failure.retryable !== (nextAttemptAt !== undefined)) {
      throw new TypeError(
        "A retryable inbound mail failure requires exactly one nextAttemptAt",
      );
    }
    if (
      failure.retryable === (failure.terminalStatus !== undefined) ||
      (failure.terminalStatus !== undefined &&
        !["rejected", "failed"].includes(failure.terminalStatus))
    ) {
      throw new TypeError(
        "A terminal inbound mail failure requires a valid terminalStatus",
      );
    }
    this.#transaction(() => {
      const row = this.#requireInboundMailEnvelope(
        identity.provider,
        identity.eventId,
      );
      const envelope = rowToInboundMailEnvelope(row);
      if (envelope.eventDigest !== identity.digest) {
        throw new InboundMailEnvelopeConflictError(identity.eventId);
      }
      if (envelope.status === "processed") {
        return;
      }
      this.#database
        .prepare(
          `UPDATE orchestration_inbound_mail_envelopes
           SET status = ?,
               next_attempt_at = ?,
               last_error_code = ?,
               updated_at = ?
           WHERE provider = ? AND event_id = ?`,
        )
        .run(
          failure.retryable ? "pending" : failure.terminalStatus!,
          nextAttemptAt ?? null,
          errorCode,
          failedAt,
          identity.provider,
          identity.eventId,
        );
    });
  }

  listInboundMailEnvelopes(
    projectId: string,
    limit = 100,
  ): InboundMailEnvelope[] {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Inbound mail list limit must be from 1 to 1000");
    }
    const rows = this.#database
      .prepare(
        `SELECT *
         FROM orchestration_inbound_mail_envelopes
         WHERE project_id = ?
         ORDER BY received_at, event_id
         LIMIT ?`,
      )
      .all(parsedProjectId, limit) as Row[];
    return rows.map(rowToInboundMailEnvelope);
  }

  hasUnresolvedInboundMailEnvelope(projectId: string): boolean {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    const row = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM orchestration_inbound_mail_envelopes
         WHERE project_id = ?
           AND status IN ('pending', 'failed')
         LIMIT 1`,
      )
      .get(parsedProjectId) as Row | undefined;
    return row !== undefined;
  }

  resolveInboundMailEnvelope(
    projectId: string,
    eventId: string,
    resolution: "retry" | "discard",
    resolvedAt: string,
  ): void {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    const parsedEventId = OrchestrationIdSchema.parse(eventId);
    const parsedResolvedAt = parseTimestamp(resolvedAt, "resolvedAt");
    if (resolution !== "retry" && resolution !== "discard") {
      throw new TypeError("Invalid inbound mail envelope resolution");
    }
    this.#transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
           FROM orchestration_inbound_mail_envelopes
           WHERE project_id = ? AND event_id = ?`,
        )
        .get(parsedProjectId, parsedEventId) as Row | undefined;
      if (!row) {
        throw new Error("Inbound mail envelope is missing");
      }
      const envelope = rowToInboundMailEnvelope(row);
      if (envelope.status === "processed" || envelope.status === "rejected") {
        return;
      }
      this.#database
        .prepare(
          `UPDATE orchestration_inbound_mail_envelopes
           SET status = ?,
               next_attempt_at = NULL,
               last_error_code = ?,
               updated_at = ?,
               processed_at = ?
           WHERE project_id = ? AND event_id = ?`,
        )
        .run(
          resolution === "retry" ? "pending" : "rejected",
          resolution === "retry" ? null : "inbound_mail.operator_discarded",
          parsedResolvedAt,
          resolution === "retry" ? null : parsedResolvedAt,
          parsedProjectId,
          parsedEventId,
        );
    });
  }

  listProjectIdsForReconciliation(
    limit: number,
    afterProjectId?: string,
  ): ReconciliationProjectPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError(
        "Reconciliation page limit must be an integer from 1 to 1000",
      );
    }
    const cursor =
      afterProjectId === undefined
        ? ""
        : OrchestrationIdSchema.parse(afterProjectId);
    const placeholders = RECONCILABLE_PROJECT_STATUSES.map(() => "?").join(
      ", ",
    );
    const rows = this.#database
      .prepare(
        `SELECT project_id
         FROM orchestration_projects AS project
         WHERE (
           project.status IN (${placeholders})
           OR project.has_pending_dashboard_login = 1
           OR EXISTS (
             SELECT 1
             FROM orchestration_inbound_mail_envelopes AS envelope
             WHERE envelope.project_id = project.project_id
               AND envelope.status IN ('pending', 'failed')
           )
         )
           AND project.project_id > ?
         ORDER BY project.project_id
         LIMIT ?`,
      )
      .all(...RECONCILABLE_PROJECT_STATUSES, cursor, limit) as Row[];
    const projectIds = rows.map((row) =>
      OrchestrationIdSchema.parse(stringColumn(row.project_id, "project_id")),
    );
    return {
      projectIds,
      ...(projectIds.length === limit
        ? { nextAfterProjectId: projectIds.at(-1)! }
        : {}),
    };
  }

  listEvents(
    projectId: string,
    afterSequence = 0,
    limit?: number,
  ): ProjectEvent[] {
    const parsedProjectId = OrchestrationIdSchema.parse(projectId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative safe integer");
    }
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    ) {
      throw new TypeError("limit must be a safe integer between 1 and 10000");
    }
    const rows = this.#database
      .prepare(
        `SELECT
           sequence,
           event_id,
           project_id,
           aggregate_revision,
           event_type,
           actor,
           payload_json,
           occurred_at
         FROM orchestration_events
         WHERE project_id = ? AND sequence > ?
         ORDER BY sequence
         ${limit === undefined ? "" : "LIMIT ?"}`,
      )
      .all(
        parsedProjectId,
        afterSequence,
        ...(limit === undefined ? [] : [limit]),
      ) as Row[];

    return rows.map((row) =>
      ProjectEventSchema.parse({
        eventId: stringColumn(row.event_id, "event_id"),
        sequence: numberColumn(row.sequence, "sequence"),
        projectId: stringColumn(row.project_id, "project_id"),
        aggregateRevision: numberColumn(
          row.aggregate_revision,
          "aggregate_revision",
        ),
        type: stringColumn(row.event_type, "event_type"),
        actor: stringColumn(row.actor, "actor"),
        payload: parseJsonColumn(row.payload_json, "payload_json"),
        occurredAt: stringColumn(row.occurred_at, "occurred_at"),
      }),
    );
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#database.close();
    this.#closed = true;
    this.#encryptionKey.fill(0);
  }

  #appendEvent(
    projectId: string,
    aggregateRevision: number,
    input: ProjectEventInput,
    occurredAt: string,
  ): void {
    const event = ProjectEventInputSchema.parse(input);
    this.#database
      .prepare(
        `INSERT INTO orchestration_events(
          event_id,
          project_id,
          aggregate_revision,
          event_type,
          actor,
          payload_json,
          occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        projectId,
        aggregateRevision,
        event.type,
        event.actor,
        canonicalJson(event.payload),
        occurredAt,
      );
  }

  #recordInboxInCurrentTransaction(inbox: VerifiedInboxEvent): boolean {
    const existing = this.#database
      .prepare(
        `SELECT payload_digest
         FROM orchestration_webhook_inbox
         WHERE provider = ? AND event_id = ?`,
      )
      .get(inbox.provider, inbox.eventId) as Row | undefined;
    if (existing) {
      if (
        stringColumn(existing.payload_digest, "payload_digest") !== inbox.digest
      ) {
        throw new InboxConflictError(inbox.provider, inbox.eventId);
      }
      return false;
    }

    this.#database
      .prepare(
        `INSERT INTO orchestration_webhook_inbox(
          provider,
          event_id,
          payload_digest,
          received_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(inbox.provider, inbox.eventId, inbox.digest, this.#timestamp());
    return true;
  }

  #requireInboundMailEnvelope(provider: string, eventId: string): Row {
    const row = this.#database
      .prepare(
        `SELECT *
         FROM orchestration_inbound_mail_envelopes
         WHERE provider = ? AND event_id = ?`,
      )
      .get(provider, eventId) as Row | undefined;
    if (!row) {
      throw new Error("Inbound mail envelope is missing");
    }
    return row;
  }

  #encrypt(project: ProjectAggregate, index: ProjectIndex): EncryptedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(Buffer.from(indexAad(index), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(canonicalJson(project), "utf8"),
      cipher.final(),
    ]);
    return {
      nonce,
      tag: cipher.getAuthTag(),
      ciphertext,
    };
  }

  #encryptProofSummarySnapshot(
    snapshot: ProofSummarySnapshotInput,
    createdAt: string,
  ): EncryptedValue {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(
      Buffer.from(proofSummarySnapshotAad(snapshot, createdAt), "utf8"),
    );
    const ciphertext = Buffer.concat([
      cipher.update(snapshot.canonicalSnapshot, "utf8"),
      cipher.final(),
    ]);
    return {
      nonce,
      tag: cipher.getAuthTag(),
      ciphertext,
    };
  }

  #rowToProofSummarySnapshot(row: Row): ProofSummarySnapshot {
    const index = proofSummarySnapshotIndexFromRow(row);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#encryptionKey,
        bufferColumn(row.encryption_nonce, "encryption_nonce"),
      );
      decipher.setAAD(
        Buffer.from(proofSummarySnapshotAad(index, index.createdAt), "utf8"),
      );
      decipher.setAuthTag(bufferColumn(row.encryption_tag, "encryption_tag"));
      const canonicalSnapshot = Buffer.concat([
        decipher.update(
          bufferColumn(row.encrypted_snapshot, "encrypted_snapshot"),
        ),
        decipher.final(),
      ]).toString("utf8");
      if (
        Buffer.byteLength(canonicalSnapshot) >
          MAX_PROOF_SUMMARY_SNAPSHOT_BYTES ||
        sha256(canonicalSnapshot) !== index.snapshotDigest ||
        canonicalJson(JSON.parse(canonicalSnapshot) as unknown) !==
          canonicalSnapshot
      ) {
        throw new Error(
          "Decrypted proof summary does not match its authenticated digest",
        );
      }
      const revocationReason =
        row.revocation_reason === null
          ? undefined
          : parseProofSummaryRevocationReason(
              stringColumn(row.revocation_reason, "revocation_reason"),
            );
      const revokedAt =
        row.revoked_at === null
          ? undefined
          : stringColumn(row.revoked_at, "revoked_at");
      return {
        snapshotId: index.snapshotId,
        projectId: index.projectId,
        deploymentReceiptId: index.deploymentReceiptId,
        revisionHash: index.revisionHash,
        snapshotDigest: index.snapshotDigest,
        canonicalSnapshot,
        createdAt: index.createdAt,
        ...(revocationReason ? { revocationReason } : {}),
        ...(revokedAt ? { revokedAt } : {}),
      };
    } catch (error) {
      throw new ProofSummarySnapshotDecryptionError(index.snapshotId, {
        cause: error,
      });
    }
  }

  #rowToProject(row: Row): ProjectAggregate {
    const index = rowToProjectIndex(row);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#encryptionKey,
        bufferColumn(row.encryption_nonce, "encryption_nonce"),
      );
      decipher.setAAD(Buffer.from(indexAad(index), "utf8"));
      decipher.setAuthTag(bufferColumn(row.encryption_tag, "encryption_tag"));
      const plaintext = Buffer.concat([
        decipher.update(
          bufferColumn(row.encrypted_aggregate, "encrypted_aggregate"),
        ),
        decipher.final(),
      ]).toString("utf8");
      const project = ProjectAggregateSchema.parse(JSON.parse(plaintext));
      if (
        project.projectId !== index.projectId ||
        project.status !== index.status ||
        project.revision !== index.revision ||
        project.createdAt !== index.createdAt ||
        project.updatedAt !== index.updatedAt
      ) {
        throw new Error(
          "Encrypted aggregate does not match its authenticated index",
        );
      }
      return project;
    } catch (error) {
      throw new AggregateDecryptionError(index.projectId, { cause: error });
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const rows = this.#database
      .prepare("SELECT version FROM orchestration_schema_migrations")
      .all() as Row[];
    const applied = new Set(
      rows.map((row) => numberColumn(row.version, "version")),
    );

    for (const migration of orchestrationMigrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.#transaction(() => {
        this.#database.exec(migration.sql);
        if (migration.version === 6) {
          this.#backfillPendingDashboardLoginIndex();
        }
        this.#database
          .prepare(
            `INSERT INTO orchestration_schema_migrations(
              version,
              name,
              applied_at
            ) VALUES (?, ?, ?)`,
          )
          .run(migration.version, migration.name, this.#timestamp());
      });
    }
  }

  #backfillPendingDashboardLoginIndex(): void {
    const rows = this.#database
      .prepare("SELECT * FROM orchestration_projects ORDER BY project_id")
      .all() as Row[];
    const update = this.#database.prepare(
      `UPDATE orchestration_projects
       SET has_pending_dashboard_login = ?
       WHERE project_id = ?`,
    );
    for (const row of rows) {
      const project = this.#rowToProject(row);
      update.run(
        hasPendingDashboardLoginEffect(project) ? 1 : 0,
        project.projectId,
      );
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
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
}

function parseVerifiedInboxEvent(
  inbox: VerifiedInboxEvent,
): VerifiedInboxEvent {
  return {
    provider: WebhookProviderSchema.parse(inbox.provider),
    eventId: OrchestrationIdSchema.parse(inbox.eventId),
    digest: OrchestrationSha256Schema.parse(inbox.digest),
  };
}

function parseSecurityAuditReceiptLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SECURITY_AUDIT_RECEIPT_LIMIT
  ) {
    throw new RangeError(
      `securityAuditReceiptLimit must be from 1 to ${MAX_SECURITY_AUDIT_RECEIPT_LIMIT}`,
    );
  }
  return value;
}

function parseWebhookSecurityFailure(
  input: WebhookSecurityFailureInput,
): WebhookSecurityFailureInput {
  return {
    provider: parseWebhookSecurityAuditProvider(input.provider),
    bodyDigest: OrchestrationSha256Schema.parse(input.bodyDigest),
    headerDigest: OrchestrationSha256Schema.parse(input.headerDigest),
    failureCode: parseWebhookSecurityFailureCode(input.failureCode),
  };
}

function parseWebhookSecurityAuditProvider(
  value: string,
): WebhookSecurityAuditProvider {
  if (
    !(WEBHOOK_SECURITY_AUDIT_PROVIDERS as readonly string[]).includes(value)
  ) {
    throw new TypeError("Invalid webhook security audit provider");
  }
  return value as WebhookSecurityAuditProvider;
}

function parseWebhookSecurityFailureCode(
  value: string,
): WebhookSecurityFailureCode {
  if (!(WEBHOOK_SECURITY_FAILURE_CODES as readonly string[]).includes(value)) {
    throw new TypeError("Invalid webhook security failure code");
  }
  return value as WebhookSecurityFailureCode;
}

function webhookSecurityGroupKey(
  provider: WebhookSecurityAuditProvider,
  failureCode: WebhookSecurityFailureCode,
): string {
  return `${provider}\u0000${failureCode}`;
}

function parseStoredTimestamp(value: string, name: string): string {
  if (
    value.length < 20 ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`Invalid webhook security audit timestamp: ${name}`);
  }
  return value;
}

function parseInboundMailEnvelopeInput(
  input: InboundMailEnvelopeInput,
): InboundMailEnvelopeInput {
  if (input.provider !== "resend") {
    throw new TypeError("Inbound mail envelope provider must be Resend");
  }
  return {
    provider: "resend",
    eventId: OrchestrationIdSchema.parse(input.eventId),
    eventDigest: OrchestrationSha256Schema.parse(input.eventDigest),
    projectId: OrchestrationIdSchema.parse(input.projectId),
    emailId: parseOpaqueEmailId(input.emailId),
    identityDigest: OrchestrationSha256Schema.parse(input.identityDigest),
    receivedAt: parseTimestamp(input.receivedAt, "receivedAt"),
  };
}

function sameInboundMailEnvelopeIdentity(
  envelope: InboundMailEnvelope,
  input: InboundMailEnvelopeInput,
): boolean {
  return (
    envelope.provider === input.provider &&
    envelope.eventId === input.eventId &&
    envelope.eventDigest === input.eventDigest &&
    envelope.projectId === input.projectId &&
    envelope.emailId === input.emailId &&
    envelope.identityDigest === input.identityDigest &&
    envelope.receivedAt === input.receivedAt
  );
}

function rowToInboundMailEnvelope(row: Row): InboundMailEnvelope {
  const nextAttemptAt = optionalStringColumn(
    row.next_attempt_at,
    "next_attempt_at",
  );
  const lastErrorCode = optionalStringColumn(
    row.last_error_code,
    "last_error_code",
  );
  const processedAt = optionalStringColumn(row.processed_at, "processed_at");
  const status = stringColumn(row.status, "status");
  if (!["pending", "processed", "rejected", "failed"].includes(status)) {
    throw new TypeError("Invalid inbound mail envelope status");
  }
  return {
    provider: "resend",
    eventId: OrchestrationIdSchema.parse(
      stringColumn(row.event_id, "event_id"),
    ),
    eventDigest: OrchestrationSha256Schema.parse(
      stringColumn(row.event_digest, "event_digest"),
    ),
    projectId: OrchestrationIdSchema.parse(
      stringColumn(row.project_id, "project_id"),
    ),
    emailId: parseOpaqueEmailId(stringColumn(row.email_id, "email_id")),
    identityDigest: OrchestrationSha256Schema.parse(
      stringColumn(row.identity_digest, "identity_digest"),
    ),
    status: status as InboundMailEnvelope["status"],
    attempts: nonnegativeInteger(row.attempts, "attempts"),
    ...(nextAttemptAt
      ? { nextAttemptAt: parseTimestamp(nextAttemptAt, "next_attempt_at") }
      : {}),
    ...(lastErrorCode
      ? { lastErrorCode: parseSafeErrorCode(lastErrorCode) }
      : {}),
    receivedAt: parseTimestamp(
      stringColumn(row.received_at, "received_at"),
      "received_at",
    ),
    updatedAt: parseTimestamp(
      stringColumn(row.updated_at, "updated_at"),
      "updated_at",
    ),
    ...(processedAt
      ? { processedAt: parseTimestamp(processedAt, "processed_at") }
      : {}),
  };
}

function parseOpaqueEmailId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError("Invalid opaque Resend email identifier");
  }
  return value;
}

function parseSafeErrorCode(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z][a-z0-9._-]*$/u.test(value)
  ) {
    throw new TypeError("Invalid inbound mail recovery error code");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }
  return false;
}

function parseTimestamp(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 64 ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`Invalid inbound mail timestamp: ${name}`);
  }
  return value;
}

interface ProofSummarySnapshotIndex {
  snapshotId: string;
  projectId: string;
  deploymentReceiptId: string;
  revisionHash: string;
  snapshotDigest: string;
  createdAt: string;
}

function parseProofSummarySnapshotInput(
  input: ProofSummarySnapshotInput,
): ProofSummarySnapshotInput {
  const canonicalSnapshot = input.canonicalSnapshot;
  if (
    typeof canonicalSnapshot !== "string" ||
    canonicalSnapshot.length === 0 ||
    Buffer.byteLength(canonicalSnapshot) > MAX_PROOF_SUMMARY_SNAPSHOT_BYTES
  ) {
    throw new TypeError("Proof summary snapshot exceeds its byte budget");
  }
  let parsedSnapshot: unknown;
  try {
    parsedSnapshot = JSON.parse(canonicalSnapshot) as unknown;
  } catch {
    throw new TypeError("Proof summary snapshot must be canonical JSON");
  }
  if (canonicalJson(parsedSnapshot) !== canonicalSnapshot) {
    throw new TypeError("Proof summary snapshot must use canonical JSON");
  }
  const snapshotDigest = OrchestrationSha256Schema.parse(input.snapshotDigest);
  if (sha256(canonicalSnapshot) !== snapshotDigest) {
    throw new TypeError("Proof summary snapshot digest does not match");
  }
  return {
    snapshotId: OrchestrationIdSchema.parse(input.snapshotId),
    projectId: OrchestrationIdSchema.parse(input.projectId),
    deploymentReceiptId: OrchestrationIdSchema.parse(input.deploymentReceiptId),
    revisionHash: OrchestrationSha256Schema.parse(input.revisionHash),
    snapshotDigest,
    canonicalSnapshot,
  };
}

function sameProofSummarySnapshotInput(
  snapshot: ProofSummarySnapshot,
  input: ProofSummarySnapshotInput,
): boolean {
  return (
    snapshot.snapshotId === input.snapshotId &&
    snapshot.projectId === input.projectId &&
    snapshot.deploymentReceiptId === input.deploymentReceiptId &&
    snapshot.revisionHash === input.revisionHash &&
    snapshot.snapshotDigest === input.snapshotDigest &&
    snapshot.canonicalSnapshot === input.canonicalSnapshot
  );
}

function proofSummarySnapshotIndexFromRow(row: Row): ProofSummarySnapshotIndex {
  return {
    snapshotId: OrchestrationIdSchema.parse(
      stringColumn(row.snapshot_id, "snapshot_id"),
    ),
    projectId: OrchestrationIdSchema.parse(
      stringColumn(row.project_id, "project_id"),
    ),
    deploymentReceiptId: OrchestrationIdSchema.parse(
      stringColumn(row.deployment_receipt_id, "deployment_receipt_id"),
    ),
    revisionHash: OrchestrationSha256Schema.parse(
      stringColumn(row.revision_hash, "revision_hash"),
    ),
    snapshotDigest: OrchestrationSha256Schema.parse(
      stringColumn(row.snapshot_digest, "snapshot_digest"),
    ),
    createdAt: parseTimestamp(
      stringColumn(row.created_at, "created_at"),
      "created_at",
    ),
  };
}

function proofSummarySnapshotAad(
  snapshot: Omit<ProofSummarySnapshotIndex, "createdAt">,
  createdAt: string,
): string {
  return canonicalJson({
    snapshotId: snapshot.snapshotId,
    projectId: snapshot.projectId,
    deploymentReceiptId: snapshot.deploymentReceiptId,
    revisionHash: snapshot.revisionHash,
    snapshotDigest: snapshot.snapshotDigest,
    createdAt,
  });
}

function parseProofSummaryRevocationReason(
  value: string,
): NonNullable<ProofSummarySnapshot["revocationReason"]> {
  if (
    !(PROOF_SUMMARY_REVOCATION_REASONS as readonly string[]).includes(value)
  ) {
    throw new TypeError("Invalid proof summary revocation reason");
  }
  return value as NonNullable<ProofSummarySnapshot["revocationReason"]>;
}

function rowToProjectIndex(row: Row): ProjectIndex {
  return {
    projectId: stringColumn(row.project_id, "project_id"),
    idempotencyKey: stringColumn(row.idempotency_key, "idempotency_key"),
    idempotencyDigest: stringColumn(
      row.idempotency_digest,
      "idempotency_digest",
    ),
    status: ProjectAggregateSchema.shape.status.parse(row.status),
    revision: numberColumn(row.revision, "revision"),
    createdAt: stringColumn(row.created_at, "created_at"),
    updatedAt: stringColumn(row.updated_at, "updated_at"),
  };
}

function indexAad(index: ProjectIndex): string {
  return canonicalJson(index);
}

function hasPendingDashboardLoginEffect(project: ProjectAggregate): boolean {
  return project.effects.some(
    (effect) =>
      effect.type === "send_dashboard_login" && effect.status === "pending",
  );
}

function stringColumn(value: RowValue | undefined, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected SQLite text column: ${name}`);
  }
  return value;
}

function numberColumn(value: RowValue | undefined, name: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`Expected SQLite integer column: ${name}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`SQLite integer column is not safe: ${name}`);
  }
  return number;
}

function nonnegativeInteger(value: RowValue | undefined, name: string): number {
  const parsed = numberColumn(value, name);
  if (parsed < 0) {
    throw new TypeError(`SQLite integer column is negative: ${name}`);
  }
  return parsed;
}

function optionalStringColumn(
  value: RowValue | undefined,
  name: string,
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return stringColumn(value, name);
}

function bufferColumn(value: RowValue | undefined, name: string): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Expected SQLite blob column: ${name}`);
  }
  return Buffer.from(value);
}

function parseJsonColumn(value: RowValue | undefined, name: string): unknown {
  return JSON.parse(stringColumn(value, name)) as unknown;
}
