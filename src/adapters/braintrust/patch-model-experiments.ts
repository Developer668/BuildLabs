import {
  init as initBraintrustExperiment,
  initDataset as initBraintrustDataset,
  type AnyDataset,
  type ExperimentSummary,
} from "braintrust";
import { z } from "zod";

import {
  FireworksModelResourceSchema,
  PatchExperimentScoresSchema,
  PatchHeldOutComparisonBodySchema,
  type PatchCheckpointResult,
  type PatchExperimentScores,
  type PatchHeldOutComparison,
  type PatchTrainingBundle,
  type PatchTrainingRecord,
} from "../../domain/patch-model.js";
import { digestJson, sha256 } from "../../lib/canonical-json.js";
import {
  assertPatchCheckpointAttestationKey,
  attestPatchHeldOutComparison,
  verifyPatchCheckpointResult,
  verifyPatchTrainingBundle,
  type PatchCheckpointAttestationContext,
  type PatchCheckpointAttestationKey,
} from "../../lib/patch-checkpoint-attestation.js";

const SCORE_NAMES = [
  "terminal",
  "proofGate",
  "build",
  "tests",
  "requestedChange",
  "priorRequirements",
  "accessibility",
  "performance",
  "supportedClaims",
  "minimalPatch",
] as const satisfies readonly (keyof PatchExperimentScores)[];

const BraintrustConfigSchema = z.strictObject({
  apiKey: z.string().min(1).max(8_192),
  orgName: z.string().min(1).max(512).optional(),
});
interface BraintrustPatchModelConfig extends z.input<
  typeof BraintrustConfigSchema
> {
  checkpointAttestationKey: PatchCheckpointAttestationKey;
}
const BraintrustProviderIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

interface BraintrustDatasetRecord {
  id: string;
  input: unknown;
  expected: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
}

interface BraintrustExperimentRecord {
  input: unknown;
  output: unknown;
  expected: unknown;
  scores: Record<string, number>;
  tags: string[];
  metadata: Record<string, unknown>;
  datasetRecordId: string;
}

export interface BraintrustPatchDatasetHandle {
  readonly id: Promise<string>;
  readonly reference: unknown;
  insert(record: BraintrustDatasetRecord): string;
  flush(): Promise<void>;
  version(): Promise<string | undefined>;
}

export interface BraintrustPatchExperimentHandle {
  readonly id: Promise<string>;
  readonly name: Promise<string>;
  log(record: BraintrustExperimentRecord): string;
  flush(): Promise<void>;
  summarize(options: {
    comparisonExperimentId: string;
    summarizeScores: true;
  }): Promise<ExperimentSummary>;
}

interface DatasetInitOptions {
  project: string;
  dataset: string;
  description: string;
  metadata: Record<string, unknown>;
  apiKey: string;
  orgName?: string;
  version?: string;
}

interface ExperimentInitOptions {
  project: string;
  experiment: string;
  description: string;
  dataset: unknown;
  metadata: Record<string, unknown>;
  apiKey: string;
  orgName?: string;
  baseExperimentId?: string;
}

export interface BraintrustPatchModelSdk {
  initDataset(options: DatasetInitOptions): BraintrustPatchDatasetHandle;
  initExperiment(
    options: ExperimentInitOptions,
  ): BraintrustPatchExperimentHandle;
}

function optionalOrgName(
  orgName: string | undefined,
): { orgName: string } | Record<string, never> {
  return orgName ? { orgName } : {};
}

const officialBraintrustSdk: BraintrustPatchModelSdk = {
  initDataset(options) {
    const dataset = initBraintrustDataset({
      project: options.project,
      dataset: options.dataset,
      description: options.description,
      metadata: options.metadata,
      apiKey: options.apiKey,
      ...optionalOrgName(options.orgName),
      ...(options.version ? { version: options.version } : {}),
    });
    return {
      id: dataset.id,
      reference: dataset,
      insert: (record) => dataset.insert(record),
      flush: () => dataset.flush(),
      version: () => dataset.version(),
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
      summarize: (summaryOptions) => experiment.summarize(summaryOptions),
    };
  },
};

export interface PublishedPatchDataset {
  projectName: string;
  datasetName: string;
  id: string;
  version: string;
  split: "heldout" | "train";
  recordCount: number;
  bundleDigest: string;
}

