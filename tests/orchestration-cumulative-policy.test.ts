import { describe, expect, it } from "vitest";

import { assertCumulativePaidRevision } from "../src/orchestration/application/orchestration-agent.js";
import type {
  ChangeClassification,
  ProposalPlan,
} from "../src/orchestration/application/fireworks-orchestration-reasoner.js";
import type { ProposalVersion } from "../src/orchestration/domain/project.js";

describe("paid revision cumulative policy", () => {
  it("allows additive steering while retaining the full paid scope", () => {
    const plan = nextPlan();
    plan.scopeItems.push({
      id: "estimate-emphasis",
      text: "Prominent estimate call to action",
      citation: {
        kind: "conversation",
        excerpt: "Prominent estimate call to action",
      },
    });
    plan.contractDraft.requirements.push({
      id: "estimate-emphasis",
      description: "Make the estimate action prominent.",
      priority: "preference",
      citation: {
        kind: "conversation",
        excerpt: "Make the estimate action prominent.",
      },
      verifiers: [
        {
          kind: "semantic",
          criterion: "The estimate action is visually prominent.",
        },
      ],
    });

    expect(() =>
      assertCumulativePaidRevision(priorProposal(), plan),
    ).not.toThrow();
  });

  it("allows only explicitly classified replacements while preserving immutable prior history", () => {
    const plan = nextPlan();
    plan.scopeItems = [
      citedScopeItem("homepage", "Homepage"),
      citedScopeItem("quote-form", "Quote form"),
    ];
    plan.contractDraft.requirements[1] = {
      id: "brand-style",
      description: "Use the newly requested blue visual direction.",
      priority: "preference",
      citation: {
        kind: "conversation",
        excerpt: "Use the newly requested blue visual direction.",
      },
      verifiers: [
        {
          kind: "semantic",
          criterion: "The visual direction uses the requested blue palette.",
        },
      ],
    };
    const classification: ChangeClassification = {
      kind: "within_paid_scope",
      explanation:
        "The authenticated customer explicitly replaced the form label and palette.",
      supersededScopeItems: [
        {
          value: "Estimate form",
          evidenceExcerpt:
            "Replace the Estimate form with a Quote form and replace the visual direction with blue.",
        },
      ],
      supersededRequirementIds: [
        {
          id: "brand-style",
          evidenceExcerpt:
            "Replace the Estimate form with a Quote form and replace the visual direction with blue.",
        },
      ],
      supersededFactIds: [],
    };

    expect(() =>
      assertCumulativePaidRevision(
        priorProposal(),
        plan,
        classification,
        "Replace the Estimate form with a Quote form and replace the visual direction with blue.",
      ),
    ).not.toThrow();
  });

  it("rejects a supersession declaration outside the active paid contract", () => {
    const classification: ChangeClassification = {
      kind: "within_paid_scope",
      explanation: "Untrusted broad deletion.",
      supersededScopeItems: [],
      supersededRequirementIds: [
        {
          id: "nonexistent-requirement",
          evidenceExcerpt: "Change the visual direction to blue.",
        },
      ],
      supersededFactIds: [],
    };

    expect(() =>
      assertCumulativePaidRevision(priorProposal(), nextPlan(), classification),
    ).toThrow(/outside the active contract/);
  });

  it("does not let an unrelated visual edit supersede the homepage requirement", () => {
    const plan = nextPlan();
    plan.contractDraft.requirements = plan.contractDraft.requirements.filter(
      (requirement) => requirement.id !== "homepage",
    );
    const classification: ChangeClassification = {
      kind: "within_paid_scope",
      explanation: "Incorrect unrelated deletion.",
      supersededScopeItems: [],
      supersededRequirementIds: [
        {
          id: "homepage",
          evidenceExcerpt: "Change the red theme to blue.",
        },
      ],
      supersededFactIds: [],
    };

    expect(() =>
      assertCumulativePaidRevision(
        priorProposal(),
        plan,
        classification,
        "Change the red theme to blue.",
      ),
    ).toThrow(/does not identify/);
  });

  it.each([
    [
      "deliverable",
      (plan: ProposalPlan) => {
        plan.scopeItems = plan.scopeItems.filter(
          (item) => item.text !== "Estimate form",
        );
      },
    ],
    [
      "soft requirement",
      (plan: ProposalPlan) => {
        plan.contractDraft.requirements =
          plan.contractDraft.requirements.filter(
            (requirement) => requirement.id !== "brand-style",
          );
      },
    ],
    [
      "existing verifier",
      (plan: ProposalPlan) => {
        plan.contractDraft.requirements[0]!.verifiers = [];
      },
    ],
    [
      "forbidden claim",
      (plan: ProposalPlan) => {
        plan.contractDraft.forbiddenClaims = [];
      },
    ],
    [
      "test command",
      (plan: ProposalPlan) => {
        plan.contractDraft.verification.testCommands = [];
      },
    ],
  ])("rejects silently removing or weakening a paid %s", (_name, mutate) => {
    const plan = nextPlan();
    mutate(plan);
    expect(() => assertCumulativePaidRevision(priorProposal(), plan)).toThrow(
      /Paid revision/,
    );
  });
});

