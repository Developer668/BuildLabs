import type { AcceptanceContract } from "../domain/contract.js";
import type {
  CommandReceipt,
  EvaluationReceipt,
  EvidenceReceipt,
  PreviewReceipt,
  ProofDecision,
  RasterClaimReceipt,
  ReviewReceipt,
} from "../domain/evidence.js";
import { canonicalJson, digestJson, sha256 } from "../lib/canonical-json.js";
import { DEPENDENCY_BOOTSTRAP_COMMAND } from "./dependency-bootstrap.js";
import {
  CONTAINER_BUILD_COMMAND,
  DOCKERFILE_VERIFICATION_COMMAND,
  forbiddenClaimsCommand,
} from "./verification.js";
import { previewInputDigest } from "./preview-inspector.js";

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
    receipt.kind === "build" ||
    receipt.kind === "container-build" ||
    receipt.kind === "dependency-bootstrap" ||
    receipt.kind === "forbidden-claim" ||
    receipt.kind === "artifact" ||
    receipt.kind === "test" ||
    receipt.kind === "requirement-command"
  );
}

function isPreviewReceipt(receipt: EvidenceReceipt): receipt is PreviewReceipt {
  return receipt.kind === "preview";
}

function isReviewReceipt(receipt: EvidenceReceipt): receipt is ReviewReceipt {
  return receipt.kind === "coderabbit";
}

function isEvaluationReceipt(
  receipt: EvidenceReceipt,
): receipt is EvaluationReceipt {
  return receipt.kind === "contract-evaluation";
}

function isRasterClaimReceipt(
  receipt: EvidenceReceipt,
): receipt is RasterClaimReceipt {
  return receipt.kind === "visual-claim";
}