export interface PublishedPatchTrainingBundle {
  projectScopeId: string;
  projectName: string;
  training: PublishedPatchDataset;
  heldout: PublishedPatchDataset;
}

export interface RecordHeldOutComparisonInput {
  bundle: PatchTrainingBundle;
  publication: PublishedPatchTrainingBundle;
  baseModelResource: string;
  candidateModelResource: string;
  baseResults: PatchCheckpointResult[];
  candidateResults: PatchCheckpointResult[];
}

function projectName(projectScopeId: string): string {
  return `buildlabs-patch-${projectScopeId}`;
}

function datasetName(split: "heldout" | "train", bundleDigest: string): string {
  const label = split === "train" ? "training" : "heldout";
  return `patch-${label}-v1-${bundleDigest.slice(0, 16)}`;
}

function scores(result: PatchCheckpointResult): Record<string, number> {
  return {
    terminal: result.reward.terminal,
    proofGate: result.reward.components.proofGate,
    build: result.reward.components.build,
    tests: result.reward.components.tests,
    requestedChange: result.reward.components.requestedChange,
    priorRequirements: result.reward.components.priorRequirements,
    accessibility: result.reward.components.accessibility,
    performance: result.reward.components.performance,
    supportedClaims: result.reward.components.supportedClaims,
    minimalPatch: result.reward.components.minimalPatch,
  };
}

function validateResults(
  records: PatchTrainingRecord[],
  input: PatchCheckpointResult[],
  label: string,
  context: PatchCheckpointAttestationContext,
  attestationKey: PatchCheckpointAttestationKey,
): Map<string, PatchCheckpointResult> {
  const results = input.map((result) =>
    verifyPatchCheckpointResult(result, context, attestationKey),
  );
  const resultIds = results.map((result) => result.caseId);
  if (new Set(resultIds).size !== resultIds.length) {
    throw new Error(`${label} results contain duplicate held-out case ids`);
  }

  const expectedIds = new Set(records.map((record) => record.exampleId));
  if (
    results.length !== records.length ||
    results.some((result) => !expectedIds.has(result.caseId))
  ) {
    throw new Error(
      `${label} results must cover the exact pinned held-out dataset`,
    );
  }
  return new Map(results.map((result) => [result.caseId, result]));
}

function normalizeSummary(summary: ExperimentSummary): PatchExperimentScores {
  const normalized: Partial<Record<keyof PatchExperimentScores, unknown>> = {};

  for (const scoreName of SCORE_NAMES) {
    const score = summary.scores[scoreName];
    if (!score || score.diff === undefined) {
      throw new Error(
        `Braintrust comparison is missing a diff for ${scoreName}`,
      );
    }
    normalized[scoreName] = {
      score: score.score,
      diff: score.diff,
      improvements: score.improvements,
      regressions: score.regressions,
    };
  }

  return PatchExperimentScoresSchema.parse(normalized);
}

export class BraintrustPatchModelExperiments {
  readonly #apiKey: string;
  readonly #checkpointAttestationKey: PatchCheckpointAttestationKey;
  readonly #orgName: string | undefined;
  readonly #sdk: BraintrustPatchModelSdk;

  constructor(
    config: BraintrustPatchModelConfig,
    sdk: BraintrustPatchModelSdk = officialBraintrustSdk,
  ) {
    const parsed = BraintrustConfigSchema.parse({
      apiKey: config.apiKey,
      ...(config.orgName ? { orgName: config.orgName } : {}),
    });
    this.#apiKey = parsed.apiKey;
    assertPatchCheckpointAttestationKey(config.checkpointAttestationKey);
    this.#checkpointAttestationKey = config.checkpointAttestationKey;
    this.#orgName = parsed.orgName;
    this.#sdk = sdk;
  }

