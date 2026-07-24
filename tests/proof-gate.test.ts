import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CodeRabbitReviewAttestation,
  EvidenceReceipt,
  ReviewFinding,
  ReviewReceipt,
} from "../src/domain/evidence.js";
import { decideProof } from "../src/application/proof-gate.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import { CODERABBIT_HANDSHAKE_REVIEW_FLAGS } from "../src/adapters/coderabbit/capability.js";
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
} from "../src/adapters/coderabbit/policy-pack.js";
import { assignment, passingEvidence } from "./fixtures.js";

type ProofInput = ReturnType<typeof assignment>;

function reviewReceipt(evidence: EvidenceReceipt[]): ReviewReceipt {
  const review = evidence.find(
    (receipt): receipt is ReviewReceipt => receipt.kind === "coderabbit",
  );
  if (!review) {
    throw new Error("Missing CodeRabbit fixture");
  }
  return review;
}

function controllerClassifiedFinding(
  finding: Omit<
    ReviewFinding,
    "category" | "governingInvariant" | "controllerRuleId"
  >,
): ReviewFinding {
  const classification = classifyCodeRabbitFinding(finding);
  return {
    ...finding,
    severity: classification.severity,
    category: classification.category,
    governingInvariant: classification.governingInvariant,
    ...(classification.ruleId
      ? { controllerRuleId: classification.ruleId }
      : {}),
  };
}

function attestReview(
  input: ProofInput,
  revisionHash: string,
  review: ReviewReceipt,
): void {
  const severityCounts: CodeRabbitReviewAttestation["severityCounts"] = {
    critical: 0,
    major: 0,
    minor: 0,
    trivial: 0,
    info: 0,
  };
  const categoryCounts = new Map<string, number>();
  for (const finding of review.findings) {
    severityCounts[finding.severity] += 1;
    if (finding.category) {
      categoryCounts.set(
        finding.category,
        (categoryCounts.get(finding.category) ?? 0) + 1,
      );
    }
  }

  const executableDigest = sha256("controller-pinned-coderabbit-cli");
  const reviewContext = {
    reviewType: "committed" as const,
    currentBranch: "candidate",
    baseBranch: "main" as const,
    baseCommit: "a".repeat(40),
    workingDirectoryDigest: sha256("controller-review-directory"),
  };
  const scope = {
    reviewKind: "authoritative_full" as const,
    ...reviewContext,
    reviewedFileCount: 1,
    reviewedFilesDigest: digestJson(["fixture-source"]),
  };
  const capability = {
    state: "healthy" as const,
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    cliVersion: "0.7.0",
    cliExecutableDigest: executableDigest,
    rootHelpDigest: sha256("coderabbit-root-help"),
    reviewHelpDigest: sha256("coderabbit-review-help"),
    reviewFlagsDigest: digestJson(CODERABBIT_HANDSHAKE_REVIEW_FLAGS),
    agentJsonl: true as const,
    supportedEventKinds: [...CODERABBIT_SUPPORTED_EVENT_KINDS],
    reviewFlags: [...CODERABBIT_HANDSHAKE_REVIEW_FLAGS],
    authenticated: true as const,
    doctor: {
      passed: 8,
      warnings: 1,
      failed: 0,
      digest: CODERABBIT_DOCTOR_DIGEST,
    },
    updatePolicy: "disabled-and-digest-pinned" as const,
    serviceConnectivity: "healthy" as const,
    controllerConfig: "supported" as const,
    toolSupport: "disabled-controller-policy" as const,
  };
  const attestation: CodeRabbitReviewAttestation = {
    schemaVersion: 1,
    reviewKind: "authoritative_full",
    capabilityState: "proof-integrated",
    authorityKey: digestJson({
      schemaVersion: 1,
      runId: review.runId,
      sourceDigest: revisionHash,
    }),
    sourceDigest: revisionHash,
    contractDigest: digestJson(input.contract),
    reviewDigest: sha256(`review:${review.receiptId}`),
    findingSetDigest: digestJson(review.findings),
    reviewContext,
    reviewContextDigest: digestJson(reviewContext),
    scope,
    scopeDigest: digestJson(scope),
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    configSchemaDigest: CODERABBIT_CONFIG_SCHEMA_DIGEST,
    configDigest: CODERABBIT_CONTROLLER_CONFIG_DIGEST,
    rulesDigest: CODERABBIT_CONTROLLER_RULES_DIGEST,
    policyDigest: review.policyDigest!,
    toolPolicyDigest: CODERABBIT_TOOL_POLICY_DIGEST,
    eventSchemaDigest: CODERABBIT_EVENT_SCHEMA_DIGEST,
    capability,
    capabilityDigest: digestJson(capability),
    cliVersion: "0.7.0",
    cliExecutableDigestBefore: executableDigest,
    cliExecutableDigestAfter: executableDigest,
    reviewFlagsDigest: digestJson(CODERABBIT_REQUIRED_REVIEW_FLAGS),
    updatePolicy: "disabled-and-digest-pinned",
    authentication: "authenticated",
    doctor: {
      passed: 8,
      warnings: 1,
      failed: 0,
      digest: CODERABBIT_DOCTOR_DIGEST,
    },
    serviceConnectivity: "healthy",
    agentJsonl: true,
    terminalState: "review_completed",
    eventCounts: {
      reviewContext: 1,
      status: 1,
      heartbeat: 0,
      finding: review.findings.length,
      complete: 1,
      error: 0,
    },
    attempts: 1,
    retryReasons: [],
    durationMs: 1,
    severityCounts,
    categoryCounts: [...categoryCounts]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => left.category.localeCompare(right.category)),
    configuredTools: [...CODERABBIT_TOOL_POLICY.configuredTools],
    observedTools: [],
    toolCoverage: "disabled-controller-policy",
  };
  review.attestation = attestation;
  review.expectedAttestationDigest = digestJson(attestation);
}

