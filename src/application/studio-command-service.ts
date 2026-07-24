import { z } from "zod";

import { isTerminalStatus, type BuildRun } from "../domain/run.js";
import { sha256 } from "../lib/canonical-json.js";
import type {
  CancellationRequest,
  CancellationResult,
  RunStore,
} from "../ports/index.js";

const RunIdSchema = z.uuid();
const StudioCancellationContextSchema = z
  .object({
    source: z.enum(["elevenlabs_webhook", "studio_speech_engine"]),
    conversationId: z.string().min(1).max(256),
  })
  .strict();

export interface CandidateStatus {
  runId: string;
  projectId: string;
  candidateId: string;
  status: BuildRun["status"];
  stage: BuildRun["stage"];
  cancelRequested: boolean;
  previewAvailable: boolean;
  previewProbeAvailable: boolean;
  artifactAvailable: boolean;
  revisionHash?: string;
  updatedAt: string;
  completedAt?: string;
}

interface CancellationControl {
  cancel(runId: string, request: CancellationRequest): CancellationResult;
}

export interface StudioCancellationContext {
  source: "elevenlabs_webhook" | "studio_speech_engine";
  conversationId: string;
}

export class StudioCommandService {
  constructor(
    private readonly store: RunStore,
    private readonly scheduler: CancellationControl,
  ) {}

  getCandidate(runIdInput: string): CandidateStatus {
    const runId = RunIdSchema.parse(runIdInput);
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Build run ${runId} was not found`);
    }
    return {
      runId: run.id,
      projectId: run.projectId,
      candidateId: run.candidateId,
      status: run.status,
      stage: run.stage,
      cancelRequested: run.cancelRequested,
      previewAvailable: Boolean(
        run.status === "passed" && run.sandboxId && run.previewPort,
      ),
      previewProbeAvailable: Boolean(
        ["running", "passed"].includes(run.status) &&
        run.sandboxId &&
        run.previewPort,
      ),
      artifactAvailable: Boolean(this.store.getArtifact(run.id)),
      ...(run.revisionHash ? { revisionHash: run.revisionHash } : {}),
      updatedAt: run.updatedAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    };
  }

  getEvidenceSummary(runIdInput: string) {
    const candidate = this.getCandidate(runIdInput);
    const receipts = this.store.listEvidence(candidate.runId);
    const byStatus = { PASS: 0, FAIL: 0, ERROR: 0 };
    const byKind: Record<string, number> = {};
    for (const receipt of receipts) {
      byStatus[receipt.status] += 1;
      byKind[receipt.kind] = (byKind[receipt.kind] ?? 0) + 1;
    }
    return {
      runId: candidate.runId,
      revisionHash: candidate.revisionHash ?? null,
      receiptCount: receipts.length,
      byStatus,
      byKind,
      proven: candidate.status === "passed",
    };
  }

  cancelCandidate(
    runIdInput: string,
    expectedStatus: "queued" | "running",
    expectedUpdatedAt: string,
    contextInput: StudioCancellationContext,
  ) {
    const context = StudioCancellationContextSchema.parse(contextInput);
    const before = this.getCandidate(runIdInput);
    if (isTerminalStatus(before.status)) {
      return {
        changed: false,
        reason: "candidate_is_terminal",
        candidate: before,
      };
    }
    if (before.cancelRequested) {
      return {
        changed: false,
        reason: "cancellation_already_requested",
        candidate: before,
      };
    }
    if (
      before.status !== expectedStatus ||
      before.updatedAt !== expectedUpdatedAt
    ) {
      return {
        changed: false,
        reason: "candidate_state_changed",
        candidate: before,
      };
    }
    const cancellation = this.scheduler.cancel(before.runId, {
      source: context.source,
      reasonCode: "explicit_operator_cancellation",
      conversationCorrelationId: sha256(
        `studio-conversation:${context.conversationId}`,
      ),
      expected: {
        status: expectedStatus,
        updatedAt: expectedUpdatedAt,
      },
    });
    return {
      changed: cancellation.changed,
      reason: cancellation.reason,
      candidate: this.getCandidate(before.runId),
    };
  }
}
