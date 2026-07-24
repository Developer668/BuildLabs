import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  curatePatchTrainingBundle,
  curatePatchTrainingRecord,
  decidePatchModelPromotion,
} from "../src/application/patch-model-training.js";
import type { EvidenceReceipt } from "../src/domain/evidence.js";
import {
  PatchTrainingBundleSchema,
  type PatchExperimentScore,
  type PatchHeldOutComparison,
  type PatchHeldOutComparisonBody,
  type PatchTrainingRecord,
  type PatchTrainingSource,
} from "../src/domain/patch-model.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { attestPatchHeldOutComparison } from "../src/lib/patch-checkpoint-attestation.js";
import { assignment, passingEvidence } from "./fixtures.js";
import { integrateCodeRabbitReviewFixture } from "./patch-model-coderabbit-fixture.js";

const KEY = "patch-model-anonymization-key!".repeat(2);
const BASE_REVISION = "b".repeat(64);
const REVISION = "c".repeat(64);

function source(): PatchTrainingSource {
  const input = assignment("patch-training", (value) => {
    value.contract.requirements.push(
      {
        id: "accessibility-regression",
        description: "Keyboard accessibility remains intact.",
        priority: "hard",
        verifiers: [
          {
            kind: "command",
            command: "npm run test:a11y",
            timeoutSeconds: 60,
          },
        ],
      },
      {
        id: "performance-regression",
        description: "The performance budget remains intact.",
        priority: "hard",
        verifiers: [
          {
            kind: "command",
            command: "npm run test:performance",
            timeoutSeconds: 60,
          },
        ],
      },
    );
  });
  const runId = randomUUID();
  const afterReceipts = passingEvidence(runId, REVISION, input);
  integrateCodeRabbitReviewFixture(
    afterReceipts,
    input.contract,
    runId,
    REVISION,
  );
  const evaluationReceipt = afterReceipts.find(
    (receipt) => receipt.kind === "contract-evaluation",
  );
  if (!evaluationReceipt || evaluationReceipt.kind !== "contract-evaluation") {
    throw new Error("Missing evaluation receipt fixture");
  }
  const beforeReceipt = {
    ...evaluationReceipt,
    receiptId: randomUUID(),
    revisionHash: BASE_REVISION,
    status: "FAIL" as const,
    braintrustScores: {
      ...evaluationReceipt.braintrustScores,
      hardRequirements: 0 as const,
    },
    requirements: evaluationReceipt.requirements.map((requirement) =>
      requirement.requirementId === "homepage"
        ? { ...requirement, status: "FAIL" as const }
        : requirement,
    ),
    summary:
      "Mission Peak Electric user@example.com fw_do_not_export_customer_data",
    unsupportedClaims: [
      {
        claim: "customer-owned failing test output",
        location: "fixture",
        reason: "pre-patch failure marker",
      },
    ],
  };

  return {
    schemaVersion: 1,
    consent: {
      schemaVersion: 1,
      projectId: input.projectId,
      status: "granted",
      purpose: "fireworks-rft-patch-model",
      recordedAt: "2026-07-23T11:00:00.000Z",
      consentReceiptId: randomUUID(),
    },
    contract: input.contract,
    runId,
    curatedAt: "2026-07-23T13:00:00.000Z",
    patch: {
      baseRevisionHash: BASE_REVISION,
      revisionHash: REVISION,
      diffSha256: sha256("private customer patch"),
      language: "typescript",
      fileKinds: ["source", "test"],
      changedFileCount: 2,
      additions: 12,
      deletions: 4,
      maxChangedLines: 40,
    },
    selection: {
      requestedChangeRequirementId: "homepage",
      accessibilityRequirementIds: ["accessibility-regression"],
      performanceRequirementIds: ["performance-regression"],
    },
    beforeReceipts: [beforeReceipt],
    afterReceipts,
  };
}

function comparisonScore(
  overrides: Partial<PatchExperimentScore> = {},
): PatchExperimentScore {
  return {
    score: 0.9,
    diff: 0.05,
    improvements: 3,
    regressions: 0,
    ...overrides,
  };
}