  async publishStructuralBundle(
    input: PatchTrainingBundle,
  ): Promise<PublishedPatchTrainingBundle> {
    const bundle = verifyPatchTrainingBundle(
      input,
      this.#checkpointAttestationKey,
    );
    const trainingRecords = bundle.records.filter(
      (record) => record.split === "train",
    );
    const heldoutRecords = bundle.records.filter(
      (record) => record.split === "heldout",
    );
    if (trainingRecords.length === 0 || heldoutRecords.length === 0) {
      throw new Error(
        "Braintrust publication requires non-empty train and held-out partitions",
      );
    }

    const name = projectName(bundle.projectScopeId);
    const [training, heldout] = await Promise.all([
      this.#publishSplit(name, bundle, "train", trainingRecords),
      this.#publishSplit(name, bundle, "heldout", heldoutRecords),
    ]);
    return {
      projectScopeId: bundle.projectScopeId,
      projectName: name,
      training,
      heldout,
    };
  }

  async recordHeldOutComparison(
    input: RecordHeldOutComparisonInput,
  ): Promise<PatchHeldOutComparison> {
    const bundle = verifyPatchTrainingBundle(
      input.bundle,
      this.#checkpointAttestationKey,
    );
    const baseModelResource = FireworksModelResourceSchema.parse(
      input.baseModelResource,
    );
    const candidateModelResource = FireworksModelResourceSchema.parse(
      input.candidateModelResource,
    );
    if (baseModelResource === candidateModelResource) {
      throw new Error("Base and candidate Fireworks models must differ");
    }

    const heldoutRecords = bundle.records
      .filter((record) => record.split === "heldout")
      .sort((left, right) => left.exampleId.localeCompare(right.exampleId));
    this.#assertPublication(bundle, input.publication, heldoutRecords.length);
    const attestationDataset = {
      id: input.publication.heldout.id,
      version: input.publication.heldout.version,
      bundleDigest: bundle.bundleDigest,
    };
    const baseResults = validateResults(
      heldoutRecords,
      input.baseResults,
      "Base",
      {
        role: "base",
        projectScopeId: bundle.projectScopeId,
        dataset: attestationDataset,
        modelResource: baseModelResource,
      },
      this.#checkpointAttestationKey,
    );
    const candidateResults = validateResults(
      heldoutRecords,
      input.candidateResults,
      "Candidate",
      {
        role: "candidate",
        projectScopeId: bundle.projectScopeId,
        dataset: attestationDataset,
        modelResource: candidateModelResource,
      },
      this.#checkpointAttestationKey,
    );

    const heldoutDataset = this.#sdk.initDataset({
      project: input.publication.projectName,
      dataset: input.publication.heldout.datasetName,
      description:
        "Pinned structural-only held-out cases for Patch Model promotion.",
      metadata: this.#datasetMetadata(bundle, "heldout"),
      apiKey: this.#apiKey,
      ...optionalOrgName(this.#orgName),
      version: input.publication.heldout.version,
    });
    const [resolvedDatasetId, resolvedDatasetVersion] = await Promise.all([
      heldoutDataset.id,
      heldoutDataset.version(),
    ]);
    if (
      resolvedDatasetId !== input.publication.heldout.id ||
      resolvedDatasetVersion !== input.publication.heldout.version
    ) {
      throw new Error(
        "Braintrust held-out dataset handle does not match the pinned publication",
      );
    }
    const resultDigest = digestJson({
      base: [...baseResults.values()].map((result) => ({
        caseId: result.caseId,
        outputDigest: result.outputDigest,
        reward: result.reward,
      })),
      candidate: [...candidateResults.values()].map((result) => ({
        caseId: result.caseId,
        outputDigest: result.outputDigest,
        reward: result.reward,
      })),
    }).slice(0, 12);
    const versionDigest = sha256(input.publication.heldout.version).slice(
      0,
      12,
    );
    const baseModelDigest = sha256(baseModelResource);
    const candidateModelDigest = sha256(candidateModelResource);
    const baseExperimentName = `patch-base-${baseModelDigest.slice(0, 12)}-${versionDigest}-${resultDigest}`;
    const candidateExperimentName = `patch-candidate-${candidateModelDigest.slice(0, 12)}-${versionDigest}-${resultDigest}`;

