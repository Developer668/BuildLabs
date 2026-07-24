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
import { CodeRabbitReviewAttestationSchema } from "../domain/evidence.js";
import { canonicalJson, digestJson, sha256 } from "../lib/canonical-json.js";
import { CODERABBIT_HANDSHAKE_REVIEW_FLAGS } from "../adapters/coderabbit/capability.js";
import {
  classifyCodeRabbitFinding,
  CODERABBIT_CONFIG_SCHEMA_DIGEST,
  CODERABBIT_CONTROLLER_CONFIG_DIGEST,
  CODERABBIT_CONTROLLER_RULES_DIGEST,
  CODERABBIT_DOCTOR_DIGEST,
  CODERABBIT_EVENT_SCHEMA_DIGEST,
  CODERABBIT_POLICY_PACK_DIGEST,
  CODERABBIT_POLICY_PACK_VERSION,
  CODERABBIT_REQUIRED_REVIEW_FLAGS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
  CODERABBIT_TOOL_POLICY,
  CODERABBIT_TOOL_POLICY_DIGEST,
  isSupportedCodeRabbitVersion,
} from "../adapters/coderabbit/policy-pack.js";
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
  if (new Set(receipts.map((receipt) => receipt.runId)).size > 1) {
    reasons.push("Proof evidence mixes multiple controller run identities");
  }

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

  const reviewReceipts = receipts.filter(isReviewReceipt);
  const legacyReviews = reviewReceipts.filter(
    (receipt) => receipt.attestation === undefined,
  );
  const invalidReviewKinds = reviewReceipts.filter(
    (receipt) =>
      receipt.attestation !== undefined &&
      receipt.attestation.reviewKind !== "authoritative_full" &&
      receipt.attestation.reviewKind !== "advisory_light",
  );
  const authoritativeReviews = reviewReceipts.filter(
    (receipt) => receipt.attestation?.reviewKind === "authoritative_full",
  );

  if (reviewReceipts.length === 0) {
    reasons.push("Missing CodeRabbit review evidence");
  }
  if (legacyReviews.length > 0) {
    reasons.push(
      "CodeRabbit review evidence contains a legacy unattested review",
    );
  }
  if (invalidReviewKinds.length > 0) {
    reasons.push("CodeRabbit review evidence contains an invalid review kind");
  }
  if (authoritativeReviews.length === 0 && reviewReceipts.length > 0) {
    reasons.push(
      "Missing authoritative full CodeRabbit review evidence for the frozen revision",
    );
  } else if (authoritativeReviews.length > 1) {
    reasons.push(
      "Multiple authoritative full CodeRabbit reviews target the frozen revision",
    );
  }

  const review =
    authoritativeReviews.length === 1 ? authoritativeReviews[0] : undefined;
  if (review) {
    reasons.push(
      ...codeRabbitAttestationFailures(contract, revisionHash, review),
    );
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

function codeRabbitAttestationFailures(
  contract: AcceptanceContract,
  revisionHash: string,
  review: ReviewReceipt,
): string[] {
  const failures: string[] = [];
  const rawAttestation = review.attestation;
  if (!rawAttestation) {
    return ["CodeRabbit review is missing its controller attestation"];
  }

  if (!review.expectedAttestationDigest) {
    failures.push(
      "CodeRabbit review is missing its expected controller attestation digest",
    );
  } else if (review.expectedAttestationDigest !== digestJson(rawAttestation)) {
    failures.push(
      "CodeRabbit review controller attestation digest does not match",
    );
  }

  const parsedAttestation =
    CodeRabbitReviewAttestationSchema.safeParse(rawAttestation);
  if (!parsedAttestation.success) {
    failures.push("CodeRabbit review controller attestation schema is invalid");
    return failures;
  }
  const attestation = parsedAttestation.data;

  if (
    attestation.schemaVersion !== 1 ||
    attestation.reviewKind !== "authoritative_full"
  ) {
    failures.push(
      "CodeRabbit review does not use the authoritative attestation schema",
    );
  }
  if (attestation.capabilityState !== "proof-integrated") {
    failures.push(
      "CodeRabbit review capability was not integrated into the proof gate",
    );
  }

  const expectedAuthorityKey = digestJson({
    schemaVersion: 1,
    runId: review.runId,
    sourceDigest: revisionHash,
  });
  if (attestation.authorityKey !== expectedAuthorityKey) {
    failures.push(
      "CodeRabbit review authority does not match the run and frozen source",
    );
  }
  if (
    attestation.sourceDigest !== revisionHash ||
    attestation.sourceDigest !== review.revisionHash
  ) {
    failures.push(
      "CodeRabbit review attestation does not match the frozen source digest",
    );
  }
  if (attestation.contractDigest !== digestJson(contract)) {
    failures.push(
      "CodeRabbit review attestation does not match the acceptance contract",
    );
  }
  if (attestation.findingSetDigest !== digestJson(review.findings)) {
    failures.push(
      "CodeRabbit review attestation does not match its normalized findings",
    );
  }
  if (
    attestation.reviewContextDigest !== digestJson(attestation.reviewContext) ||
    attestation.scopeDigest !== digestJson(attestation.scope)
  ) {
    failures.push(
      "CodeRabbit review context or scope digest does not match its evidence",
    );
  }
  if (
    attestation.reviewContext.reviewType !== "committed" ||
    attestation.reviewContext.currentBranch !== "candidate" ||
    attestation.reviewContext.baseBranch !== "main" ||
    attestation.scope.reviewKind !== "authoritative_full" ||
    attestation.scope.reviewType !== attestation.reviewContext.reviewType ||
    attestation.scope.currentBranch !==
      attestation.reviewContext.currentBranch ||
    attestation.scope.baseBranch !== attestation.reviewContext.baseBranch ||
    attestation.scope.baseCommit !== attestation.reviewContext.baseCommit ||
    attestation.scope.workingDirectoryDigest !==
      attestation.reviewContext.workingDirectoryDigest ||
    attestation.scope.reviewedFileCount < 1
  ) {
    failures.push("CodeRabbit review scope evidence is not authoritative");
  }

  if (
    attestation.policyPackVersion !== CODERABBIT_POLICY_PACK_VERSION ||
    attestation.policyPackDigest !== CODERABBIT_POLICY_PACK_DIGEST
  ) {
    failures.push(
      "CodeRabbit review does not use the current controller policy pack",
    );
  }
  if (attestation.configSchemaDigest !== CODERABBIT_CONFIG_SCHEMA_DIGEST) {
    failures.push(
      "CodeRabbit review configuration schema digest does not match the controller",
    );
  }
  if (attestation.configDigest !== CODERABBIT_CONTROLLER_CONFIG_DIGEST) {
    failures.push(
      "CodeRabbit review configuration digest does not match the controller",
    );
  }
  if (attestation.rulesDigest !== CODERABBIT_CONTROLLER_RULES_DIGEST) {
    failures.push(
      "CodeRabbit review rules digest does not match the controller",
    );
  }
  if (attestation.toolPolicyDigest !== CODERABBIT_TOOL_POLICY_DIGEST) {
    failures.push(
      "CodeRabbit review tool policy digest does not match the controller",
    );
  }
  if (attestation.eventSchemaDigest !== CODERABBIT_EVENT_SCHEMA_DIGEST) {
    failures.push(
      "CodeRabbit review event schema digest does not match the controller",
    );
  }
  if (
    !review.policyDigest ||
    !review.expectedPolicyDigest ||
    attestation.policyDigest !== review.policyDigest ||
    attestation.policyDigest !== review.expectedPolicyDigest
  ) {
    failures.push(
      "CodeRabbit review attestation is not bound to the controller review policy",
    );
  }

  const cliVersion = parseCodeRabbitVersion(attestation.cliVersion);
  if (!cliVersion || !isSupportedCodeRabbitVersion(cliVersion)) {
    failures.push("CodeRabbit review CLI version is outside the allowed range");
  }
  if (
    attestation.cliExecutableDigestBefore !==
      attestation.cliExecutableDigestAfter ||
    attestation.cliExecutableDigestBefore !==
      attestation.capability.cliExecutableDigest
  ) {
    failures.push("CodeRabbit review CLI executable changed during review");
  }
  if (
    attestation.capabilityDigest !== digestJson(attestation.capability) ||
    attestation.capability.state !== "healthy" ||
    attestation.capability.policyPackVersion !==
      CODERABBIT_POLICY_PACK_VERSION ||
    attestation.capability.policyPackDigest !== CODERABBIT_POLICY_PACK_DIGEST ||
    attestation.capability.cliVersion !== attestation.cliVersion ||
    attestation.capability.reviewFlagsDigest !==
      digestJson(attestation.capability.reviewFlags) ||
    !sameStrings(
      attestation.capability.reviewFlags,
      CODERABBIT_HANDSHAKE_REVIEW_FLAGS,
    ) ||
    !sameStrings(
      attestation.capability.supportedEventKinds,
      CODERABBIT_SUPPORTED_EVENT_KINDS,
    ) ||
    !attestation.capability.agentJsonl ||
    !attestation.capability.authenticated ||
    attestation.capability.updatePolicy !== "disabled-and-digest-pinned" ||
    attestation.capability.serviceConnectivity !== "healthy" ||
    attestation.capability.controllerConfig !== "supported" ||
    attestation.capability.toolSupport !== "disabled-controller-policy" ||
    canonicalJson(attestation.capability.doctor) !==
      canonicalJson(attestation.doctor)
  ) {
    failures.push(
      "CodeRabbit review capability digest does not match its healthy handshake",
    );
  }
  const expectedReviewFlagsDigest = digestJson(
    CODERABBIT_REQUIRED_REVIEW_FLAGS,
  );
  if (attestation.reviewFlagsDigest !== expectedReviewFlagsDigest) {
    failures.push(
      "CodeRabbit review flags digest does not match the authoritative full review",
    );
  }
  if (attestation.updatePolicy !== "disabled-and-digest-pinned") {
    failures.push("CodeRabbit review update policy is not proof-safe");
  }
  if (attestation.authentication !== "authenticated") {
    failures.push("CodeRabbit review was not authenticated");
  }
  if (
    attestation.doctor.passed !== 8 ||
    attestation.doctor.warnings !== 1 ||
    attestation.doctor.failed !== 0 ||
    attestation.doctor.digest !== CODERABBIT_DOCTOR_DIGEST
  ) {
    failures.push("CodeRabbit review doctor checks were not healthy");
  }
  if (attestation.serviceConnectivity !== "healthy") {
    failures.push("CodeRabbit review service connectivity was not healthy");
  }
  if (!attestation.agentJsonl) {
    failures.push("CodeRabbit review did not use agent-mode JSONL");
  }
  if (attestation.terminalState !== "review_completed") {
    failures.push(
      "CodeRabbit review is missing successful terminal completion",
    );
  }
  if (
    attestation.eventCounts.reviewContext !== 1 ||
    attestation.eventCounts.status < 1 ||
    attestation.eventCounts.finding !== review.findings.length ||
    attestation.eventCounts.complete !== 1 ||
    attestation.eventCounts.error !== 0
  ) {
    failures.push(
      "CodeRabbit review event counts do not prove one complete full review",
    );
  }
  if (attestation.attempts !== attestation.retryReasons.length + 1) {
    failures.push(
      "CodeRabbit review attempts do not match its bounded retry evidence",
    );
  }

  const expectedSeverityCounts = {
    critical: 0,
    major: 0,
    minor: 0,
    trivial: 0,
    info: 0,
  };
  const expectedCategoryCounts = new Map<string, number>();
  let findingMetadataMatches = true;
  let findingRangesAreValid = true;
  for (const finding of review.findings) {
    expectedSeverityCounts[finding.severity] += 1;
    if (finding.category) {
      expectedCategoryCounts.set(
        finding.category,
        (expectedCategoryCounts.get(finding.category) ?? 0) + 1,
      );
    }

    const classification = classifyCodeRabbitFinding(finding);
    if (
      finding.category !== classification.category ||
      finding.governingInvariant !== classification.governingInvariant ||
      finding.severity !== classification.severity ||
      finding.controllerRuleId !== classification.ruleId
    ) {
      findingMetadataMatches = false;
    }
    const hasStartLine = finding.startLine !== undefined;
    const hasEndLine = finding.endLine !== undefined;
    if (
      hasStartLine !== hasEndLine ||
      (hasStartLine &&
        hasEndLine &&
        (finding.endLine as number) < (finding.startLine as number))
    ) {
      findingRangesAreValid = false;
    }
  }
  if (
    canonicalJson(attestation.severityCounts) !==
    canonicalJson(expectedSeverityCounts)
  ) {
    failures.push(
      "CodeRabbit review severity counts do not match its findings",
    );
  }
  const normalizedCategoryCounts = [...expectedCategoryCounts]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.category, "utf8"),
        Buffer.from(right.category, "utf8"),
      ),
    );
  if (
    review.findings.some((finding) => !finding.category) ||
    canonicalJson(attestation.categoryCounts) !==
      canonicalJson(normalizedCategoryCounts)
  ) {
    failures.push(
      "CodeRabbit review category counts do not match its findings",
    );
  }
  if (!findingMetadataMatches) {
    failures.push(
      "CodeRabbit review findings do not match controller severity classification",
    );
  }
  if (!findingRangesAreValid) {
    failures.push("CodeRabbit review contains an invalid finding line range");
  }

  if (
    !sameStrings(
      attestation.configuredTools,
      CODERABBIT_TOOL_POLICY.configuredTools,
    ) ||
    attestation.observedTools.length !== 0 ||
    attestation.toolCoverage !== "disabled-controller-policy"
  ) {
    failures.push(
      "CodeRabbit review tool coverage does not match controller policy",
    );
  }

  return failures;
}

function parseCodeRabbitVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return undefined;
  }
  const parsed = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
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

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
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
