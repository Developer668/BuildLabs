import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EvidenceReceipt } from "../src/domain/evidence.js";
import { decideProof } from "../src/application/proof-gate.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import { assignment, passingEvidence } from "./fixtures.js";

describe("proof gate", () => {
  const revision = "a".repeat(64);

  it("passes only a complete evidence set for the exact revision", () => {
    const input = assignment();
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input).filter(
      (receipt) => receipt.kind !== kind,
    );
    expect(
      decideProof(input.contract, revision, evidence).reasons,
    ).toContainEqual(expect.stringContaining(reason));
  });

  it("does not reuse evidence from a stale revision", () => {
    const input = assignment();
    const evidence = passingEvidence(randomUUID(), "b".repeat(64), input);
    const decision = decideProof(input.contract, revision, evidence);
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain(
      "Missing build evidence for the frozen revision",
    );
  });

  it("never averages away an unsupported claim", () => {
    const input = assignment();
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence: EvidenceReceipt[] = passingEvidence(
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
    const evidence = passingEvidence(randomUUID(), revision, input).filter(
      (receipt) => receipt.kind !== "container-build",
    );
    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "Missing container build evidence for the frozen revision",
    );
  });

  it("requires the controller-owned CodeRabbit policy identity", () => {
    const input = assignment();
    const evidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
    const review = evidence.find((receipt) => receipt.kind === "coderabbit");
    if (!review || review.kind !== "coderabbit") {
      throw new Error("Missing CodeRabbit fixture");
    }
    review.policyDigest = sha256("unrelated controller policy");

    expect(decideProof(input.contract, revision, evidence).reasons).toContain(
      "CodeRabbit review policy digest does not match the controller policy",
    );
  });

  it("requires one deterministic scan bound to every forbidden claim", () => {
    const input = assignment();
    const evidence = passingEvidence(randomUUID(), revision, input).filter(
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
    const completeEvidence = passingEvidence(randomUUID(), revision, input);
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
    const unsupportedEvidence = passingEvidence(randomUUID(), revision, input);
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

    const driftedEvidence = passingEvidence(randomUUID(), revision, input);
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
    const evidence = passingEvidence(randomUUID(), revision, input);
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
