import { createHmac } from "node:crypto";

import {
  init as initBraintrustExperiment,
  initDataset as initBraintrustDataset,
  type AnyDataset,
  type DatasetRecord,
  type ExperimentSummary,
} from "braintrust";
import { z } from "zod";

import { evaluatePatchModelMatrix } from "../../application/patch-model-evaluation.js";
import {
  PATCH_EVALUATION_POLICY,
  PATCH_EVALUATION_POLICY_DIGEST,
  PatchEvaluationModelSchema,
  PatchEvaluationTrialSchema,
  type PatchEvaluationMatrixInput,
  type PatchEvaluationScores,
  type PatchEvaluationTrial,
  type PatchPromotionEligibilityRecord,
} from "../../domain/patch-model-evaluation.js";
import {
  FireworksModelResourceSchema,
  PatchTrainingRecordSchema,
  type PatchTrainingBundle,
  type PatchTrainingRecord,
} from "../../domain/patch-model.js";
import { Sha256Schema } from "../../domain/contract.js";
import { canonicalJson, digestJson } from "../../lib/canonical-json.js";
import {
  assertPatchCheckpointAttestationKey,
  verifyPatchTrainingBundle,
  type PatchCheckpointAttestationKey,
} from "../../lib/patch-checkpoint-attestation.js";
import type { PublishedPatchTrainingBundle } from "./patch-model-experiments.js";

const ProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const MatrixConfigSchema = z.strictObject({
  apiKey: z.string().min(1).max(8_192),
  orgName: z.string().min(1).max(512).optional(),
  eligibilityKeyId: ProviderIdSchema,
});

