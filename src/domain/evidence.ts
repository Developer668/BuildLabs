import { z } from "zod";

import { Sha256Schema } from "./contract.js";

export const EvidenceStatusSchema = z.enum(["PASS", "FAIL", "ERROR"]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

const ReceiptBaseSchema = z.object({
  receiptId: z.uuid(),
  runId: z.uuid(),
  revisionHash: Sha256Schema,
  status: EvidenceStatusSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  inputDigest: Sha256Schema,
  outputDigest: Sha256Schema,
});

export const SandboxAsyncExecutionReceiptSchema = z
  .object({
    schema: z.literal("buildlabs.daytona.async-execution.v1"),
    commandSha256: Sha256Schema,
    sessionRef: Sha256Schema,
    commandRef: Sha256Schema,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    outcome: z.enum(["completed", "failed", "timed_out", "cancelled"]),
    exitCode: z.number().int().nullable(),
    stdoutSha256: Sha256Schema,
    stderrSha256: Sha256Schema,
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    outputTruncated: z.boolean(),
    sandboxTerminated: z.boolean(),
    failureCode: z
      .enum([
        "aborted",
        "authentication",
        "attestation",
        "conflict",
        "not_found",
        "otel_export",
        "provider",
        "quota",
        "rate_limited",
        "timeout",
        "unknown",
      ])
      .optional(),
  })
  .strict();

export const CommandReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.enum([
    "artifact",
    "build",
    "container-build",
    "dependency-bootstrap",
    "forbidden-claim",
    "test",
    "requirement-command",
  ]),
  provider: z.literal("daytona"),
  requirementId: z.string().optional(),
  verifierIndex: z.number().int().nonnegative().optional(),
  forbiddenClaimIndices: z
    .array(z.number().int().nonnegative())
    .min(1)
    .max(100)
    .optional(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean().default(false),
  stderrTruncated: z.boolean().default(false),
  durationMs: z.number().int().nonnegative(),
  asyncExecution: SandboxAsyncExecutionReceiptSchema.optional(),
});

export const PreviewCheckSchema = z.object({
  requirementId: z.string().optional(),
  verifierIndex: z.number().int().nonnegative().optional(),
  discovered: z.literal(true).optional(),
  path: z.string(),
  expectedStatus: z.number().int(),
  actualStatus: z.number().int().nullable(),
  expectedText: z.array(z.string()),
  missingText: z.array(z.string()),
  forbiddenClaimIndices: z
    .array(z.number().int().nonnegative())
    .max(100)
    .optional(),
  visibleTextDigest: Sha256Schema.optional(),
  screenshotSha256s: z.array(Sha256Schema).min(1).max(256).optional(),
  nonHtmlMediaType: z.string().min(1).max(200).optional(),
  error: z.string().optional(),
});

export const PreviewReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("preview"),
  provider: z.literal("daytona"),
  checks: z.array(PreviewCheckSchema).min(1).max(10_033),
});

const ReviewFilePathSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !Array.from(path).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }) &&
      path
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Review finding path must be a safe workspace-relative path",
  );

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "trivial", "info"]),
  fileName: ReviewFilePathSchema,
  message: z.string().min(1).max(32_000),
  codegenInstructions: z.string().min(1).max(32_000).optional(),
  suggestions: z.array(z.string().min(1).max(8_000)).max(20).optional(),
  startLine: z.number().int().positive().max(10_000_000).optional(),
  endLine: z.number().int().positive().max(10_000_000).optional(),
  category: z
    .enum([
      "access-control",
      "accessibility",
      "business-claims",
      "code-quality",
      "cross-project-isolation",
      "dependency-policy",
      "docker-delivery",
      "payment-gate",
      "privacy",
      "production-credentials",
      "proof-gate",
      "raw-preview-exposure",
      "unsafe-webhook",
      "unrestricted-logs",
    ])
    .optional(),
  governingInvariant: z.string().min(1).max(256).optional(),
  controllerRuleId: z.string().min(1).max(64).optional(),
});

const CodeRabbitDoctorEvidenceSchema = z
  .object({
    passed: z.number().int().nonnegative().max(100),
    warnings: z.number().int().nonnegative().max(100),
    failed: z.number().int().nonnegative().max(100),
    digest: Sha256Schema,
  })
  .strict();

export const CodeRabbitReviewContextEvidenceSchema = z
  .object({
    reviewType: z.literal("committed"),
    currentBranch: z.string().min(1).max(512),
    baseBranch: z.literal("main"),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    workingDirectoryDigest: Sha256Schema,
  })
  .strict();