function passingProofEvidence(
  runId: string,
  revisionHash: string,
  input = assignment(),
): EvidenceReceipt[] {
  const evidence = passingEvidence(runId, revisionHash, input);
  attestReview(input, revisionHash, reviewReceipt(evidence));
  return evidence;
}

function mutateSignedAttestation(
  evidence: EvidenceReceipt[],
  mutate: (attestation: CodeRabbitReviewAttestation) => void,
): ReviewReceipt {
  const review = reviewReceipt(evidence);
  if (!review.attestation) {
    throw new Error("Missing CodeRabbit attestation fixture");
  }
  mutate(review.attestation);
  review.expectedAttestationDigest = digestJson(review.attestation);
  return review;
}

const attestationBindingCases: {
  name: string;
  mutate: (attestation: CodeRabbitReviewAttestation) => void;
  reason: string;
}[] = [
  {
    name: "frozen source",
    mutate: (attestation) => {
      attestation.sourceDigest = sha256("different frozen source");
    },
    reason:
      "CodeRabbit review attestation does not match the frozen source digest",
  },
  {
    name: "acceptance contract",
    mutate: (attestation) => {
      attestation.contractDigest = sha256("different acceptance contract");
    },
    reason:
      "CodeRabbit review attestation does not match the acceptance contract",
  },
  {
    name: "configuration schema",
    mutate: (attestation) => {
      attestation.configSchemaDigest = sha256("different configuration schema");
    },
    reason:
      "CodeRabbit review configuration schema digest does not match the controller",
  },
  {
    name: "controller configuration",
    mutate: (attestation) => {
      attestation.configDigest = sha256("different controller configuration");
    },
    reason:
      "CodeRabbit review configuration digest does not match the controller",
  },
  {
    name: "controller rules",
    mutate: (attestation) => {
      attestation.rulesDigest = sha256("different controller rules");
    },
    reason: "CodeRabbit review rules digest does not match the controller",
  },
  {
    name: "policy pack",
    mutate: (attestation) => {
      attestation.policyPackDigest = sha256("different policy pack");
    },
    reason: "CodeRabbit review does not use the current controller policy pack",
  },
  {
    name: "controller policy",
    mutate: (attestation) => {
      attestation.policyDigest = sha256("different review policy");
    },
    reason:
      "CodeRabbit review attestation is not bound to the controller review policy",
  },
  {
    name: "tool policy",
    mutate: (attestation) => {
      attestation.toolPolicyDigest = sha256("different tool policy");
    },
    reason:
      "CodeRabbit review tool policy digest does not match the controller",
  },
  {
    name: "event schema",
    mutate: (attestation) => {
      attestation.eventSchemaDigest = sha256("different event schema");
    },
    reason:
      "CodeRabbit review event schema digest does not match the controller",
  },
  {
    name: "review context digest",
    mutate: (attestation) => {
      attestation.reviewContextDigest = sha256("different review context");
    },
    reason:
      "CodeRabbit review context or scope digest does not match its evidence",
  },
  {
    name: "review scope digest",
    mutate: (attestation) => {
      attestation.scopeDigest = sha256("different review scope");
    },
    reason:
      "CodeRabbit review context or scope digest does not match its evidence",
  },
  {
    name: "capability digest",
    mutate: (attestation) => {
      attestation.capabilityDigest = sha256("different capability evidence");
    },
    reason:
      "CodeRabbit review capability digest does not match its healthy handshake",
  },
  {
    name: "capability executable",
    mutate: (attestation) => {
      const replacement = sha256("stable but unprobed CLI executable");
      attestation.cliExecutableDigestBefore = replacement;
      attestation.cliExecutableDigestAfter = replacement;
    },
    reason: "CodeRabbit review CLI executable changed during review",
  },
  {
    name: "CLI version",
    mutate: (attestation) => {
      attestation.cliVersion = "0.8.0";
    },
    reason: "CodeRabbit review CLI version is outside the allowed range",
  },
  {
    name: "CLI executable",
    mutate: (attestation) => {
      attestation.cliExecutableDigestAfter = sha256(
        "changed CodeRabbit executable",
      );
    },
    reason: "CodeRabbit review CLI executable changed during review",
  },
  {
    name: "authoritative review flags",
    mutate: (attestation) => {
      attestation.reviewFlagsDigest = sha256("different review flags");
    },
    reason:
      "CodeRabbit review flags digest does not match the authoritative full review",
  },
  {
    name: "doctor result",
    mutate: (attestation) => {
      attestation.doctor.passed -= 1;
    },
    reason: "CodeRabbit review doctor checks were not healthy",
  },
  {
    name: "normalized findings",
    mutate: (attestation) => {
      attestation.findingSetDigest = sha256("different finding set");
    },
    reason:
      "CodeRabbit review attestation does not match its normalized findings",
  },
];

