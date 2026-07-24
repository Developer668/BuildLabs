import type { OutboxEvent, ProvenArtifact } from "../../domain/artifact.js";
import type { BuildAssignment } from "../../domain/contract.js";
import type {
  CustomerBuildObservation,
  CustomerBuildObservationQuery,
} from "../../domain/customer-observability.js";
import type { BuildRun } from "../../domain/run.js";

export interface BuildDispatchReceipt {
  created: boolean;
  run: BuildRun;
}

export interface BuildRunSnapshot {
  run: BuildRun;
  artifact: ProvenArtifact | null;
}

export interface ProvenEventPollRequest {
  limit?: number;
  projectId?: string;
  runIds?: string[];
  maxAttempts?: number;
  intervalMs?: number;
}

export const MIN_PROVEN_PREVIEW_TTL_SECONDS = 60;
export const MAX_PROVEN_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ProvenPreviewRequest {
  event: OutboxEvent;
  ttlSeconds: number;
  idempotencyKey: string;
}

export interface CustomerBuildObservationRequest extends CustomerBuildObservationQuery {
  runId: string;
}

export interface FrozenProvenPreview {
  kind: "frozen_proven_preview";
  eventId: string;
  runId: string;
  artifactId: string;
  revisionHash: string;
  artifactSha256: string;
  snapshotId: string;
  url: string;
  expiresAt: string;
}

/**
 * A capability issued only after a candidate.proven artifact has been
 * downloaded, size/hash checked, safely extracted, and tree-digested.
 */
export abstract class ValidatedProvenArtifact {
  protected constructor() {}

  abstract readonly eventId: string;
  abstract readonly runId: string;
  abstract readonly projectId: string;
  abstract readonly candidateId: string;
  abstract readonly contractHash: string;
  abstract readonly revisionHash: string;
  abstract readonly artifactId: string;
  abstract readonly sourceSha256: string;
  abstract readonly sourceSizeBytes: number;
  abstract readonly workspaceSha256: string;
  abstract readonly directory: string;

  abstract assertUsable(): void;
  abstract cleanup(): Promise<void>;
}

export interface BuildBackendPort {
  /**
   * Authenticates to the exact build backend and verifies its provider and
   * Daytona snapshot readiness contract.
   */
  health(signal?: AbortSignal): Promise<void>;
  dispatchBuild(
    assignment: BuildAssignment,
    signal?: AbortSignal,
  ): Promise<BuildDispatchReceipt>;
  cancelBuild(runId: string, signal?: AbortSignal): Promise<BuildRun>;
  getBuildRun(runId: string, signal?: AbortSignal): Promise<BuildRunSnapshot>;
  /**
   * Returns a deliberately minimized customer-facing progress view. The
   * contract has no raw logs, prompts, reasoning, sandbox identities, mutable
   * preview endpoints, or artifact contents.
   */
  getCustomerBuildObservation(
    request: CustomerBuildObservationRequest,
    signal?: AbortSignal,
  ): Promise<CustomerBuildObservation>;
  pollProvenEvents(
    request?: ProvenEventPollRequest,
    signal?: AbortSignal,
  ): Promise<OutboxEvent[]>;
  acknowledgeProvenEvent(eventId: string, signal?: AbortSignal): Promise<void>;
  getProvenPreview(
    request: ProvenPreviewRequest,
    signal?: AbortSignal,
  ): Promise<FrozenProvenPreview>;
  downloadProvenArtifact(
    event: OutboxEvent,
    signal?: AbortSignal,
  ): Promise<ValidatedProvenArtifact>;
}
