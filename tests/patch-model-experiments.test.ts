import type { ExperimentSummary } from "braintrust";
import { describe, expect, it } from "vitest";

import {
  BraintrustPatchModelExperiments,
  type BraintrustPatchModelSdk,
  type PublishedPatchTrainingBundle,
} from "../src/adapters/braintrust/patch-model-experiments.js";
import {
  PATCH_CURATION_POLICY_DIGEST,
  curatePatchTrainingBundle,
} from "../src/application/patch-model-training.js";
import {
  PatchTrainingRecordSchema,
  type PatchCheckpointResult,
  type PatchTrainingBundle,
  type PatchTrainingRecord,
} from "../src/domain/patch-model.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import { attestPatchCheckpointResult } from "../src/lib/patch-checkpoint-attestation.js";

const ATTESTATION_KEY = "patch-checkpoint-controller-key!".repeat(2);
const BASE_MODEL_RESOURCE = "accounts/fireworks/models/qwen3-4b";
const CANDIDATE_MODEL_RESOURCE = "accounts/buildlabs/models/patch-model-v1";

type DatasetInit = Parameters<BraintrustPatchModelSdk["initDataset"]>[0];
type ExperimentInit = Parameters<BraintrustPatchModelSdk["initExperiment"]>[0];

interface DatasetState {
  options: DatasetInit;
  records: unknown[];
  flushCount: number;
  id: string;
  version: string;
  reference: object;
}

interface ExperimentState {
  options: ExperimentInit;
  records: unknown[];
  flushCount: number;
  summarizeOptions: unknown[];
  id: string;
}

function patchRecord(
  label: string,
  split: "heldout" | "train",
): PatchTrainingRecord {
  const digest = (suffix: string) => sha256(`${label}:${suffix}`);
  return PatchTrainingRecordSchema.parse({
    schemaVersion: 1,
    projectScopeId: "a".repeat(64),
    exampleId: digest("example"),
    split,
    input: {
      contractStructure: {
        hardRequirementCount: 3,
        preferenceRequirementCount: 1,
        approvedFactCount: 1,
        forbiddenClaimCount: 1,
        commandVerifierCount: 2,
        httpVerifierCount: 1,
        semanticVerifierCount: 1,
        testCommandCount: 1,
      },
      priorEvidence: {
        receiptCount: 1,
        byKind: {
          artifact: 0,
          build: 0,
          "container-build": 0,
          "contract-evaluation": 0,
          coderabbit: 0,
          "forbidden-claim": 0,
          preview: 0,
          "requirement-command": 0,
          test: 1,
        },
        byStatus: { PASS: 0, FAIL: 1, ERROR: 0 },
      },
      requestedChange: {
        priority: "hard",
        verifierKinds: ["http"],
        priorHardRequirementCount: 2,
        accessibilityCheckCount: 1,
        performanceCheckCount: 1,
      },
    },
    expected: {
      patchShape: {
        language: "typescript",
        fileKinds: ["source", "test"],
        changedFileCount: 2,
        additions: 10,
        deletions: 2,
        maxChangedLines: 40,
      },
      reward: {
        policyVersion: 1,
        components: {
          proofGate: 1,
          build: 1,
          tests: 1,
          requestedChange: 1,
          priorRequirements: 1,
          accessibility: 1,
          performance: 1,
          supportedClaims: 1,
          minimalPatch: 1,
        },
        terminal: 1,
        accepted: true,
        reasonCodes: [],
        evidenceDigest: digest("evidence"),
      },
    },
    metadata: {
      curatedAt: "2026-07-23T13:00:00.000Z",
      dataUseConsent: "granted",
      consentReceiptDigest: digest("consent"),
      sourceEvidenceDigest: digest("source-evidence"),
      baseRevisionDigest: digest("base"),
      candidateRevisionDigest: digest("candidate"),
      diffDigest: digest("diff"),
      curationPolicyDigest: PATCH_CURATION_POLICY_DIGEST,
    },
  });
}

function result(
  record: PatchTrainingRecord,
  publication: PublishedPatchTrainingBundle,
  role: "base" | "candidate",
  modelResource: string,
): PatchCheckpointResult {
  return attestPatchCheckpointResult(
    {
      caseId: record.exampleId,
      outputDigest: sha256(`output:${role}:${record.exampleId}`),
      reward: record.expected.reward,
    },
    {
      role,
      projectScopeId: record.projectScopeId,
      dataset: {
        id: publication.heldout.id,
        version: publication.heldout.version,
        bundleDigest: publication.heldout.bundleDigest,
      },
      modelResource,
    },
    ATTESTATION_KEY,
  );
}

