import { z } from "zod";

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_EVENT_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.-]*$/;
const CREDENTIAL_PATTERN =
  /\b(?:bearer\s+[a-z0-9._~+/=-]+|sk[-_][a-z0-9_-]{8,}|api[-_ ]?key\s*[:=]|access[-_ ]?token\s*[:=])/i;

function safeText(maximum: number) {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
      "Text contains unsafe control characters",
    )
    .refine((value) => !/[<>]/.test(value), "HTML is not accepted")
    .refine(
      (value) => !CREDENTIAL_PATTERN.test(value),
      "Credential-shaped text is not accepted",
    );
}

const IdSchema = z.string().min(1).max(256).regex(SAFE_ID_PATTERN);
const UuidSchema = z.uuid();
const TimestampSchema = z.iso.datetime();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const EventTypeSchema = z.string().min(1).max(128).regex(SAFE_EVENT_PATTERN);
const ErrorCodeSchema = z.string().min(1).max(128).regex(SAFE_CODE_PATTERN);
const RunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "rejected",
  "failed",
  "cancelled",
]);
const RunStageSchema = z.enum([
  "queued",
  "provisioning",
  "generating",
  "verifying",
  "reviewing",
  "evaluating",
  "finalizing",
  "complete",
]);
const LifecycleSchema = z.enum([
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

const SafeHttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    !url.hostname.endsWith(".local")
  );
}, "Only credential-free HTTPS URLs are accepted");

const RunSchema = z.object({
  id: UuidSchema,
  projectId: IdSchema,
  candidateId: IdSchema,
  status: RunStatusSchema,
  stage: RunStageSchema,
  revisionHash: Sha256Schema.optional(),
  cancelRequested: z.boolean(),
  errorCode: ErrorCodeSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
});

const LatestRunEventSchema = z.object({
  sequence: z.number().int().positive(),
  runId: UuidSchema,
  type: EventTypeSchema,
  stage: RunStageSchema,
  createdAt: TimestampSchema,
});

const AssignmentSchema = z
  .object({
    strategyLabel: safeText(200),
    requestedAt: TimestampSchema,
    contract: z.object({
      contractId: IdSchema,
      contractRevision: z.number().int().positive(),
      approvedAt: TimestampSchema,
      approvedFacts: z
        .array(
          z.object({
            id: IdSchema,
            statement: safeText(2_000),
          }),
        )
        .max(500),
      requirements: z
        .array(
          z.object({
            id: IdSchema,
            description: safeText(2_000),
            priority: z.enum(["hard", "preference"]),
            verifierKinds: z
              .array(z.enum(["command", "http", "semantic"]))
              .max(20),
          }),
        )
        .min(1)
        .max(500),
    }),
  })
  .nullable();

const RunSummarySchema = z
  .object({
    run: RunSchema,
    assignment: AssignmentSchema,
    activity: z
      .object({
        eventCount: z.number().int().nonnegative(),
        latestEvent: LatestRunEventSchema.nullable(),
      })
      .strict(),
    proof: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        hardRequirements: z.number().int().nonnegative(),
      })
      .strict(),
    artifactAvailable: z.boolean(),
    previewAvailable: z.boolean(),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.activity.latestEvent &&
      summary.activity.latestEvent.runId !== summary.run.id
    ) {
      context.addIssue({
        code: "custom",
        message: "Latest activity belongs to a different run",
        path: ["activity", "latestEvent", "runId"],
      });
    }
    if (
      summary.proof.passed + summary.proof.failed + summary.proof.errors >
      summary.proof.total
    ) {
      context.addIssue({
        code: "custom",
        message: "Proof status counts exceed the receipt total",
        path: ["proof"],
      });
    }
  });

const OperatorRunSnapshotSchema = z
  .object({
    runs: z.array(RunSummarySchema).max(100),
    generatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const runIds = new Set<string>();
    for (const [index, summary] of snapshot.runs.entries()) {
      if (runIds.has(summary.run.id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate run identity",
          path: ["runs", index, "run", "id"],
        });
      }
      runIds.add(summary.run.id);
    }
  });

