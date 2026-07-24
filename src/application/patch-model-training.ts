import { createHmac } from "node:crypto";

import type { AcceptanceContract, Requirement } from "../domain/contract.js";
import type {
  CommandReceipt,
  EvaluationReceipt,
  EvidenceReceipt,
} from "../domain/evidence.js";
import {
  PatchPromotionDecisionSchema,
  PatchTrainingRecordSchema,
  PatchTrainingSourceSchema,
  type PatchExperimentScores,
  type PatchHeldOutComparison,
  type PatchPromotionDecision,
  type PatchReward,
  type PatchRewardReasonCode,
  type PatchTrainingBundle,
  type PatchTrainingRecord,
  type PatchTrainingSource,
} from "../domain/patch-model.js";
import { canonicalJson, digestJson } from "../lib/canonical-json.js";
import {
  attestPatchTrainingBundle,
  verifyPatchHeldOutComparison,
  type PatchCheckpointAttestationKey,
} from "../lib/patch-checkpoint-attestation.js";
import { DEPENDENCY_BOOTSTRAP_COMMAND } from "./dependency-bootstrap.js";
import { decideProof } from "./proof-gate.js";
import {
  CONTAINER_BUILD_COMMAND,
  forbiddenClaimsCommand,
} from "./verification.js";

const EVIDENCE_KINDS = [
  "artifact",
  "build",
  "container-build",
  "contract-evaluation",
  "coderabbit",
  "dependency-bootstrap",
  "forbidden-claim",
  "visual-claim",
  "preview",
  "requirement-command",
  "test",
] as const satisfies readonly EvidenceReceipt["kind"][];