function priorProposal(): ProposalVersion {
  return {
    plan: {
      deliverables: [
        { itemId: "homepage", text: "Homepage", sourceIds: ["source"] },
        {
          itemId: "estimate-form",
          text: "Estimate form",
          sourceIds: ["source"],
        },
      ],
    },
    contract: {
      approvedFacts: [
        {
          factId: "business-name",
          statement: "The business is named Mission Peak Electric.",
          sourceIds: ["source"],
        },
      ],
      forbiddenClaims: ["24/7 emergency service"],
      requirements: [
        {
          requirementId: "homepage",
          description: "Provide a homepage.",
          priority: "hard",
          sourceIds: ["source"],
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: [],
            },
          ],
        },
        {
          requirementId: "brand-style",
          description: "Use the approved visual direction.",
          priority: "preference",
          sourceIds: ["source"],
          verifiers: [
            {
              kind: "semantic",
              criterion: "The approved visual direction is used.",
            },
          ],
        },
      ],
      verification: {
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm start",
        previewPort: 3000,
      },
    },
  } as ProposalVersion;
}

function nextPlan(): ProposalPlan {
  return {
    title: "Mission Peak Electric",
    summary: "A cumulative revision.",
    scopeItems: [
      citedScopeItem("homepage", "Homepage"),
      citedScopeItem("estimate-form", "Estimate form"),
    ],
    buildPrompt: "Build the cumulative contract.",
    strategyLabels: ["conversion-first"],
    assets: [],
    clarificationQuestions: [],
    contractDraft: {
      approvedFacts: [
        {
          id: "business-name",
          statement: "The business is named Mission Peak Electric.",
          citation: {
            kind: "conversation",
            excerpt: "Mission Peak Electric",
          },
        },
      ],
      forbiddenClaims: ["24/7 emergency service"],
      requirements: [
        {
          id: "homepage",
          description: "Provide a homepage.",
          priority: "hard",
          citation: {
            kind: "conversation",
            excerpt: "Provide a homepage.",
          },
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: [],
            },
          ],
        },
        {
          id: "brand-style",
          description: "Use the approved visual direction.",
          priority: "preference",
          citation: {
            kind: "conversation",
            excerpt: "Use the approved visual direction.",
          },
          verifiers: [
            {
              kind: "semantic",
              criterion: "The approved visual direction is used.",
            },
          ],
        },
      ],
      verification: {
        origin: "system_policy",
        policyId: "buildlabs-proof-gate-v1",
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm start",
        previewPort: 3000,
      },
    },
  };
}

function citedScopeItem(
  id: string,
  text: string,
): ProposalPlan["scopeItems"][number] {
  return {
    id,
    text,
    citation: {
      kind: "conversation",
      excerpt: text,
    },
  };
}