export const CodeRabbitReviewScopeEvidenceSchema = z
  .object({
    reviewKind: z.enum(["authoritative_full", "advisory_light"]),
    reviewType: z.literal("committed"),
    currentBranch: z.string().min(1).max(512),
    baseBranch: z.literal("main"),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    workingDirectoryDigest: Sha256Schema,
    reviewedFileCount: z.number().int().nonnegative().max(10_000),
    reviewedFilesDigest: Sha256Schema,
  })
  .strict();

export const CodeRabbitCapabilityEvidenceSchema = z
  .object({
    state: z.literal("healthy"),
    policyPackVersion: z.string().min(1).max(128),
    policyPackDigest: Sha256Schema,
    cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    cliExecutableDigest: Sha256Schema,
    rootHelpDigest: Sha256Schema,
    reviewHelpDigest: Sha256Schema,
    reviewFlagsDigest: Sha256Schema,
    agentJsonl: z.literal(true),
    supportedEventKinds: z
      .array(
        z.enum([
          "review_context",
          "status",
          "heartbeat",
          "finding",
          "complete",
          "error",
        ]),
      )
      .length(6),
    reviewFlags: z.array(z.string().min(1).max(64)).max(32),
    authenticated: z.literal(true),
    doctor: CodeRabbitDoctorEvidenceSchema,
    updatePolicy: z.literal("disabled-and-digest-pinned"),
    serviceConnectivity: z.literal("healthy"),
    controllerConfig: z.literal("supported"),
    toolSupport: z.literal("disabled-controller-policy"),
  })
  .strict();

export const CodeRabbitReviewAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewKind: z.enum(["authoritative_full", "advisory_light"]),
    capabilityState: z.enum(["review-verified", "proof-integrated"]),
    authorityKey: Sha256Schema,
    sourceDigest: Sha256Schema,
    contractDigest: Sha256Schema,
    reviewDigest: Sha256Schema,
    findingSetDigest: Sha256Schema,
    reviewContext: CodeRabbitReviewContextEvidenceSchema,
    reviewContextDigest: Sha256Schema,
    scope: CodeRabbitReviewScopeEvidenceSchema,
    scopeDigest: Sha256Schema,
    policyPackVersion: z.string().min(1).max(128),
    policyPackDigest: Sha256Schema,
    configSchemaDigest: Sha256Schema,
    configDigest: Sha256Schema,
    rulesDigest: Sha256Schema,
    policyDigest: Sha256Schema,
    toolPolicyDigest: Sha256Schema,
    eventSchemaDigest: Sha256Schema,
    capability: CodeRabbitCapabilityEvidenceSchema,
    capabilityDigest: Sha256Schema,
    cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    cliExecutableDigestBefore: Sha256Schema,
    cliExecutableDigestAfter: Sha256Schema,
    reviewFlagsDigest: Sha256Schema,
    updatePolicy: z.literal("disabled-and-digest-pinned"),
    authentication: z.literal("authenticated"),
    doctor: CodeRabbitDoctorEvidenceSchema,
    serviceConnectivity: z.literal("healthy"),
    agentJsonl: z.literal(true),
    terminalState: z.literal("review_completed"),
    eventCounts: z
      .object({
        reviewContext: z.number().int().nonnegative().max(10_000),
        status: z.number().int().nonnegative().max(10_000),
        heartbeat: z.number().int().nonnegative().max(10_000),
        finding: z.number().int().nonnegative().max(500),
        complete: z.number().int().nonnegative().max(10),
        error: z.number().int().nonnegative().max(10_000),
      })
      .strict(),
    attempts: z.number().int().min(1).max(3),
    retryReasons: z
      .array(z.enum(["structured_rate_limit", "missing_terminal_completion"]))
      .max(2),
    durationMs: z.number().int().nonnegative(),
    severityCounts: z
      .object({
        critical: z.number().int().nonnegative().max(500),
        major: z.number().int().nonnegative().max(500),
        minor: z.number().int().nonnegative().max(500),
        trivial: z.number().int().nonnegative().max(500),
        info: z.number().int().nonnegative().max(500),
      })
      .strict(),
    categoryCounts: z
      .array(
        z
          .object({
            category: z.string().min(1).max(64),
            count: z.number().int().positive().max(500),
          })
          .strict(),
      )
      .max(32),
    configuredTools: z.array(z.string().min(1).max(64)).max(64),
    observedTools: z.array(z.string().min(1).max(64)).max(64),
    toolCoverage: z.enum(["disabled-controller-policy", "protocol-observed"]),
  })
  .strict();

