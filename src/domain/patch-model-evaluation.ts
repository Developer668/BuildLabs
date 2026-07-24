import { z } from "zod";

import { Sha256Schema } from "./contract.js";
import { FireworksModelResourceSchema } from "./patch-model.js";
import { digestJson } from "../lib/canonical-json.js";

const OpaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const BinaryScoreSchema = z.union([z.literal(0), z.literal(1)]);

export const PATCH_EVALUATION_POLICY = {
  schemaVersion: 1,
  confidenceLevel: 0.95,
  minimumHeldoutCases: 20,
  minimumTrialsPerCase: 3,
  minimumPairedImprovementFloor: 0.01,
  minimumBaselineImprovement: 0,
} as const;
export const PATCH_EVALUATION_POLICY_DIGEST = digestJson(
  PATCH_EVALUATION_POLICY,
);

export const PatchEvaluationScoresSchema = z.strictObject({
  terminal: z.number().min(0).max(1),
  proofGate: BinaryScoreSchema,
  privacy: BinaryScoreSchema,
  build: BinaryScoreSchema,
  tests: BinaryScoreSchema,
  requestedChange: BinaryScoreSchema,
  priorRequirements: BinaryScoreSchema,
  accessibility: BinaryScoreSchema,
  performance: BinaryScoreSchema,
  supportedClaims: BinaryScoreSchema,
  minimalPatch: BinaryScoreSchema,
});
export type PatchEvaluationScores = z.infer<typeof PatchEvaluationScoresSchema>;

export const PatchEvaluationModelSchema = z.strictObject({
  role: z.enum(["base", "candidate", "baseline"]),
  label: OpaqueProviderIdSchema,
  modelResource: FireworksModelResourceSchema,
  experimentId: OpaqueProviderIdSchema,
  comparisonBaseExperimentId: OpaqueProviderIdSchema.nullable(),
  capabilitySnapshotDigest: Sha256Schema,
  routerPolicyDigest: Sha256Schema,
  serviceTier: z.enum(["standard", "priority", "fast"]),
  fallbackReason: z.string().min(1).max(2_000),
  returnedModelResource: FireworksModelResourceSchema,
});
export type PatchEvaluationModel = z.infer<typeof PatchEvaluationModelSchema>;

export const PatchEvaluationTrialBodySchema = z.strictObject({
  projectScopeId: Sha256Schema,
  datasetId: OpaqueProviderIdSchema,
  datasetVersion: OpaqueProviderIdSchema,
  bundleDigest: Sha256Schema,
  evaluationPolicyDigest: z.literal(PATCH_EVALUATION_POLICY_DIGEST),
  role: z.enum(["base", "candidate", "baseline"]),
  caseId: Sha256Schema,
  trialIndex: z.number().int().nonnegative().max(99),
  seed: z.number().int().nonnegative().max(2_147_483_647),
  modelResource: FireworksModelResourceSchema,
  capabilitySnapshotDigest: Sha256Schema,
  routerPolicyDigest: Sha256Schema,
  serviceTier: z.enum(["standard", "priority", "fast"]),
  fallbackReason: z.string().min(1).max(2_000),
  returnedModelResource: FireworksModelResourceSchema,
  outputDigest: Sha256Schema,
  evaluatorEvidenceDigest: Sha256Schema,
  scores: PatchEvaluationScoresSchema,
});

export const PatchEvaluationTrialAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("patch-evaluation-trial"),
  keyId: OpaqueProviderIdSchema,
  trialDigest: Sha256Schema,
  signature: Sha256Schema,
});

export const PatchEvaluationTrialSchema = z
  .strictObject({
    ...PatchEvaluationTrialBodySchema.shape,
    attestation: PatchEvaluationTrialAttestationSchema,
  })
  .superRefine((trial, context) => {
    const body = PatchEvaluationTrialBodySchema.parse({
      projectScopeId: trial.projectScopeId,
      datasetId: trial.datasetId,
      datasetVersion: trial.datasetVersion,
      bundleDigest: trial.bundleDigest,
      evaluationPolicyDigest: trial.evaluationPolicyDigest,
      role: trial.role,
      caseId: trial.caseId,
      trialIndex: trial.trialIndex,
      seed: trial.seed,
      modelResource: trial.modelResource,
      capabilitySnapshotDigest: trial.capabilitySnapshotDigest,
      routerPolicyDigest: trial.routerPolicyDigest,
      serviceTier: trial.serviceTier,
      fallbackReason: trial.fallbackReason,
      returnedModelResource: trial.returnedModelResource,
      outputDigest: trial.outputDigest,
      evaluatorEvidenceDigest: trial.evaluatorEvidenceDigest,
      scores: trial.scores,
    });
    if (trial.attestation.trialDigest !== digestJson(body)) {
      context.addIssue({
        code: "custom",
        message: "Patch evaluation trial digest does not match",
        path: ["attestation", "trialDigest"],
      });
    }
  });
export type PatchEvaluationTrial = z.infer<typeof PatchEvaluationTrialSchema>;

export const PatchEvaluationMatrixInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  dataset: z.strictObject({
    id: OpaqueProviderIdSchema,
    version: OpaqueProviderIdSchema,
    bundleDigest: Sha256Schema,
    split: z.literal("heldout"),
    recordCount: z.number().int().positive().max(100_000),
  }),
  minimumTrialsPerCase: z
    .number()
    .int()
    .min(PATCH_EVALUATION_POLICY.minimumTrialsPerCase)
    .max(20),
  confidenceLevel: z.literal(PATCH_EVALUATION_POLICY.confidenceLevel),
  minimumTerminalScore: z.number().min(0).max(1),
  minimumPairedImprovement: z
    .number()
    .min(PATCH_EVALUATION_POLICY.minimumPairedImprovementFloor)
    .max(1),
  models: z.array(PatchEvaluationModelSchema).min(3).max(20),
  trials: z.array(PatchEvaluationTrialSchema).min(1).max(2_000_000),
});
export type PatchEvaluationMatrixInput = z.infer<
  typeof PatchEvaluationMatrixInputSchema
>;

export const PatchConfidenceIntervalSchema = z.strictObject({
  count: z.number().int().positive(),
  mean: z.number().min(-1).max(1),
  lowerBound: z.number().min(-1).max(1),
  upperBound: z.number().min(-1).max(1),
});
export type PatchConfidenceInterval = z.infer<
  typeof PatchConfidenceIntervalSchema
>;

export const PatchEvaluationSummarySchema = z.strictObject({
  role: z.enum(["base", "candidate", "baseline"]),
  label: OpaqueProviderIdSchema,
  modelResource: FireworksModelResourceSchema,
  experimentId: OpaqueProviderIdSchema,
  scores: z.strictObject({
    terminal: PatchConfidenceIntervalSchema,
    proofGate: PatchConfidenceIntervalSchema,
    privacy: PatchConfidenceIntervalSchema,
    build: PatchConfidenceIntervalSchema,
    tests: PatchConfidenceIntervalSchema,
    requestedChange: PatchConfidenceIntervalSchema,
    priorRequirements: PatchConfidenceIntervalSchema,
    accessibility: PatchConfidenceIntervalSchema,
    performance: PatchConfidenceIntervalSchema,
    supportedClaims: PatchConfidenceIntervalSchema,
    minimalPatch: PatchConfidenceIntervalSchema,
  }),
});
export type PatchEvaluationSummary = z.infer<
  typeof PatchEvaluationSummarySchema
>;

export const PatchEvaluationVetoSchema = z.strictObject({
  caseId: Sha256Schema,
  trialIndex: z.number().int().nonnegative().max(99),
  component: z.enum([
    "proofGate",
    "privacy",
    "build",
    "tests",
    "requestedChange",
    "priorRequirements",
    "accessibility",
    "performance",
    "supportedClaims",
    "minimalPatch",
  ]),
  reason: z.enum(["candidate-failure", "regression-against-pinned-base"]),
});
export type PatchEvaluationVeto = z.infer<typeof PatchEvaluationVetoSchema>;

const PatchPromotionEligibilityFields = {
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  dataset: z.strictObject({
    id: OpaqueProviderIdSchema,
    version: OpaqueProviderIdSchema,
    bundleDigest: Sha256Schema,
    recordCount: z.number().int().positive(),
  }),
  matrixDigest: Sha256Schema,
  baseModelResource: FireworksModelResourceSchema,
  candidateModelResource: FireworksModelResourceSchema,
  baselineModelResources: z.array(FireworksModelResourceSchema).min(1).max(18),
  confidenceLevel: z.literal(PATCH_EVALUATION_POLICY.confidenceLevel),
  minimumTrialsPerCase: z
    .number()
    .int()
    .min(PATCH_EVALUATION_POLICY.minimumTrialsPerCase)
    .max(20),
  evaluationPolicyDigest: z.literal(PATCH_EVALUATION_POLICY_DIGEST),
  thresholds: z.strictObject({
    minimumHeldoutCases: z.literal(PATCH_EVALUATION_POLICY.minimumHeldoutCases),
    minimumTerminalScore: z.number().min(0).max(1),
    minimumPairedImprovement: z
      .number()
      .min(PATCH_EVALUATION_POLICY.minimumPairedImprovementFloor)
      .max(1),
    minimumBaselineImprovement: z.literal(
      PATCH_EVALUATION_POLICY.minimumBaselineImprovement,
    ),
  }),
  summaries: z.array(PatchEvaluationSummarySchema).min(3).max(20),
  pairedTerminalImprovement: PatchConfidenceIntervalSchema,
  pairedBaselineImprovements: z
    .array(
      z.strictObject({
        baselineModelResource: FireworksModelResourceSchema,
        terminalImprovement: PatchConfidenceIntervalSchema,
      }),
    )
    .min(1)
    .max(18),
  vetoes: z.array(PatchEvaluationVetoSchema).max(2_000_000),
  status: z.enum(["blocked", "eligible-for-manual-promotion"]),
  automaticPromotion: z.literal(false),
  promoted: z.literal(false),
  reasons: z.array(z.string().min(1).max(500)).max(100),
} as const;

export const PatchPromotionEligibilityBodySchema = z.strictObject(
  PatchPromotionEligibilityFields,
);

export const PatchPromotionEligibilityAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("manual-promotion-eligibility"),
  keyId: OpaqueProviderIdSchema,
  recordDigest: Sha256Schema,
  signature: Sha256Schema,
});

export const PatchPromotionEligibilityRecordSchema = z.strictObject({
  ...PatchPromotionEligibilityFields,
  attestation: PatchPromotionEligibilityAttestationSchema,
});
export type PatchPromotionEligibilityRecord = z.infer<
  typeof PatchPromotionEligibilityRecordSchema
>;
