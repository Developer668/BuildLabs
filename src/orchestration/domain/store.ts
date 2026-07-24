import type {
  CreateProjectInput,
  CreateProjectResult,
  ProjectAggregate,
  ProjectEvent,
  ProjectEventInput,
} from "./project.js";

export interface ReconciliationProjectPage {
  projectIds: string[];
  nextAfterProjectId?: string;
}

export interface VerifiedInboxEvent {
  provider: string;
  eventId: string;
  digest: string;
}

export interface CustomerDashboardLoginConsumption {
  tokenDigest: string;
  projectId: string;
  expiresAt: string;
}

export type WebhookSecurityAuditProvider = "resend" | "stripe";
export type WebhookSecurityFailureCode =
  "invalid_signature_headers" | "webhook_verification_failed";

/**
 * Content-free fingerprint of a rejected provider webhook. The caller hashes
 * the exact raw body and the complete signature-header tuple before crossing
 * this boundary; raw request bytes, header values, and customer identifiers
 * are never accepted by the store.
 */
export interface WebhookSecurityFailureInput {
  provider: WebhookSecurityAuditProvider;
  bodyDigest: string;
  headerDigest: string;
  failureCode: WebhookSecurityFailureCode;
}

export interface WebhookSecurityFailureRecordResult {
  outcome: "recorded" | "duplicate" | "overflow_summarized";
}

export interface WebhookSecurityFailureSummaryGroup {
  provider: WebhookSecurityAuditProvider;
  failureCode: WebhookSecurityFailureCode;
  retainedReceiptCount: number;
  overflowObservationCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface WebhookSecurityFailureSummary {
  receiptLimit: number;
  retainedReceiptCount: number;
  overflowObservationCount: number;
  groups: WebhookSecurityFailureSummaryGroup[];
}

export interface WebhookSecurityAuditStore {
  recordWebhookSecurityFailure(
    input: WebhookSecurityFailureInput,
  ): WebhookSecurityFailureRecordResult;
  summarizeWebhookSecurityFailures(): WebhookSecurityFailureSummary;
}

export interface ProofSummarySnapshotInput {
  snapshotId: string;
  projectId: string;
  deploymentReceiptId: string;
  revisionHash: string;
  snapshotDigest: string;
  canonicalSnapshot: string;
}

export interface ProofSummarySnapshot extends ProofSummarySnapshotInput {
  createdAt: string;
  revokedAt?: string;
  revocationReason?:
    | "operator_requested"
    | "capability_compromised"
    | "privacy_request"
    | "security_policy";
}

export interface ProofSummarySnapshotCreateResult {
  snapshot: ProofSummarySnapshot;
  created: boolean;
}

export interface ProofSummarySnapshotRevocationResult {
  revoked: boolean;
  revokedAt: string;
}

export interface ProofSummarySnapshotStore {
  createProofSummarySnapshot(
    input: ProofSummarySnapshotInput,
  ): ProofSummarySnapshotCreateResult;
  getProofSummarySnapshot(snapshotId: string): ProofSummarySnapshot | undefined;
  revokeProofSummarySnapshot(
    snapshotId: string,
    reason: NonNullable<ProofSummarySnapshot["revocationReason"]>,
  ): ProofSummarySnapshotRevocationResult;
}

/**
 * Minimal, non-content-bearing receipt for a signature-verified Resend inbound
 * notification. The opaque Resend email ID is retained only so enrichment can
 * be retried; sender, recipients, subject, message body, and raw webhook bytes
 * are deliberately excluded.
 */
export interface InboundMailEnvelopeInput {
  provider: "resend";
  eventId: string;
  eventDigest: string;
  projectId: string;
  emailId: string;
  identityDigest: string;
  receivedAt: string;
}

export interface InboundMailEnvelope extends InboundMailEnvelopeInput {
  status: "pending" | "processed" | "rejected" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
  processedAt?: string;
}

export interface InboundMailEnvelopeFailure {
  provider: "resend";
  eventId: string;
  eventDigest: string;
  errorCode: string;
  retryable: boolean;
  terminalStatus?: "rejected" | "failed";
  nextAttemptAt?: string;
  failedAt: string;
}

export interface InboundMailEnvelopeStore {
  stageInboundMailEnvelope(
    input: InboundMailEnvelopeInput,
  ): InboundMailEnvelope;
  claimPendingInboundMailEnvelopes(
    projectId: string,
    readyAt: string,
    leaseUntil: string,
    limit: number,
  ): InboundMailEnvelope[];
  completeInboundMailEnvelope(
    provider: "resend",
    eventId: string,
    eventDigest: string,
    processedAt: string,
  ): void;
  recordInboundMailEnvelopeFailure(failure: InboundMailEnvelopeFailure): void;
  listInboundMailEnvelopes(
    projectId: string,
    limit?: number,
  ): InboundMailEnvelope[];
  hasUnresolvedInboundMailEnvelope(projectId: string): boolean;
  resolveInboundMailEnvelope(
    projectId: string,
    eventId: string,
    resolution: "retry" | "discard",
    resolvedAt: string,
  ): void;
  hasVerifiedInboxEvent(
    provider: string,
    eventId: string,
    digest: string,
  ): boolean;
}

/**
 * Durable boundary used by the orchestration application engine.
 *
 * `saveProject` treats `expectedRevision` as a compare-and-set token. The
 * supplied project must still carry that revision; a successful save returns a
 * new aggregate with the revision incremented exactly once.
 *
 * `recordInbox` must be called only after the transport adapter verifies the
 * provider signature over the raw webhook body.
 */
export interface OrchestrationProjectStore
  extends
    InboundMailEnvelopeStore,
    WebhookSecurityAuditStore,
    ProofSummarySnapshotStore {
  createProject(input: CreateProjectInput): CreateProjectResult;
  getProject(projectId: string): ProjectAggregate | undefined;
  saveProject(
    project: ProjectAggregate,
    expectedRevision: number,
    event: ProjectEventInput,
    inbox?: VerifiedInboxEvent,
    customerDashboardLogin?: CustomerDashboardLoginConsumption,
  ): ProjectAggregate;
  recordInbox(provider: string, eventId: string, digest: string): boolean;
  /**
   * Atomically consumes a passwordless dashboard login capability after email
   * ownership verification succeeds. Only the capability digest is retained.
   */
  consumeCustomerDashboardLogin(
    tokenDigest: string,
    projectId: string,
    expiresAt: string,
  ): boolean;
  hasConsumedCustomerDashboardLogin(
    tokenDigest: string,
    projectId: string,
  ): boolean;
  /**
   * Lists only opaque project identifiers from the plaintext lifecycle index.
   * It never decrypts protected aggregates. The cursor is exclusive and pages
   * in stable project-id order so a bounded worker can wrap safely.
   */
  listProjectIdsForReconciliation(
    limit: number,
    afterProjectId?: string,
  ): ReconciliationProjectPage;
  listEvents(
    projectId: string,
    afterSequence?: number,
    limit?: number,
  ): ProjectEvent[];
  close(): void;
}
