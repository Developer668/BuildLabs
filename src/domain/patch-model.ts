import { z } from "zod";

import { digestJson } from "../lib/canonical-json.js";
import { AcceptanceContractSchema, Sha256Schema } from "./contract.js";
import { EvidenceReceiptSchema } from "./evidence.js";

const ProjectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const RequirementIdSchema = ProjectIdSchema;
const BinaryScoreSchema = z.union([z.literal(0), z.literal(1)]);
const OpaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const FireworksModelResourceSchema = z
  .string()
  .min(1)
  .max(1_000)
  .regex(
    /^accounts\/[A-Za-z0-9][A-Za-z0-9._-]*\/models\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  );

export const PatchFileKindSchema = z.enum([
  "asset",
  "configuration",
  "database",
  "documentation",
  "other",
  "source",
  "style",
  "test",
]);
export type PatchFileKind = z.infer<typeof PatchFileKindSchema>;

export const PatchTrainingConsentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: ProjectIdSchema,
  status: z.literal("granted"),
  purpose: z.literal("fireworks-rft-patch-model"),
  recordedAt: z.iso.datetime(),
  consentReceiptId: z.uuid(),
});
export type PatchTrainingConsent = z.infer<typeof PatchTrainingConsentSchema>;

export const PatchShapeSchema = z
  .strictObject({
    baseRevisionHash: Sha256Schema,
    revisionHash: Sha256Schema,
    diffSha256: Sha256Schema,
    language: z.enum(["javascript", "python", "typescript"]),
    fileKinds: z.array(PatchFileKindSchema).min(1).max(8),
    changedFileCount: z.number().int().positive().max(10_000),
    additions: z.number().int().nonnegative().max(1_000_000),
    deletions: z.number().int().nonnegative().max(1_000_000),
    maxChangedLines: z.number().int().positive().max(1_000_000),
  })
  .superRefine((shape, context) => {
    if (shape.baseRevisionHash === shape.revisionHash) {
      context.addIssue({
        code: "custom",
        message: "A patch must change the frozen revision",
        path: ["revisionHash"],
      });
    }
    if (shape.additions + shape.deletions === 0) {
      context.addIssue({
        code: "custom",
        message: "A patch must add or delete at least one line",
        path: ["additions"],
      });
    }
    if (new Set(shape.fileKinds).size !== shape.fileKinds.length) {
      context.addIssue({
        code: "custom",
        message: "Patch file kinds must be unique",
        path: ["fileKinds"],
      });
    }
  });
export type PatchShape = z.infer<typeof PatchShapeSchema>;

export const PatchEvidenceSelectionSchema = z.strictObject({
  requestedChangeRequirementId: RequirementIdSchema,
  accessibilityRequirementIds: z.array(RequirementIdSchema).min(1).max(50),
  performanceRequirementIds: z.array(RequirementIdSchema).min(1).max(50),
});
export type PatchEvidenceSelection = z.infer<
  typeof PatchEvidenceSelectionSchema
>;

export const PatchTrainingSourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  consent: PatchTrainingConsentSchema,
  contract: AcceptanceContractSchema,
  runId: z.uuid(),
  curatedAt: z.iso.datetime(),
  patch: PatchShapeSchema,
  selection: PatchEvidenceSelectionSchema,
  beforeReceipts: z.array(EvidenceReceiptSchema).min(1).max(5_000),
  afterReceipts: z.array(EvidenceReceiptSchema).min(1).max(5_000),
});
export type PatchTrainingSource = z.infer<typeof PatchTrainingSourceSchema>;

const EvidenceKindCountsSchema = z.strictObject({
  artifact: z.number().int().nonnegative(),
  build: z.number().int().nonnegative(),
  "container-build": z.number().int().nonnegative(),
  "contract-evaluation": z.number().int().nonnegative(),
  coderabbit: z.number().int().nonnegative(),
  "dependency-bootstrap": z.number().int().nonnegative().default(0),
  "forbidden-claim": z.number().int().nonnegative(),
  "visual-claim": z.number().int().nonnegative().default(0),
  preview: z.number().int().nonnegative(),
  "requirement-command": z.number().int().nonnegative(),
  test: z.number().int().nonnegative(),
});

const EvidenceStatusCountsSchema = z.strictObject({
  PASS: z.number().int().nonnegative(),
  FAIL: z.number().int().nonnegative(),
  ERROR: z.number().int().nonnegative(),
});

