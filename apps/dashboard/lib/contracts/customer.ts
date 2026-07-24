import { z } from "zod";

import {
  BatchAliasSchema,
  BuilderAliasSchema,
  EventAliasSchema,
  FrameAliasSchema,
  IsoTimestampSchema,
  ProjectAliasSchema,
  SafeHttpsUrlSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  parseCustomerSafe,
  safeTextSchema,
} from "./safety";

export const CustomerLifecycleSchema = z.enum([
  "intake_received",
  "needs_clarification",
  "researching",
  "proposal_drafting",
  "awaiting_customer_revision",
  "awaiting_payment",
  "payment_verification_failed",
  "paid",
  "building",
  "verifying",
  "no_proven_candidate",
  "preview_ready",
  "revision_pending",
  "deploying",
  "deployment_verification_failed",
  "delivering",
  "completed",
  "cancelled",
  "failed",
  "needs_operator_attention",
]);

export const CustomerActivityActionSchema = z.enum([
  "sandbox_provisioning",
  "files_listing",
  "file_reading",
  "file_writing",
  "command_running",
  "dependency_bootstrap",
  "build_running",
  "test_running",
  "operator_preview_starting",
  "revision_freezing",
  "command_verification",
  "delivery_verification",
  "code_review",
  "contract_evaluation",
  "claim_inspection",
  "repairing",
  "finalizing",
  "waiting",
]);

export const CustomerActivitySchema = z
  .object({
    activityId: z.string().regex(/^activity_[A-Za-z0-9_-]{1,96}$/),
    builderId: BuilderAliasSchema,
    step: z.number().int().nonnegative().nullable(),
    repairRound: z.number().int().nonnegative().max(100),
    action: CustomerActivityActionSchema,
    outcome: z.enum(["started", "succeeded", "failed"]),
    fileCount: z.number().int().nonnegative().max(10_000).nullable(),
    safeRelativePaths: z.array(SafeRelativePathSchema).max(10),
    diffStats: z
      .object({
        files: z.number().int().nonnegative().max(10_000),
        additions: z.number().int().nonnegative().max(10_000_000),
        deletions: z.number().int().nonnegative().max(10_000_000),
      })
      .strict()
      .nullable(),
    commandLabel: z
      .enum([
        "Configured build command",
        "Configured test command",
        "Controller requirement command",
        "Delivery image build",
      ])
      .nullable(),
    occurredAt: IsoTimestampSchema,
  })
  .strict();

export const CustomerWorkspaceSchema = z
  .object({
    state: z.enum([
      "unavailable",
      "starting",
      "live_unverified",
      "stale",
      "blocked",
      "ended",
    ]),
    customerRenderable: z.boolean(),
    latestFrameId: FrameAliasSchema.nullable(),
    capturedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const hasFrame =
      workspace.latestFrameId !== null && workspace.capturedAt !== null;
    const renderableState =
      workspace.state === "live_unverified" || workspace.state === "stale";
    if (
      workspace.customerRenderable !== (hasFrame && renderableState) ||
      (workspace.latestFrameId === null) !== (workspace.capturedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Renderable WIP requires one complete safe frame receipt",
      });
    }
  });