const ProposalSchema = z.object({
  version: z.number().int().positive(),
  projectTitle: safeText(500),
  digest: Sha256Schema,
  plan: z.object({
    summary: z.object({ text: safeText(20_000) }),
  }),
  quote: z.object({
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[a-z]{3}$/),
  }),
  contract: z.object({
    projectId: IdSchema,
    version: z.number().int().positive(),
    digest: Sha256Schema,
    approvedFacts: z
      .array(
        z.object({
          factId: IdSchema,
          statement: safeText(2_000),
        }),
      )
      .max(500),
    requirements: z
      .array(
        z.object({
          requirementId: IdSchema,
          description: safeText(2_000),
          priority: z.enum(["hard", "preference"]),
          verifiers: z
            .array(z.object({ kind: z.enum(["command", "http", "semantic"]) }))
            .max(20),
        }),
      )
      .min(1)
      .max(500),
    createdAt: TimestampSchema,
  }),
  createdAt: TimestampSchema,
});

const PaymentSchema = z.object({
  receiptId: IdSchema,
  projectId: IdSchema,
  proposalVersion: z.number().int().positive(),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  amountReceivedMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.literal("paid"),
  verificationSource: z.enum(["signed_webhook", "provider_api"]),
  providerStateVerified: z.literal(true),
  signatureVerified: z.boolean(),
  paidAt: TimestampSchema,
  verifiedAt: TimestampSchema,
  livemode: z.boolean(),
});

const BatchRunSchema = z
  .object({
    runId: UuidSchema,
    candidateId: IdSchema,
    status: RunStatusSchema,
  })
  .strict();

const BuildBatchSchema = z.object({
  batchId: IdSchema,
  projectId: IdSchema,
  proposalVersion: z.number().int().positive(),
  contractVersion: z.number().int().positive(),
  requestedCandidateCount: z.number().int().min(1).max(4),
  runs: z.array(BatchRunSchema).max(4),
  status: z.enum([
    "pending",
    "dispatched",
    "building",
    "verifying",
    "completed",
    "failed",
    "cancelled",
  ]),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
});

const PreviewSchema = z.object({
  receiptId: IdSchema,
  projectId: IdSchema,
  runId: UuidSchema,
  candidateId: IdSchema,
  proposalVersion: z.number().int().positive(),
  revisionHash: Sha256Schema,
  artifactDigest: Sha256Schema,
  url: SafeHttpsUrlSchema,
  expiresAt: TimestampSchema,
  immutable: z.literal(true),
  httpsHealthy: z.literal(true),
  createdAt: TimestampSchema,
  verifiedAt: TimestampSchema,
});