    const baseExperiment = this.#sdk.initExperiment({
      project: input.publication.projectName,
      experiment: baseExperimentName,
      description:
        "Base Fireworks Patch Model evaluated on a pinned structural held-out dataset.",
      dataset: heldoutDataset.reference,
      metadata: {
        schemaVersion: 1,
        dataClass: "anonymized-structural-only",
        dataUseConsent: "granted",
        split: "heldout",
        role: "base",
        modelResourceDigest: baseModelDigest,
        datasetVersionDigest: versionDigest,
      },
      apiKey: this.#apiKey,
      ...optionalOrgName(this.#orgName),
    });
    this.#logResults(
      baseExperiment,
      heldoutRecords,
      baseResults,
      baseModelDigest,
    );
    await baseExperiment.flush();
    const baseExperimentId = BraintrustProviderIdSchema.parse(
      await baseExperiment.id,
    );
    const resolvedBaseExperimentName = BraintrustProviderIdSchema.parse(
      await baseExperiment.name,
    );
    if (resolvedBaseExperimentName !== baseExperimentName) {
      throw new Error("Braintrust base experiment identity is invalid");
    }

    const candidateExperiment = this.#sdk.initExperiment({
      project: input.publication.projectName,
      experiment: candidateExperimentName,
      description:
        "Candidate Fireworks Patch Model compared against the pinned base experiment.",
      dataset: heldoutDataset.reference,
      metadata: {
        schemaVersion: 1,
        dataClass: "anonymized-structural-only",
        dataUseConsent: "granted",
        split: "heldout",
        role: "candidate",
        modelResourceDigest: candidateModelDigest,
        datasetVersionDigest: versionDigest,
      },
      apiKey: this.#apiKey,
      ...optionalOrgName(this.#orgName),
      baseExperimentId,
    });
    this.#logResults(
      candidateExperiment,
      heldoutRecords,
      candidateResults,
      candidateModelDigest,
    );
    await candidateExperiment.flush();
    const candidateExperimentId = BraintrustProviderIdSchema.parse(
      await candidateExperiment.id,
    );
    const resolvedCandidateExperimentName = BraintrustProviderIdSchema.parse(
      await candidateExperiment.name,
    );
    if (resolvedCandidateExperimentName !== candidateExperimentName) {
      throw new Error("Braintrust candidate experiment identity is invalid");
    }
    const summary = await candidateExperiment.summarize({
      comparisonExperimentId: baseExperimentId,
      summarizeScores: true,
    });
    if (
      summary.projectName !== input.publication.projectName ||
      summary.experimentId !== candidateExperimentId ||
      summary.experimentName !== candidateExperimentName
    ) {
      throw new Error("Braintrust comparison summary identity is invalid");
    }
    if (summary.comparisonExperimentName !== baseExperimentName) {
      throw new Error(
        "Braintrust summary is not pinned to the requested base experiment",
      );
    }

    return attestPatchHeldOutComparison(
      PatchHeldOutComparisonBodySchema.parse({
        schemaVersion: 1,
        projectScopeId: bundle.projectScopeId,
        dataset: {
          id: input.publication.heldout.id,
          version: input.publication.heldout.version,
          split: "heldout",
          recordCount: heldoutRecords.length,
        },
        base: {
          modelResource: baseModelResource,
          experimentId: baseExperimentId,
        },
        candidate: {
          modelResource: candidateModelResource,
          experimentId: candidateExperimentId,
        },
        comparisonBaseExperimentId: baseExperimentId,
        comparisonExperimentName: summary.comparisonExperimentName,
        scores: normalizeSummary(summary),
      }),
      this.#checkpointAttestationKey,
    );
  }

  async #publishSplit(
    project: string,
    bundle: PatchTrainingBundle,
    split: "heldout" | "train",
    records: PatchTrainingRecord[],
  ): Promise<PublishedPatchDataset> {
    const name = datasetName(split, bundle.bundleDigest);
    const dataset = this.#sdk.initDataset({
      project,
      dataset: name,
      description:
        split === "train"
          ? "Opted-in structural-only Patch Model curation records."
          : "Structural-only Patch Model cases reserved for held-out comparison.",
      metadata: this.#datasetMetadata(bundle, split),
      apiKey: this.#apiKey,
      ...optionalOrgName(this.#orgName),
    });

    for (const record of records) {
      dataset.insert({
        id: record.exampleId,
        input: {
          caseId: record.exampleId,
          structural: record.input,
        },
        expected: record.expected,
        tags: ["patch-model", "structural-only", split],
        metadata: {
          schemaVersion: 1,
          dataUseConsent: record.metadata.dataUseConsent,
          projectScopeId: record.projectScopeId,
          split,
          bundleDigest: bundle.bundleDigest,
          curationPolicyDigest: record.metadata.curationPolicyDigest,
          sourceEvidenceDigest: record.metadata.sourceEvidenceDigest,
          consentReceiptDigest: record.metadata.consentReceiptDigest,
        },
      });
    }
    await dataset.flush();
    const [id, version] = await Promise.all([dataset.id, dataset.version()]);
    if (!id || !version) {
      throw new Error(
        `Braintrust ${split} dataset did not return a pinned version`,
      );
    }
    const safeId = BraintrustProviderIdSchema.parse(id);
    const safeVersion = BraintrustProviderIdSchema.parse(version);

    return {
      projectName: project,
      datasetName: name,
      id: safeId,
      version: safeVersion,
      split,
      recordCount: records.length,
      bundleDigest: bundle.bundleDigest,
    };
  }

  #datasetMetadata(
    bundle: PatchTrainingBundle,
    split: "heldout" | "train",
  ): Record<string, unknown> {
    return {
      schemaVersion: 1,
      dataClass: "anonymized-structural-only",
      dataUseConsent: "granted",
      projectScopeId: bundle.projectScopeId,
      split,
      bundleDigest: bundle.bundleDigest,
      crossProjectMixing: false,
    };
  }

  #assertPublication(
    bundle: PatchTrainingBundle,
    publication: PublishedPatchTrainingBundle,
    heldoutCount: number,
  ): void {
    for (const providerId of [
      publication.training.id,
      publication.training.version,
      publication.heldout.id,
      publication.heldout.version,
    ]) {
      BraintrustProviderIdSchema.parse(providerId);
    }
    const trainingCount = bundle.records.length - heldoutCount;
    const expectedProjectName = projectName(bundle.projectScopeId);
    if (
      publication.projectScopeId !== bundle.projectScopeId ||
      publication.projectName !== expectedProjectName ||
      publication.training.projectName !== expectedProjectName ||
      publication.heldout.projectName !== expectedProjectName
    ) {
      throw new Error("Braintrust publication belongs to a different project");
    }
    if (
      publication.heldout.bundleDigest !== bundle.bundleDigest ||
      publication.training.bundleDigest !== bundle.bundleDigest
    ) {
      throw new Error("Braintrust publication is for a different bundle");
    }
    if (
      publication.heldout.split !== "heldout" ||
      publication.heldout.recordCount !== heldoutCount ||
      publication.heldout.datasetName !==
        datasetName("heldout", bundle.bundleDigest)
    ) {
      throw new Error("Braintrust held-out publication is not exact");
    }
    if (!publication.heldout.id || !publication.heldout.version) {
      throw new Error("Braintrust held-out dataset is not version-pinned");
    }
    if (
      publication.training.split !== "train" ||
      publication.training.recordCount !== trainingCount ||
      publication.training.datasetName !==
        datasetName("train", bundle.bundleDigest)
    ) {
      throw new Error("Braintrust training publication is not exact");
    }
    if (!publication.training.id || !publication.training.version) {
      throw new Error("Braintrust training dataset is not version-pinned");
    }
    if (publication.training.id === publication.heldout.id) {
      throw new Error(
        "Braintrust train and held-out partitions must use different datasets",
      );
    }
  }

  #logResults(
    experiment: BraintrustPatchExperimentHandle,
    records: PatchTrainingRecord[],
    results: Map<string, PatchCheckpointResult>,
    modelResourceDigest: string,
  ): void {
    for (const record of records) {
      const result = results.get(record.exampleId);
      if (!result) {
        throw new Error("Missing held-out checkpoint result");
      }
      experiment.log({
        input: {
          caseId: record.exampleId,
          structural: record.input,
        },
        output: {
          outputDigest: result.outputDigest,
          reward: result.reward,
        },
        expected: record.expected,
        scores: scores(result),
        tags: ["patch-model", "heldout", "structural-only"],
        metadata: {
          schemaVersion: 1,
          dataClass: "anonymized-structural-only",
          dataUseConsent: record.metadata.dataUseConsent,
          modelResourceDigest,
          evidenceDigest: result.reward.evidenceDigest,
          curationPolicyDigest: record.metadata.curationPolicyDigest,
        },
        datasetRecordId: record.exampleId,
      });
    }
  }
}
