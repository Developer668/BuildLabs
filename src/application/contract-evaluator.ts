import type { BuildAssignment } from "../domain/contract.js";
import type { EvaluationReceipt, EvidenceReceipt } from "../domain/evidence.js";
import type { FrozenRevision } from "../domain/run.js";
import { canonicalJson, sha256 } from "../lib/canonical-json.js";
import type {
  InspectedPage,
  InspectedSourceFile,
  ModelPort,
  TraceSpan,
} from "../ports/index.js";
import { createReceiptBase } from "./receipts.js";

export interface ContractEvaluationRequest {
  runId: string;
  revision: FrozenRevision;
  assignment: BuildAssignment;
  pages: InspectedPage[];
  sourceFiles: InspectedSourceFile[];
  commandEvidence: EvidenceReceipt[];
  model: ModelPort;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}

export async function evaluateContract(
  request: ContractEvaluationRequest,
): Promise<EvaluationReceipt> {
  const startedAt = new Date().toISOString();
  const evidencePolicy = buildEvidencePolicy(request);
  const textPages = request.pages.map(({ path, status, visibleText }) => ({
    path,
    status,
    visibleText,
  }));
  const input = {
    contract: request.assignment.contract,
    revision: request.revision,
    pages: textPages,
    sourceFiles: request.sourceFiles,
    commandEvidence: request.commandEvidence,
    availableEvidenceRefs: evidencePolicy.available,
    requiredEvidenceRefsByRequirement: evidencePolicy.requiredByRequirement,
  };

  const output = await request.trace.child(
    "contract.evaluate",
    "score",
    {
      contractId: request.assignment.contract.contractId,
      revisionHash: request.revision.sourceDigest,
      pageCount: request.pages.length,
      sourceFileCount: request.sourceFiles.length,
    },
    async (span) => {
      const result = await request.model.evaluateContract(
        input,
        request.signal,
      );
      span.log({ output: result });
      return result;
    },
  );

  const requirementIds = new Set(
    request.assignment.contract.requirements.map(
      (requirement) => requirement.id,
    ),
  );
  const seen = new Set<string>();
  const malformedReasons: string[] = [];
  const allowedEvidenceRefs = new Set(evidencePolicy.available);
  for (const result of output.requirements) {
    if (!requirementIds.has(result.requirementId)) {
      malformedReasons.push(
        `Evaluator returned unknown requirement ${result.requirementId}`,
      );
    }
    if (seen.has(result.requirementId)) {
      malformedReasons.push(
        `Evaluator returned duplicate requirement ${result.requirementId}`,
      );
    }
    seen.add(result.requirementId);
    if (result.status === "PASS" && result.evidenceRefs.length === 0) {
      malformedReasons.push(
        `Evaluator returned PASS without evidence for ${result.requirementId}`,
      );
    }
    for (const evidenceRef of result.evidenceRefs) {
      if (!allowedEvidenceRefs.has(evidenceRef)) {
        malformedReasons.push(
          `Evaluator cited unknown evidence ${evidenceRef} for ${result.requirementId}`,
        );
      }
    }
    if (result.status === "PASS" && requirementIds.has(result.requirementId)) {
      const cited = new Set(result.evidenceRefs);
      const requiredGroups =
        evidencePolicy.requiredByRequirement[result.requirementId] ?? [];
      for (const [verifierIndex, group] of requiredGroups.entries()) {
        if (group.length === 0) {
          malformedReasons.push(
            `Controller has no evidence for verifier ${verifierIndex} of ${result.requirementId}`,
          );
        } else if (!group.some((reference) => cited.has(reference))) {
          malformedReasons.push(
            `Evaluator did not cite requirement-specific evidence for verifier ${verifierIndex} of ${result.requirementId}`,
          );
        }
      }
    }
  }
  for (const requirementId of requirementIds) {
    if (!seen.has(requirementId)) {
      malformedReasons.push(`Evaluator omitted requirement ${requirementId}`);
    }
  }

  const hardFailures = request.assignment.contract.requirements.filter(
    (requirement) =>
      requirement.priority === "hard" &&
      output.requirements.find(
        (result) => result.requirementId === requirement.id,
      )?.status !== "PASS",
  );
  const preferenceRequirements =
    request.assignment.contract.requirements.filter(
      (requirement) => requirement.priority === "preference",
    );
  const passingPreferences = preferenceRequirements.filter(
    (requirement) =>
      output.requirements.find(
        (result) => result.requirementId === requirement.id,
      )?.status === "PASS",
  );
  const status =
    malformedReasons.length > 0
      ? "ERROR"
      : hardFailures.length > 0 || output.unsupportedClaims.length > 0
        ? "FAIL"
        : "PASS";
  const braintrustScores = {
    hardRequirements:
      hardFailures.length === 0 && malformedReasons.length === 0
        ? (1 as const)
        : (0 as const),
    supportedBusinessFacts:
      output.unsupportedClaims.length === 0 ? (1 as const) : (0 as const),
    evidenceGrounding:
      malformedReasons.length === 0 ? (1 as const) : (0 as const),
    preferenceSatisfaction:
      preferenceRequirements.length === 0
        ? 1
        : passingPreferences.length / preferenceRequirements.length,
  };
  const completedAt = new Date().toISOString();
  const normalizedOutput =
    malformedReasons.length > 0
      ? {
          ...output,
          summary: `${output.summary}\n${malformedReasons.join("\n")}`,
        }
      : output;

  request.trace.log({
    scores: {
      hard_requirements: braintrustScores.hardRequirements,
      supported_business_facts: braintrustScores.supportedBusinessFacts,
      evidence_grounding: braintrustScores.evidenceGrounding,
      preference_satisfaction: braintrustScores.preferenceSatisfaction,
    },
    metadata: {
      evaluationStatus: status,
      revisionHash: request.revision.sourceDigest,
    },
  });

  return {
    ...createReceiptBase({
      runId: request.runId,
      revisionHash: request.revision.sourceDigest,
      status,
      startedAt,
      completedAt,
      input: {
        contractHash: canonicalJson(request.assignment.contract),
        pages: request.pages.map((page) => ({
          path: page.path,
          status: page.status,
        })),
        sourceFiles: request.sourceFiles.map((file) => file.path),
      },
      output: normalizedOutput,
    }),
    kind: "contract-evaluation",
    provider: "fireworks",
    traceProvider: "braintrust",
    traceId: request.trace.traceId,
    braintrustScores,
    requirements: normalizedOutput.requirements,
    unsupportedClaims: normalizedOutput.unsupportedClaims,
    summary: normalizedOutput.summary,
  };
}