export const BuilderSchema = z
  .object({
    builderId: BuilderAliasSchema,
    displayName: z.string().regex(/^Builder [1-4]$/),
    allocation: z.enum(["allocated", "not_allocated"]),
    status: z.enum([
      "queued",
      "running",
      "passed",
      "rejected",
      "failed",
      "cancelled",
      "superseded",
      "awaiting_proven_event",
    ]),
    stage: z
      .enum([
        "queued",
        "provisioning",
        "generating",
        "verifying",
        "reviewing",
        "evaluating",
        "finalizing",
        "complete",
      ])
      .nullable(),
    progress: z
      .object({
        completedToolCalls: z.number().int().nonnegative().max(100_000),
        failedToolCalls: z.number().int().nonnegative().max(100_000),
        repairRound: z.number().int().nonnegative().max(100),
        proofReceiptCount: z.number().int().nonnegative().max(100_000),
      })
      .strict(),
    workspace: CustomerWorkspaceSchema,
    currentActivity: CustomerActivitySchema.nullable(),
    updatedAt: IsoTimestampSchema.nullable(),
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((builder, context) => {
    if (
      builder.currentActivity !== null &&
      builder.currentActivity.builderId !== builder.builderId
    ) {
      context.addIssue({
        code: "custom",
        message: "Activity must be bound to its builder",
      });
    }
    if (
      builder.allocation === "not_allocated" &&
      (builder.stage !== null ||
        builder.currentActivity !== null ||
        builder.workspace.customerRenderable ||
        builder.completedAt !== null ||
        builder.progress.completedToolCalls !== 0 ||
        builder.progress.failedToolCalls !== 0 ||
        builder.progress.repairRound !== 0 ||
        builder.progress.proofReceiptCount !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "An unallocated lane cannot report build activity",
      });
    }
  });

const MilestoneSchema = z
  .object({
    id: z.enum(["scope", "payment", "build", "proof", "preview", "production"]),
    state: z.enum([
      "not_started",
      "active",
      "complete",
      "blocked",
      "superseded",
    ]),
    receiptAt: IsoTimestampSchema.nullable(),
  })
  .strict();

const ContractSchema = z
  .object({
    version: z.number().int().positive(),
    title: safeTextSchema(500),
    summary: safeTextSchema(10_000),
    deliverables: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            text: safeTextSchema(5_000),
          })
          .strict(),
      )
      .max(500),
    requirements: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            text: safeTextSchema(5_000),
            priority: z.enum(["hard", "preference"]),
          })
          .strict(),
      )
      .max(500),
    unknowns: z.array(safeTextSchema(2_000)).max(100),
  })
  .strict();

const ActiveBatchSchema = z
  .object({
    batchId: BatchAliasSchema,
    contractVersion: z.number().int().positive(),
    state: z.enum([
      "pending",
      "dispatched",
      "building",
      "verifying",
      "completed",
      "failed",
      "cancelled",
      "superseded",
    ]),
    requestedBuilderCount: z.number().int().min(1).max(4),
    builders: z.array(BuilderSchema).length(4),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (
      new Set(batch.builders.map((builder) => builder.builderId)).size !== 4
    ) {
      context.addIssue({
        code: "custom",
        message: "Builder identifiers must be unique",
      });
    }
    const allocated = batch.builders.filter(
      (builder) => builder.allocation === "allocated",
    ).length;
    if (allocated > batch.requestedBuilderCount) {
      context.addIssue({
        code: "custom",
        message: "Allocated builders exceed the requested count",
      });
    }
  });

const PreviewSchema = z
  .object({
    state: z.literal("ready"),
    contractVersion: z.number().int().positive(),
    artifactDigest: Sha256Schema,
    revisionHash: Sha256Schema,
    url: SafeHttpsUrlSchema,
    expiresAt: IsoTimestampSchema,
    verifiedAt: IsoTimestampSchema,
    frozen: z.literal(true),
  })
  .strict();

const ProductionSchema = z
  .object({
    state: z.literal("ready"),
    contractVersion: z.number().int().positive(),
    artifactDigest: Sha256Schema,
    imageDigest: Sha256Schema,
    releaseVersion: z.number().int().positive(),
    url: SafeHttpsUrlSchema,
    verifiedAt: IsoTimestampSchema,
  })
  .strict();