export const PatchRewardReasonCodeSchema = z.enum([
  "accessibility-regression",
  "build-failed",
  "oversized-patch",
  "performance-regression",
  "prior-requirement-regression",
  "proof-gate-failed",
  "requested-change-unverified",
  "tests-failed",
  "unsupported-claim",
]);
export type PatchRewardReasonCode = z.infer<typeof PatchRewardReasonCodeSchema>;

export const PatchRewardComponentsSchema = z.strictObject({
  proofGate: BinaryScoreSchema,
  build: BinaryScoreSchema,
  tests: BinaryScoreSchema,
  requestedChange: BinaryScoreSchema,
  priorRequirements: BinaryScoreSchema,
  accessibility: BinaryScoreSchema,
  performance: BinaryScoreSchema,
  supportedClaims: BinaryScoreSchema,
  minimalPatch: BinaryScoreSchema,
});
export type PatchRewardComponents = z.infer<typeof PatchRewardComponentsSchema>;

const REWARD_REASON_BY_COMPONENT = {
  proofGate: "proof-gate-failed",
  build: "build-failed",
  tests: "tests-failed",
  requestedChange: "requested-change-unverified",
  priorRequirements: "prior-requirement-regression",
  accessibility: "accessibility-regression",
  performance: "performance-regression",
  supportedClaims: "unsupported-claim",
  minimalPatch: "oversized-patch",
} as const satisfies Record<
  keyof z.infer<typeof PatchRewardComponentsSchema>,
  z.infer<typeof PatchRewardReasonCodeSchema>
>;

export const PatchRewardSchema = z
  .strictObject({
    policyVersion: z.literal(1),
    components: PatchRewardComponentsSchema,
    terminal: z.number().min(0).max(1),
    accepted: z.boolean(),
    reasonCodes: z.array(PatchRewardReasonCodeSchema).max(9),
    evidenceDigest: Sha256Schema,
  })
  .superRefine((reward, context) => {
    const expectedReasons = Object.entries(REWARD_REASON_BY_COMPONENT)
      .filter(
        ([component]) =>
          reward.components[
            component as keyof typeof REWARD_REASON_BY_COMPONENT
          ] === 0,
      )
      .map(([, reason]) => reason);
    if (
      new Set(reward.reasonCodes).size !== reward.reasonCodes.length ||
      expectedReasons.some((reason) => !reward.reasonCodes.includes(reason)) ||
      reward.reasonCodes.some((reason) => !expectedReasons.includes(reason))
    ) {
      context.addIssue({
        code: "custom",
        message: "Patch reward reason codes do not match its components",
        path: ["reasonCodes"],
      });
    }

    const hardGatePassed = Object.entries(reward.components)
      .filter(([component]) => component !== "minimalPatch")
      .every(([, score]) => score === 1);
    const expectedTerminal = hardGatePassed
      ? reward.components.minimalPatch === 1
        ? 1
        : 0.75
      : 0;
    if (reward.terminal !== expectedTerminal) {
      context.addIssue({
        code: "custom",
        message: "Patch reward terminal score does not match its components",
        path: ["terminal"],
      });
    }
    if (reward.accepted !== (reward.components.proofGate === 1)) {
      context.addIssue({
        code: "custom",
        message: "Patch reward acceptance does not match the proof gate",
        path: ["accepted"],
      });
    }
  });
export type PatchReward = z.infer<typeof PatchRewardSchema>;

export const PatchTrainingRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  exampleId: Sha256Schema,
  split: z.enum(["train", "heldout"]),
  input: z.strictObject({
    contractStructure: z.strictObject({
      hardRequirementCount: z.number().int().nonnegative(),
      preferenceRequirementCount: z.number().int().nonnegative(),
      approvedFactCount: z.number().int().nonnegative(),
      forbiddenClaimCount: z.number().int().nonnegative(),
      commandVerifierCount: z.number().int().nonnegative(),
      httpVerifierCount: z.number().int().nonnegative(),
      semanticVerifierCount: z.number().int().nonnegative(),
      testCommandCount: z.number().int().positive(),
    }),
    priorEvidence: z.strictObject({
      receiptCount: z.number().int().positive(),
      byKind: EvidenceKindCountsSchema,
      byStatus: EvidenceStatusCountsSchema,
    }),
    requestedChange: z.strictObject({
      priority: z.literal("hard"),
      verifierKinds: z
        .array(z.enum(["command", "http"]))
        .min(1)
        .max(20),
      priorHardRequirementCount: z.number().int().nonnegative(),
      accessibilityCheckCount: z.number().int().positive(),
      performanceCheckCount: z.number().int().positive(),
    }),
  }),
  expected: z.strictObject({
    patchShape: z.strictObject({
      language: z.enum(["javascript", "python", "typescript"]),
      fileKinds: z.array(PatchFileKindSchema).min(1).max(8),
      changedFileCount: z.number().int().positive(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      maxChangedLines: z.number().int().positive(),
    }),
    reward: PatchRewardSchema,
  }),
  metadata: z.strictObject({
    curatedAt: z.iso.datetime(),
    dataUseConsent: z.literal("granted"),
    consentReceiptDigest: Sha256Schema,
    sourceEvidenceDigest: Sha256Schema,
    baseRevisionDigest: Sha256Schema,
    candidateRevisionDigest: Sha256Schema,
    diffDigest: Sha256Schema,
    curationPolicyDigest: Sha256Schema,
  }),
});
export type PatchTrainingRecord = z.infer<typeof PatchTrainingRecordSchema>;