function keyedProviderDigest(
  key: string | Uint8Array,
  purpose: string,
  value: unknown,
): string {
  return createHmac("sha256", key)
    .update("buildlabs.braintrust.patch-matrix.v1")
    .update("\0")
    .update(purpose)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

const MatrixModelPlanSchema = PatchEvaluationModelSchema.pick({
  role: true,
  label: true,
  modelResource: true,
  capabilitySnapshotDigest: true,
  routerPolicyDigest: true,
  serviceTier: true,
  fallbackReason: true,
  returnedModelResource: true,
});
export type MatrixModelPlan = z.infer<typeof MatrixModelPlanSchema>;

const MatrixTrialInputSchema = PatchEvaluationTrialSchema;
export type MatrixTrialInput = z.infer<typeof MatrixTrialInputSchema>;

export interface BraintrustMatrixDataset {
  bundle: PatchTrainingBundle;
  publication: PublishedPatchTrainingBundle;
}

export interface RecordPatchModelMatrixInput {
  dataset: BraintrustMatrixDataset;
  minimumTrialsPerCase: number;
  minimumTerminalScore: number;
  minimumPairedImprovement: number;
  models: MatrixModelPlan[];
  trialsByModel: ReadonlyMap<string, readonly MatrixTrialInput[]>;
}

interface ExperimentRecord {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  expected: Record<string, unknown>;
  scores: Record<string, number>;
  tags: string[];
  metadata: Record<string, unknown>;
  datasetRecordId: string;
}

interface ExperimentInit {
  project: string;
  experiment: string;
  description: string;
  dataset: unknown;
  metadata: Record<string, unknown>;
  apiKey: string;
  orgName?: string;
  baseExperimentId?: string;
}

interface DatasetInit {
  project: string;
  dataset: string;
  version: string;
  apiKey: string;
  orgName?: string;
}

export interface BraintrustMatrixDatasetHandle {
  readonly id: Promise<string>;
  readonly reference: unknown;
  version(): Promise<string | undefined>;
  records(): Promise<readonly BraintrustMatrixDatasetRecord[]>;
}

export interface BraintrustMatrixDatasetRecord {
  id: string;
  input: unknown;
  expected: unknown;
  tags: unknown;
  metadata: unknown;
}

export interface BraintrustMatrixExperiment {
  readonly id: Promise<string>;
  readonly name: Promise<string>;
  log(record: ExperimentRecord): string;
  flush(): Promise<void>;
  summarize(options: {
    comparisonExperimentId: string;
    summarizeScores: true;
  }): Promise<ExperimentSummary>;
}

export interface BraintrustMatrixSdk {
  initDataset(options: DatasetInit): BraintrustMatrixDatasetHandle;
  initExperiment(options: ExperimentInit): BraintrustMatrixExperiment;
}

function optionalOrgName(
  orgName: string | undefined,
): { orgName: string } | Record<string, never> {
  return orgName ? { orgName } : {};
}

const officialSdk: BraintrustMatrixSdk = {
  initDataset(options) {
    const dataset = initBraintrustDataset({
      project: options.project,
      dataset: options.dataset,
      version: options.version,
      apiKey: options.apiKey,
      ...optionalOrgName(options.orgName),
    });
    return {
      id: dataset.id,
      reference: dataset,
      version: () => dataset.version(),
      records: async () =>
        (await dataset.fetchedData()).map(
          (record: DatasetRecord): BraintrustMatrixDatasetRecord => ({
            id: record.id,
            input: record.input,
            expected: record.expected,
            tags: record.tags,
            metadata: record.metadata,
          }),
        ),
    };
  },
  initExperiment(options) {
    const experiment = initBraintrustExperiment({
      project: options.project,
      experiment: options.experiment,
      description: options.description,
      dataset: options.dataset as AnyDataset,
      metadata: options.metadata,
      apiKey: options.apiKey,
      ...optionalOrgName(options.orgName),
      ...(options.baseExperimentId
        ? { baseExperimentId: options.baseExperimentId }
        : {}),
      gitMetadataSettings: { collect: "none" },
      isPublic: false,
      setCurrent: false,
    });
    return {
      id: experiment.id,
      name: experiment.name,
      log: (record) => experiment.log(record),
      flush: () => experiment.flush(),
      summarize: (options) => experiment.summarize(options),
    };
  },
};

function scoreRecord(scores: PatchEvaluationScores): Record<string, number> {
  return { ...scores };
}

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

function assertBraintrustScoreSummary(
  summary: ExperimentSummary,
  trials: PatchEvaluationTrial[],
  baseTrials: PatchEvaluationTrial[],
): void {
  const baseByKey = new Map(
    baseTrials.map((trial) => [`${trial.caseId}:${trial.trialIndex}`, trial]),
  );
  for (const scoreName of SCORE_NAMES) {
    const score = summary.scores[scoreName];
    const expectedScore =
      trials.reduce((total, trial) => total + trial.scores[scoreName], 0) /
      trials.length;
    const expectedDiff =
      trials.reduce((total, trial) => {
        const base = baseByKey.get(`${trial.caseId}:${trial.trialIndex}`);
        if (base === undefined) {
          throw new Error(
            "Braintrust comparison lacks a paired base observation",
          );
        }
        return total + trial.scores[scoreName] - base.scores[scoreName];
      }, 0) / trials.length;
    if (
      score === undefined ||
      typeof score.score !== "number" ||
      typeof score.diff !== "number" ||
      !Number.isFinite(score.score) ||
      !Number.isFinite(score.diff) ||
      Math.abs(score.score - expectedScore) > 0.000001 ||
      Math.abs(score.diff - expectedDiff) > 0.000001
    ) {
      throw new Error(
        `Braintrust comparison score ${scoreName} does not match controller-attested trials`,
      );
    }
  }
}

function experimentName(
  datasetVersion: string,
  plan: MatrixModelPlan,
  matrixRunDigest: string,
): string {
  return `patch-matrix-${plan.role}-${digestJson({
    datasetVersion,
    matrixRunDigest,
    label: plan.label,
    modelResource: plan.modelResource,
    capabilitySnapshotDigest: plan.capabilitySnapshotDigest,
    routerPolicyDigest: plan.routerPolicyDigest,
    serviceTier: plan.serviceTier,
    fallbackReason: plan.fallbackReason,
    returnedModelResource: plan.returnedModelResource,
  }).slice(0, 20)}`;
}

function validatePlans(plans: MatrixModelPlan[]): {
  base: MatrixModelPlan;
  ordered: MatrixModelPlan[];
} {
  const parsed = plans.map((plan) => MatrixModelPlanSchema.parse(plan));
  const bases = parsed.filter(({ role }) => role === "base");
  const candidates = parsed.filter(({ role }) => role === "candidate");
  const baselines = parsed.filter(({ role }) => role === "baseline");
  if (bases.length !== 1 || candidates.length !== 1 || baselines.length < 1) {
    throw new Error(
      "Braintrust matrix requires one base, one candidate, and a current baseline",
    );
  }
  for (const values of [
    parsed.map(({ label }) => label),
    parsed.map(({ modelResource }) => modelResource),
  ]) {
    if (new Set(values).size !== values.length) {
      throw new Error("Braintrust matrix model pins must be unique");
    }
  }
  return {
    base: bases[0]!,
    ordered: [
      bases[0]!,
      candidates[0]!,
      ...baselines.sort((left, right) => left.label.localeCompare(right.label)),
    ],
  };
}

const ProviderDatasetRecordSchema = z.strictObject({
  id: Sha256Schema,
  input: z.unknown(),
  expected: z.unknown(),
  tags: z.array(z.string().min(1).max(100)).max(20),
  metadata: z.record(z.string(), z.unknown()),
});

function expectedHeldoutDatasetRecords(
  records: PatchTrainingRecord[],
  bundleDigest: string,
): z.infer<typeof ProviderDatasetRecordSchema>[] {
  return records.map((record) =>
    ProviderDatasetRecordSchema.parse({
      id: record.exampleId,
      input: {
        caseId: record.exampleId,
        structural: record.input,
      },
      expected: record.expected,
      tags: ["patch-model", "structural-only", "heldout"],
      metadata: {
        schemaVersion: 1,
        dataUseConsent: record.metadata.dataUseConsent,
        projectScopeId: record.projectScopeId,
        split: "heldout",
        bundleDigest,
        curationPolicyDigest: record.metadata.curationPolicyDigest,
        sourceEvidenceDigest: record.metadata.sourceEvidenceDigest,
        consentReceiptDigest: record.metadata.consentReceiptDigest,
      },
    }),
  );
}

function verifyProviderDatasetRecords(
  input: readonly BraintrustMatrixDatasetRecord[],
  expected: z.infer<typeof ProviderDatasetRecordSchema>[],
): string {
  const actual = input
    .map((record) => ProviderDatasetRecordSchema.parse(record))
    .sort((left, right) => left.id.localeCompare(right.id));
  const orderedExpected = [...expected].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (
    actual.length !== orderedExpected.length ||
    canonicalJson(actual) !== canonicalJson(orderedExpected)
  ) {
    throw new Error(
      "Braintrust pinned held-out dataset content does not match the signed bundle",
    );
  }
  return digestJson(orderedExpected);
}

function validateDataset(
  dataset: BraintrustMatrixDataset,
  attestationKey: PatchCheckpointAttestationKey,
): {
  projectScopeId: string;
  records: PatchTrainingRecord[];
  publication: PublishedPatchTrainingBundle;
  expectedDatasetRecords: z.infer<typeof ProviderDatasetRecordSchema>[];
} {
  const bundle = verifyPatchTrainingBundle(dataset.bundle, attestationKey);
  const records = bundle.records
    .filter(({ split }) => split === "heldout")
    .map((record) => {
      const parsed = PatchTrainingRecordSchema.parse(record);
      if (parsed.split !== "heldout") {
        throw new Error("Braintrust matrix dataset contains a training record");
      }
      return parsed;
    })
    .sort((left, right) => left.exampleId.localeCompare(right.exampleId));
  if (records.length === 0) {
    throw new Error("Braintrust matrix requires held-out records");
  }
  const projectScopeId = records[0]!.projectScopeId;
  if (records.some((record) => record.projectScopeId !== projectScopeId)) {
    throw new Error("Braintrust matrix dataset cannot mix projects");
  }
  const caseIds = records.map(({ exampleId }) => exampleId);
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("Braintrust matrix held-out case ids must be unique");
  }
  const trainingCount = bundle.records.filter(
    ({ split }) => split === "train",
  ).length;
  const publication = dataset.publication;
  const expectedProjectName = `buildlabs-patch-${projectScopeId}`;
  const expectedHeldoutName = `patch-heldout-v1-${bundle.bundleDigest.slice(0, 16)}`;
  const expectedTrainingName = `patch-training-v1-${bundle.bundleDigest.slice(0, 16)}`;
  for (const providerId of [
    publication.training.id,
    publication.training.version,
    publication.heldout.id,
    publication.heldout.version,
  ]) {
    ProviderIdSchema.parse(providerId);
  }
  if (
    publication.projectScopeId !== projectScopeId ||
    publication.projectName !== expectedProjectName ||
    publication.training.projectName !== expectedProjectName ||
    publication.heldout.projectName !== expectedProjectName
  ) {
    throw new Error("Braintrust matrix publication belongs to another project");
  }
  if (
    publication.training.bundleDigest !== bundle.bundleDigest ||
    publication.heldout.bundleDigest !== bundle.bundleDigest ||
    publication.training.split !== "train" ||
    publication.heldout.split !== "heldout" ||
    publication.training.recordCount !== trainingCount ||
    publication.heldout.recordCount !== records.length ||
    publication.training.datasetName !== expectedTrainingName ||
    publication.heldout.datasetName !== expectedHeldoutName ||
    publication.training.id === publication.heldout.id
  ) {
    throw new Error(
      "Braintrust matrix publication does not match the signed bundle",
    );
  }
  Sha256Schema.parse(bundle.bundleDigest);
  return {
    projectScopeId,
    records,
    publication,
    expectedDatasetRecords: expectedHeldoutDatasetRecords(
      records,
      bundle.bundleDigest,
    ),
  };
}

