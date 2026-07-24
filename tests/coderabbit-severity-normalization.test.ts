import { describe, expect, it } from "vitest";

import { classifyCodeRabbitFinding } from "../src/adapters/coderabbit/policy-pack.js";
import {
  type ExpectedCodeRabbitReviewContext,
  parseCodeRabbitEvents,
} from "../src/adapters/coderabbit/protocol.js";

const expectedContext: ExpectedCodeRabbitReviewContext = {
  reviewKind: "authoritative_full",
  reviewType: "committed",
  currentBranch: "buildlabs-candidate",
  baseCommit: "0000000000000000000000000000000000000000",
  workingDirectory: "/controller/candidate",
  expectedFiles: ["src/index.ts"],
};

describe("CodeRabbit controller severity normalization", () => {
  it.each([
    [
      "Direct sandbox endpoint is returned to the browser",
      "raw-preview-exposure",
      "BL-CR-001",
    ],
    [
      "A privileged bearer value is forwarded into the container",
      "production-credentials",
      "BL-CR-002",
    ],
    [
      "Release proceeds when verification is unavailable",
      "proof-gate",
      "BL-CR-003",
    ],
    [
      "Work is dispatched before billing reconciliation",
      "payment-gate",
      "BL-CR-004",
    ],
    [
      "Published operating hours lack a cited source",
      "business-claims",
      "BL-CR-005",
    ],
    [
      "Callback body is accepted without cryptographic validation",
      "unsafe-webhook",
      "BL-CR-006",
    ],
    [
      "Full request payload is persisted for every customer",
      "unrestricted-logs",
      "BL-CR-007",
    ],
    [
      "A cache key omits the tenant identifier",
      "cross-project-isolation",
      "BL-CR-008",
    ],
    ["The container uses the host network", "docker-delivery", "BL-CR-009"],
    [
      "Install hooks execute during dependency restore",
      "dependency-policy",
      "BL-CR-010",
    ],
  ] as const)(
    "promotes an adversarial paraphrase to its controller rule: %s",
    (message, category, controllerRuleId) => {
      expect(
        classifyCodeRabbitFinding({
          severity: "info",
          fileName: "src/index.ts",
          message,
        }),
      ).toMatchObject({
        severity: "critical",
        category,
        ruleId: controllerRuleId,
      });
    },
  );

  it.each([
    [
      "A mutable preview link is exposed to the customer",
      "raw-preview-exposure",
    ],
    [
      "A hardcoded provider secret is bundled with the app",
      "production-credentials",
    ],
    ["A proof receipt is reused after the source digest changes", "proof-gate"],
    ["Deploy starts before payment verification", "payment-gate"],
    ["Service area copy is unapproved and lacks evidence", "business-claims"],
    ["Webhook signature checking fails open", "unsafe-webhook"],
    ["A bearer token is written to trace output", "unrestricted-logs"],
    ["Another project data set can be read", "cross-project-isolation"],
    ["The Dockerfile copies .env into an image layer", "docker-delivery"],
    ["The Yarn packageManager value is unpinned", "dependency-policy"],
  ] as const)(
    "keeps overlapping security language in the specific invariant: %s",
    (message, category) => {
      expect(
        classifyCodeRabbitFinding({
          severity: "minor",
          fileName: "src/index.ts",
          message,
        }),
      ).toMatchObject({ severity: "critical", category });
    },
  );

  it("scans the provider comment even when separate repair prose is present", () => {
    const output = [
      {
        type: "review_context",
        reviewType: "committed",
        currentBranch: expectedContext.currentBranch,
        baseBranch: "main",
        baseCommit: expectedContext.baseCommit,
        workingDirectory: expectedContext.workingDirectory,
      },
      {
        type: "finding",
        severity: "info",
        fileName: "src/index.ts",
        comment: "A cache key omits the tenant identifier",
        codegenInstructions: "Apply a narrow guard.",
        suggestions: [],
      },
      {
        type: "complete",
        status: "review_completed",
        findings: 1,
        reviewedFiles: ["src/index.ts"],
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");

    const result = parseCodeRabbitEvents(output, expectedContext);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      severity: "critical",
      category: "cross-project-isolation",
      controllerRuleId: "BL-CR-008",
    });
  });

  it("preserves provider critical severity without accepting a prose category", () => {
    expect(
      classifyCodeRabbitFinding({
        severity: "critical",
        fileName: "src/widget.ts",
        message: "The state transition can lose an update.",
      }),
    ).toEqual({
      severity: "critical",
      category: "code-quality",
      governingInvariant:
        "candidate-quality-findings-are-repaired-when-bounded",
    });
  });

  it("does not promote an unrelated style finding based only on its path", () => {
    expect(
      classifyCodeRabbitFinding({
        severity: "trivial",
        fileName: "Dockerfile",
        message: "Combine adjacent labels for readability.",
      }),
    ).toEqual({
      severity: "trivial",
      category: "code-quality",
      governingInvariant:
        "candidate-quality-findings-are-repaired-when-bounded",
    });
  });
});