const REWARD_COMPONENT_NAMES = [
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

const HARD_REWARD_COMPONENT_NAMES = [
  "proofGate",
  "build",
  "tests",
  "requestedChange",
  "priorRequirements",
  "accessibility",
  "performance",
  "supportedClaims",
] as const satisfies readonly (keyof PatchExperimentScores)[];

export const PATCH_CURATION_POLICY = Object.freeze({
  version: 2,
  partition: {
    algorithm: "hmac-sha256-task-group-modulo",
    heldoutModulo: 5,
    heldoutRemainder: 0,
  },
  reward: {
    hardFailureScore: 0,
    passingMinimalScore: 1,
    passingOversizedScore: 0.75,
    source: "controller-evidence-receipts",
  },
  remoteDataClass: "anonymized-structural-only",
});

export const PATCH_CURATION_POLICY_DIGEST = digestJson(PATCH_CURATION_POLICY);

export const PATCH_PROMOTION_POLICY = Object.freeze({
  version: 2,
  minimumHeldoutExamples: 20,
  minimumTerminalScore: 0.8,
  minimumTerminalImprovement: 0.02,
  minimumHardComponentScore: 1,
  maximumRegressionsPerScore: 0,
  requiresPrivacyVeto: true,
  requiresRepeatedTrialConfidence: true,
  automaticPromotion: false,
});

export const PATCH_PROMOTION_POLICY_DIGEST = digestJson(PATCH_PROMOTION_POLICY);

type AnonymizationKey = string | Uint8Array;

function keyBytes(key: AnonymizationKey): Uint8Array {
  const bytes =
    typeof key === "string" ? Buffer.from(key, "utf8") : new Uint8Array(key);
  if (bytes.byteLength < 32) {
    throw new Error(
      "Patch training anonymization key must be at least 32 bytes",
    );
  }
  return bytes;
}

function opaqueDigest(
  key: Uint8Array,
  namespace: string,
  value: unknown,
): string {
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function requireHardRequirement(
  contract: AcceptanceContract,
  requirementId: string,
  label: string,
): Requirement {
  const requirement = contract.requirements.find(
    (candidate) => candidate.id === requirementId,
  );
  if (!requirement) {
    throw new Error(`${label} references an unknown requirement`);
  }
  if (requirement.priority !== "hard") {
    throw new Error(`${label} must reference a hard requirement`);
  }
  return requirement;
}

function latest<T extends EvidenceReceipt>(
  receipts: EvidenceReceipt[],
  predicate: (receipt: EvidenceReceipt) => receipt is T,
): T | undefined {
  return receipts
    .filter(predicate)
    .sort((left, right) =>
      right.completedAt.localeCompare(left.completedAt),
    )[0];
}

function isCommandReceipt(receipt: EvidenceReceipt): receipt is CommandReceipt {
  return (
    receipt.kind === "artifact" ||
    receipt.kind === "build" ||
    receipt.kind === "container-build" ||
    receipt.kind === "dependency-bootstrap" ||
    receipt.kind === "forbidden-claim" ||
    receipt.kind === "requirement-command" ||
    receipt.kind === "test"
  );
}

function sameNumbers(left: number[] | undefined, right: number[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function latestEvaluation(
  receipts: EvidenceReceipt[],
): EvaluationReceipt | undefined {
  return latest(
    receipts,
    (receipt): receipt is EvaluationReceipt =>
      receipt.kind === "contract-evaluation",
  );
}

function passingCommand(
  receipts: EvidenceReceipt[],
  kind: CommandReceipt["kind"],
  command?: string,
): boolean {
  const receipt = latest(
    receipts,
    (candidate): candidate is CommandReceipt =>
      isCommandReceipt(candidate) &&
      candidate.kind === kind &&
      (command === undefined || candidate.command === command),
  );
  return receipt?.status === "PASS" && receipt.exitCode === 0;
}

function requirementPassed(
  evaluation: EvaluationReceipt | undefined,
  requirementId: string,
): boolean {
  return (
    evaluation?.requirements.find(
      (requirement) => requirement.requirementId === requirementId,
    )?.status === "PASS"
  );
}

function requirementStatus(
  evaluation: EvaluationReceipt | undefined,
  requirementId: string,
): "FAIL" | "PASS" | "UNVERIFIED" | undefined {
  return evaluation?.requirements.find(
    (requirement) => requirement.requirementId === requirementId,
  )?.status;
}

function assertReceiptScope(
  receipts: EvidenceReceipt[],
  runId: string,
  revisionHash: string,
  label: string,
): void {
  for (const receipt of receipts) {
    if (receipt.runId !== runId) {
      throw new Error(`${label} receipt belongs to a different run`);
    }
    if (receipt.revisionHash !== revisionHash) {
      throw new Error(`${label} receipt belongs to a different revision`);
    }
  }
}

function evidenceProfile(receipts: EvidenceReceipt[]): {
  receiptCount: number;
  byKind: Record<(typeof EVIDENCE_KINDS)[number], number>;
  byStatus: Record<"ERROR" | "FAIL" | "PASS", number>;
} {
  const byKind = Object.fromEntries(
    EVIDENCE_KINDS.map((kind) => [kind, 0]),
  ) as Record<(typeof EVIDENCE_KINDS)[number], number>;
  const byStatus = { ERROR: 0, FAIL: 0, PASS: 0 };

  for (const receipt of receipts) {
    byKind[receipt.kind] += 1;
    byStatus[receipt.status] += 1;
  }

  return {
    receiptCount: receipts.length,
    byKind,
    byStatus,
  };
}

function contractStructure(contract: AcceptanceContract): {
  hardRequirementCount: number;
  preferenceRequirementCount: number;
  approvedFactCount: number;
  forbiddenClaimCount: number;
  commandVerifierCount: number;
  httpVerifierCount: number;
  semanticVerifierCount: number;
  testCommandCount: number;
} {
  const verifierKinds = contract.requirements.flatMap(
    (requirement) => requirement.verifiers,
  );
  return {
    hardRequirementCount: contract.requirements.filter(
      (requirement) => requirement.priority === "hard",
    ).length,
    preferenceRequirementCount: contract.requirements.filter(
      (requirement) => requirement.priority === "preference",
    ).length,
    approvedFactCount: contract.approvedFacts.length,
    forbiddenClaimCount: contract.forbiddenClaims.length,
    commandVerifierCount: verifierKinds.filter(
      (verifier) => verifier.kind === "command",
    ).length,
    httpVerifierCount: verifierKinds.filter(
      (verifier) => verifier.kind === "http",
    ).length,
    semanticVerifierCount: verifierKinds.filter(
      (verifier) => verifier.kind === "semantic",
    ).length,
    testCommandCount: contract.verification.testCommands.length,
  };
}

function receiptIdentities(receipts: EvidenceReceipt[]): unknown[] {
  return receipts
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      status: receipt.status,
      inputDigest: receipt.inputDigest,
      outputDigest: receipt.outputDigest,
      revisionHash: receipt.revisionHash,
    }))
    .sort((left, right) => left.receiptId.localeCompare(right.receiptId));
}

function computeReward(
  source: PatchTrainingSource,
  evidenceDigest: string,
): PatchReward {
  const { contract, patch, selection, afterReceipts } = source;
  const proofDecision = decideProof(
    contract,
    patch.revisionHash,
    afterReceipts,
  );
  const evaluation = latestEvaluation(afterReceipts);

  const buildPassed =
    passingCommand(
      afterReceipts,
      "dependency-bootstrap",
      DEPENDENCY_BOOTSTRAP_COMMAND,
    ) &&
    passingCommand(
      afterReceipts,
      "build",
      contract.verification.buildCommand,
    ) &&
    passingCommand(afterReceipts, "container-build", CONTAINER_BUILD_COMMAND);
  const testsPassed = contract.verification.testCommands.every((command) =>
    passingCommand(afterReceipts, "test", command),
  );
  const requestedChangePassed = requirementPassed(
    evaluation,
    selection.requestedChangeRequirementId,
  );
  const priorRequirementsPassed = contract.requirements
    .filter(
      (requirement) =>
        requirement.priority === "hard" &&
        requirement.id !== selection.requestedChangeRequirementId,
    )
    .every((requirement) => requirementPassed(evaluation, requirement.id));
  const accessibilityPassed = selection.accessibilityRequirementIds.every(
    (requirementId) => requirementPassed(evaluation, requirementId),
  );
  const performancePassed = selection.performanceRequirementIds.every(
    (requirementId) => requirementPassed(evaluation, requirementId),
  );
  const forbiddenClaimIndices = contract.forbiddenClaims.map(
    (_, index) => index,
  );
  const forbiddenClaimScan =
    forbiddenClaimIndices.length === 0
      ? undefined
      : latest(
          afterReceipts,
          (candidate): candidate is CommandReceipt =>
            isCommandReceipt(candidate) &&
            candidate.kind === "forbidden-claim" &&
            candidate.command ===
              forbiddenClaimsCommand(contract.forbiddenClaims) &&
            sameNumbers(candidate.forbiddenClaimIndices, forbiddenClaimIndices),
        );
  const forbiddenClaimScansPassed =
    forbiddenClaimIndices.length === 0 ||
    (forbiddenClaimScan?.status === "PASS" &&
      forbiddenClaimScan.exitCode === 0);
  const supportedClaims =
    evaluation?.status === "PASS" &&
    evaluation.unsupportedClaims.length === 0 &&
    evaluation.braintrustScores.supportedBusinessFacts === 1 &&
    evaluation.braintrustScores.evidenceGrounding === 1 &&
    forbiddenClaimScansPassed;
  const minimalPatch =
    patch.additions + patch.deletions <= patch.maxChangedLines;

  const components = {
    proofGate: proofDecision.passed ? 1 : 0,
    build: buildPassed ? 1 : 0,
    tests: testsPassed ? 1 : 0,
    requestedChange: requestedChangePassed ? 1 : 0,
    priorRequirements: priorRequirementsPassed ? 1 : 0,
    accessibility: accessibilityPassed ? 1 : 0,
    performance: performancePassed ? 1 : 0,
    supportedClaims: supportedClaims ? 1 : 0,
    minimalPatch: minimalPatch ? 1 : 0,
  } as const;

  const reasonCodes: PatchRewardReasonCode[] = [];
  if (components.proofGate === 0) reasonCodes.push("proof-gate-failed");
  if (components.build === 0) reasonCodes.push("build-failed");
  if (components.tests === 0) reasonCodes.push("tests-failed");
  if (components.requestedChange === 0) {
    reasonCodes.push("requested-change-unverified");
  }
  if (components.priorRequirements === 0) {
    reasonCodes.push("prior-requirement-regression");
  }
  if (components.accessibility === 0) {
    reasonCodes.push("accessibility-regression");
  }
  if (components.performance === 0) {
    reasonCodes.push("performance-regression");
  }
  if (components.supportedClaims === 0) {
    reasonCodes.push("unsupported-claim");
  }
  if (components.minimalPatch === 0) {
    reasonCodes.push("oversized-patch");
  }

  const hardGatePassed = HARD_REWARD_COMPONENT_NAMES.every(
    (component) => components[component] === 1,
  );
  const terminal = hardGatePassed
    ? components.minimalPatch === 1
      ? PATCH_CURATION_POLICY.reward.passingMinimalScore
      : PATCH_CURATION_POLICY.reward.passingOversizedScore
    : PATCH_CURATION_POLICY.reward.hardFailureScore;

  return {
    policyVersion: 1,
    components,
    terminal,
    accepted: proofDecision.passed,
    reasonCodes,
    evidenceDigest,
  };
}

function validateSource(source: PatchTrainingSource): {
  requestedChange: Requirement;
} {
  if (source.consent.projectId !== source.contract.projectId) {
    throw new Error("Patch training consent belongs to a different project");
  }
  if (Date.parse(source.curatedAt) < Date.parse(source.consent.recordedAt)) {
    throw new Error("Patch training consent must predate curation");
  }

  assertReceiptScope(
    source.beforeReceipts,
    source.runId,
    source.patch.baseRevisionHash,
    "Before",
  );
  assertReceiptScope(
    source.afterReceipts,
    source.runId,
    source.patch.revisionHash,
    "After",
  );

  const receiptIds = [...source.beforeReceipts, ...source.afterReceipts].map(
    (receipt) => receipt.receiptId,
  );
  assertUnique(receiptIds, "Patch evidence receipt ids");

  if (
    !source.beforeReceipts.some(
      (receipt) => receipt.status === "FAIL" || receipt.status === "ERROR",
    )
  ) {
    throw new Error(
      "Patch training source must contain a controller-observed pre-patch failure",
    );
  }

  assertUnique(
    source.selection.accessibilityRequirementIds,
    "Accessibility requirement ids",
  );
  assertUnique(
    source.selection.performanceRequirementIds,
    "Performance requirement ids",
  );

  const requestedChange = requireHardRequirement(
    source.contract,
    source.selection.requestedChangeRequirementId,
    "Requested change",
  );
  const selectedGuardIds = [
    ...source.selection.accessibilityRequirementIds,
    ...source.selection.performanceRequirementIds,
  ];
  if (selectedGuardIds.includes(requestedChange.id)) {
    throw new Error("Requested change cannot also serve as a regression guard");
  }
  assertUnique(
    selectedGuardIds,
    "Accessibility and performance requirement ids",
  );

  const beforeEvaluation = latestEvaluation(source.beforeReceipts);
  const requestedBeforeStatus = requirementStatus(
    beforeEvaluation,
    requestedChange.id,
  );
  if (
    requestedBeforeStatus !== "FAIL" &&
    requestedBeforeStatus !== "UNVERIFIED"
  ) {
    throw new Error(
      "Requested change must be failed or unverified before the patch",
    );
  }

  for (const requirementId of source.selection.accessibilityRequirementIds) {
    requireHardRequirement(
      source.contract,
      requirementId,
      "Accessibility evidence",
    );
    if (!requirementPassed(beforeEvaluation, requirementId)) {
      throw new Error(
        "Accessibility regression guard must pass before the patch",
      );
    }
  }
  for (const requirementId of source.selection.performanceRequirementIds) {
    requireHardRequirement(
      source.contract,
      requirementId,
      "Performance evidence",
    );
    if (!requirementPassed(beforeEvaluation, requirementId)) {
      throw new Error(
        "Performance regression guard must pass before the patch",
      );
    }
  }

  return { requestedChange };
}

export function curatePatchTrainingRecord(
  input: PatchTrainingSource,
  anonymizationKey: AnonymizationKey,
): PatchTrainingRecord {
  const source = PatchTrainingSourceSchema.parse(input);
  const key = keyBytes(anonymizationKey);
  const { requestedChange } = validateSource(source);

  const projectScopeId = opaqueDigest(
    key,
    "buildlabs.patch-model.project",
    source.contract.projectId,
  );
  const exampleId = opaqueDigest(key, "buildlabs.patch-model.example", {
    projectId: source.contract.projectId,
    runId: source.runId,
    baseRevisionHash: source.patch.baseRevisionHash,
    revisionHash: source.patch.revisionHash,
    diffSha256: source.patch.diffSha256,
  });
  const splitDigest = opaqueDigest(key, "buildlabs.patch-model.partition", {
    projectId: source.contract.projectId,
    contractId: source.contract.contractId,
    requestedChangeRequirementId: source.selection.requestedChangeRequirementId,
  });
  const split =
    Number.parseInt(splitDigest.slice(0, 8), 16) %
      PATCH_CURATION_POLICY.partition.heldoutModulo ===
    PATCH_CURATION_POLICY.partition.heldoutRemainder
      ? "heldout"
      : "train";
  const sourceEvidenceDigest = opaqueDigest(
    key,
    "buildlabs.patch-model.evidence",
    {
      before: receiptIdentities(source.beforeReceipts),
      after: receiptIdentities(source.afterReceipts),
    },
  );
  const reward = computeReward(source, sourceEvidenceDigest);
  const verifierKinds = [
    ...new Set(
      requestedChange.verifiers.map((verifier) => {
        if (verifier.kind === "semantic") {
          throw new Error(
            "A hard requested change cannot use a semantic verifier",
          );
        }
        return verifier.kind;
      }),
    ),
  ].sort();

  return PatchTrainingRecordSchema.parse({
    schemaVersion: 1,
    projectScopeId,
    exampleId,
    split,
    input: {
      contractStructure: contractStructure(source.contract),
      priorEvidence: evidenceProfile(source.beforeReceipts),
      requestedChange: {
        priority: "hard",
        verifierKinds,
        priorHardRequirementCount: source.contract.requirements.filter(
          (requirement) =>
            requirement.priority === "hard" &&
            requirement.id !== requestedChange.id,
        ).length,
        accessibilityCheckCount:
          source.selection.accessibilityRequirementIds.length,
        performanceCheckCount:
          source.selection.performanceRequirementIds.length,
      },
    },
    expected: {
      patchShape: {
        language: source.patch.language,
        fileKinds: [...source.patch.fileKinds].sort(),
        changedFileCount: source.patch.changedFileCount,
        additions: source.patch.additions,
        deletions: source.patch.deletions,
        maxChangedLines: source.patch.maxChangedLines,
      },
      reward,
    },
    metadata: {
      curatedAt: source.curatedAt,
      dataUseConsent: "granted",
      consentReceiptDigest: opaqueDigest(
        key,
        "buildlabs.patch-model.consent",
        source.consent,
      ),
      sourceEvidenceDigest,
      baseRevisionDigest: opaqueDigest(
        key,
        "buildlabs.patch-model.revision",
        source.patch.baseRevisionHash,
      ),
      candidateRevisionDigest: opaqueDigest(
        key,
        "buildlabs.patch-model.revision",
        source.patch.revisionHash,
      ),
      diffDigest: opaqueDigest(
        key,
        "buildlabs.patch-model.diff",
        source.patch.diffSha256,
      ),
      curationPolicyDigest: PATCH_CURATION_POLICY_DIGEST,
    },
  });
}

export function curatePatchTrainingBundle(
  input: PatchTrainingRecord[],
  attestationKey: PatchCheckpointAttestationKey,
): PatchTrainingBundle {
  const records = input
    .map((record) => PatchTrainingRecordSchema.parse(record))
    .sort((left, right) => left.exampleId.localeCompare(right.exampleId));
  if (records.length === 0) {
    throw new Error("Patch training bundle must contain at least one record");
  }

  const projectScopeId = records[0]!.projectScopeId;
  if (records.some((record) => record.projectScopeId !== projectScopeId)) {
    throw new Error(
      "Patch training records from different projects cannot mix",
    );
  }
  assertUnique(
    records.map((record) => record.exampleId),
    "Patch training example ids",
  );
  if (
    records.some(
      (record) =>
        record.metadata.curationPolicyDigest !== PATCH_CURATION_POLICY_DIGEST,
    )
  ) {
    throw new Error("Patch training record uses an unknown curation policy");
  }

  const body = {
    schemaVersion: 1 as const,
    projectScopeId,
    records,
  };
  return attestPatchTrainingBundle(
    {
      ...body,
      bundleDigest: digestJson(body),
    },
    attestationKey,
  );
}

export function decidePatchModelPromotion(
  input: PatchHeldOutComparison,
  attestationKey: PatchCheckpointAttestationKey,
): PatchPromotionDecision {
  const comparison = verifyPatchHeldOutComparison(input, attestationKey);
  const reasons: string[] = [
    "Aggregate comparison cannot attest privacy vetoes or repeated-trial confidence; the signed Patch Model matrix is required",
  ];

  if (
    comparison.dataset.recordCount <
    PATCH_PROMOTION_POLICY.minimumHeldoutExamples
  ) {
    reasons.push(
      `Held-out dataset has ${comparison.dataset.recordCount} examples; ${PATCH_PROMOTION_POLICY.minimumHeldoutExamples} required`,
    );
  }

  if (
    comparison.scores.terminal.score <
    PATCH_PROMOTION_POLICY.minimumTerminalScore
  ) {
    reasons.push(
      `Terminal score ${comparison.scores.terminal.score} is below ${PATCH_PROMOTION_POLICY.minimumTerminalScore}`,
    );
  }
  // Braintrust defines diff as current (candidate) minus the explicit reference.
  if (
    comparison.scores.terminal.diff <
    PATCH_PROMOTION_POLICY.minimumTerminalImprovement
  ) {
    reasons.push(
      `Terminal improvement ${comparison.scores.terminal.diff} is below ${PATCH_PROMOTION_POLICY.minimumTerminalImprovement}`,
    );
  }
  if (comparison.scores.terminal.improvements === 0) {
    reasons.push("Braintrust reported no held-out terminal improvements");
  }
  if (
    comparison.scores.terminal.regressions >
    PATCH_PROMOTION_POLICY.maximumRegressionsPerScore
  ) {
    reasons.push(
      `terminal has ${comparison.scores.terminal.regressions} held-out regression(s)`,
    );
  }
  if (
    comparison.scores.terminal.improvements +
      comparison.scores.terminal.regressions >
    comparison.dataset.recordCount
  ) {
    reasons.push("terminal comparison counts exceed the held-out dataset");
  }

  for (const scoreName of REWARD_COMPONENT_NAMES) {
    const score = comparison.scores[scoreName];
    if (score.regressions > PATCH_PROMOTION_POLICY.maximumRegressionsPerScore) {
      reasons.push(
        `${scoreName} has ${score.regressions} held-out regression(s)`,
      );
    }
    if (score.diff < 0) {
      reasons.push(`${scoreName} regressed by ${Math.abs(score.diff)}`);
    }
    if (
      HARD_REWARD_COMPONENT_NAMES.includes(
        scoreName as (typeof HARD_REWARD_COMPONENT_NAMES)[number],
      ) &&
      score.score < PATCH_PROMOTION_POLICY.minimumHardComponentScore
    ) {
      reasons.push(
        `${scoreName} score ${score.score} is below ${PATCH_PROMOTION_POLICY.minimumHardComponentScore}`,
      );
    }
    if (
      score.improvements + score.regressions >
      comparison.dataset.recordCount
    ) {
      reasons.push(
        `${scoreName} comparison counts exceed the held-out dataset`,
      );
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const status =
    uniqueReasons.length === 0 ? "eligible-for-manual-promotion" : "blocked";
  const decisionBody = {
    comparison,
    policy: PATCH_PROMOTION_POLICY,
    promotionPolicyDigest: PATCH_PROMOTION_POLICY_DIGEST,
    status,
    reasons: uniqueReasons,
  };

  return PatchPromotionDecisionSchema.parse({
    schemaVersion: 1,
    status,
    automaticPromotion: false,
    promoted: false,
    reasons: uniqueReasons,
    decisionDigest: digestJson(decisionBody),
  });
}