describe("proof gate", () => {
  const revision = "a".repeat(64);

  it("passes only a complete evidence set for the exact revision", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    expect(decideProof(input.contract, revision, evidence)).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it.each([
    ["artifact", "Missing Dockerfile evidence"],
    ["dependency-bootstrap", "Missing dependency bootstrap evidence"],
    ["build", "Missing build evidence"],
    ["test", "Missing test evidence"],
    ["preview", "Missing preview evidence"],
    ["visual-claim", "Missing complete raster claim inspection"],
    ["coderabbit", "Missing CodeRabbit review evidence"],
    [
      "contract-evaluation",
      "Missing Fireworks/Braintrust contract evaluation evidence",
    ],
  ] as const)("fails closed when %s evidence is absent", (kind, reason) => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input).filter(
      (receipt) => receipt.kind !== kind,
    );
    expect(
      decideProof(input.contract, revision, evidence).reasons,
    ).toContainEqual(expect.stringContaining(reason));
  });

  it("does not reuse evidence from a stale revision", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), "b".repeat(64), input);
    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "Missing build evidence for the frozen revision",
    );
  });

  it("never averages away an unsupported claim", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const evaluation = evidence.find(
      (receipt) => receipt.kind === "contract-evaluation",
    );
    if (!evaluation || evaluation.kind !== "contract-evaluation") {
      throw new Error("Missing evaluation fixture");
    }
    evaluation.unsupportedClaims.push({
      claim: "24/7 emergency service",
      location: "/",
      reason: "No approved fact supports this claim",
    });
    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "Candidate contains 1 unsupported claim(s)",
    );
  });

  it("never accepts a forbidden claim found in rendered visible text", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    preview.checks[0]!.forbiddenClaimIndices = [0];

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Rendered preview contains one or more forbidden claims",
    );
  });

  it("requires a hard PASS to cite its exact verifier evidence", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const evaluation = evidence.find(
      (receipt) => receipt.kind === "contract-evaluation",
    );
    if (!evaluation || evaluation.kind !== "contract-evaluation") {
      throw new Error("Missing evaluation fixture");
    }
    evaluation.requirements.find(
      (requirement) => requirement.requirementId === "homepage",
    )!.evidenceRefs = ["fact:fact-name"];

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Hard requirement homepage did not cite HTTP verifier 0 evidence",
    );
  });

  it("requires a rendered-page digest for every hard HTTP verifier", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    delete preview.checks.find((check) => check.requirementId === "homepage")!
      .visibleTextDigest;

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "HTTP verifier 0 is missing rendered-page evidence for hard requirement homepage",
    );
  });

  it("requires screenshot provenance for every hard HTTP verifier", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    delete preview.checks.find((check) => check.requirementId === "homepage")!
      .screenshotSha256s;

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "HTTP verifier 0 is missing rendered screenshot evidence for hard requirement homepage",
    );
  });

  it("binds preview proof to the current rendered verifier protocol and targets", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    preview.inputDigest = sha256("legacy raw-fetch preview targets");

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Preview evidence does not match the controller rendered-verifier input",
    );
  });

  it("binds every dynamically discovered route check to the output digest", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    preview.checks.push({
      discovered: true,
      path: "/services",
      expectedStatus: 200,
      actualStatus: 200,
      expectedText: [],
      missingText: [],
      visibleTextDigest: sha256("Services"),
      screenshotSha256s: [sha256("services screenshot")],
    });

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Preview evidence output digest does not match its checks",
    );
  });

  it("accepts a complete blocking check for a discovered rendered route", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    preview.checks.push({
      discovered: true,
      path: "/services",
      expectedStatus: 200,
      actualStatus: 200,
      expectedText: [],
      missingText: [],
      visibleTextDigest: sha256("Services"),
      screenshotSha256s: [sha256("services screenshot")],
    });
    preview.outputDigest = digestJson(preview.checks);
    const visual = evidence.find((receipt) => receipt.kind === "visual-claim");
    if (!visual || visual.kind !== "visual-claim") {
      throw new Error("Missing raster claim fixture");
    }
    const servicesDigest = sha256("services screenshot");
    visual.assetCount += 1;
    visual.renderedAssetCount += 1;
    visual.aggregateBytes += 1;
    visual.assetDigests.push(servicesDigest);
    visual.modelInputDigests.push(servicesDigest);
    visual.renderedInputDigest = digestJson([
      {
        path: "/",
        screenshotSha256s: [sha256("rendered screenshot")],
      },
      { path: "/services", screenshotSha256s: [servicesDigest] },
    ]);

    expect(decideProof(input.contract, revision, evidence)).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("rejects a preview check whose claimed target differs from the contract", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    preview.checks.find(
      (check) => check.requirementId === "homepage",
    )!.expectedText = [];

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "HTTP verifier 0 failed for hard requirement homepage",
    );
  });

  it("rejects duplicate hard HTTP checks", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const preview = evidence.find((receipt) => receipt.kind === "preview");
    if (!preview || preview.kind !== "preview") {
      throw new Error("Missing preview fixture");
    }
    const homepage = preview.checks.find(
      (check) => check.requirementId === "homepage",
    )!;
    preview.checks.push({ ...homepage });

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "HTTP verifier 0 is ambiguous for hard requirement homepage",
    );
  });

  it("requires a hard PASS to cite the exact command receipt", () => {
    const input = assignment("command-citation", (value) => {
      value.contract.requirements[0]!.verifiers.push({
        kind: "command",
        command: "node scripts/verify-homepage.mjs",
        timeoutSeconds: 30,
      });
    });
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const evaluation = evidence.find(
      (receipt) => receipt.kind === "contract-evaluation",
    );
    if (!evaluation || evaluation.kind !== "contract-evaluation") {
      throw new Error("Missing evaluation fixture");
    }
    const homepage = evaluation.requirements.find(
      (requirement) => requirement.requirementId === "homepage",
    );
    if (!homepage) {
      throw new Error("Missing homepage evaluation fixture");
    }
    homepage.evidenceRefs = homepage.evidenceRefs.filter(
      (reference) => !reference.startsWith("receipt:"),
    );

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Hard requirement homepage did not cite command verifier 1 evidence",
    );
  });

  it("allows a preference to rank without blocking a hard-pass candidate", () => {
    const input = assignment();
    const evidence: EvidenceReceipt[] = passingProofEvidence(
      randomUUID(),
      revision,
      input,
    );
    const evaluation = evidence.find(
      (receipt) => receipt.kind === "contract-evaluation",
    );
    if (!evaluation || evaluation.kind !== "contract-evaluation") {
      throw new Error("Missing evaluation fixture");
    }
    evaluation.requirements.find(
      (requirement) => requirement.requirementId === "visual-polish",
    )!.status = "FAIL";
    expect(decideProof(input.contract, revision, evidence).passed).toBe(true);
  });

  it("requires the generated container to build", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input).filter(
      (receipt) => receipt.kind !== "container-build",
    );
    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Missing container build evidence for the frozen revision",
    );
  });

  it("requires the controller-owned CodeRabbit policy identity", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const review = evidence.find((receipt) => receipt.kind === "coderabbit");
    if (!review || review.kind !== "coderabbit") {
      throw new Error("Missing CodeRabbit fixture");
    }
    delete review.policyDigest;

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review is missing its controller policy digest",
    );
  });

  it("rejects a wrong but well-formed CodeRabbit policy digest", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const review = evidence.find((receipt) => receipt.kind === "coderabbit");
    if (!review || review.kind !== "coderabbit") {
      throw new Error("Missing CodeRabbit fixture");
    }
    review.policyDigest = sha256("unrelated controller policy");

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review policy digest does not match the controller policy",
    );
  });

  it.each(attestationBindingCases)(
    "rejects a CodeRabbit attestation bound to the wrong $name",
    ({ mutate, reason }) => {
      const input = assignment();
      const evidence = passingProofEvidence(randomUUID(), revision, input);
      mutateSignedAttestation(evidence, mutate);

      const decision = decideProof(input.contract, revision, evidence);
      expect(decision.passed).toBe(false);
      expect(decision.reasons).toContain(reason);
    },
  );

  it("rejects a CodeRabbit attestation whose outer digest is forged", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    reviewReceipt(evidence).expectedAttestationDigest =
      sha256("forged attestation");

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review controller attestation digest does not match",
    );
  });

  it("rejects legacy CodeRabbit evidence without a controller attestation", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const review = reviewReceipt(evidence);
    delete review.attestation;
    delete review.expectedAttestationDigest;

    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "CodeRabbit review evidence contains a legacy unattested review",
    );
    expect(decision.reasons).toContain(
      "Missing authoritative full CodeRabbit review evidence for the frozen revision",
    );
  });

  it("rejects duplicate authoritative reviews for one frozen source", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const duplicate: ReviewReceipt = structuredClone(reviewReceipt(evidence));
    duplicate.receiptId = randomUUID();
    evidence.push(duplicate);

    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "Multiple authoritative full CodeRabbit reviews target the frozen revision",
    );
  });

  it("does not count an advisory light review as authoritative", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    mutateSignedAttestation(evidence, (attestation) => {
      attestation.reviewKind = "advisory_light";
    });

    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "Missing authoritative full CodeRabbit review evidence for the frozen revision",
    );
  });

  it("allows an advisory review alongside exactly one authoritative review", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const advisory: ReviewReceipt = structuredClone(reviewReceipt(evidence));
    advisory.receiptId = randomUUID();
    if (!advisory.attestation) {
      throw new Error("Missing CodeRabbit attestation fixture");
    }
    advisory.attestation.reviewKind = "advisory_light";
    advisory.expectedAttestationDigest = digestJson(advisory.attestation);
    evidence.push(advisory);

    expect(decideProof(input.contract, revision, evidence)).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("rejects partial CodeRabbit review evidence despite a success attestation", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    reviewReceipt(evidence).complete = false;

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review did not complete cleanly (PASS)",
    );
  });

  it("rejects event evidence without exactly one successful completion", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    mutateSignedAttestation(evidence, (attestation) => {
      attestation.eventCounts.complete = 0;
    });

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review event counts do not prove one complete full review",
    );
  });

  it("rejects a terminal state outside the strict attestation schema", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    mutateSignedAttestation(evidence, (attestation) => {
      (
        attestation as unknown as {
          terminalState: string;
        }
      ).terminalState = "review_skipped";
    });

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review controller attestation schema is invalid",
    );
  });

  it("never averages away a controller-classified critical review finding", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const review = reviewReceipt(evidence);
    review.findings.push(
      controllerClassifiedFinding({
        severity: "critical",
        fileName: "src/delivery.ts",
        message: "A required controller condition is not enforced.",
        startLine: 12,
        endLine: 14,
      }),
    );
    attestReview(input, revision, review);
    const evaluation = evidence.find(
      (receipt) => receipt.kind === "contract-evaluation",
    );
    if (!evaluation || evaluation.kind !== "contract-evaluation") {
      throw new Error("Missing evaluation fixture");
    }
    evaluation.braintrustScores.preferenceSatisfaction = 1;

    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "CodeRabbit reported 1 critical finding(s)",
    );
  });

  it("requires one deterministic scan bound to every forbidden claim", () => {
    const input = assignment();
    const evidence = passingProofEvidence(randomUUID(), revision, input).filter(
      (receipt) => receipt.kind !== "forbidden-claim",
    );
    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Missing complete forbidden-claim scan",
    );
  });

  it("requires a clean raster inspection when no explicit forbidden claims exist", () => {
    const input = assignment("zero-forbidden-proof", (value) => {
      value.contract.forbiddenClaims = [];
    });
    const completeEvidence = passingProofEvidence(
      randomUUID(),
      revision,
      input,
    );
    expect(decideProof(input.contract, revision, completeEvidence)).toEqual({
      passed: true,
      reasons: [],
    });

    const missingVisualEvidence = completeEvidence.filter(
      (receipt) => receipt.kind !== "visual-claim",
    );
    expect(
      decideProof(input.contract, revision, missingVisualEvidence).reasons,
    ).toContain("Missing complete raster claim inspection");
  });

  it("rejects unsupported visual assertions and rendered-pixel digest drift", () => {
    const input = assignment();
    const unsupportedEvidence = passingProofEvidence(
      randomUUID(),
      revision,
      input,
    );
    const unsupported = unsupportedEvidence.find(
      (receipt) => receipt.kind === "visual-claim",
    );
    if (!unsupported || unsupported.kind !== "visual-claim") {
      throw new Error("Missing raster claim fixture");
    }
    unsupported.status = "FAIL";
    unsupported.unsupportedAssetIndices = [0];
    expect(
      decideProof(input.contract, revision, unsupportedEvidence).reasons,
    ).toContain("Raster claim inspection did not pass (FAIL)");

    const driftedEvidence = passingProofEvidence(randomUUID(), revision, input);
    const drifted = driftedEvidence.find(
      (receipt) => receipt.kind === "visual-claim",
    );
    if (!drifted || drifted.kind !== "visual-claim") {
      throw new Error("Missing raster claim fixture");
    }
    drifted.renderedInputDigest = sha256("different rendered pixels");
    expect(
      decideProof(input.contract, revision, driftedEvidence).reasons,
    ).toContain(
      "Raster claim inspection is not bound to the rendered preview pixels",
    );
  });

  it("rejects a forbidden-claim scan with incomplete index binding", () => {
    const input = assignment("forbidden-binding", (value) => {
      value.contract.forbiddenClaims.push("open weekends");
    });
    const evidence = passingProofEvidence(randomUUID(), revision, input);
    const scan = evidence.find((receipt) => receipt.kind === "forbidden-claim");
    if (!scan || scan.kind !== "forbidden-claim") {
      throw new Error("Missing forbidden-claim fixture");
    }
    scan.forbiddenClaimIndices = [1, 0];

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Missing complete forbidden-claim scan",
    );
  });
});