const PatchTrainingBundleFields = {
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  records: z.array(PatchTrainingRecordSchema).min(1).max(100_000),
  bundleDigest: Sha256Schema,
} as const;

function validatePatchTrainingBundleContent(
  bundle: z.infer<
    ReturnType<typeof z.strictObject<typeof PatchTrainingBundleFields>>
  >,
  context: z.core.$RefinementCtx,
): void {
  const expectedDigest = digestJson({
    schemaVersion: bundle.schemaVersion,
    projectScopeId: bundle.projectScopeId,
    records: bundle.records,
  });
  if (bundle.bundleDigest !== expectedDigest) {
    context.addIssue({
      code: "custom",
      message: "Patch training bundle digest does not match its contents",
      path: ["bundleDigest"],
    });
  }
  if (
    bundle.records.some(
      (record) => record.projectScopeId !== bundle.projectScopeId,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Patch training bundle records must share its project scope",
      path: ["records"],
    });
  }
}

export const PatchTrainingBundleBodySchema = z
  .strictObject(PatchTrainingBundleFields)
  .superRefine(validatePatchTrainingBundleContent);
export type PatchTrainingBundleBody = z.infer<
  typeof PatchTrainingBundleBodySchema
>;

export const PatchTrainingBundleAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("braintrust-structural-publication"),
  projectScopeId: Sha256Schema,
  bundleDigest: Sha256Schema,
  recordCount: z.number().int().positive().max(100_000),
  curationPolicyDigest: Sha256Schema,
  consentReceiptDigests: z.array(Sha256Schema).min(1).max(100_000),
  signature: Sha256Schema,
});
export type PatchTrainingBundleAttestation = z.infer<
  typeof PatchTrainingBundleAttestationSchema
>;

export const PatchTrainingBundleSchema = z
  .strictObject({
    ...PatchTrainingBundleFields,
    attestation: PatchTrainingBundleAttestationSchema,
  })
  .superRefine((bundle, context) => {
    validatePatchTrainingBundleContent(bundle, context);
    const curationPolicyDigests = [
      ...new Set(
        bundle.records.map((record) => record.metadata.curationPolicyDigest),
      ),
    ];
    const consentReceiptDigests = [
      ...new Set(
        bundle.records.map((record) => record.metadata.consentReceiptDigest),
      ),
    ].sort();
    const attestation = bundle.attestation;

    if (
      attestation.projectScopeId !== bundle.projectScopeId ||
      attestation.bundleDigest !== bundle.bundleDigest ||
      attestation.recordCount !== bundle.records.length ||
      curationPolicyDigests.length !== 1 ||
      attestation.curationPolicyDigest !== curationPolicyDigests[0] ||
      JSON.stringify(attestation.consentReceiptDigests) !==
        JSON.stringify(consentReceiptDigests)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Patch training bundle attestation does not match its provenance",
        path: ["attestation"],
      });
    }
  });
export type PatchTrainingBundle = z.infer<typeof PatchTrainingBundleSchema>;

export const PatchExperimentScoreSchema = z.strictObject({
  score: z.number().min(0).max(1),
  diff: z.number().min(-1).max(1),
  improvements: z.number().int().nonnegative(),
  regressions: z.number().int().nonnegative(),
});
export type PatchExperimentScore = z.infer<typeof PatchExperimentScoreSchema>;

