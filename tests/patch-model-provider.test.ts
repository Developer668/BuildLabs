import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  curatePatchProviderBundle,
  curatePatchProviderExample,
  exportPatchProviderBundle,
  verifyPatchProviderBundle,
  verifyPatchProviderExport,
} from "../src/application/patch-model-provider.js";
import { decideProof } from "../src/application/proof-gate.js";
import type { EvidenceReceipt } from "../src/domain/evidence.js";
import type {
  PatchProviderExample,
  PatchProviderSourceFile,
} from "../src/domain/patch-model-provider.js";
import type { PatchTrainingSource } from "../src/domain/patch-model.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import { assignment, passingEvidence } from "./fixtures.js";
import { integrateCodeRabbitReviewFixture } from "./patch-model-coderabbit-fixture.js";

const KEY = "patch-provider-controller-key!".repeat(2);

function material(
  contractRevision: number,
  contractId = `contract-provider-${contractRevision}`,
  projectId = "project-mission-peak",
): {
  source: PatchTrainingSource;
  sourceFiles: PatchProviderSourceFile[];
  sourceContentDigest: string;
  unifiedDiff: string;
} {
  const build = assignment(`provider-${contractRevision}`, (value) => {
    value.projectId = projectId;
    value.contract.projectId = projectId;
    value.contract.contractRevision = contractRevision;
    value.contract.contractId = contractId;
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
  const sourceFiles = [
    {
      path: "src/title.ts",
      content: 'export const heading = "Mission Peak Electric";\n',
    },
  ];
  const unifiedDiff = [
    "diff --git a/src/title.ts b/src/title.ts",
    "index 1111111..2222222 100644",
    "--- a/src/title.ts",
    "+++ b/src/title.ts",
    "@@ -1 +1 @@",
    '-export const heading = "Mission Peak Electric";',
    `+export const heading = "Mission Peak Electric services revision-${contractRevision}-${sha256(contractId).slice(0, 6)}";`,
    "",
  ].join("\n");
  const baseRevisionHash = sha256(
    `${contractRevision}:${contractId}:provider-base`,
  );
  const revisionHash = sha256(
    `${contractRevision}:${contractId}:provider-revision`,
  );
  const runId = randomUUID();
  const afterReceipts = passingEvidence(runId, revisionHash, build);
  integrateCodeRabbitReviewFixture(
    afterReceipts,
    build.contract,
    runId,
    revisionHash,
  );
  const evaluation = afterReceipts.find(
    (receipt) => receipt.kind === "contract-evaluation",
  );
  if (!evaluation || evaluation.kind !== "contract-evaluation") {
    throw new Error("Missing evaluation fixture");
  }
  const beforeReceipt: EvidenceReceipt = {
    ...evaluation,
    receiptId: randomUUID(),
    revisionHash: baseRevisionHash,
    status: "FAIL",
    braintrustScores: {
      ...evaluation.braintrustScores,
      hardRequirements: 0,
    },
    requirements: evaluation.requirements.map((requirement) =>
      requirement.requirementId === "homepage"
        ? { ...requirement, status: "FAIL" as const }
        : requirement,
    ),
    summary: "controller-observed failure",
  };
  return {
    source: {
      schemaVersion: 1,
      consent: {
        schemaVersion: 1,
        projectId,
        status: "granted",
        purpose: "fireworks-rft-patch-model",
        recordedAt: "2026-07-23T11:00:00.000Z",
        consentReceiptId: randomUUID(),
      },
      contract: build.contract,
      runId,
      curatedAt: "2026-07-23T13:00:00.000Z",
      patch: {
        baseRevisionHash,
        revisionHash,
        diffSha256: sha256(unifiedDiff),
        language: "typescript",
        fileKinds: ["source"],
        changedFileCount: 1,
        additions: 1,
        deletions: 1,
        maxChangedLines: 20,
      },
      selection: {
        requestedChangeRequirementId: "homepage",
        accessibilityRequirementIds: ["accessibility-regression"],
        performanceRequirementIds: ["performance-regression"],
      },
      beforeReceipts: [beforeReceipt],
      afterReceipts,
    },
    sourceFiles,
    sourceContentDigest: digestJson(sourceFiles),
    unifiedDiff,
  };
}

function examplesWithBothSplits(): [
  PatchProviderExample,
  PatchProviderExample,
] {
  let training: PatchProviderExample | undefined;
  let heldout: PatchProviderExample | undefined;
  for (let revision = 1; revision <= 100; revision += 1) {
    const example = curatePatchProviderExample(material(revision), KEY);
    if (example.split === "train" && !training) training = example;
    if (example.split === "heldout" && !heldout) heldout = example;
    if (training && heldout) return [training, heldout];
  }
  throw new Error("Could not construct both deterministic splits");
}

describe("Patch Model provider training data", () => {
  it("creates an anonymized, governed SFT tool trajectory", () => {
    const raw = material(1);
    expect(
      decideProof(
        raw.source.contract,
        raw.source.patch.revisionHash,
        raw.source.afterReceipts,
      ).reasons,
    ).toEqual([]);
    const example = curatePatchProviderExample(raw, KEY);
    const serialized = JSON.stringify(example);

    expect(example.messages.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(example.expected.originalPatchDigest).toBe(
      raw.source.patch.diffSha256,
    );
    expect(example.metadata).toMatchObject({
      contractRevision: 1,
      dataUseConsent: "granted",
      sourceDigest: raw.sourceContentDigest,
    });
    expect(serialized).toContain("[SUPPORTED_TEXT_");
    expect(serialized).not.toContain("Mission Peak Electric");
    expect(serialized).not.toContain("src/title.ts");
    expect(serialized).not.toContain(raw.source.runId);
    expect(serialized).not.toContain(raw.source.consent.consentReceiptId);
    expect(serialized).not.toMatch(/reasoning_content|chain.of.thought/i);
  });

  it.each([
    ['export const contact = "private@example.com";', "email address"],
    ['export const payment = "pi_customersecret123";', "payment reference"],
    ['export const token = "Bearer abcdefghijklmnop";', "bearer credential"],
    ['export const notes = "<think>private";', "private reasoning"],
    ['export const logs = "stdout:\\\\ncustomer output";', "raw process log"],
    ['export const home = "/Users/customer/private";', "user filesystem path"],
    ['export const site = "https://customer.com";', "URL or domain"],
    ['export const host = "192.168.10.42";', "IP address"],
    ['export const office = "123 Market Street";', "postal address"],
    ['export const owner = "owner: Jane Customer";', "named person"],
    ['export const intl = "+44 20 7946 0958";', "international phone number"],
  ])("rejects contaminated provider material: %s", (content, reason) => {
    const raw = material(2);
    raw.sourceFiles[0]!.content = content;
    raw.sourceContentDigest = digestJson(raw.sourceFiles);
    expect(() => curatePatchProviderExample(raw, KEY)).toThrow(reason);
  });

  it("requires valid consent and controller-bound diff statistics", () => {
    const invalidConsent = material(3) as unknown as {
      source: { consent: { status: string } };
      sourceFiles: PatchProviderSourceFile[];
      unifiedDiff: string;
    };
    invalidConsent.source.consent.status = "denied";
    expect(() =>
      curatePatchProviderExample(
        invalidConsent as unknown as ReturnType<typeof material>,
        KEY,
      ),
    ).toThrow();

    const wrongDiff = material(4);
    wrongDiff.unifiedDiff += "\n+unattested";
    expect(() => curatePatchProviderExample(wrongDiff, KEY)).toThrow(
      "controller digest",
    );

    const wrongSource = material(5);
    wrongSource.sourceFiles[0]!.content += "// unbound\n";
    expect(() => curatePatchProviderExample(wrongSource, KEY)).toThrow(
      "controller content digest",
    );
  });

  it("rejects omitted source files and non-applicable diffs", () => {
    const missing = material(6);
    missing.sourceFiles[0]!.path = "src/other.ts";
    missing.sourceContentDigest = digestJson(missing.sourceFiles);
    expect(() => curatePatchProviderExample(missing, KEY)).toThrow(
      "omitted source file",
    );

    const mismatch = material(7);
    mismatch.sourceFiles[0]!.content = 'export const heading = "Elsewhere";\n';
    mismatch.sourceContentDigest = digestJson(mismatch.sourceFiles);
    expect(() => curatePatchProviderExample(mismatch, KEY)).toThrow(
      "removal does not match source",
    );
  });

  it("keeps targets and rewards out of the Fireworks RFT prompt export", () => {
    const [training, heldout] = examplesWithBothSplits();
    const bundle = curatePatchProviderBundle([training, heldout], KEY);
    const rft = exportPatchProviderBundle(
      bundle,
      KEY,
      "fireworks-rft-jsonl",
      "train",
    );
    const sft = exportPatchProviderBundle(
      bundle,
      KEY,
      "openai-sft-jsonl",
      "train",
    );

    expect(rft.content).not.toContain("tool_calls");
    expect(rft.content).not.toContain("proofDigest");
    expect(rft.content).not.toContain('"reward"');
    expect(rft.content).not.toContain("Mission Peak Electric");
    expect(sft.content).toContain("tool_calls");
    expect(sft.content).not.toContain("Mission Peak Electric");
    expect(verifyPatchProviderBundle(bundle, KEY)).toEqual(bundle);
    expect(verifyPatchProviderExport(rft, KEY)).toEqual(rft);
    expect(rft.attestation.consentReceiptDigests).toEqual(
      bundle.attestation.consentReceiptDigests,
    );
  });

  it("rejects duplicate records, cross-project mixing, and split overlap", () => {
    const [training] = examplesWithBothSplits();
    expect(() => curatePatchProviderBundle([training, training], KEY)).toThrow(
      "duplicate example ids",
    );

    const otherProject = curatePatchProviderExample(
      material(80, "contract-other", "project-other"),
      KEY,
    );
    expect(() =>
      curatePatchProviderBundle([training, otherProject], KEY),
    ).toThrow("mix projects");

    const candidates: PatchProviderExample[] = [];
    for (let index = 1; index <= 100; index += 1) {
      const example = curatePatchProviderExample(
        material(101, `contract-overlap-${index}`),
        KEY,
      );
      candidates.push(example);
      const opposite = candidates.find(
        (candidate) => candidate.split !== example.split,
      );
      if (opposite) {
        expect(() =>
          curatePatchProviderBundle([opposite, example], KEY),
        ).toThrow("duplicate task groups");
        return;
      }
    }
    throw new Error("Could not construct an adversarial split-overlap pair");
  });

  it("fails verification after bundle attestation tampering", () => {
    const [training, heldout] = examplesWithBothSplits();
    const bundle = curatePatchProviderBundle([training, heldout], KEY);
    bundle.attestation.signature = "0".repeat(64);
    expect(() => verifyPatchProviderBundle(bundle, KEY)).toThrow(
      "signature is invalid",
    );
  });

  it("fails verification after provider export attestation tampering", () => {
    const [training, heldout] = examplesWithBothSplits();
    const bundle = curatePatchProviderBundle([training, heldout], KEY);
    const providerExport = exportPatchProviderBundle(
      bundle,
      KEY,
      "fireworks-rft-jsonl",
      "train",
    );
    providerExport.attestation.signature = "0".repeat(64);
    expect(() => verifyPatchProviderExport(providerExport, KEY)).toThrow(
      "signature is invalid",
    );
  });
});