export class BraintrustPatchModelMatrix {
  readonly #apiKey: string;
  readonly #eligibilityKey: string | Uint8Array;
  readonly #eligibilityKeyId: string;
  readonly #checkpointAttestationKey: PatchCheckpointAttestationKey;
  readonly #orgName: string | undefined;
  readonly #sdk: BraintrustMatrixSdk;

  constructor(
    config: {
      apiKey: string;
      orgName?: string;
      eligibilityKeyId: string;
      eligibilityKey: string | Uint8Array;
      checkpointAttestationKey: PatchCheckpointAttestationKey;
    },
    sdk: BraintrustMatrixSdk = officialSdk,
  ) {
    const parsed = MatrixConfigSchema.parse({
      apiKey: config.apiKey,
      eligibilityKeyId: config.eligibilityKeyId,
      ...(config.orgName ? { orgName: config.orgName } : {}),
    });
    const keyBytes =
      typeof config.eligibilityKey === "string"
        ? Buffer.from(config.eligibilityKey, "utf8")
        : config.eligibilityKey;
    if (keyBytes.byteLength < 32) {
      throw new Error("Braintrust matrix eligibility key is too short");
    }
    this.#apiKey = parsed.apiKey;
    this.#eligibilityKey = config.eligibilityKey;
    this.#eligibilityKeyId = parsed.eligibilityKeyId;
    assertPatchCheckpointAttestationKey(config.checkpointAttestationKey);
    this.#checkpointAttestationKey = config.checkpointAttestationKey;
    this.#orgName = parsed.orgName;
    this.#sdk = sdk;
  }

