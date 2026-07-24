import { describe, expect, it } from "vitest";

import { BuildAssignmentSchema } from "../src/domain/contract.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { compileBuildAssignments } from "../src/orchestration/application/build-assignment-compiler.js";
import {
  buildProposalVersion,
  UnverifiedProposalEvidenceError,
} from "../src/orchestration/application/proposal-builder.js";
import {
  ConversationAnalysisSchema,
  ProposalPlanSchema,
} from "../src/orchestration/application/fireworks-orchestration-reasoner.js";
import {
  acceptanceContractDigest,
  CustomerProfileSchema,
  IntakeSchema,
  proposalDigest,
} from "../src/orchestration/domain/project.js";

const now = "2026-07-23T12:00:00.000Z";

describe("compileBuildAssignments", () => {
  it("fans out exact minimized evidence and rejects model-authored evidence laundering", () => {
    const rawConversation =
      "I am Jordan Lee (jordan@example.com). Mission Peak Electric serves Fremont. Build a homepage and estimate form. We agreed on USD 2,500.";
    const minimizedConversation = rawConversation
      .replace("Jordan Lee", "█".repeat("Jordan Lee".length))
      .replace("jordan@example.com", "█".repeat("jordan@example.com".length));
    const intake = IntakeSchema.parse({
      kind: "voice",
      intakeId: "intake-build-one",
      receivedAt: now,
      content: rawConversation,
      contentDigest: sha256(rawConversation),
      piiSpans: [],
      source: {
        provider: "elevenlabs",
        conversationId: "conversation-build-one",
      },
    });
    const analysis = ConversationAnalysisSchema.parse({
      customer: { name: "Jordan Lee", email: "jordan@example.com" },
      piiSpans: [],
      quote: {
        amountMinor: 250_000,
        currency: "usd",
        evidenceExcerpt: "We agreed on USD 2,500",
      },
      researchTargets: [],
      clarificationQuestions: [],
    });
    const plan = ProposalPlanSchema.parse({
      title: "Mission Peak Electric website",
      summary: "An accessible service website.",
      scopeItems: [
        {
          id: "website",
          text: "Build a homepage and estimate form.",
          citation: {
            kind: "conversation",
            excerpt: "Build a homepage and estimate form",
          },
        },
      ],
      buildPrompt: "Build an accessible site for Mission Peak Electric.",
      strategyLabels: ["conversion-first", "trust-first"],
      assets: [],
      clarificationQuestions: [],
      contractDraft: {
        approvedFacts: [
          {
            id: "service-area",
            statement: "Mission Peak Electric serves Fremont.",
            citation: {
              kind: "conversation",
              excerpt: "Mission Peak Electric serves Fremont",
            },
          },
        ],
        forbiddenClaims: ["24/7 emergency service"],
        requirements: [
          {
            id: "homepage",
            description: "Build a homepage and estimate form.",
            priority: "hard",
            citation: {
              kind: "conversation",
              excerpt: "Build a homepage and estimate form",
            },
            verifiers: [
              {
                kind: "http",
                path: "/",
                expectedStatus: 200,
                bodyIncludes: ["Mission Peak Electric"],
              },
            ],
          },
        ],
        verification: {
          origin: "system_policy",
          policyId: "buildlabs-proof-gate-v1",
          buildCommand: "npm run build",
          testCommands: ["npm test"],
          previewCommand: "npm run start",
          previewPort: 3000,
        },
      },
    });
    const proposal = buildProposalVersion({
      projectId: "project-build-one",
      version: 1,
      createdAt: now,
      intake,
      minimizedConversation,
      analysis,
      plan,
      research: [],
      disallowedPiiValues: ["Jordan Lee", "jordan@example.com"],
    });
    const customer = CustomerProfileSchema.parse({
      profileId: "profile-build-one",
      displayName: "Jordan Lee",
      email: {
        value: "jordan@example.com",
        verified: true,
        verifiedAt: now,
      },
      organizationName: "Mission Peak Electric",
      researchConsent: {
        granted: false,
        scope: "own_business_only",
      },
    });

    const result = compileBuildAssignments({
      projectId: "project-build-one",
      proposal,
      customer,
      requestedAt: now,
    });

    expect(result.assignments).toHaveLength(2);
    expect(result.transcript.content).toBe(minimizedConversation);
    const factSource = result.contract.approvedFacts[0]?.sources[0];
    expect(factSource).toMatchObject({
      type: "transcript",
      excerpt: "Mission Peak Electric serves Fremont",
      excerptSha256: sha256("Mission Peak Electric serves Fremont"),
    });
    if (factSource?.type !== "transcript") {
      throw new Error(
        "Expected the approved fact to retain transcript evidence",
      );
    }
    expect(
      result.transcript.content.slice(
        factSource.startOffset,
        factSource.endOffset,
      ),
    ).toBe("Mission Peak Electric serves Fremont");
    expect(
      new Set(result.assignments.map((assignment) => assignment.assignmentId))
        .size,
    ).toBe(2);
    for (const assignment of result.assignments) {
      expect(BuildAssignmentSchema.parse(assignment)).toEqual(assignment);
      expect(assignment.transcript.content).not.toContain("Jordan Lee");
      expect(assignment.transcript.content).not.toContain("jordan@example.com");
      expect(assignment.contract).toEqual(result.contract);
    }

    const forgedProposal = structuredClone(proposal);
    const forgedStatement = "Fremont serves Mission Peak Electric.";
    const forgedFact = forgedProposal.contract.approvedFacts[0];
    const forgedPlanFact = forgedProposal.plan.approvedFacts[0];
    if (!forgedFact || !forgedPlanFact) {
      throw new Error("Expected an approved fact fixture");
    }
    forgedFact.statement = forgedStatement;
    forgedPlanFact.text = forgedStatement;
    const { digest: oldContractDigest, ...contractContent } =
      forgedProposal.contract;
    void oldContractDigest;
    forgedProposal.contract.digest = acceptanceContractDigest(contractContent);
    const { digest: oldProposalDigest, ...proposalContent } = forgedProposal;
    void oldProposalDigest;
    forgedProposal.digest = proposalDigest(proposalContent);

    expect(() =>
      compileBuildAssignments({
        projectId: "project-build-one",
        proposal: forgedProposal,
        customer,
        requestedAt: now,
      }),
    ).toThrow(UnverifiedProposalEvidenceError);
  });
});
