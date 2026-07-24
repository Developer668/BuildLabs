import { describe, expect, it } from "vitest";

import {
  attestPatchEvaluationTrial,
  evaluatePatchModelMatrix,
  verifyPatchPromotionEligibility,
} from "../src/application/patch-model-evaluation.js";
import {
  PATCH_EVALUATION_POLICY,
  PATCH_EVALUATION_POLICY_DIGEST,
  type PatchEvaluationModel,
  type PatchEvaluationMatrixInput,
  type PatchEvaluationScores,
} from "../src/domain/patch-model-evaluation.js";
import { sha256 } from "../src/lib/canonical-json.js";

const KEY = "patch-evaluation-controller-key!".repeat(2);
const SIGNING = { keyId: "buildlabs-controller-v1", key: KEY };
const BASE = "accounts/fireworks/models/kimi-k2p6";
const CANDIDATE = "accounts/buildlabs/models/patch-model-checkpoint-v1";
const BASELINE = "accounts/fireworks/models/glm-5p2";
const PROJECT_SCOPE = sha256("project-scope");
const DATASET = {
  id: "dataset-heldout",
  version: "version-immutable-1",
  bundleDigest: sha256("provider-bundle"),
  split: "heldout" as const,
  recordCount: 20,
};

function scores(terminal: number): PatchEvaluationScores {
  return {
    terminal,
    proofGate: 1,
    privacy: 1,
    build: 1,
    tests: 1,
    requestedChange: 1,
    priorRequirements: 1,
    accessibility: 1,
    performance: 1,
    supportedClaims: 1,
    minimalPatch: 1,
  };
}

