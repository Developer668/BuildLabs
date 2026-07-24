import { z } from "zod";

import {
  AcceptanceContractSchema,
  VerifierSchema,
  type AcceptanceContract,
} from "../../domain/contract.js";
import { sha256 } from "../../lib/canonical-json.js";
import {
  findStandaloneEvidenceOffset,
  isSameExtractiveEvidence,
} from "./evidence-grounding.js";

const ConversationCitationSchema = z
  .object({
    kind: z.literal("conversation"),
    excerpt: z.string().min(1).max(4_000),
  })
  .strict();

const ResearchCitationSchema = z
  .object({
    kind: z.literal("research"),
    url: z.url(),
    excerpt: z.string().min(1).max(4_000),
  })
  .strict();

export const EvidenceCitationSchema = z.discriminatedUnion("kind", [
  ConversationCitationSchema,
  ResearchCitationSchema,
]);
export const FactCitationSchema = EvidenceCitationSchema;
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;

const DraftRequirementSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    description: z.string().min(1).max(2_000),
    priority: z.enum(["hard", "preference"]),
    citation: EvidenceCitationSchema,
    verifiers: z.array(VerifierSchema).max(20),
  })
  .strict()
  .superRefine((requirement, context) => {
    if (requirement.priority === "hard" && requirement.verifiers.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Hard requirements require at least one verifier",
        path: ["verifiers"],
      });
    }
  });

export const ContractDraftSchema = z
  .object({
    approvedFacts: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
            statement: z.string().min(1).max(2_000),
            citation: EvidenceCitationSchema,
          })
          .strict(),
      )
      .max(500),
    forbiddenClaims: z.array(z.string().min(1).max(2_000)).max(500),
    requirements: z.array(DraftRequirementSchema).min(1).max(500),
    verification: z
      .object({
        origin: z.literal("system_policy"),
        policyId: z.literal("buildlabs-proof-gate-v1"),
        buildCommand: z.string().min(1).max(2_000),
        testCommands: z.array(z.string().min(1).max(2_000)).min(1).max(20),
        previewCommand: z.string().min(1).max(2_000),
        previewPort: z.number().int().min(1).max(65_535),
      })
      .strict(),
  })
  .strict();

export type ContractDraft = z.infer<typeof ContractDraftSchema>;

export interface ResearchCapture {
  url: string;
  capturedAt: string;
  text: string;
}

export interface CompileAcceptanceContractInput {
  contractId: string;
  projectId: string;
  conversation: string;
  approvedAt: string;
  draft: ContractDraft;
  research: ResearchCapture[];
}

export class UnsupportedCitationError extends Error {
  constructor(factId: string, message: string) {
    super(`Fact ${factId} has no valid source: ${message}`);
    this.name = "UnsupportedCitationError";
  }
}

export function compileAcceptanceContract(
  input: CompileAcceptanceContractInput,
): AcceptanceContract {
  const draft = ContractDraftSchema.parse(input.draft);
  const transcriptSha256 = sha256(input.conversation);
  const approvedFacts = draft.approvedFacts.map((fact) => {
    const citation = fact.citation;
    if (!isSameExtractiveEvidence(fact.statement, citation.excerpt)) {
      throw new UnsupportedCitationError(
        fact.id,
        "the statement is not the same exact extractive evidence",
      );
    }
    if (citation.kind === "conversation") {
      const startOffset = findStandaloneEvidenceOffset(
        input.conversation,
        citation.excerpt,
      );
      if (startOffset < 0) {
        throw new UnsupportedCitationError(
          fact.id,
          "the conversation excerpt was not found exactly",
        );
      }
      return {
        id: fact.id,
        statement: fact.statement,
        sources: [
          {
            type: "transcript" as const,
            transcriptSha256,
            startOffset,
            endOffset: startOffset + citation.excerpt.length,
            excerpt: citation.excerpt,
            excerptSha256: sha256(citation.excerpt),
          },
        ],
      };
    }

    const capture = input.research.find(
      (candidate) => candidate.url === citation.url,
    );
    if (
      !capture ||
      findStandaloneEvidenceOffset(capture.text, citation.excerpt) < 0
    ) {
      throw new UnsupportedCitationError(
        fact.id,
        "the cited research capture or exact excerpt was not found",
      );
    }
    return {
      id: fact.id,
      statement: fact.statement,
      sources: [
        {
          type: "research" as const,
          url: capture.url,
          capturedAt: capture.capturedAt,
          excerpt: citation.excerpt,
          excerptSha256: sha256(citation.excerpt),
        },
      ],
    };
  });
  for (const requirement of draft.requirements) {
    const citation = requirement.citation;
    if (!isSameExtractiveEvidence(requirement.description, citation.excerpt)) {
      throw new UnsupportedCitationError(
        requirement.id,
        "the requirement is not the same exact extractive evidence",
      );
    }
    const capture =
      citation.kind === "research"
        ? input.research.find((candidate) => candidate.url === citation.url)
        : undefined;
    const sourceText =
      citation.kind === "conversation" ? input.conversation : capture?.text;
    if (
      !sourceText ||
      findStandaloneEvidenceOffset(sourceText, citation.excerpt) < 0
    ) {
      throw new UnsupportedCitationError(
        requirement.id,
        "the exact requirement evidence unit was not found",
      );
    }
  }

  return AcceptanceContractSchema.parse({
    version: 1,
    contractId: input.contractId,
    projectId: input.projectId,
    transcriptSha256,
    approvedAt: input.approvedAt,
    approvedFacts,
    forbiddenClaims: draft.forbiddenClaims,
    requirements: draft.requirements.map((requirement) => ({
      id: requirement.id,
      description: requirement.description,
      priority: requirement.priority,
      verifiers: requirement.verifiers.map((verifier) =>
        VerifierSchema.parse(verifier),
      ),
    })),
    verification: draft.verification,
  });
}
