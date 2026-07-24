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
});

export const ReviewReceiptSchema = ReceiptBaseSchema.extend({
  kind: z.literal("coderabbit"),
  provider: z.literal("coderabbit"),
  complete: z.boolean(),
  findings: z.array(ReviewFindingSchema).max(500),
  policyDigest: Sha256Schema.optional(),
  expectedPolicyDigest: Sha256Schema.optional(),
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
export type PreviewReceipt = z.infer<typeof PreviewReceiptSchema>;
export type ReviewReceipt = z.infer<typeof ReviewReceiptSchema>;
export type EvaluationReceipt = z.infer<typeof EvaluationReceiptSchema>;
export type RasterClaimReceipt = z.infer<typeof RasterClaimReceiptSchema>;
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export interface ProofDecision {
  passed: boolean;
  reasons: string[];
}