function heldOutComparison(
  mutate?: (comparison: PatchHeldOutComparisonBody) => void,
): PatchHeldOutComparison {
  const body: PatchHeldOutComparisonBody = {
    schemaVersion: 1,
    projectScopeId: "d".repeat(64),
    dataset: {
      id: "dataset-heldout",
      version: "version-001",
      split: "heldout",
      recordCount: 20,
    },
    base: {
      modelResource: "accounts/fireworks/models/qwen3-4b",
      experimentId: "experiment-base",
    },
    candidate: {
      modelResource: "accounts/buildlabs/models/patch-model-v1",
      experimentId: "experiment-candidate",
    },
    comparisonBaseExperimentId: "experiment-base",
    comparisonExperimentName: "patch-base",
    scores: {
      terminal: comparisonScore(),
      proofGate: comparisonScore(),
      build: comparisonScore(),
      tests: comparisonScore(),
      requestedChange: comparisonScore(),
      priorRequirements: comparisonScore(),
      accessibility: comparisonScore(),
      performance: comparisonScore(),
      supportedClaims: comparisonScore(),
      minimalPatch: comparisonScore(),
    },
  };
  mutate?.(body);
  return attestPatchHeldOutComparison(body, KEY);
}

describe("Patch Model curation and promotion", () => {
  it("curates only structural data and derives reward from controller receipts", () => {
    const raw = source();
    const record = curatePatchTrainingRecord(raw, KEY);

    expect(record.expected.reward).toMatchObject({
      terminal: 1,
      accepted: true,
      reasonCodes: [],
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
    });
    expect(record.metadata.dataUseConsent).toBe("granted");
    expect(record.input.requestedChange).toEqual({
      priority: "hard",
      verifierKinds: ["http"],
      priorHardRequirementCount: 2,
      accessibilityCheckCount: 1,
      performanceCheckCount: 1,
    });

    const serialized = JSON.stringify(record);
    for (const forbidden of [
      raw.contract.projectId,
      raw.runId,
      raw.consent.consentReceiptId,
      raw.contract.approvedFacts[0]!.statement,
      raw.contract.requirements[0]!.description,
      raw.contract.verification.buildCommand,
      "Mission Peak Electric",
      "user@example.com",
      "fw_do_not_export_customer_data",
      "customer-owned failing test output",
      BASE_REVISION,
      REVISION,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires explicit granted consent before curation", () => {
    const raw = source() as unknown as {
      consent: { status: string };
    };
    raw.consent.status = "denied";

    expect(() =>
      curatePatchTrainingRecord(raw as unknown as PatchTrainingSource, KEY),
    ).toThrow();
  });

  it("requires a real pre-patch failure receipt", () => {
    const raw = source();
    raw.beforeReceipts[0]!.status = "PASS";

    expect(() => curatePatchTrainingRecord(raw, KEY)).toThrow(
      "controller-observed pre-patch failure",
    );
  });

  it("rejects an already-satisfied requested change", () => {
    const raw = source();
    const before = raw.beforeReceipts[0];
    if (!before || before.kind !== "contract-evaluation") {
      throw new Error("Missing pre-patch evaluation");
    }
    before.requirements = before.requirements.map((requirement) =>
      requirement.requirementId === "homepage"
        ? { ...requirement, status: "PASS" as const }
        : requirement,
    );

    expect(() => curatePatchTrainingRecord(raw, KEY)).toThrow(
      "failed or unverified before the patch",
    );
  });

  it("rejects overlapping regression guards", () => {
    const raw = source();
    raw.selection.performanceRequirementIds = ["accessibility-regression"];

    expect(() => curatePatchTrainingRecord(raw, KEY)).toThrow(
      "Accessibility and performance requirement ids",
    );
  });

  it("hard-gates reward when post-patch tests fail", () => {
    const raw = source();
    const receipt = raw.afterReceipts.find(
      (candidate) => candidate.kind === "test",
    );
    if (!receipt || receipt.kind !== "test") {
      throw new Error("Missing test receipt fixture");
    }
    receipt.status = "FAIL";
    receipt.exitCode = 1;

    const reward = curatePatchTrainingRecord(raw, KEY).expected.reward;
    expect(reward.terminal).toBe(0);
    expect(reward.components.tests).toBe(0);
    expect(reward.reasonCodes).toContain("tests-failed");
    expect(reward.reasonCodes).toContain("proof-gate-failed");
  });

  it("penalizes an oversized but otherwise proven patch", () => {
    const raw = source();
    raw.patch.maxChangedLines = 10;

    const reward = curatePatchTrainingRecord(raw, KEY).expected.reward;
    expect(reward.accepted).toBe(true);
    expect(reward.terminal).toBe(0.75);
    expect(reward.reasonCodes).toEqual(["oversized-patch"]);
  });

  it("keeps project records in separate bundles", () => {
    const record = curatePatchTrainingRecord(source(), KEY);
    const otherProject = {
      ...record,
      projectScopeId: "e".repeat(64),
      exampleId: "f".repeat(64),
    } satisfies PatchTrainingRecord;

    expect(() =>
      curatePatchTrainingBundle([record, otherProject], KEY),
    ).toThrow("different projects cannot mix");
  });

  it("partitions deterministically without exposing source identifiers", () => {
    const raw = source();
    const first = curatePatchTrainingRecord(raw, KEY);
    const second = curatePatchTrainingRecord(raw, KEY);

    expect(second).toEqual(first);
    const bundle = curatePatchTrainingBundle([first], KEY);
    expect(bundle.records).toEqual([first]);
    expect(bundle.bundleDigest).toHaveLength(64);
  });

  it("rejects bundle contents changed without a new digest and attestation", () => {
    const record = curatePatchTrainingRecord(source(), KEY);
    const bundle = curatePatchTrainingBundle([record], KEY);
    bundle.records[0]!.input.contractStructure.hardRequirementCount += 1;

    expect(() => PatchTrainingBundleSchema.parse(bundle)).toThrow(
      "bundle digest does not match its contents",
    );
  });

  it("keeps repeated outcomes for one requested task in the same split", () => {
    const first = curatePatchTrainingRecord(source(), KEY);
    const second = curatePatchTrainingRecord(source(), KEY);

    expect(second.exampleId).not.toBe(first.exampleId);
    expect(second.split).toBe(first.split);
  });

  it("keeps legacy aggregate comparisons blocked pending the signed matrix", () => {
    const decision = decidePatchModelPromotion(heldOutComparison(), KEY);

    expect(decision).toMatchObject({
      status: "blocked",
      automaticPromotion: false,
      promoted: false,
      reasons: expect.arrayContaining([
        expect.stringContaining(
          "cannot attest privacy vetoes or repeated-trial confidence",
        ),
      ]),
    });
  });

  it("fails promotion closed on a safety regression", () => {
    const comparison = heldOutComparison((body) => {
      body.scores.supportedClaims = comparisonScore({
        diff: -0.05,
        regressions: 1,
      });
    });

    const decision = decidePatchModelPromotion(comparison, KEY);
    expect(decision.status).toBe("blocked");
    expect(decision.promoted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("supportedClaims has 1"),
        expect.stringContaining("supportedClaims regressed"),
      ]),
    );
  });

  it("fails promotion closed on any terminal regression", () => {
    const comparison = heldOutComparison((body) => {
      body.scores.terminal = comparisonScore({
        improvements: 4,
        regressions: 1,
      });
    });

    expect(decidePatchModelPromotion(comparison, KEY)).toMatchObject({
      status: "blocked",
      promoted: false,
      reasons: expect.arrayContaining([
        expect.stringContaining("terminal has 1"),
      ]),
    });
  });

  it("fails promotion closed on a small held-out set", () => {
    const comparison = heldOutComparison((body) => {
      body.dataset.recordCount = 19;
    });

    expect(decidePatchModelPromotion(comparison, KEY)).toMatchObject({
      status: "blocked",
      automaticPromotion: false,
      promoted: false,
      reasons: expect.arrayContaining([expect.stringContaining("20 required")]),
    });
  });

  it("rejects a forged comparison before issuing eligibility", () => {
    const comparison = heldOutComparison();
    comparison.scores.terminal.diff = 1;

    expect(() => decidePatchModelPromotion(comparison, KEY)).toThrow(
      "comparison attestation does not match",
    );
  });

  it("rejects evidence receipts from another run", () => {
    const raw = source();
    const receipt = raw.afterReceipts[0] as EvidenceReceipt;
    receipt.runId = randomUUID();

    expect(() => curatePatchTrainingRecord(raw, KEY)).toThrow("different run");
  });
});