function summaryScores(includeDiff = true): ExperimentSummary["scores"] {
  return Object.fromEntries(
    [
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
    ].map((name) => [
      name,
      {
        name,
        score: 0.9,
        ...(includeDiff ? { diff: 0.05 } : {}),
        improvements: 1,
        regressions: 0,
      },
    ]),
  );
}

function fakeSdk(
  options: {
    includeDiff?: boolean;
    mismatchedPinnedDatasetIdentity?: boolean;
    mismatchedSummaryIdentity?: boolean;
  } = {},
): {
  sdk: BraintrustPatchModelSdk;
  datasets: DatasetState[];
  experiments: ExperimentState[];
} {
  const datasets: DatasetState[] = [];
  const experiments: ExperimentState[] = [];
  const sdk: BraintrustPatchModelSdk = {
    initDataset(initOptions) {
      const index = datasets.length + 1;
      const pinned = initOptions.version
        ? datasets.find(
            (dataset) =>
              dataset.options.project === initOptions.project &&
              dataset.options.dataset === initOptions.dataset &&
              dataset.version === initOptions.version,
          )
        : undefined;
      const state: DatasetState = {
        options: initOptions,
        records: [],
        flushCount: 0,
        id:
          pinned && !options.mismatchedPinnedDatasetIdentity
            ? pinned.id
            : `dataset-${index}`,
        version: initOptions.version ?? `version-${index}`,
        reference: pinned?.reference ?? { dataset: index },
      };
      datasets.push(state);
      return {
        id: Promise.resolve(state.id),
        reference: state.reference,
        insert(record) {
          state.records.push(record);
          return record.id;
        },
        flush() {
          state.flushCount += 1;
          return Promise.resolve();
        },
        version() {
          return Promise.resolve(state.version);
        },
      };
    },
    initExperiment(initOptions) {
      const index = experiments.length + 1;
      const state: ExperimentState = {
        options: initOptions,
        records: [],
        flushCount: 0,
        summarizeOptions: [],
        id: `experiment-${index}`,
      };
      experiments.push(state);
      return {
        id: Promise.resolve(state.id),
        name: Promise.resolve(initOptions.experiment),
        log(record) {
          state.records.push(record);
          return sha256(JSON.stringify(record));
        },
        flush() {
          state.flushCount += 1;
          return Promise.resolve();
        },
        summarize(summaryOptions) {
          state.summarizeOptions.push(summaryOptions);
          return Promise.resolve({
            projectName: initOptions.project,
            experimentName: initOptions.experiment,
            experimentId: options.mismatchedSummaryIdentity
              ? "another-experiment"
              : state.id,
            comparisonExperimentName: experiments[0]!.options.experiment,
            scores: summaryScores(options.includeDiff ?? true),
          });
        },
      };
    },
  };
  return { sdk, datasets, experiments };
}

async function comparisonFixture(label: string) {
  const train = patchRecord(`${label}-train`, "train");
  const heldout = patchRecord(`${label}-heldout`, "heldout");
  const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
  const fake = fakeSdk();
  const adapter = new BraintrustPatchModelExperiments(
    {
      apiKey: "braintrust-secret-key",
      checkpointAttestationKey: ATTESTATION_KEY,
    },
    fake.sdk,
  );
  const publication = await adapter.publishStructuralBundle(bundle);
  return { adapter, bundle, fake, heldout, publication };
}