const DeploymentSchema = z.object({
  receiptId: IdSchema,
  projectId: IdSchema,
  runId: UuidSchema,
  candidateId: IdSchema,
  proposalVersion: z.number().int().positive(),
  revisionHash: Sha256Schema,
  artifactDigest: Sha256Schema,
  releaseVersion: z.number().int().positive(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  url: SafeHttpsUrlSchema,
  httpsHealthy: z.literal(true),
  deployedAt: TimestampSchema,
  releaseVerifiedAt: TimestampSchema,
  verifiedAt: TimestampSchema,
});

const EffectSchema = z.object({
  type: z.enum([
    "research_business",
    "send_email_verification",
    "send_dashboard_login",
    "send_clarification",
    "create_checkout_session",
    "expire_checkout_session",
    "send_proposal",
    "reconcile_payment",
    "send_payment_confirmation",
    "send_dashboard_access",
    "send_steering_acknowledgement",
    "dispatch_build_batch",
    "cancel_build_run",
    "acknowledge_proven_event",
    "materialize_proven_preview",
    "refresh_proven_preview",
    "send_proven_preview",
    "reconcile_mail_delivery",
    "deploy_proven_candidate",
    "verify_deployment",
    "persist_proof_summary_snapshot",
    "send_final_delivery",
  ]),
  status: z.enum(["pending", "completed", "failed"]),
  attempts: z.number().int().nonnegative().max(10_000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
});

const OperatorErrorSchema = z.object({
  code: ErrorCodeSchema,
  category: z.enum(["transient", "permanent", "policy", "security"]),
  retryable: z.boolean(),
  occurredAt: TimestampSchema,
});

const ProjectSchema = z.object({
  projectId: IdSchema,
  revision: z.number().int().nonnegative(),
  status: LifecycleSchema,
  proposals: z.array(ProposalSchema).max(1_000),
  activeProposalVersion: z.number().int().positive().optional(),
  paidProposalVersion: z.number().int().positive().optional(),
  payments: z.array(PaymentSchema).max(1_000),
  buildBatches: z.array(BuildBatchSchema).max(1_000),
  activeBuildBatchId: IdSchema.optional(),
  previews: z.array(PreviewSchema).max(1_000),
  deployments: z.array(DeploymentSchema).max(1_000),
  openClarificationQuestions: z.array(safeText(1_000)).max(20),
  effects: z.array(EffectSchema).max(10_000),
  errors: z.array(OperatorErrorSchema).max(10_000),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

const ProjectEventSchema = z.object({
  eventId: UuidSchema,
  sequence: z.number().int().positive(),
  projectId: IdSchema,
  aggregateRevision: z.number().int().nonnegative(),
  type: EventTypeSchema,
  actor: z.enum(["system", "customer", "provider", "operator"]),
  occurredAt: TimestampSchema,
});

const OperatorEvidenceSnapshotSchema = z
  .object({
    traceCorrelation: Sha256Schema,
    project: ProjectSchema,
    events: z
      .object({
        items: z.array(ProjectEventSchema).max(500),
        nextAfterSequence: z.number().int().positive().optional(),
      })
      .strict(),
    operations: z
      .object({
        effects: z.array(EffectSchema).max(10_000),
        errors: z.array(OperatorErrorSchema).max(10_000),
        deadLetters: z
          .array(z.object({ errorCode: ErrorCodeSchema }))
          .max(10_000),
        inboundMail: z
          .array(
            z.object({
              status: z.enum(["pending", "processed", "rejected", "failed"]),
              attempts: z.number().int().nonnegative(),
              receivedAt: TimestampSchema,
              updatedAt: TimestampSchema,
              lastErrorCode: ErrorCodeSchema.optional(),
            }),
          )
          .max(10_000),
      })
      .strict(),
  })
  .strict();

const ProviderStateSchema = z.enum([
  "configured",
  "end-to-end-verified",
  "healthy",
  "unconfigured",
  "unhealthy",
]);

const OperatorIntegrationsSnapshotSchema = z.object({
  status: z
    .object({
      daytona: ProviderStateSchema,
      fireworks: ProviderStateSchema,
      braintrust: ProviderStateSchema,
      coderabbit: ProviderStateSchema,
      copilotkit: ProviderStateSchema,
      elevenlabs: ProviderStateSchema,
    })
    .strict(),
  lastProbeAt: TimestampSchema.nullable(),
});

export type OperatorRunSummary = z.infer<typeof RunSummarySchema>;
export type OperatorRunSnapshot = z.infer<typeof OperatorRunSnapshotSchema>;
export type OperatorEvidenceSnapshot = z.infer<
  typeof OperatorEvidenceSnapshotSchema
>;
export type OperatorIntegrationsSnapshot = z.infer<
  typeof OperatorIntegrationsSnapshotSchema
>;
export type OperatorProviderState = z.infer<typeof ProviderStateSchema>;

export interface OperatorProjectRunGroup {
  projectId: string;
  updatedAt: string;
  runs: OperatorRunSummary[];
}

export function parseOperatorRunSnapshot(value: unknown): OperatorRunSnapshot {
  return OperatorRunSnapshotSchema.parse(value);
}

export function parseOperatorEvidenceSnapshot(
  value: unknown,
  expectedProjectId: string,
): OperatorEvidenceSnapshot {
  const snapshot = OperatorEvidenceSnapshotSchema.parse(value);
  if (
    snapshot.project.projectId !== expectedProjectId ||
    snapshot.events.items.some(
      (event) => event.projectId !== expectedProjectId,
    ) ||
    snapshot.project.proposals.some(
      (proposal) => proposal.contract.projectId !== expectedProjectId,
    ) ||
    snapshot.project.payments.some(
      (payment) => payment.projectId !== expectedProjectId,
    ) ||
    snapshot.project.buildBatches.some(
      (batch) => batch.projectId !== expectedProjectId,
    ) ||
    snapshot.project.previews.some(
      (preview) => preview.projectId !== expectedProjectId,
    ) ||
    snapshot.project.deployments.some(
      (deployment) => deployment.projectId !== expectedProjectId,
    )
  ) {
    throw new Error("Operator evidence crossed a project boundary");
  }
  if (
    snapshot.project.activeProposalVersion !== undefined &&
    !snapshot.project.proposals.some(
      ({ version }) => version === snapshot.project.activeProposalVersion,
    )
  ) {
    throw new Error("Active proposal version is absent");
  }
  if (
    snapshot.project.paidProposalVersion !== undefined &&
    !snapshot.project.proposals.some(
      ({ version }) => version === snapshot.project.paidProposalVersion,
    )
  ) {
    throw new Error("Paid proposal version is absent");
  }
  if (
    snapshot.project.activeBuildBatchId !== undefined &&
    !snapshot.project.buildBatches.some(
      ({ batchId }) => batchId === snapshot.project.activeBuildBatchId,
    )
  ) {
    throw new Error("Active build batch is absent");
  }
  return snapshot;
}

export function parseOperatorIntegrationsSnapshot(
  value: unknown,
): OperatorIntegrationsSnapshot {
  return OperatorIntegrationsSnapshotSchema.parse(value);
}

export function groupOperatorRuns(
  snapshot: OperatorRunSnapshot,
): OperatorProjectRunGroup[] {
  const groups = new Map<string, OperatorRunSummary[]>();
  for (const summary of snapshot.runs) {
    const group = groups.get(summary.run.projectId) ?? [];
    group.push(summary);
    groups.set(summary.run.projectId, group);
  }
  return [...groups.entries()]
    .map(([projectId, runs]) => {
      runs.sort((left, right) =>
        right.run.updatedAt.localeCompare(left.run.updatedAt),
      );
      return {
        projectId,
        updatedAt: runs[0]!.run.updatedAt,
        runs,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function activeProposal(
  snapshot: OperatorEvidenceSnapshot,
): OperatorEvidenceSnapshot["project"]["proposals"][number] | null {
  const version = snapshot.project.activeProposalVersion;
  if (version === undefined) {
    return null;
  }
  return (
    snapshot.project.proposals.find(
      (proposal) => proposal.version === version,
    ) ?? null
  );
}

export function activeBatch(
  snapshot: OperatorEvidenceSnapshot,
): OperatorEvidenceSnapshot["project"]["buildBatches"][number] | null {
  const batchId = snapshot.project.activeBuildBatchId;
  if (!batchId) {
    return null;
  }
  return (
    snapshot.project.buildBatches.find((batch) => batch.batchId === batchId) ??
    null
  );
}

export function latestPayment(
  snapshot: OperatorEvidenceSnapshot,
): OperatorEvidenceSnapshot["project"]["payments"][number] | null {
  const paidVersion = snapshot.project.paidProposalVersion;
  const matches = snapshot.project.payments.filter(
    (payment) =>
      paidVersion === undefined || payment.proposalVersion === paidVersion,
  );
  return (
    matches.sort((left, right) =>
      right.verifiedAt.localeCompare(left.verifiedAt),
    )[0] ?? null
  );
}

export function latestPreview(
  snapshot: OperatorEvidenceSnapshot,
): OperatorEvidenceSnapshot["project"]["previews"][number] | null {
  return (
    [...snapshot.project.previews].sort((left, right) =>
      right.verifiedAt.localeCompare(left.verifiedAt),
    )[0] ?? null
  );
}

export function latestDeployment(
  snapshot: OperatorEvidenceSnapshot,
): OperatorEvidenceSnapshot["project"]["deployments"][number] | null {
  return (
    [...snapshot.project.deployments].sort((left, right) =>
      right.verifiedAt.localeCompare(left.verifiedAt),
    )[0] ?? null
  );
}