export function decideProof(
  contract: AcceptanceContract,
  revisionHash: string,
  allReceipts: EvidenceReceipt[],
): ProofDecision {
  const reasons: string[] = [];
  const receipts = allReceipts.filter(
    (receipt) => receipt.revisionHash === revisionHash,
  );

  const dockerfile = latest(
    receipts,
    (receipt): receipt is CommandReceipt =>
      isCommandReceipt(receipt) &&
      receipt.kind === "artifact" &&
      receipt.command === DOCKERFILE_VERIFICATION_COMMAND,
  );
  if (!dockerfile) {
    reasons.push("Missing Dockerfile evidence for the frozen revision");
  } else if (dockerfile.status !== "PASS" || dockerfile.exitCode !== 0) {
    reasons.push(`Dockerfile artifact did not pass (${dockerfile.status})`);
  }

  const dependencyBootstrap = latest(
    receipts,
    (receipt): receipt is CommandReceipt =>
      isCommandReceipt(receipt) &&
      receipt.kind === "dependency-bootstrap" &&
      receipt.command === DEPENDENCY_BOOTSTRAP_COMMAND,
  );
  if (!dependencyBootstrap) {
    reasons.push("Missing dependency bootstrap evidence");
  } else if (
    dependencyBootstrap.status !== "PASS" ||
    dependencyBootstrap.exitCode !== 0
  ) {
    reasons.push(
      `Dependency bootstrap did not pass (${dependencyBootstrap.status})`,
    );
  }

  const build = latest(
    receipts,
    (receipt): receipt is CommandReceipt =>
      isCommandReceipt(receipt) &&
      receipt.kind === "build" &&
      receipt.command === contract.verification.buildCommand,
  );
  if (!build) {
    reasons.push("Missing build evidence for the frozen revision");
  } else if (build.status !== "PASS" || build.exitCode !== 0) {
    reasons.push(`Build did not pass (${build.status})`);
  }

  const containerBuild = latest(
    receipts,
    (receipt): receipt is CommandReceipt =>
      isCommandReceipt(receipt) &&
      receipt.kind === "container-build" &&
      receipt.command === CONTAINER_BUILD_COMMAND,
  );
  if (!containerBuild) {
    reasons.push("Missing container build evidence for the frozen revision");
  } else if (
    containerBuild.status !== "PASS" ||
    containerBuild.exitCode !== 0
  ) {
    reasons.push(`Container image did not build (${containerBuild.status})`);
  }

  for (const command of contract.verification.testCommands) {
    const test = latest(
      receipts,
      (receipt): receipt is CommandReceipt =>
        isCommandReceipt(receipt) &&
        receipt.kind === "test" &&
        receipt.command === command,
    );
    if (!test) {
      reasons.push(`Missing test evidence: ${command}`);
    } else if (test.status !== "PASS" || test.exitCode !== 0) {
      reasons.push(`Test did not pass: ${command} (${test.status})`);
    }
  }

  const expectedIndices = contract.forbiddenClaims.map((_, index) => index);
  if (contract.forbiddenClaims.length > 0) {
    const scan = latest(
      receipts,
      (receipt): receipt is CommandReceipt =>
        isCommandReceipt(receipt) &&
        receipt.kind === "forbidden-claim" &&
        sameNumbers(receipt.forbiddenClaimIndices, expectedIndices) &&
        receipt.command === forbiddenClaimsCommand(contract.forbiddenClaims),
    );
    if (!scan) {
      reasons.push("Missing complete forbidden-claim scan");
    } else if (scan.status !== "PASS" || scan.exitCode !== 0) {
      reasons.push("One or more forbidden claims were detected");
    }
  }

  const visualScan = latest(
    receipts,
    (receipt): receipt is RasterClaimReceipt =>
      isRasterClaimReceipt(receipt) &&
      sameNumbers(receipt.forbiddenClaimIndices, expectedIndices) &&
      receipt.claimSetDigest ===
        sha256(canonicalJson(contract.forbiddenClaims)) &&
      receipt.approvedFactSetDigest ===
        sha256(
          canonicalJson(contract.approvedFacts.map((fact) => fact.statement)),
        ),
  );
  if (!visualScan) {
    reasons.push("Missing complete raster claim inspection");
  } else if (visualScan.status !== "PASS") {
    reasons.push(`Raster claim inspection did not pass (${visualScan.status})`);
  } else if (
    visualScan.matches.length > 0 ||
    visualScan.unsupportedAssetIndices.length > 0 ||
    visualScan.unverifiedAssetIndices.length > 0
  ) {
    reasons.push("Raster assets contain unsupported or forbidden claims");
  }

  const preview = latest(receipts, isPreviewReceipt);
  if (!preview) {
    reasons.push("Missing preview evidence");
  } else if (preview.inputDigest !== previewInputDigest(contract)) {
    reasons.push(
      "Preview evidence does not match the controller rendered-verifier input",
    );
  } else if (preview.outputDigest !== digestJson(preview.checks)) {
    reasons.push("Preview evidence output digest does not match its checks");
  } else if (preview.status !== "PASS") {
    reasons.push("One or more preview checks did not pass");
  }
  if (
    preview?.checks.some(
      (check) => (check.forbiddenClaimIndices?.length ?? 0) > 0,
    )
  ) {
    reasons.push("Rendered preview contains one or more forbidden claims");
  }
  const renderedRasterInput = previewRenderedRasterInput(preview);
  if (
    visualScan &&
    (!renderedRasterInput ||
      visualScan.renderedInputDigest !== renderedRasterInput.digest ||
      visualScan.renderedAssetCount !== renderedRasterInput.digests.length ||
      !sameStrings(
        visualScan.assetDigests.slice(visualScan.workspaceAssetCount),
        renderedRasterInput.digests,
      ))
  ) {
    reasons.push(
      "Raster claim inspection is not bound to the rendered preview pixels",
    );
  }
  const rootPreviewChecks =
    preview?.checks.filter(
      (check) =>
        check.requirementId === undefined &&
        check.verifierIndex === undefined &&
        check.path === "/",
    ) ?? [];
  if (
    preview &&
    (rootPreviewChecks.length !== 1 ||
      rootPreviewChecks[0]?.expectedStatus !== 200 ||
      rootPreviewChecks[0].actualStatus !== 200 ||
      rootPreviewChecks[0].expectedText.length !== 0 ||
      rootPreviewChecks[0].missingText.length !== 0 ||
      Boolean(rootPreviewChecks[0].error) ||
      !rootPreviewChecks[0].visibleTextDigest ||
      !hasScreenshotTileDigests(rootPreviewChecks[0].screenshotSha256s))
  ) {
    reasons.push("Root rendered preview check is missing or invalid");
  }
  if (preview) {
    const requestedPaths = new Set([
      "/",
      ...contract.requirements.flatMap((requirement) =>
        requirement.verifiers.flatMap((verifier) =>
          verifier.kind === "http" ? [verifier.path] : [],
        ),
      ),
    ]);
    const discoveredPaths = new Set<string>();
    for (const check of preview.checks) {
      if (check.discovered) {
        const hasRenderedEvidence =
          check.nonHtmlMediaType === undefined &&
          Boolean(check.visibleTextDigest) &&
          hasScreenshotTileDigests(check.screenshotSha256s);
        if (
          requestedPaths.has(check.path) ||
          discoveredPaths.has(check.path) ||
          check.requirementId !== undefined ||
          check.verifierIndex !== undefined ||
          check.expectedStatus !== 200 ||
          check.actualStatus !== 200 ||
          check.expectedText.length !== 0 ||
          check.missingText.length !== 0 ||
          Boolean(check.error) ||
          !hasRenderedEvidence
        ) {
          reasons.push("Discovered rendered route check is invalid");
        }
        discoveredPaths.add(check.path);
      } else if (
        check.requirementId === undefined &&
        check.verifierIndex === undefined &&
        check.path !== "/"
      ) {
        reasons.push("Preview evidence contains an unbound route check");
      }
    }
    if (requestedPaths.size + discoveredPaths.size > 32) {
      reasons.push("Preview evidence exceeds the rendered route limit");
    }
  }

  const review = latest(receipts, isReviewReceipt);
  if (!review) {
    reasons.push("Missing CodeRabbit review evidence");
  } else {
    const criticalCount = review.findings.filter(
      (finding) => finding.severity === "critical",
    ).length;
    if (review.status !== "PASS" || !review.complete) {
      reasons.push(
        `CodeRabbit review did not complete cleanly (${review.status})`,
      );
    }
    if (
      review.complete &&
      (!review.policyDigest || !review.expectedPolicyDigest)
    ) {
      reasons.push("CodeRabbit review is missing its controller policy digest");
    } else if (
      review.complete &&
      review.policyDigest !== review.expectedPolicyDigest
    ) {
      reasons.push(
        "CodeRabbit review policy digest does not match the controller policy",
      );
    }
    if (criticalCount > 0) {
      reasons.push(`CodeRabbit reported ${criticalCount} critical finding(s)`);
    }
  }

  const evaluation = latest(receipts, isEvaluationReceipt);
  if (!evaluation) {
    reasons.push("Missing Fireworks/Braintrust contract evaluation evidence");
  } else {
    if (evaluation.status !== "PASS" || evaluation.traceId.length === 0) {
      reasons.push(`Contract evaluation did not pass (${evaluation.status})`);
    }
    if (evaluation.unsupportedClaims.length > 0) {
      reasons.push(
        `Candidate contains ${evaluation.unsupportedClaims.length} unsupported claim(s)`,
      );
    }
    if (
      evaluation.provider !== "fireworks" ||
      evaluation.traceProvider !== "braintrust" ||
      evaluation.braintrustScores.hardRequirements !== 1 ||
      evaluation.braintrustScores.supportedBusinessFacts !== 1 ||
      evaluation.braintrustScores.evidenceGrounding !== 1
    ) {
      reasons.push("Braintrust gate scores are incomplete or failing");
    }
  }

  for (const requirement of contract.requirements) {
    if (requirement.priority !== "hard") {
      continue;
    }

    const evaluationResult = evaluation?.requirements.find(
      (result) => result.requirementId === requirement.id,
    );
    const citedEvidence = new Set(evaluationResult?.evidenceRefs ?? []);
    if (!evaluationResult) {
      reasons.push(`Missing evaluation for hard requirement ${requirement.id}`);
    } else if (evaluationResult.status !== "PASS") {
      reasons.push(
        `Hard requirement ${requirement.id} is ${evaluationResult.status}`,
      );
    }

    for (const [verifierIndex, verifier] of requirement.verifiers.entries()) {
      if (verifier.kind === "command") {
        const receipt = latest(
          receipts,
          (candidate): candidate is CommandReceipt =>
            isCommandReceipt(candidate) &&
            candidate.kind === "requirement-command" &&
            candidate.requirementId === requirement.id &&
            candidate.verifierIndex === verifierIndex &&
            candidate.command === verifier.command,
        );
        if (!receipt) {
          reasons.push(
            `Missing command verifier ${verifierIndex} for hard requirement ${requirement.id}`,
          );
        } else if (receipt.status !== "PASS" || receipt.exitCode !== 0) {
          reasons.push(
            `Command verifier ${verifierIndex} failed for hard requirement ${requirement.id}`,
          );
        } else if (
          evaluationResult?.status === "PASS" &&
          !citedEvidence.has(`receipt:${receipt.receiptId}`)
        ) {
          reasons.push(
            `Hard requirement ${requirement.id} did not cite command verifier ${verifierIndex} evidence`,
          );
        }
      }

      if (verifier.kind === "http") {
        const matchingChecks =
          preview?.checks.filter(
            (candidate) =>
              candidate.requirementId === requirement.id &&
              candidate.verifierIndex === verifierIndex,
          ) ?? [];
        const check = matchingChecks[0];
        if (!check) {
          reasons.push(
            `Missing HTTP verifier ${verifierIndex} for hard requirement ${requirement.id}`,
          );
        } else if (matchingChecks.length !== 1) {
          reasons.push(
            `HTTP verifier ${verifierIndex} is ambiguous for hard requirement ${requirement.id}`,
          );
        } else if (
          check.path !== verifier.path ||
          check.expectedStatus !== verifier.expectedStatus ||
          !sameStrings(check.expectedText, verifier.bodyIncludes) ||
          check.error ||
          check.actualStatus !== verifier.expectedStatus ||
          check.missingText.length > 0
        ) {
          reasons.push(
            `HTTP verifier ${verifierIndex} failed for hard requirement ${requirement.id}`,
          );
        } else if (!check.visibleTextDigest) {
          reasons.push(
            `HTTP verifier ${verifierIndex} is missing rendered-page evidence for hard requirement ${requirement.id}`,
          );
        } else if (!hasScreenshotTileDigests(check.screenshotSha256s)) {
          reasons.push(
            `HTTP verifier ${verifierIndex} is missing rendered screenshot evidence for hard requirement ${requirement.id}`,
          );
        } else if (
          evaluationResult?.status === "PASS" &&
          !citedEvidence.has(`page:${check.path}:${check.visibleTextDigest}`)
        ) {
          reasons.push(
            `Hard requirement ${requirement.id} did not cite HTTP verifier ${verifierIndex} evidence`,
          );
        }
      }
    }
  }

  return {
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

function hasScreenshotTileDigests(
  digests: string[] | undefined,
): digests is string[] {
  return (
    digests !== undefined &&
    digests.length >= 1 &&
    digests.length <= 256 &&
    digests.every((digest) => /^[a-f0-9]{64}$/.test(digest))
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameNumbers(left: number[] | undefined, right: number[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function previewRenderedRasterInput(
  preview: PreviewReceipt | undefined,
): { digest: string; digests: string[] } | undefined {
  if (!preview) {
    return undefined;
  }
  const byPath = new Map<string, string[]>();
  for (const check of preview.checks) {
    if (!check.screenshotSha256s) {
      continue;
    }
    const existing = byPath.get(check.path);
    if (existing && !sameStrings(existing, check.screenshotSha256s)) {
      return undefined;
    }
    byPath.set(check.path, check.screenshotSha256s);
  }
  const entries = [...byPath]
    .map(([path, screenshotSha256s]) => ({ path, screenshotSha256s }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    );
  return {
    digest: digestJson(entries),
    digests: entries.flatMap((entry) => entry.screenshotSha256s),
  };
}
