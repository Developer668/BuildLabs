import { createHmac, timingSafeEqual } from "node:crypto";
import type { z } from "zod";

import {
  PATCH_EVALUATION_POLICY,
  PATCH_EVALUATION_POLICY_DIGEST,
  PatchEvaluationMatrixInputSchema,
  PatchEvaluationTrialBodySchema,
  PatchEvaluationTrialSchema,
  PatchPromotionEligibilityAttestationSchema,
  PatchPromotionEligibilityBodySchema,
  PatchPromotionEligibilityRecordSchema,
  type PatchConfidenceInterval,
  type PatchEvaluationMatrixInput,
  type PatchEvaluationModel,
  type PatchEvaluationScores,
  type PatchEvaluationSummary,
  type PatchEvaluationTrial,
  type PatchEvaluationVeto,
  type PatchPromotionEligibilityRecord,
} from "../domain/patch-model-evaluation.js";
import { canonicalJson, digestJson } from "../lib/canonical-json.js";

type EligibilityKey = string | Uint8Array;

const SCORE_NAMES = [
  "terminal",
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
] as const satisfies readonly (keyof PatchEvaluationScores)[];

const VETO_COMPONENTS = [
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
] as const satisfies readonly Exclude<
  keyof PatchEvaluationScores,
  "terminal"
>[];

const Z_95 = 1.959963984540054;