function matrix(): PatchEvaluationMatrixInput {
  const baseExperimentId = "experiment-base";
  const models: PatchEvaluationModel[] = [
    {
      role: "base" as const,
      label: "pinned-base",
      modelResource: BASE,
      experimentId: baseExperimentId,
      comparisonBaseExperimentId: null,
      capabilitySnapshotDigest: sha256("base-capabilities"),
      routerPolicyDigest: sha256("router-policy"),
      serviceTier: "standard" as const,
      fallbackReason: "preferred",
      returnedModelResource: BASE,
    },
    {
      role: "candidate" as const,
      label: "candidate-checkpoint",
      modelResource: CANDIDATE,
      experimentId: "experiment-candidate",
      comparisonBaseExperimentId: baseExperimentId,
      capabilitySnapshotDigest: sha256("candidate-capabilities"),
      routerPolicyDigest: sha256("router-policy"),
      serviceTier: "standard" as const,
      fallbackReason: "preferred",
      returnedModelResource: CANDIDATE,
    },
    {
      role: "baseline" as const,
      label: "current-glm-baseline",
      modelResource: BASELINE,
      experimentId: "experiment-current-baseline",
      comparisonBaseExperimentId: baseExperimentId,
      capabilitySnapshotDigest: sha256("baseline-capabilities"),
      routerPolicyDigest: sha256("router-policy"),
      serviceTier: "standard" as const,
      fallbackReason: "preferred",
      returnedModelResource: BASELINE,
    },
  ];
  const trials = [];
  for (let caseIndex = 0; caseIndex < 20; caseIndex += 1) {
    const caseId = sha256(`case:${caseIndex}`);
    for (let trialIndex = 0; trialIndex < 3; trialIndex += 1) {
      const seed = caseIndex * 100 + trialIndex;
      for (const model of models) {
        const terminal =
          model.role === "candidate" ? 1 : model.role === "base" ? 0.8 : 0.75;
        trials.push(
          attestPatchEvaluationTrial(
            {
              projectScopeId: PROJECT_SCOPE,
              datasetId: DATASET.id,
              datasetVersion: DATASET.version,
              bundleDigest: DATASET.bundleDigest,
              evaluationPolicyDigest: PATCH_EVALUATION_POLICY_DIGEST,
              role: model.role,
              caseId,
              trialIndex,
              seed,
              modelResource: model.modelResource,
              capabilitySnapshotDigest: model.capabilitySnapshotDigest,
              routerPolicyDigest: model.routerPolicyDigest,
              serviceTier: model.serviceTier,
              fallbackReason: model.fallbackReason,
              returnedModelResource: model.returnedModelResource,
              outputDigest: sha256(
                `${caseId}:${trialIndex}:${model.modelResource}:output`,
              ),
              evaluatorEvidenceDigest: sha256(
                `${caseId}:${trialIndex}:${model.modelResource}:evidence`,
              ),
              scores: scores(terminal),
            },
            SIGNING,
          ),
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    projectScopeId: PROJECT_SCOPE,
    dataset: DATASET,
    minimumTrialsPerCase: 3,
    confidenceLevel: 0.95,
    minimumTerminalScore: 0.8,
    minimumPairedImprovement: 0.02,
    models,
    trials,
  };
}

describe("Patch Model repeated-trial evaluation", () => {
  it("signs a confidence-aware manual eligibility record", () => {
    const record = evaluatePatchModelMatrix(matrix(), SIGNING);

    expect(record).toMatchObject({
      status: "eligible-for-manual-promotion",
      automaticPromotion: false,
      promoted: false,
      baseModelResource: BASE,
      candidateModelResource: CANDIDATE,
      baselineModelResources: [BASELINE],
      confidenceLevel: 0.95,
      minimumTrialsPerCase: 3,
      evaluationPolicyDigest: PATCH_EVALUATION_POLICY_DIGEST,
      thresholds: {
        minimumHeldoutCases: PATCH_EVALUATION_POLICY.minimumHeldoutCases,
        minimumTerminalScore: 0.8,
        minimumPairedImprovement: 0.02,
        minimumBaselineImprovement:
          PATCH_EVALUATION_POLICY.minimumBaselineImprovement,
      },
      vetoes: [],
    });
    expect(record.summaries).toHaveLength(3);
    expect(record.pairedTerminalImprovement).toMatchObject({
      count: 20,
      mean: 0.2,
      lowerBound: 0.2,
      upperBound: 0.2,
    });
    expect(record.pairedBaselineImprovements).toEqual([
      {
        baselineModelResource: BASELINE,
        terminalImprovement: {
          count: 20,
          mean: 0.25,
          lowerBound: 0.25,
          upperBound: 0.25,
        },
      },
    ]);
    expect(verifyPatchPromotionEligibility(record, SIGNING)).toEqual(record);
  });

  it("rejects a Braintrust comparison pinned to the wrong base", () => {
    const input = matrix();
    input.models[1]!.comparisonBaseExperimentId = "experiment-wrong";
    expect(() => evaluatePatchModelMatrix(input, SIGNING)).toThrow(
      "not pinned to the explicit base experiment",
    );
  });

  it("rejects a zero improvement threshold before eligibility can be signed", () => {
    const input = matrix();
    input.minimumPairedImprovement = 0;

    expect(() => evaluatePatchModelMatrix(input, SIGNING)).toThrow();
  });

  it("rejects a valid trial signature replayed from another dataset context", () => {
    const input = matrix();
    const index = input.trials.findIndex(
      (trial) => trial.modelResource === CANDIDATE,
    );
    const original = input.trials[index]!;
    const { attestation: _attestation, ...body } = original;
    void _attestation;
    input.trials[index] = attestPatchEvaluationTrial(
      {
        ...body,
        datasetVersion: "version-immutable-other",
      },
      SIGNING,
    );

    expect(() => evaluatePatchModelMatrix(input, SIGNING)).toThrow(
      "attestation context does not match the pinned matrix",
    );
  });

  it.each(["proofGate", "privacy", "supportedClaims", "minimalPatch"] as const)(
    "never averages away a %s veto",
    (component) => {
      const input = matrix();
      const trial = input.trials.find(
        (candidate) => candidate.modelResource === CANDIDATE,
      )!;
      const scoresWithVeto = { ...trial.scores, [component]: 0 as const };
      const index = input.trials.indexOf(trial);
      input.trials[index] = attestPatchEvaluationTrial(
        {
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
          scores: scoresWithVeto,
        },
        SIGNING,
      );
      const attestedTrial = input.trials[index];

      const record = evaluatePatchModelMatrix(input, SIGNING);

      expect(record.status).toBe("blocked");
      expect(record.reasons).toContain(
        `${component} has a non-averageable candidate veto`,
      );
      expect(record.vetoes).toContainEqual({
        caseId: attestedTrial.caseId,
        trialIndex: attestedTrial.trialIndex,
        component,
        reason: "regression-against-pinned-base",
      });
      expect(
        record.summaries.find(({ role }) => role === "candidate")!.scores
          .terminal.mean,
      ).toBe(1);
    },
  );

  it("requires identical repeated trials and controller seeds", () => {
    const missing = matrix();
    const index = missing.trials.findIndex(
      (trial) =>
        trial.modelResource === CANDIDATE &&
        trial.caseId === sha256("case:0") &&
        trial.trialIndex === 2,
    );
    missing.trials.splice(index, 1);
    expect(() => evaluatePatchModelMatrix(missing, SIGNING)).toThrow(
      "same repeated trials",
    );

    const wrongSeed = matrix();
    const wrongIndex = wrongSeed.trials.findIndex(
      (trial) => trial.modelResource === CANDIDATE,
    );
    const original = wrongSeed.trials[wrongIndex]!;
    wrongSeed.trials[wrongIndex] = attestPatchEvaluationTrial(
      {
        projectScopeId: original.projectScopeId,
        datasetId: original.datasetId,
        datasetVersion: original.datasetVersion,
        bundleDigest: original.bundleDigest,
        evaluationPolicyDigest: original.evaluationPolicyDigest,
        role: original.role,
        caseId: original.caseId,
        trialIndex: original.trialIndex,
        seed: original.seed + 1,
        modelResource: original.modelResource,
        capabilitySnapshotDigest: original.capabilitySnapshotDigest,
        routerPolicyDigest: original.routerPolicyDigest,
        serviceTier: original.serviceTier,
        fallbackReason: original.fallbackReason,
        returnedModelResource: original.returnedModelResource,
        outputDigest: original.outputDigest,
        evaluatorEvidenceDigest: original.evaluatorEvidenceDigest,
        scores: original.scores,
      },
      SIGNING,
    );
    expect(() => evaluatePatchModelMatrix(wrongSeed, SIGNING)).toThrow(
      "same controller seed",
    );
  });

  it("fails verification after eligibility or routing evidence tampering", () => {
    const record = evaluatePatchModelMatrix(matrix(), SIGNING);
    record.attestation.signature = "0".repeat(64);
    expect(() => verifyPatchPromotionEligibility(record, SIGNING)).toThrow(
      "signature is invalid",
    );

    const input = matrix();
    input.models[1]!.capabilitySnapshotDigest = sha256(
      "different-capability-snapshot",
    );
    expect(() => evaluatePatchModelMatrix(input, SIGNING)).toThrow(
      "attestation context does not match the pinned matrix",
    );
  });
});