export const PatchExperimentScoresSchema = z.strictObject({
  terminal: PatchExperimentScoreSchema,
  proofGate: PatchExperimentScoreSchema,
  build: PatchExperimentScoreSchema,
  tests: PatchExperimentScoreSchema,
  requestedChange: PatchExperimentScoreSchema,
  priorRequirements: PatchExperimentScoreSchema,
  accessibility: PatchExperimentScoreSchema,
  performance: PatchExperimentScoreSchema,
  supportedClaims: PatchExperimentScoreSchema,
  minimalPatch: PatchExperimentScoreSchema,
});
export type PatchExperimentScores = z.infer<typeof PatchExperimentScoresSchema>;

export const PatchCheckpointOutcomeSchema = z.strictObject({
  caseId: Sha256Schema,
  outputDigest: Sha256Schema,
  reward: PatchRewardSchema,
});
export type PatchCheckpointOutcome = z.infer<
  typeof PatchCheckpointOutcomeSchema
>;

export const PatchCheckpointAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  role: z.enum(["base", "candidate"]),
  projectScopeId: Sha256Schema,
  dataset: z.strictObject({
    id: OpaqueProviderIdSchema,
    version: OpaqueProviderIdSchema,
    bundleDigest: Sha256Schema,
  }),
  modelResourceDigest: Sha256Schema,
  resultDigest: Sha256Schema,
  signature: Sha256Schema,
});
export type PatchCheckpointAttestation = z.infer<
  typeof PatchCheckpointAttestationSchema
>;

export const PatchCheckpointResultSchema = PatchCheckpointOutcomeSchema.extend({
  attestation: PatchCheckpointAttestationSchema,
});
export type PatchCheckpointResult = z.infer<typeof PatchCheckpointResultSchema>;

const PatchHeldOutComparisonFields = {
  schemaVersion: z.literal(1),
  projectScopeId: Sha256Schema,
  dataset: z.strictObject({
    id: OpaqueProviderIdSchema,
    version: OpaqueProviderIdSchema,
    split: z.literal("heldout"),
    recordCount: z.number().int().positive(),
  }),
  base: z.strictObject({
    modelResource: FireworksModelResourceSchema,
    experimentId: OpaqueProviderIdSchema,
  }),
  candidate: z.strictObject({
    modelResource: FireworksModelResourceSchema,
    experimentId: OpaqueProviderIdSchema,
  }),
  comparisonBaseExperimentId: OpaqueProviderIdSchema,
  comparisonExperimentName: OpaqueProviderIdSchema,
  scores: PatchExperimentScoresSchema,
} as const;

function validateHeldOutComparison(
  comparison: z.infer<
    ReturnType<typeof z.strictObject<typeof PatchHeldOutComparisonFields>>
  >,
  context: z.core.$RefinementCtx,
): void {
  if (comparison.base.modelResource === comparison.candidate.modelResource) {
    context.addIssue({
      code: "custom",
      message: "Base and candidate model resources must differ",
      path: ["candidate", "modelResource"],
    });
  }
  if (comparison.base.experimentId === comparison.candidate.experimentId) {
    context.addIssue({
      code: "custom",
      message: "Base and candidate experiment ids must differ",
      path: ["candidate", "experimentId"],
    });
  }
  if (comparison.comparisonBaseExperimentId !== comparison.base.experimentId) {
    context.addIssue({
      code: "custom",
      message:
        "The Braintrust comparison must be explicitly pinned to the base experiment",
      path: ["comparisonBaseExperimentId"],
    });
  }
}

export const PatchHeldOutComparisonBodySchema = z
  .strictObject(PatchHeldOutComparisonFields)
  .superRefine(validateHeldOutComparison);
export type PatchHeldOutComparisonBody = z.infer<
  typeof PatchHeldOutComparisonBodySchema
>;

export const PatchHeldOutComparisonAttestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("manual-promotion-eligibility"),
  comparisonDigest: Sha256Schema,
  signature: Sha256Schema,
});

export const PatchHeldOutComparisonSchema = z
  .strictObject({
    ...PatchHeldOutComparisonFields,
    attestation: PatchHeldOutComparisonAttestationSchema,
  })
  .superRefine(validateHeldOutComparison);
export type PatchHeldOutComparison = z.infer<
  typeof PatchHeldOutComparisonSchema
>;

export const PatchPromotionDecisionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["blocked", "eligible-for-manual-promotion"]),
  automaticPromotion: z.literal(false),
  promoted: z.literal(false),
  reasons: z.array(z.string().min(1).max(500)).max(50),
  decisionDigest: Sha256Schema,
});
export type PatchPromotionDecision = z.infer<
  typeof PatchPromotionDecisionSchema
>;