export const CodeRabbitRepairBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingDigest: Sha256Schema,
    fileName: ReviewFilePathSchema,
    range: z
      .object({
        startLine: z.number().int().positive().max(10_000_000),
        endLine: z.number().int().positive().max(10_000_000),
      })
      .strict()
      .nullable(),
    severity: z.enum(["critical", "major", "minor", "trivial", "info"]),
    category: z.string().min(1).max(64),
    governingInvariant: z.string().min(1).max(256),
    controllerRuleId: z.string().min(1).max(64).optional(),
    controllerPolicyVersion: z.string().min(1).max(128),
    controllerPolicyDigest: Sha256Schema,
    reviewDigest: Sha256Schema,
    sourceDigest: Sha256Schema,
    untrustedSummary: z.string().min(1).max(4_000),
    untrustedRemediation: z.string().min(1).max(4_000).optional(),
  })
  .strict();

export const ReviewReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("coderabbit"),
  provider: z.literal("coderabbit"),
  complete: z.boolean(),
  findings: z.array(ReviewFindingSchema).max(500),
  policyDigest: Sha256Schema.optional(),
  expectedPolicyDigest: Sha256Schema.optional(),
  attestation: CodeRabbitReviewAttestationSchema.optional(),
  expectedAttestationDigest: Sha256Schema.optional(),
  error: z.string().min(1).max(8_192).optional(),
});

export const RequirementEvaluationSchema = z.object({
  requirementId: z.string().min(1),
  status: z.enum(["PASS", "FAIL", "UNVERIFIED"]),
  explanation: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
});

export const UnsupportedClaimSchema = z.object({
  claim: z.string().min(1),
  location: z.string().min(1),
  reason: z.string().min(1),
});

export const EvaluationReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("contract-evaluation"),
  provider: z.literal("fireworks"),
  traceProvider: z.literal("braintrust"),
  traceId: z.string().min(1),
  braintrustScores: z.object({
    hardRequirements: z.union([z.literal(0), z.literal(1)]),
    supportedBusinessFacts: z.union([z.literal(0), z.literal(1)]),
    evidenceGrounding: z.union([z.literal(0), z.literal(1)]),
    preferenceSatisfaction: z.number().min(0).max(1),
  }),
  requirements: z.array(RequirementEvaluationSchema),
  unsupportedClaims: z.array(UnsupportedClaimSchema),
  summary: z.string().min(1),
});

const RasterClaimMatchSchema = z.strictObject({
  assetIndex: z.number().int().nonnegative().max(575),
  assetSha256: Sha256Schema,
  forbiddenClaimIndices: z
    .array(z.number().int().nonnegative().max(99))
    .max(100),
});