describe("Braintrust Patch Model datasets and experiments", () => {
  it("publishes separate version-pinned structural train and held-out datasets", async () => {
    const train = patchRecord("train", "train");
    const heldout = patchRecord("heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );

    const publication = await adapter.publishStructuralBundle(bundle);

    expect(publication).toMatchObject({
      projectScopeId: bundle.projectScopeId,
      projectName: `buildlabs-patch-${bundle.projectScopeId}`,
      training: {
        datasetName: `patch-training-v1-${bundle.bundleDigest.slice(0, 16)}`,
        split: "train",
        recordCount: 1,
      },
      heldout: {
        datasetName: `patch-heldout-v1-${bundle.bundleDigest.slice(0, 16)}`,
        split: "heldout",
        recordCount: 1,
      },
    });
    expect(fake.datasets).toHaveLength(2);
    expect(fake.datasets.every((dataset) => dataset.flushCount === 1)).toBe(
      true,
    );
    expect(fake.datasets[0]!.records).toHaveLength(1);
    expect(fake.datasets[1]!.records).toHaveLength(1);
    const publishedPayloads = JSON.stringify(
      fake.datasets.flatMap((dataset) => dataset.records),
    );
    expect(publishedPayloads).not.toContain("braintrust-secret-key");
    expect(publishedPayloads).not.toContain(ATTESTATION_KEY);
    expect(publishedPayloads).not.toContain("Mission Peak Electric");
  });

  it("rejects a schema-valid bundle without controller provenance", async () => {
    const records = [
      patchRecord("forged-train", "train"),
      patchRecord("forged-heldout", "heldout"),
    ].sort((left, right) => left.exampleId.localeCompare(right.exampleId));
    const body = {
      schemaVersion: 1 as const,
      projectScopeId: records[0]!.projectScopeId,
      records,
    };
    const bundleDigest = digestJson(body);
    const bundle = {
      ...body,
      bundleDigest,
      attestation: {
        schemaVersion: 1 as const,
        purpose: "braintrust-structural-publication" as const,
        projectScopeId: body.projectScopeId,
        bundleDigest,
        recordCount: records.length,
        curationPolicyDigest: records[0]!.metadata.curationPolicyDigest,
        consentReceiptDigests: [
          ...new Set(
            records.map((record) => record.metadata.consentReceiptDigest),
          ),
        ].sort(),
        signature: "f".repeat(64),
      },
    } satisfies PatchTrainingBundle;
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );

    await expect(adapter.publishStructuralBundle(bundle)).rejects.toThrow(
      "bundle attestation signature is invalid",
    );
    expect(fake.datasets).toHaveLength(0);
  });

  it("refuses to publish an incomplete partition", async () => {
    const bundle = curatePatchTrainingBundle(
      [patchRecord("only-training", "train")],
      ATTESTATION_KEY,
    );
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );

    await expect(adapter.publishStructuralBundle(bundle)).rejects.toThrow(
      "non-empty train and held-out",
    );
    expect(fake.datasets).toHaveLength(0);
  });

  it("records identical-input base and candidate experiments pinned by id", async () => {
    const train = patchRecord("comparison-train", "train");
    const heldout = patchRecord("comparison-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);

    const comparison = await adapter.recordHeldOutComparison({
      bundle,
      publication,
      baseModelResource: BASE_MODEL_RESOURCE,
      candidateModelResource: CANDIDATE_MODEL_RESOURCE,
      baseResults: [result(heldout, publication, "base", BASE_MODEL_RESOURCE)],
      candidateResults: [
        result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
      ],
    });

    expect(fake.experiments).toHaveLength(2);
    expect(fake.experiments[1]!.options.baseExperimentId).toBe("experiment-1");
    expect(fake.experiments[1]!.summarizeOptions).toEqual([
      {
        comparisonExperimentId: "experiment-1",
        summarizeScores: true,
      },
    ]);
    const baseLog = fake.experiments[0]!.records[0] as {
      input: unknown;
    };
    const candidateLog = fake.experiments[1]!.records[0] as {
      input: unknown;
    };
    expect(candidateLog.input).toEqual(baseLog.input);
    const loggedPayloads = JSON.stringify(
      fake.experiments.flatMap((experiment) => experiment.records),
    );
    expect(loggedPayloads).not.toContain("accounts/fireworks/models/qwen3-4b");
    expect(loggedPayloads).not.toContain(
      "accounts/buildlabs/models/patch-model-v1",
    );
    expect(loggedPayloads).not.toContain("braintrust-secret-key");
    expect(loggedPayloads).not.toContain(ATTESTATION_KEY);
    expect(comparison).toMatchObject({
      comparisonBaseExperimentId: "experiment-1",
      candidate: { experimentId: "experiment-2" },
      dataset: {
        id: publication.heldout.id,
        version: publication.heldout.version,
        split: "heldout",
        recordCount: 1,
      },
      scores: {
        terminal: {
          score: 0.9,
          diff: 0.05,
          improvements: 1,
          regressions: 0,
        },
      },
    });
  });

  it("fails closed when Braintrust omits a comparison diff", async () => {
    const train = patchRecord("missing-diff-train", "train");
    const heldout = patchRecord("missing-diff-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk({ includeDiff: false });
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [
          result(heldout, publication, "base", BASE_MODEL_RESOURCE),
        ],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("missing a diff for terminal");
  });

  it("requires exact held-out result coverage", async () => {
    const train = patchRecord("coverage-train", "train");
    const heldout = patchRecord("coverage-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("exact pinned held-out dataset");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects post-publication bundle mutation before reusing attested results", async () => {
    const train = patchRecord("bundle-mutation-train", "train");
    const heldout = patchRecord("bundle-mutation-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);
    const baseResult = result(
      heldout,
      publication,
      "base",
      BASE_MODEL_RESOURCE,
    );
    const candidateResult = result(
      heldout,
      publication,
      "candidate",
      CANDIDATE_MODEL_RESOURCE,
    );
    const mutatedRecord = bundle.records.find(
      (record) => record.split === "heldout",
    )!;
    mutatedRecord.input.contractStructure.hardRequirementCount += 1;
    bundle.bundleDigest = digestJson({
      schemaVersion: bundle.schemaVersion,
      projectScopeId: bundle.projectScopeId,
      records: bundle.records,
    });
    bundle.attestation.bundleDigest = bundle.bundleDigest;

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [baseResult],
        candidateResults: [candidateResult],
      }),
    ).rejects.toThrow("bundle attestation signature is invalid");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects a reopened dataset handle with a different provider identity", async () => {
    const train = patchRecord("dataset-identity-train", "train");
    const heldout = patchRecord("dataset-identity-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk({ mismatchedPinnedDatasetIdentity: true });
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [
          result(heldout, publication, "base", BASE_MODEL_RESOURCE),
        ],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("handle does not match the pinned publication");
    expect(fake.experiments).toHaveLength(0);
  });

  it("binds comparison to the exact published training partition too", async () => {
    const train = patchRecord("binding-train", "train");
    const heldout = patchRecord("binding-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk();
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);
    publication.training.recordCount += 1;

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [
          result(heldout, publication, "base", BASE_MODEL_RESOURCE),
        ],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("training publication is not exact");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects a tampered reward before creating an experiment", async () => {
    const { adapter, bundle, fake, heldout, publication } =
      await comparisonFixture("tampered-reward");
    const baseResult = result(
      heldout,
      publication,
      "base",
      BASE_MODEL_RESOURCE,
    );
    baseResult.reward = {
      ...baseResult.reward,
      terminal: 0,
      accepted: false,
      components: {
        ...baseResult.reward.components,
        proofGate: 0,
      },
      reasonCodes: ["proof-gate-failed"],
    };

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [baseResult],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("attestation context does not match");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects candidate-to-base attestation replay", async () => {
    const { adapter, bundle, fake, heldout, publication } =
      await comparisonFixture("role-replay");
    const candidateResult = result(
      heldout,
      publication,
      "candidate",
      CANDIDATE_MODEL_RESOURCE,
    );

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [candidateResult],
        candidateResults: [candidateResult],
      }),
    ).rejects.toThrow("base attestation context does not match");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects model and dataset replay", async () => {
    const { adapter, bundle, fake, heldout, publication } =
      await comparisonFixture("context-replay");
    const replayedBase = attestPatchCheckpointResult(
      {
        caseId: heldout.exampleId,
        outputDigest: sha256("replayed-output"),
        reward: heldout.expected.reward,
      },
      {
        role: "base",
        projectScopeId: bundle.projectScopeId,
        dataset: {
          id: publication.heldout.id,
          version: "older-pinned-version",
          bundleDigest: publication.heldout.bundleDigest,
        },
        modelResource: "accounts/fireworks/models/other-base",
      },
      ATTESTATION_KEY,
    );

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [replayedBase],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("base attestation context does not match");
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects signatures from another controller key", async () => {
    const { bundle, fake, heldout, publication } =
      await comparisonFixture("wrong-key");
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: "different-controller-key!".repeat(2),
      },
      fake.sdk,
    );

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [
          result(heldout, publication, "base", BASE_MODEL_RESOURCE),
        ],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("attestation signature is invalid");
    expect(fake.experiments).toHaveLength(0);
  });

  it("requires a high-entropy local attestation key", () => {
    const fake = fakeSdk();
    expect(
      () =>
        new BraintrustPatchModelExperiments(
          {
            apiKey: "braintrust-secret-key",
            checkpointAttestationKey: "short",
          },
          fake.sdk,
        ),
    ).toThrow("at least 32 bytes");
  });

  it("rejects a comparison summary from another experiment", async () => {
    const train = patchRecord("summary-identity-train", "train");
    const heldout = patchRecord("summary-identity-heldout", "heldout");
    const bundle = curatePatchTrainingBundle([train, heldout], ATTESTATION_KEY);
    const fake = fakeSdk({ mismatchedSummaryIdentity: true });
    const adapter = new BraintrustPatchModelExperiments(
      {
        apiKey: "braintrust-secret-key",
        checkpointAttestationKey: ATTESTATION_KEY,
      },
      fake.sdk,
    );
    const publication = await adapter.publishStructuralBundle(bundle);

    await expect(
      adapter.recordHeldOutComparison({
        bundle,
        publication,
        baseModelResource: BASE_MODEL_RESOURCE,
        candidateModelResource: CANDIDATE_MODEL_RESOURCE,
        baseResults: [
          result(heldout, publication, "base", BASE_MODEL_RESOURCE),
        ],
        candidateResults: [
          result(heldout, publication, "candidate", CANDIDATE_MODEL_RESOURCE),
        ],
      }),
    ).rejects.toThrow("summary identity is invalid");
  });
});