interface EvidencePolicy {
  available: string[];
  requiredByRequirement: Record<string, string[][]>;
}

function buildEvidencePolicy(
  request: ContractEvaluationRequest,
): EvidencePolicy {
  const factRefs = request.assignment.contract.approvedFacts.map(
    (fact) => `fact:${fact.id}`,
  );
  const commandRefs = new Map(
    request.commandEvidence.map((receipt) => [
      receipt.receiptId,
      `receipt:${receipt.receiptId}`,
    ]),
  );
  const pageRefs = new Map(
    request.pages.map((page) => [
      page.path,
      `page:${page.path}:${sha256(page.visibleText)}`,
    ]),
  );
  const sourceRefs = request.sourceFiles.map(
    (file) => `source:${file.path}:${sha256(file.contents)}`,
  );
  const semanticRefs = [...pageRefs.values()];
  const requiredByRequirement: Record<string, string[][]> = {};

  for (const requirement of request.assignment.contract.requirements) {
    const groups = requirement.verifiers.map((verifier, verifierIndex) => {
      if (verifier.kind === "command") {
        return request.commandEvidence
          .filter(
            (receipt) =>
              receipt.kind === "requirement-command" &&
              receipt.requirementId === requirement.id &&
              receipt.verifierIndex === verifierIndex &&
              receipt.command === verifier.command,
          )
          .map((receipt) => commandRefs.get(receipt.receiptId))
          .filter((reference): reference is string => Boolean(reference));
      }
      if (verifier.kind === "http") {
        const reference = pageRefs.get(verifier.path);
        return reference ? [reference] : [];
      }
      return semanticRefs;
    });
    requiredByRequirement[requirement.id] =
      groups.length > 0 ? groups : [semanticRefs];
  }

  return {
    available: [
      ...new Set([
        ...factRefs,
        ...commandRefs.values(),
        ...pageRefs.values(),
        ...sourceRefs,
      ]),
    ],
    requiredByRequirement,
  };
}