export const RasterClaimReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("visual-claim"),
  provider: z.enum(["controller", "fireworks"]),
  traceProvider: z.literal("braintrust"),
  traceId: z.string().min(1),
  claimSetDigest: Sha256Schema,
  approvedFactSetDigest: Sha256Schema,
  renderedInputDigest: Sha256Schema,
  forbiddenClaimIndices: z
    .array(z.number().int().nonnegative().max(99))
    .max(100),
  assetCount: z.number().int().nonnegative().max(576),
  workspaceAssetCount: z.number().int().nonnegative().max(64),
  renderedAssetCount: z.number().int().nonnegative().max(512),
  aggregateBytes: z
    .number()
    .int()
    .nonnegative()
    .max(70 * 1_024 * 1_024),
  assetDigests: z.array(Sha256Schema).max(576),
  modelInputDigests: z.array(Sha256Schema).max(576),
  modelDigest: Sha256Schema.optional(),
  matches: z.array(RasterClaimMatchSchema).max(576),
  unsupportedAssetIndices: z
    .array(z.number().int().nonnegative().max(575))
    .max(576),
  unverifiedAssetIndices: z
    .array(z.number().int().nonnegative().max(575))
    .max(576),
  errorCode: z
    .enum([
      "aborted",
      "asset_bound_exceeded",
      "invalid_asset",
      "image_decode_failed",
      "multi_frame_asset",
      "policy_bound_exceeded",
      "model_capability_unavailable",
      "model_response_invalid",
      "provider_error",
      "provider_unverified",
      "unsupported_asset_format",
      "workspace_read_failed",
    ])
    .optional(),
}).superRefine((receipt, context) => {
  if (
    receipt.assetDigests.length !== receipt.assetCount ||
    receipt.modelInputDigests.length !== receipt.assetCount ||
    receipt.workspaceAssetCount + receipt.renderedAssetCount !==
      receipt.assetCount
  ) {
    context.addIssue({
      code: "custom",
      message: "Visual claim evidence does not bind every raster asset",
      path: ["assetDigests"],
    });
  }
  const expectedIndices = receipt.forbiddenClaimIndices.map(
    (_, index) => index,
  );
  if (
    !receipt.forbiddenClaimIndices.every(
      (value, index) => value === expectedIndices[index],
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Visual claim indices must be complete and ordered",
      path: ["forbiddenClaimIndices"],
    });
  }
  const findingIndices = [
    ...receipt.matches.map((match) => match.assetIndex),
    ...receipt.unsupportedAssetIndices,
    ...receipt.unverifiedAssetIndices,
  ];
  if (
    new Set(receipt.matches.map((match) => match.assetIndex)).size !==
      receipt.matches.length ||
    new Set(receipt.unsupportedAssetIndices).size !==
      receipt.unsupportedAssetIndices.length ||
    new Set(receipt.unverifiedAssetIndices).size !==
      receipt.unverifiedAssetIndices.length ||
    new Set(findingIndices).size !== findingIndices.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Visual claim findings must be unique and non-overlapping",
      path: ["matches"],
    });
  }
  for (const match of receipt.matches) {
    if (
      match.assetIndex >= receipt.assetCount ||
      receipt.assetDigests[match.assetIndex] !== match.assetSha256 ||
      match.forbiddenClaimIndices.length === 0 ||
      new Set(match.forbiddenClaimIndices).size !==
        match.forbiddenClaimIndices.length ||
      !match.forbiddenClaimIndices.every(
        (index, position) =>
          position === 0 || match.forbiddenClaimIndices[position - 1]! < index,
      ) ||
      !match.forbiddenClaimIndices.every((index) =>
        receipt.forbiddenClaimIndices.includes(index),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Visual claim match is not bound to the scanned input",
        path: ["matches"],
      });
    }
  }
  if (
    receipt.unsupportedAssetIndices.some(
      (index) => index >= receipt.assetCount,
    ) ||
    receipt.unverifiedAssetIndices.some((index) => index >= receipt.assetCount)
  ) {
    context.addIssue({
      code: "custom",
      message: "Unverified visual claim index is outside the scanned input",
      path: ["unverifiedAssetIndices"],
    });
  }
  if (
    receipt.status === "PASS" &&
    (receipt.matches.length > 0 ||
      receipt.unsupportedAssetIndices.length > 0 ||
      receipt.unverifiedAssetIndices.length > 0 ||
      receipt.errorCode)
  ) {
    context.addIssue({
      code: "custom",
      message: "Passing visual claim evidence must be complete and clean",
      path: ["status"],
    });
  }
  if (
    receipt.status === "FAIL" &&
    receipt.matches.length === 0 &&
    receipt.unsupportedAssetIndices.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Failed visual claim evidence must contain a claim finding",
      path: ["status"],
    });
  }
  if (
    receipt.status === "FAIL" &&
    (receipt.unverifiedAssetIndices.length > 0 || receipt.errorCode)
  ) {
    context.addIssue({
      code: "custom",
      message: "Failed visual claim evidence cannot be unverified or errored",
      path: ["status"],
    });
  }
  if (receipt.status === "ERROR" && !receipt.errorCode) {
    context.addIssue({
      code: "custom",
      message: "Errored visual claim evidence requires a bounded error code",
      path: ["errorCode"],
    });
  }
  if (
    receipt.status === "ERROR" &&
    (receipt.matches.length > 0 || receipt.unsupportedAssetIndices.length > 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Errored visual claim evidence cannot contain claim findings",
      path: ["status"],
    });
  }
  if (
    receipt.assetCount > 0 &&
    receipt.status !== "ERROR" &&
    (receipt.provider !== "fireworks" || !receipt.modelDigest)
  ) {
    context.addIssue({
      code: "custom",
      message: "Scanned visual claim evidence requires a Fireworks model",
      path: ["provider"],
    });
  }
});

export const EvidenceReceiptSchema = z.discriminatedUnion("kind", [
  CommandReceiptSchema,
  PreviewReceiptSchema,
  ReviewReceiptSchema,
  EvaluationReceiptSchema,
  RasterClaimReceiptSchema,
]);

export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export type SandboxAsyncExecutionReceipt = z.infer<
  typeof SandboxAsyncExecutionReceiptSchema
>;
export type PreviewReceipt = z.infer<typeof PreviewReceiptSchema>;
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export type EvaluationReceipt = z.infer<typeof EvaluationReceiptSchema>;
export type RasterClaimReceipt = z.infer<typeof RasterClaimReceiptSchema>;
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type CodeRabbitReviewAttestation = z.infer<
  typeof CodeRabbitReviewAttestationSchema
>;
export type CodeRabbitRepairBrief = z.infer<typeof CodeRabbitRepairBriefSchema>;

export interface ProofDecision {
  passed: boolean;
  reasons: string[];
}