export const CustomerProjectSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: ProjectAliasSchema,
    aggregateRevision: z.number().int().nonnegative(),
    eventCursor: z.number().int().nonnegative(),
    title: safeTextSchema(500),
    lifecycle: z
      .object({
        canonical: CustomerLifecycleSchema,
        label: safeTextSchema(100),
        changedAt: IsoTimestampSchema,
      })
      .strict(),
    requestedVersion: z.number().int().positive().nullable(),
    paidCommercialVersion: z.number().int().positive().nullable(),
    currentProvenVersion: z.number().int().positive().nullable(),
    currentProductionVersion: z.number().int().positive().nullable(),
    milestoneStates: z.array(MilestoneSchema).length(6),
    activeBatch: ActiveBatchSchema.nullable(),
    contract: ContractSchema.nullable(),
    proof: z
      .object({
        contractVersion: z.number().int().positive(),
        receiptCount: z.number().int().nonnegative().max(100_000),
        state: z.enum(["in_progress", "recorded", "blocked"]),
      })
      .strict()
      .nullable(),
    preview: PreviewSchema.nullable(),
    production: ProductionSchema.nullable(),
    pendingAction: z.enum([
      "answer_clarification",
      "pay",
      "open_production",
      "review_preview",
      "watch",
      "none",
    ]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const milestoneOrder = [
      "scope",
      "payment",
      "build",
      "proof",
      "preview",
      "production",
    ];
    if (
      snapshot.milestoneStates.some(
        (milestone, index) => milestone.id !== milestoneOrder[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Milestones must use the canonical order",
      });
    }
    if (
      snapshot.contract !== null &&
      snapshot.requestedVersion !== snapshot.contract.version
    ) {
      context.addIssue({
        code: "custom",
        message: "The requested version must match the contract",
      });
    }
    if (
      snapshot.activeBatch !== null &&
      snapshot.paidCommercialVersion !== snapshot.activeBatch.contractVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "An active build must be bound to a paid contract version",
      });
    }
    if (
      snapshot.proof !== null &&
      snapshot.activeBatch?.contractVersion !== snapshot.proof.contractVersion
    ) {
      context.addIssue({
        code: "custom",
        message: "Proof progress must match the active contract version",
      });
    }
    if (
      snapshot.currentProvenVersion !==
      (snapshot.preview?.contractVersion ?? null)
    ) {
      context.addIssue({
        code: "custom",
        message: "The proven version must match the frozen preview",
      });
    }
    if (
      snapshot.currentProductionVersion !==
      (snapshot.production?.contractVersion ?? null)
    ) {
      context.addIssue({
        code: "custom",
        message: "The production version must match the verified release",
      });
    }
    if (
      snapshot.production !== null &&
      snapshot.preview !== null &&
      snapshot.production.contractVersion ===
        snapshot.preview.contractVersion &&
      snapshot.production.artifactDigest !== snapshot.preview.artifactDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "Preview and production must bind the same proven artifact",
      });
    }
  });

export const CustomerEventTypeSchema = z.enum([
  "contract.version_created",
  "payment.verified",
  "build.batch_started",
  "build.batch_superseded",
  "builder.state_changed",
  "candidate.outcome_recorded",
  "preview.ready",
  "deployment.state_changed",
  "production.ready",
  "clarification.requested",
  "steering.received",
  "notification.state_changed",
  "project.state_changed",
]);

export const CustomerEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: EventAliasSchema,
    sequence: z.number().int().positive(),
    aggregateRevision: z.number().int().nonnegative(),
    projectId: ProjectAliasSchema,
    contractVersion: z.number().int().positive().nullable(),
    type: CustomerEventTypeSchema,
    occurredAt: IsoTimestampSchema,
    data: z
      .object({
        status: CustomerLifecycleSchema.optional(),
        builderId: BuilderAliasSchema.optional(),
        actor: z.enum(["customer", "operator", "system"]),
      })
      .strict(),
  })
  .strict();

export type CustomerProjectSnapshot = z.infer<
  typeof CustomerProjectSnapshotSchema
>;
export type CustomerEvent = z.infer<typeof CustomerEventSchema>;
export type Builder = z.infer<typeof BuilderSchema>;
export type CustomerActivity = z.infer<typeof CustomerActivitySchema>;

export function parseCustomerProjectSnapshot(
  value: unknown,
): CustomerProjectSnapshot {
  return parseCustomerSafe(CustomerProjectSnapshotSchema, value);
}

export function parseCustomerEvent(value: unknown): CustomerEvent {
  return parseCustomerSafe(CustomerEventSchema, value);
}