  async recordAndEvaluate(
    rawInput: RecordPatchModelMatrixInput,
  ): Promise<PatchPromotionEligibilityRecord> {
    const { projectScopeId, records, publication, expectedDatasetRecords } =
      validateDataset(rawInput.dataset, this.#checkpointAttestationKey);
    const { ordered } = validatePlans(rawInput.models);
    const plannedResources = new Set(
      ordered.map(({ modelResource }) => modelResource),
    );
    if (
      [...rawInput.trialsByModel.keys()].some(
        (modelResource) => !plannedResources.has(modelResource),
      )
    ) {
      throw new Error(
        "Braintrust matrix trial groups must match the exact pinned model set",
      );
    }
    const caseIds = new Set(records.map(({ exampleId }) => exampleId));
    const parsedTrialsByModel = new Map<string, PatchEvaluationTrial[]>();
    for (const plan of ordered) {
      const modelTrials = rawInput.trialsByModel.get(plan.modelResource);
      if (!modelTrials) {
        throw new Error(`Braintrust matrix is missing ${plan.role} trials`);
      }
      const trials = modelTrials.map((trial) =>
        MatrixTrialInputSchema.parse(trial),
      );
      if (
        trials.some(
          (trial) =>
            trial.modelResource !== plan.modelResource ||
            !caseIds.has(trial.caseId),
        )
      ) {
        throw new Error(
          "Braintrust matrix trial references an unknown case or model",
        );
      }
      parsedTrialsByModel.set(plan.modelResource, trials);
    }

    const datasetIdentity = {
      id: publication.heldout.id,
      version: publication.heldout.version,
      bundleDigest: rawInput.dataset.bundle.bundleDigest,
      split: "heldout" as const,
      recordCount: records.length,
    };
    const orderedTrials = ordered.flatMap((plan) =>
      [...parsedTrialsByModel.get(plan.modelResource)!].sort(
        (left, right) =>
          left.caseId.localeCompare(right.caseId) ||
          left.trialIndex - right.trialIndex,
      ),
    );
    const trialSetDigest = digestJson(orderedTrials);
    const expectedDatasetContentDigest = digestJson(
      [...expectedDatasetRecords].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    );
    const matrixRunDigest = digestJson({
      schemaVersion: 1,
      projectScopeId,
      dataset: datasetIdentity,
      datasetContentDigest: expectedDatasetContentDigest,
      evaluationPolicyDigest: PATCH_EVALUATION_POLICY_DIGEST,
      thresholds: {
        confidenceLevel: PATCH_EVALUATION_POLICY.confidenceLevel,
        minimumTrialsPerCase: rawInput.minimumTrialsPerCase,
        minimumTerminalScore: rawInput.minimumTerminalScore,
        minimumPairedImprovement: rawInput.minimumPairedImprovement,
        minimumBaselineImprovement:
          PATCH_EVALUATION_POLICY.minimumBaselineImprovement,
      },
      models: ordered,
      trialSetDigest,
    });
    const preflightBaseId = "preflight-base";
    const preflightMatrix: PatchEvaluationMatrixInput = {
      schemaVersion: 1,
      projectScopeId,
      dataset: datasetIdentity,
      minimumTrialsPerCase: rawInput.minimumTrialsPerCase,
      confidenceLevel: PATCH_EVALUATION_POLICY.confidenceLevel,
      minimumTerminalScore: rawInput.minimumTerminalScore,
      minimumPairedImprovement: rawInput.minimumPairedImprovement,
      models: ordered.map((plan, index) => ({
        ...plan,
        experimentId:
          plan.role === "base" ? preflightBaseId : `preflight-${index}`,
        comparisonBaseExperimentId:
          plan.role === "base" ? null : preflightBaseId,
      })),
      trials: orderedTrials,
    };
    evaluatePatchModelMatrix(preflightMatrix, {
      keyId: this.#eligibilityKeyId,
      key: this.#eligibilityKey,
    });

    const heldoutDataset = this.#sdk.initDataset({
      project: publication.projectName,
      dataset: publication.heldout.datasetName,
      version: publication.heldout.version,
      apiKey: this.#apiKey,
      ...optionalOrgName(this.#orgName),
    });
    const [resolvedDatasetId, resolvedDatasetVersion, providerRecords] =
      await Promise.all([
        heldoutDataset.id,
        heldoutDataset.version(),
        heldoutDataset.records(),
      ]);
    if (
      resolvedDatasetId !== publication.heldout.id ||
      resolvedDatasetVersion !== publication.heldout.version
    ) {
      throw new Error(
        "Braintrust matrix dataset handle does not match the pinned publication",
      );
    }
    const datasetContentDigest = verifyProviderDatasetRecords(
      providerRecords,
      expectedDatasetRecords,
    );
    if (datasetContentDigest !== expectedDatasetContentDigest) {
      throw new Error(
        "Braintrust pinned held-out dataset digest does not match the signed bundle",
      );
    }
    const providerDigest = (purpose: string, value: unknown) =>
      keyedProviderDigest(this.#eligibilityKey, purpose, value);
    const providerMatrixRunDigest = providerDigest(
      "matrix-run",
      matrixRunDigest,
    );
    const providerTrialSetDigest = providerDigest("trial-set", trialSetDigest);
    const providerDatasetContentDigest = providerDigest(
      "dataset-content",
      datasetContentDigest,
    );

    const experimentIds = new Map<string, string>();
    let baseExperimentId: string | undefined;
    let baseExperimentName: string | undefined;

    for (const plan of ordered) {
      const trials = parsedTrialsByModel.get(plan.modelResource)!;
      const modelTrialDigest = digestJson(
        [...trials].sort(
          (left, right) =>
            left.caseId.localeCompare(right.caseId) ||
            left.trialIndex - right.trialIndex,
        ),
      );
      const fallbackStatus =
        plan.fallbackReason === "preferred" ? "preferred" : "fallback";
      const fallbackReasonDigest = providerDigest(
        "fallback-reason",
        plan.fallbackReason,
      );
      const providerModelTrialDigest = providerDigest(
        "model-trials",
        modelTrialDigest,
      );
      const name = experimentName(
        publication.heldout.version,
        plan,
        providerMatrixRunDigest,
      );
      const experiment = this.#sdk.initExperiment({
        project: publication.projectName,
        experiment: name,
        description:
          "Repeated Patch Model trials with controller-attested, content-free scores.",
        dataset: heldoutDataset.reference,
        metadata: {
          schemaVersion: 1,
          dataClass: "counts-enums-keyed-digests",
          digestKeyId: this.#eligibilityKeyId,
          role: plan.role,
          serviceTier: plan.serviceTier,
          fallbackStatus,
          fallbackReasonDigest,
          modelResourceDigest: providerDigest(
            "model-resource",
            plan.modelResource,
          ),
          returnedModelResourceDigest: providerDigest(
            "returned-model-resource",
            plan.returnedModelResource,
          ),
          capabilitySnapshotDigest: providerDigest(
            "capability-snapshot",
            plan.capabilitySnapshotDigest,
          ),
          routerPolicyDigest: providerDigest(
            "router-policy",
            plan.routerPolicyDigest,
          ),
          datasetVersionDigest: providerDigest(
            "dataset-version",
            publication.heldout.version,
          ),
          bundleDigest: providerDigest(
            "bundle",
            rawInput.dataset.bundle.bundleDigest,
          ),
          datasetContentDigest: providerDatasetContentDigest,
          evaluationPolicyDigest: providerDigest(
            "evaluation-policy",
            PATCH_EVALUATION_POLICY_DIGEST,
          ),
          matrixRunDigest: providerMatrixRunDigest,
          trialSetDigest: providerTrialSetDigest,
          modelTrialDigest: providerModelTrialDigest,
          repeatedTrials: true,
        },
        apiKey: this.#apiKey,
        ...optionalOrgName(this.#orgName),
        ...(baseExperimentId ? { baseExperimentId } : {}),
      });
      for (const trial of trials) {
        experiment.log({
          input: {
            caseId: trial.caseId,
            trialIndex: trial.trialIndex,
            seed: trial.seed,
          },
          output: {
            outputDigest: providerDigest("trial-output", trial.outputDigest),
            evaluatorEvidenceDigest: providerDigest(
              "trial-evaluator-evidence",
              trial.evaluatorEvidenceDigest,
            ),
          },
          expected: {
            proofRequired: true,
            privacyRequired: true,
            supportedClaimsRequired: true,
            minimalPatchRequired: true,
          },
          scores: scoreRecord(trial.scores),
          tags: ["patch-model", "heldout", "repeated-trial", plan.role],
          metadata: {
            schemaVersion: 1,
            digestKeyId: this.#eligibilityKeyId,
            role: plan.role,
            serviceTier: plan.serviceTier,
            fallbackStatus,
            fallbackReasonDigest,
            modelResourceDigest: providerDigest(
              "model-resource",
              plan.modelResource,
            ),
            returnedModelResourceDigest: providerDigest(
              "returned-model-resource",
              plan.returnedModelResource,
            ),
            capabilitySnapshotDigest: providerDigest(
              "capability-snapshot",
              plan.capabilitySnapshotDigest,
            ),
            routerPolicyDigest: providerDigest(
              "router-policy",
              plan.routerPolicyDigest,
            ),
            bundleDigest: providerDigest(
              "bundle",
              rawInput.dataset.bundle.bundleDigest,
            ),
            datasetContentDigest: providerDatasetContentDigest,
            evaluationPolicyDigest: providerDigest(
              "evaluation-policy",
              PATCH_EVALUATION_POLICY_DIGEST,
            ),
            matrixRunDigest: providerMatrixRunDigest,
            trialSetDigest: providerTrialSetDigest,
            modelTrialDigest: providerModelTrialDigest,
            trialAttestationDigest: providerDigest(
              "trial-attestation",
              trial.attestation.trialDigest,
            ),
          },
          datasetRecordId: trial.caseId,
        });
      }
      await experiment.flush();
      const [id, resolvedName] = await Promise.all([
        experiment.id,
        experiment.name,
      ]);
      const safeId = ProviderIdSchema.parse(id);
      if (ProviderIdSchema.parse(resolvedName) !== name) {
        throw new Error("Braintrust matrix experiment identity is invalid");
      }
      experimentIds.set(plan.modelResource, safeId);
      if (plan.role === "base") {
        baseExperimentId = safeId;
        baseExperimentName = name;
      } else {
        if (!baseExperimentId || !baseExperimentName) {
          throw new Error("Braintrust base experiment must be created first");
        }
        const summary = await experiment.summarize({
          comparisonExperimentId: baseExperimentId,
          summarizeScores: true,
        });
        if (
          summary.projectName !== publication.projectName ||
          summary.experimentId !== safeId ||
          summary.experimentName !== name ||
          summary.comparisonExperimentName !== baseExperimentName
        ) {
          throw new Error(
            "Braintrust matrix summary is not pinned to the explicit base experiment",
          );
        }
        assertBraintrustScoreSummary(
          summary,
          trials,
          parsedTrialsByModel.get(ordered[0]!.modelResource)!,
        );
      }
    }

    if (!baseExperimentId) {
      throw new Error("Braintrust matrix did not create a base experiment");
    }
    const models = ordered.map((plan) =>
      PatchEvaluationModelSchema.parse({
        ...plan,
        experimentId: experimentIds.get(plan.modelResource),
        comparisonBaseExperimentId:
          plan.role === "base" ? null : baseExperimentId,
      }),
    );
    const trials: PatchEvaluationTrial[] = ordered.flatMap((plan) =>
      parsedTrialsByModel.get(plan.modelResource)!.map((trial) =>
        PatchEvaluationTrialSchema.parse({
          ...trial,
          modelResource: FireworksModelResourceSchema.parse(plan.modelResource),
        }),
      ),
    );
    const matrix: PatchEvaluationMatrixInput = {
      schemaVersion: 1,
      projectScopeId,
      dataset: {
        ...datasetIdentity,
      },
      minimumTrialsPerCase: rawInput.minimumTrialsPerCase,
      confidenceLevel: PATCH_EVALUATION_POLICY.confidenceLevel,
      minimumTerminalScore: rawInput.minimumTerminalScore,
      minimumPairedImprovement: rawInput.minimumPairedImprovement,
      models,
      trials,
    };
    return evaluatePatchModelMatrix(matrix, {
      keyId: this.#eligibilityKeyId,
      key: this.#eligibilityKey,
    });
  }
}
