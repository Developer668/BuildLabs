import type { ExperimentSummary } from "braintrust";
import { describe, expect, it } from "vitest";

import {
  BraintrustPatchModelMatrix,
  type BraintrustMatrixDatasetRecord,
  type BraintrustMatrixSdk,
  type MatrixModelPlan,
  type MatrixTrialInput,
} from "../src/adapters/braintrust/patch-model-matrix.js";
import { attestPatchEvaluationTrial } from "../src/application/patch-model-evaluation.js";
import { PATCH_EVALUATION_POLICY_DIGEST } from "../src/domain/patch-model-evaluation.js";
import {
  PATCH_CURATION_POLICY_DIGEST,
  curatePatchTrainingBundle,
} from "../src/application/patch-model-training.js";
import {
  PatchTrainingRecordSchema,
  type PatchTrainingRecord,
} from "../src/domain/patch-model.js";
import { sha256 } from "../src/lib/canonical-json.js";

const KEY = "braintrust-matrix-controller-key!".repeat(2);
const PROJECT_SCOPE = sha256("matrix-project");
const BASE = "accounts/fireworks/models/kimi-k2p6";
const CANDIDATE = "accounts/buildlabs/models/patch-model-checkpoint-v1";
const BASELINE = "accounts/fireworks/models/glm-5p2";

interface ExperimentState {
  options: Parameters<BraintrustMatrixSdk["initExperiment"]>[0];
  id: string;
  logs: unknown[];
  flushes: number;
  comparisons: string[];
}

function fakeSdk(
  behavior: {
    wrongComparison?: boolean;
    wrongScores?: boolean;
    datasetRecords?: readonly BraintrustMatrixDatasetRecord[];
  } = {},
): {
  sdk: BraintrustMatrixSdk;
  experiments: ExperimentState[];
} {
  const experiments: ExperimentState[] = [];
  const sdk: BraintrustMatrixSdk = {
    initDataset(datasetOptions) {
      return {
        id: Promise.resolve("dataset-heldout"),
        reference: { dataset: datasetOptions.dataset },
        version: () => Promise.resolve(datasetOptions.version),
        records: () => Promise.resolve(behavior.datasetRecords ?? []),
      };
    },
    initExperiment(options) {
      const state: ExperimentState = {
        options,
        id: `experiment-${experiments.length + 1}`,
        logs: [],
        flushes: 0,
        comparisons: [],
      };
      experiments.push(state);
      return {
        id: Promise.resolve(state.id),
        name: Promise.resolve(options.experiment),
        log(record) {
          state.logs.push(record);
          return sha256(JSON.stringify(record));
        },
        flush() {
          state.flushes += 1;
          return Promise.resolve();
        },
        summarize(summaryOptions) {
          state.comparisons.push(summaryOptions.comparisonExperimentId);
          const base = experiments.find(
            (candidate) =>
              candidate.id === summaryOptions.comparisonExperimentId,
          );
          const scoreNames = Object.keys(
            (state.logs[0] as { scores: Record<string, number> }).scores,
          );
          const scores = Object.fromEntries(
            scoreNames.map((name) => {
              const currentValues = state.logs.map(
                (log) =>
                  (log as { scores: Record<string, number> }).scores[name]!,
              );
              const baseValues = (base?.logs ?? []).map(
                (log) =>
                  (log as { scores: Record<string, number> }).scores[name]!,
              );
              const score =
                currentValues.reduce((sum, value) => sum + value, 0) /
                currentValues.length;
              const baseScore =
                baseValues.reduce((sum, value) => sum + value, 0) /
                baseValues.length;
              return [
                name,
                {
                  score: behavior.wrongScores ? score - 0.5 : score,
                  diff: score - baseScore,
                  improvements: 0,
                  regressions: 0,
                },
              ];
            }),
          );
          return Promise.resolve({
            projectName: options.project,
            experimentName: options.experiment,
            experimentId: state.id,
            comparisonExperimentName: behavior.wrongComparison
              ? "wrong-base"
              : base?.options.experiment,
            scores,
          } as ExperimentSummary);
        },
      };
    },
  };
  return { sdk, experiments };
}