function keyBytes(key: EligibilityKey): Uint8Array {
  const bytes =
    typeof key === "string" ? Buffer.from(key, "utf8") : new Uint8Array(key);
  if (bytes.byteLength < 32) {
    throw new Error("Promotion eligibility key must be at least 32 bytes");
  }
  return bytes;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Patch evaluation ${label} must be unique`);
  }
}

function selectModels(models: PatchEvaluationModel[]): {
  base: PatchEvaluationModel;
  candidate: PatchEvaluationModel;
  baselines: PatchEvaluationModel[];
} {
  const bases = models.filter(({ role }) => role === "base");
  const candidates = models.filter(({ role }) => role === "candidate");
  const baselines = models.filter(({ role }) => role === "baseline");
  if (bases.length !== 1 || candidates.length !== 1 || baselines.length < 1) {
    throw new Error(
      "Patch evaluation requires one base, one candidate, and at least one current baseline",
    );
  }
  const base = bases[0]!;
  const candidate = candidates[0]!;
  unique(
    models.map(({ label }) => label),
    "model labels",
  );
  unique(
    models.map(({ modelResource }) => modelResource),
    "model resources",
  );
  unique(
    models.map(({ experimentId }) => experimentId),
    "experiment ids",
  );
  if (base.comparisonBaseExperimentId !== null) {
    throw new Error(
      "Pinned base experiment must not reference another Braintrust baseline",
    );
  }
  for (const model of [candidate, ...baselines]) {
    if (model.comparisonBaseExperimentId !== base.experimentId) {
      throw new Error(
        `${model.role} Braintrust experiment is not pinned to the explicit base experiment`,
      );
    }
  }
  if (
    models.some((model) => model.returnedModelResource !== model.modelResource)
  ) {
    throw new Error(
      "Patch evaluation model pin does not match the returned model",
    );
  }
  return { base, candidate, baselines };
}

function trialSignature(
  body: z.infer<typeof PatchEvaluationTrialBodySchema>,
  key: EligibilityKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-model.evaluation-trial.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function attestPatchEvaluationTrial(
  input: z.input<typeof PatchEvaluationTrialBodySchema>,
  signing: { keyId: string; key: EligibilityKey },
): PatchEvaluationTrial {
  const body = PatchEvaluationTrialBodySchema.parse(input);
  return PatchEvaluationTrialSchema.parse({
    ...body,
    attestation: {
      schemaVersion: 1,
      purpose: "patch-evaluation-trial",
      keyId: signing.keyId,
      trialDigest: digestJson(body),
      signature: trialSignature(body, signing.key),
    },
  });
}

function verifyEvaluationTrial(
  input: PatchEvaluationTrial,
  signing: { keyId: string; key: EligibilityKey },
): PatchEvaluationTrial {
  const trial = PatchEvaluationTrialSchema.parse(input);
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
  const actual = Buffer.from(trial.attestation.signature, "hex");
  const expected = Buffer.from(trialSignature(body, signing.key), "hex");
  if (
    trial.attestation.keyId !== signing.keyId ||
    trial.attestation.trialDigest !== digestJson(body) ||
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Patch evaluation trial attestation is invalid");
  }
  return trial;
}

function trialKey(trial: PatchEvaluationTrial): string {
  return `${trial.caseId}:${trial.trialIndex}`;
}

function validateTrials(
  input: PatchEvaluationMatrixInput,
  models: PatchEvaluationModel[],
  signing: { keyId: string; key: EligibilityKey },
): Map<string, Map<string, PatchEvaluationTrial>> {
  const modelResources = new Set(
    models.map(({ modelResource }) => modelResource),
  );
  if (
    input.trials.some(({ modelResource }) => !modelResources.has(modelResource))
  ) {
    throw new Error("Patch evaluation trial references an unpinned model");
  }

  const byModel = new Map<string, Map<string, PatchEvaluationTrial>>();
  const modelsByResource = new Map(
    models.map((model) => [model.modelResource, model]),
  );
  for (const model of models) {
    byModel.set(model.modelResource, new Map());
  }
  for (const candidateTrial of input.trials) {
    const trial = verifyEvaluationTrial(candidateTrial, signing);
    const model = modelsByResource.get(trial.modelResource);
    if (
      model === undefined ||
      trial.projectScopeId !== input.projectScopeId ||
      trial.datasetId !== input.dataset.id ||
      trial.datasetVersion !== input.dataset.version ||
      trial.bundleDigest !== input.dataset.bundleDigest ||
      trial.evaluationPolicyDigest !== PATCH_EVALUATION_POLICY_DIGEST ||
      trial.role !== model.role ||
      trial.capabilitySnapshotDigest !== model.capabilitySnapshotDigest ||
      trial.routerPolicyDigest !== model.routerPolicyDigest ||
      trial.serviceTier !== model.serviceTier ||
      trial.fallbackReason !== model.fallbackReason ||
      trial.returnedModelResource !== model.returnedModelResource
    ) {
      throw new Error(
        "Patch evaluation trial attestation context does not match the pinned matrix",
      );
    }
    const trials = byModel.get(trial.modelResource)!;
    const key = trialKey(trial);
    if (trials.has(key)) {
      throw new Error("Patch evaluation contains duplicate model trials");
    }
    trials.set(key, trial);
  }

  const reference = byModel.get(models[0]!.modelResource)!;
  const referenceKeys = [...reference.keys()].sort();
  const caseIds = [
    ...new Set([...reference.values()].map(({ caseId }) => caseId)),
  ].sort();
  if (caseIds.length !== input.dataset.recordCount) {
    throw new Error(
      "Patch evaluation trials do not cover the exact pinned held-out dataset",
    );
  }
  let expectedTrialsPerCase: number | undefined;
  for (const model of models) {
    const trials = byModel.get(model.modelResource)!;
    if (
      JSON.stringify([...trials.keys()].sort()) !==
      JSON.stringify(referenceKeys)
    ) {
      throw new Error(
        "Every patch evaluation model must cover the same repeated trials",
      );
    }
    for (const caseId of caseIds) {
      const indices = [...trials.values()]
        .filter((trial) => trial.caseId === caseId)
        .map(({ trialIndex }) => trialIndex)
        .sort((left, right) => left - right);
      if (
        indices.length !== input.minimumTrialsPerCase ||
        indices.some((value, index) => value !== index)
      ) {
        throw new Error(
          "Patch evaluation trials must be contiguous and meet the repeated-trial minimum",
        );
      }
      expectedTrialsPerCase ??= indices.length;
      if (indices.length !== expectedTrialsPerCase) {
        throw new Error(
          "Patch evaluation requires a uniform trial count per case",
        );
      }
    }
  }

  const uniqueSeeds = new Set<number>();
  for (const key of referenceKeys) {
    const seeds = models.map(
      (model) => byModel.get(model.modelResource)!.get(key)!.seed,
    );
    if (new Set(seeds).size !== 1) {
      throw new Error(
        "Paired patch evaluation trials must use the same controller seed",
      );
    }
    if (uniqueSeeds.has(seeds[0]!)) {
      throw new Error(
        "Patch evaluation controller seeds must be unique across trials",
      );
    }
    uniqueSeeds.add(seeds[0]!);
  }
  return byModel;
}

function interval(
  values: number[],
  bounds: readonly [number, number],
): PatchConfidenceInterval {
  if (values.length === 0) {
    throw new Error(
      "Patch evaluation confidence interval requires observations",
    );
  }
  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.length === 1
      ? 0
      : values.reduce((total, value) => total + (value - mean) ** 2, 0) /
        (values.length - 1);
  const margin = Z_95 * Math.sqrt(variance / values.length);
  const stable = (value: number) => Number(value.toFixed(12));
  return {
    count: values.length,
    mean: stable(mean),
    lowerBound: stable(Math.max(bounds[0], mean - margin)),
    upperBound: stable(Math.min(bounds[1], mean + margin)),
  };
}

function summarizeModel(
  model: PatchEvaluationModel,
  trials: PatchEvaluationTrial[],
): PatchEvaluationSummary {
  const caseIds = [...new Set(trials.map(({ caseId }) => caseId))].sort();
  const scoreIntervals = Object.fromEntries(
    SCORE_NAMES.map((scoreName) => [
      scoreName,
      interval(
        caseIds.map((caseId) => {
          const caseTrials = trials.filter((trial) => trial.caseId === caseId);
          return (
            caseTrials.reduce(
              (total, trial) => total + trial.scores[scoreName],
              0,
            ) / caseTrials.length
          );
        }),
        [0, 1],
      ),
    ]),
  ) as PatchEvaluationSummary["scores"];
  return {
    role: model.role,
    label: model.label,
    modelResource: model.modelResource,
    experimentId: model.experimentId,
    scores: scoreIntervals,
  };
}

function eligibilitySignature(
  body: z.infer<typeof PatchPromotionEligibilityBodySchema>,
  key: EligibilityKey,
): string {
  return createHmac("sha256", keyBytes(key))
    .update("buildlabs.patch-model.promotion-eligibility.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

export function evaluatePatchModelMatrix(
  rawInput: PatchEvaluationMatrixInput,
  signing: { keyId: string; key: EligibilityKey },
): PatchPromotionEligibilityRecord {
  const input = PatchEvaluationMatrixInputSchema.parse(rawInput);
  const { base, candidate, baselines } = selectModels(input.models);
  const byModel = validateTrials(input, input.models, signing);
  const summaries = input.models
    .map((model) =>
      summarizeModel(model, [...byModel.get(model.modelResource)!.values()]),
    )
    .sort((left, right) => {
      const order = { base: 0, candidate: 1, baseline: 2 };
      return (
        order[left.role] - order[right.role] ||
        left.label.localeCompare(right.label)
      );
    });

  const baseTrials = byModel.get(base.modelResource)!;
  const candidateTrials = byModel.get(candidate.modelResource)!;
  const caseIds = [
    ...new Set([...baseTrials.values()].map(({ caseId }) => caseId)),
  ].sort();
  const pairedDifferences = caseIds.map((caseId) => {
    const baseCase = [...baseTrials.values()].filter(
      (trial) => trial.caseId === caseId,
    );
    const candidateCase = [...candidateTrials.values()].filter(
      (trial) => trial.caseId === caseId,
    );
    return (
      candidateCase.reduce((total, trial) => total + trial.scores.terminal, 0) /
        candidateCase.length -
      baseCase.reduce((total, trial) => total + trial.scores.terminal, 0) /
        baseCase.length
    );
  });
  const pairedTerminalImprovement = interval(pairedDifferences, [-1, 1]);
  const pairedBaselineImprovements = baselines
    .map((baseline) => {
      const baselineTrials = byModel.get(baseline.modelResource)!;
      const differences = caseIds.map((caseId) => {
        const candidateValues = [...candidateTrials.values()].filter(
          (trial) => trial.caseId === caseId,
        );
        const baselineValues = [...baselineTrials.values()].filter(
          (trial) => trial.caseId === caseId,
        );
        return (
          candidateValues.reduce(
            (total, trial) => total + trial.scores.terminal,
            0,
          ) /
            candidateValues.length -
          baselineValues.reduce(
            (total, trial) => total + trial.scores.terminal,
            0,
          ) /
            baselineValues.length
        );
      });
      return {
        baselineModelResource: baseline.modelResource,
        terminalImprovement: interval(differences, [-1, 1]),
      };
    })
    .sort((left, right) =>
      left.baselineModelResource.localeCompare(right.baselineModelResource),
    );

  const vetoes: PatchEvaluationVeto[] = [];
  for (const [key, candidateTrial] of [...candidateTrials.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const baseTrial = baseTrials.get(key)!;
    for (const component of VETO_COMPONENTS) {
      if (candidateTrial.scores[component] === 0) {
        vetoes.push({
          caseId: candidateTrial.caseId,
          trialIndex: candidateTrial.trialIndex,
          component,
          reason:
            candidateTrial.scores[component] < baseTrial.scores[component]
              ? "regression-against-pinned-base"
              : "candidate-failure",
        });
      }
    }
  }

  const candidateSummary = summaries.find(({ role }) => role === "candidate")!;
  const reasons: string[] = [];
  if (input.dataset.recordCount < PATCH_EVALUATION_POLICY.minimumHeldoutCases) {
    reasons.push(
      `Held-out dataset has ${input.dataset.recordCount} cases; ${PATCH_EVALUATION_POLICY.minimumHeldoutCases} required`,
    );
  }
  if (
    candidateSummary.scores.terminal.lowerBound < input.minimumTerminalScore
  ) {
    reasons.push(
      `Candidate terminal 95% confidence lower bound ${candidateSummary.scores.terminal.lowerBound} is below ${input.minimumTerminalScore}`,
    );
  }
  for (const comparison of pairedBaselineImprovements) {
    if (
      comparison.terminalImprovement.lowerBound <
      PATCH_EVALUATION_POLICY.minimumBaselineImprovement
    ) {
      reasons.push(
        `Candidate regresses against current baseline ${comparison.baselineModelResource}`,
      );
    }
  }
  if (pairedTerminalImprovement.lowerBound < input.minimumPairedImprovement) {
    reasons.push(
      `Paired 95% confidence lower bound ${pairedTerminalImprovement.lowerBound} is below ${input.minimumPairedImprovement}`,
    );
  }
  for (const component of VETO_COMPONENTS) {
    if (vetoes.some((veto) => veto.component === component)) {
      reasons.push(`${component} has a non-averageable candidate veto`);
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const status =
    uniqueReasons.length === 0 ? "eligible-for-manual-promotion" : "blocked";
  const body = PatchPromotionEligibilityBodySchema.parse({
    schemaVersion: 1,
    projectScopeId: input.projectScopeId,
    dataset: {
      id: input.dataset.id,
      version: input.dataset.version,
      bundleDigest: input.dataset.bundleDigest,
      recordCount: input.dataset.recordCount,
    },
    matrixDigest: digestJson(input),
    baseModelResource: base.modelResource,
    candidateModelResource: candidate.modelResource,
    baselineModelResources: baselines
      .map(({ modelResource }) => modelResource)
      .sort(),
    confidenceLevel: input.confidenceLevel,
    minimumTrialsPerCase: input.minimumTrialsPerCase,
    evaluationPolicyDigest: PATCH_EVALUATION_POLICY_DIGEST,
    thresholds: {
      minimumHeldoutCases: PATCH_EVALUATION_POLICY.minimumHeldoutCases,
      minimumTerminalScore: input.minimumTerminalScore,
      minimumPairedImprovement: input.minimumPairedImprovement,
      minimumBaselineImprovement:
        PATCH_EVALUATION_POLICY.minimumBaselineImprovement,
    },
    summaries,
    pairedTerminalImprovement,
    pairedBaselineImprovements,
    vetoes,
    status,
    automaticPromotion: false,
    promoted: false,
    reasons: uniqueReasons,
  });
  return PatchPromotionEligibilityRecordSchema.parse({
    ...body,
    attestation: {
      schemaVersion: 1,
      purpose: "manual-promotion-eligibility",
      keyId: signing.keyId,
      recordDigest: digestJson(body),
      signature: eligibilitySignature(body, signing.key),
    },
  });
}

export function verifyPatchPromotionEligibility(
  input: PatchPromotionEligibilityRecord,
  signing: { keyId: string; key: EligibilityKey },
): PatchPromotionEligibilityRecord {
  const record = PatchPromotionEligibilityRecordSchema.parse(input);
  const body = PatchPromotionEligibilityBodySchema.parse({
    schemaVersion: record.schemaVersion,
    projectScopeId: record.projectScopeId,
    dataset: record.dataset,
    matrixDigest: record.matrixDigest,
    baseModelResource: record.baseModelResource,
    candidateModelResource: record.candidateModelResource,
    baselineModelResources: record.baselineModelResources,
    confidenceLevel: record.confidenceLevel,
    minimumTrialsPerCase: record.minimumTrialsPerCase,
    evaluationPolicyDigest: record.evaluationPolicyDigest,
    thresholds: record.thresholds,
    summaries: record.summaries,
    pairedTerminalImprovement: record.pairedTerminalImprovement,
    pairedBaselineImprovements: record.pairedBaselineImprovements,
    vetoes: record.vetoes,
    status: record.status,
    automaticPromotion: record.automaticPromotion,
    promoted: record.promoted,
    reasons: record.reasons,
  });
  const attestation = PatchPromotionEligibilityAttestationSchema.parse(
    record.attestation,
  );
  if (
    attestation.keyId !== signing.keyId ||
    attestation.recordDigest !== digestJson(body)
  ) {
    throw new Error("Patch promotion eligibility attestation does not match");
  }
  const actual = Buffer.from(attestation.signature, "hex");
  const expected = Buffer.from(eligibilitySignature(body, signing.key), "hex");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Patch promotion eligibility signature is invalid");
  }
  return record;
}