function record(
  caseIndex: number,
  split: "heldout" | "train" = "heldout",
): PatchTrainingRecord {
  const digest = (label: string) => sha256(`${caseIndex}:${label}`);
  return PatchTrainingRecordSchema.parse({
    schemaVersion: 1,
    projectScopeId: PROJECT_SCOPE,
    exampleId: digest("case"),
    split,
    input: {
      contractStructure: {
        hardRequirementCount: 2,
        preferenceRequirementCount: 0,
        approvedFactCount: 1,
        forbiddenClaimCount: 1,
        commandVerifierCount: 1,
        httpVerifierCount: 1,
        semanticVerifierCount: 0,
        testCommandCount: 1,
      },
      priorEvidence: {
        receiptCount: 1,
        byKind: {
          artifact: 0,
          build: 0,
          "container-build": 0,
          "contract-evaluation": 1,
          coderabbit: 0,
          "dependency-bootstrap": 0,
          "forbidden-claim": 0,
          "visual-claim": 0,
          preview: 0,
          "requirement-command": 0,
          test: 0,
        },
        byStatus: { PASS: 0, FAIL: 1, ERROR: 0 },
      },
      requestedChange: {
        priority: "hard",
        verifierKinds: ["http"],
        priorHardRequirementCount: 1,
        accessibilityCheckCount: 1,
        performanceCheckCount: 1,
      },
    },
    expected: {
      patchShape: {
        language: "typescript",
        fileKinds: ["source"],
        changedFileCount: 1,
        additions: 1,
        deletions: 1,
        maxChangedLines: 10,
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
      curatedAt: "2026-07-24T10:00:00.000Z",
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

function plans(): MatrixModelPlan[] {
  return [
    {
      role: "base",
      label: "pinned-base",
      modelResource: BASE,
      capabilitySnapshotDigest: sha256("base-capability"),
      routerPolicyDigest: sha256("router"),
      serviceTier: "standard",
      fallbackReason: "preferred",
      returnedModelResource: BASE,
    },
    {
      role: "candidate",
      label: "candidate-checkpoint",
      modelResource: CANDIDATE,
      capabilitySnapshotDigest: sha256("candidate-capability"),
      routerPolicyDigest: sha256("router"),
      serviceTier: "standard",
      fallbackReason: "preferred",
      returnedModelResource: CANDIDATE,
    },
    {
      role: "baseline",
      label: "current-glm",
      modelResource: BASELINE,
      capabilitySnapshotDigest: sha256("baseline-capability"),
      routerPolicyDigest: sha256("router"),
      serviceTier: "standard",
      fallbackReason: "preferred",
      returnedModelResource: BASELINE,
    },
  ];
}

function trials(
  records: PatchTrainingRecord[],
  dataset: {
    id: string;
    version: string;
    bundleDigest: string;
  },
  modelPlans: MatrixModelPlan[],
): ReadonlyMap<string, readonly MatrixTrialInput[]> {
  const output = new Map<string, MatrixTrialInput[]>();
  for (const [model, terminal] of [
    [BASE, 0.8],
    [CANDIDATE, 1],
    [BASELINE, 0.75],
  ] as const) {
    const plan = modelPlans.find(
      ({ modelResource }) => modelResource === model,
    )!;
    output.set(
      model,
      records.flatMap((record, caseIndex) =>
        [0, 1, 2].map((trialIndex) =>
          attestPatchEvaluationTrial(
            {
              projectScopeId: PROJECT_SCOPE,
              datasetId: dataset.id,
              datasetVersion: dataset.version,
              bundleDigest: dataset.bundleDigest,
              evaluationPolicyDigest: PATCH_EVALUATION_POLICY_DIGEST,
              role: plan.role,
              caseId: record.exampleId,
              trialIndex,
              seed: caseIndex * 10 + trialIndex,
              modelResource: model,
              capabilitySnapshotDigest: plan.capabilitySnapshotDigest,
              routerPolicyDigest: plan.routerPolicyDigest,
              serviceTier: plan.serviceTier,
              fallbackReason: plan.fallbackReason,
              returnedModelResource: plan.returnedModelResource,
              outputDigest: sha256(
                `${model}:${record.exampleId}:${trialIndex}:output`,
              ),
              evaluatorEvidenceDigest: sha256(
                `${model}:${record.exampleId}:${trialIndex}:evidence`,
              ),
              scores: {
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
              },
            },
            { keyId: "controller-v1", key: KEY },
          ),
        ),
      ),
    );
  }
  return output;
}

function input() {
  const records = Array.from({ length: 20 }, (_, index) => record(index));
  const bundle = curatePatchTrainingBundle(
    [record(1_000, "train"), ...records],
    KEY,
  );
  const projectName = `buildlabs-patch-${PROJECT_SCOPE}`;
  const modelPlans = plans();
  const heldoutPublication = {
    projectName,
    datasetName: `patch-heldout-v1-${bundle.bundleDigest.slice(0, 16)}`,
    id: "dataset-heldout",
    version: "version-heldout-immutable-1",
    split: "heldout" as const,
    recordCount: records.length,
    bundleDigest: bundle.bundleDigest,
  };
  return {
    dataset: {
      bundle,
      publication: {
        projectScopeId: PROJECT_SCOPE,
        projectName,
        training: {
          projectName,
          datasetName: `patch-training-v1-${bundle.bundleDigest.slice(0, 16)}`,
          id: "dataset-training",
          version: "version-training-immutable-1",
          split: "train" as const,
          recordCount: 1,
          bundleDigest: bundle.bundleDigest,
        },
        heldout: heldoutPublication,
      },
    },
    minimumTrialsPerCase: 3,
    minimumTerminalScore: 0.8,
    minimumPairedImprovement: 0.02,
    models: modelPlans,
    trialsByModel: trials(records, heldoutPublication, modelPlans),
  };
}

function providerDatasetRecords(
  value: ReturnType<typeof input>,
): BraintrustMatrixDatasetRecord[] {
  return value.dataset.bundle.records
    .filter((candidate) => candidate.split === "heldout")
    .map((candidate) => ({
      id: candidate.exampleId,
      input: {
        caseId: candidate.exampleId,
        structural: candidate.input,
      },
      expected: candidate.expected,
      tags: ["patch-model", "structural-only", "heldout"],
      metadata: {
        schemaVersion: 1,
        dataUseConsent: candidate.metadata.dataUseConsent,
        projectScopeId: candidate.projectScopeId,
        split: "heldout",
        bundleDigest: value.dataset.bundle.bundleDigest,
        curationPolicyDigest: candidate.metadata.curationPolicyDigest,
        sourceEvidenceDigest: candidate.metadata.sourceEvidenceDigest,
        consentReceiptDigest: candidate.metadata.consentReceiptDigest,
      },
    }));
}

describe("Braintrust Patch Model matrix adapter", () => {
  it("records content-free repeated experiments against an explicit base", async () => {
    const value = input();
    const fake = fakeSdk({
      datasetRecords: providerDatasetRecords(value),
    });
    const adapter = new BraintrustPatchModelMatrix(
      {
        apiKey: "braintrust-test-key",
        eligibilityKeyId: "controller-v1",
        eligibilityKey: KEY,
        checkpointAttestationKey: KEY,
      },
      fake.sdk,
    );

    const eligibility = await adapter.recordAndEvaluate(value);

    expect(eligibility.status).toBe("eligible-for-manual-promotion");
    expect(eligibility.promoted).toBe(false);
    expect(fake.experiments).toHaveLength(3);
    expect(fake.experiments.every(({ flushes }) => flushes === 1)).toBe(true);
    expect(fake.experiments[0]!.options.baseExperimentId).toBeUndefined();
    expect(fake.experiments[1]!.options.baseExperimentId).toBe(
      fake.experiments[0]!.id,
    );
    expect(fake.experiments[2]!.options.baseExperimentId).toBe(
      fake.experiments[0]!.id,
    );
    expect(
      fake.experiments
        .slice(1)
        .every(
          ({ comparisons }) =>
            comparisons.length === 1 &&
            comparisons[0] === fake.experiments[0]!.id,
        ),
    ).toBe(true);

    const serialized = JSON.stringify(
      fake.experiments.map(({ logs, options }) => ({
        logs,
        metadata: options.metadata,
      })),
    );
    expect(serialized).not.toContain("Mission Peak Electric");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("braintrust-test-key");
    expect(serialized).toContain("matrixRunDigest");
    expect(serialized).toContain("trialAttestationDigest");
    expect(serialized).toContain("fallbackReasonDigest");
  });

  it("fails closed when Braintrust reports the wrong comparison baseline", async () => {
    const value = input();
    const fake = fakeSdk({
      wrongComparison: true,
      datasetRecords: providerDatasetRecords(value),
    });
    const adapter = new BraintrustPatchModelMatrix(
      {
        apiKey: "braintrust-test-key",
        eligibilityKeyId: "controller-v1",
        eligibilityKey: KEY,
        checkpointAttestationKey: KEY,
      },
      fake.sdk,
    );

    await expect(adapter.recordAndEvaluate(value)).rejects.toThrow(
      "not pinned to the explicit base experiment",
    );
  });

  it("fails closed when Braintrust scores disagree with attested trials", async () => {
    const value = input();
    const fake = fakeSdk({
      wrongScores: true,
      datasetRecords: providerDatasetRecords(value),
    });
    const adapter = new BraintrustPatchModelMatrix(
      {
        apiKey: "braintrust-test-key",
        eligibilityKeyId: "controller-v1",
        eligibilityKey: KEY,
        checkpointAttestationKey: KEY,
      },
      fake.sdk,
    );

    await expect(adapter.recordAndEvaluate(value)).rejects.toThrow(
      /does not match controller-attested trials/u,
    );
  });

  it("rejects a pinned provider dataset whose content differs from the signed bundle", async () => {
    const value = input();
    const providerRecords = providerDatasetRecords(value);
    providerRecords[0] = {
      ...providerRecords[0]!,
      expected: { contaminated: true },
    };
    const fake = fakeSdk({ datasetRecords: providerRecords });
    const adapter = new BraintrustPatchModelMatrix(
      {
        apiKey: "braintrust-test-key",
        eligibilityKeyId: "controller-v1",
        eligibilityKey: KEY,
        checkpointAttestationKey: KEY,
      },
      fake.sdk,
    );

    await expect(adapter.recordAndEvaluate(value)).rejects.toThrow(
      "dataset content does not match the signed bundle",
    );
    expect(fake.experiments).toHaveLength(0);
  });

  it("rejects missing model trials before producing eligibility", async () => {
    const value = input();
    const fake = fakeSdk({
      datasetRecords: providerDatasetRecords(value),
    });
    const adapter = new BraintrustPatchModelMatrix(
      {
        apiKey: "braintrust-test-key",
        eligibilityKeyId: "controller-v1",
        eligibilityKey: KEY,
        checkpointAttestationKey: KEY,
      },
      fake.sdk,
    );
    const mutableTrials = new Map<string, readonly MatrixTrialInput[]>(
      value.trialsByModel,
    );
    mutableTrials.delete(CANDIDATE);
    value.trialsByModel = mutableTrials;

    await expect(adapter.recordAndEvaluate(value)).rejects.toThrow(
      "missing candidate trials",
    );
    expect(fake.experiments).toHaveLength(0);
  });
});
