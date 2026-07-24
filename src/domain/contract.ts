import { z } from "zod";

import { digestJson, sha256 } from "../lib/canonical-json.js";

export const MAX_RENDERED_ROUTE_COUNT = 32;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const TranscriptFactSourceSchema = z.object({
  type: z.literal("transcript"),
  transcriptSha256: Sha256Schema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  excerpt: z.string().min(1).max(4_000),
  excerptSha256: Sha256Schema,
});

export const ResearchFactSourceSchema = z.object({
  type: z.literal("research"),
  url: z.url(),
  capturedAt: z.iso.datetime(),
  excerpt: z.string().min(1).max(4_000),
  excerptSha256: Sha256Schema,
});

export const FactSourceSchema = z.discriminatedUnion("type", [
  TranscriptFactSourceSchema,
  ResearchFactSourceSchema,
]);

export const ApprovedFactSchema = z.object({
  id: IdSchema,
  statement: z.string().min(1).max(2_000),
  sources: z.array(FactSourceSchema).min(1),
});

export const CommandVerifierSchema = z.object({
  kind: z.literal("command"),
  command: z.string().min(1).max(2_000),
  timeoutSeconds: z.number().int().min(1).max(900).default(180),
});

export const HttpVerifierSchema = z.object({
  kind: z.literal("http"),
  path: z
    .string()
    .min(1)
    .max(1_000)
    .refine((path) => {
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("\\") ||
        path.includes("#")
      ) {
        return false;
      }
      try {
        const url = new URL(path, "http://127.0.0.1");
        return `${url.pathname}${url.search}` === path;
      } catch {
        return false;
      }
    }, "HTTP verifier path must be a canonical origin-relative path without a fragment"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  bodyIncludes: z.array(z.string().min(1).max(500)).max(20).default([]),
});

export const SemanticVerifierSchema = z.object({
  kind: z.literal("semantic"),
  criterion: z.string().min(1).max(2_000),
});

export const VerifierSchema = z.discriminatedUnion("kind", [
  CommandVerifierSchema,
  HttpVerifierSchema,
  SemanticVerifierSchema,
]);

export const RequirementSchema = z.object({
  id: IdSchema,
  description: z.string().min(1).max(2_000),
  priority: z.enum(["hard", "preference"]),
  verifiers: z.array(VerifierSchema).max(20).default([]),
});

export const AcceptanceContractSchema = z
  .object({
    version: z.literal(1),
    contractRevision: z.number().int().positive().default(1),
    contractId: IdSchema,
    projectId: IdSchema,
    transcriptSha256: Sha256Schema,
    approvedAt: z.iso.datetime(),
    approvedFacts: z.array(ApprovedFactSchema).max(500),
    forbiddenClaims: z.array(z.string().min(4).max(500)).max(100),
    requirements: z.array(RequirementSchema).min(1).max(500),
    verification: z.object({
      buildCommand: z.string().min(1).max(2_000),
      testCommands: z.array(z.string().min(1).max(2_000)).min(1).max(20),
      previewCommand: z.string().min(1).max(2_000),
      previewPort: z.number().int().min(1).max(65_535),
    }),
  })
  .superRefine((contract, context) => {
    const requirementIds = new Set<string>();
    const renderedPaths = new Set(["/"]);
    for (const [index, requirement] of contract.requirements.entries()) {
      if (requirementIds.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate requirement id: ${requirement.id}`,
          path: ["requirements", index, "id"],
        });
      }
      requirementIds.add(requirement.id);
      for (const verifier of requirement.verifiers) {
        if (verifier.kind === "http") {
          renderedPaths.add(verifier.path);
        }
      }

      if (
        requirement.priority === "hard" &&
        requirement.verifiers.length === 0
      ) {
        context.addIssue({
          code: "custom",
          message: "Hard requirements must have at least one verifier",
          path: ["requirements", index, "verifiers"],
        });
      }
      if (
        requirement.priority === "hard" &&
        requirement.verifiers.some((verifier) => verifier.kind === "semantic")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Semantic verifiers are ranking-only; hard requirements require deterministic command or HTTP verification",
          path: ["requirements", index, "verifiers"],
        });
      }
    }
    if (renderedPaths.size > MAX_RENDERED_ROUTE_COUNT) {
      context.addIssue({
        code: "custom",
        message: `Acceptance Contract requests ${renderedPaths.size} unique rendered routes; at most ${MAX_RENDERED_ROUTE_COUNT} are allowed`,
        path: ["requirements"],
      });
    }

    const factIds = new Set<string>();
    for (const [factIndex, fact] of contract.approvedFacts.entries()) {
      if (factIds.has(fact.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate fact id: ${fact.id}`,
          path: ["approvedFacts", factIndex, "id"],
        });
      }
      factIds.add(fact.id);

      for (const [sourceIndex, source] of fact.sources.entries()) {
        if (
          source.type === "transcript" &&
          source.transcriptSha256 !== contract.transcriptSha256
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Transcript fact source does not match the contract transcript",
            path: [
              "approvedFacts",
              factIndex,
              "sources",
              sourceIndex,
              "transcriptSha256",
            ],
          });
        }

        if (
          source.type === "transcript" &&
          source.endOffset <= source.startOffset
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Transcript source endOffset must be greater than startOffset",
            path: ["approvedFacts", factIndex, "sources", sourceIndex],
          });
        }

        if (
          source.type === "research" &&
          sha256(source.excerpt) !== source.excerptSha256
        ) {
          context.addIssue({
            code: "custom",
            message: "Research excerpt hash does not match its contents",
            path: [
              "approvedFacts",
              factIndex,
              "sources",
              sourceIndex,
              "excerptSha256",
            ],
          });
        }
      }
    }
  });

export type AcceptanceContract = z.infer<typeof AcceptanceContractSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Verifier = z.infer<typeof VerifierSchema>;

export const TranscriptArtifactSchema = z.object({
  content: z.string().min(1).max(1_500_000),
  sha256: Sha256Schema,
});

export const BuildAssignmentSchema = z
  .object({
    assignmentId: IdSchema,
    projectId: IdSchema,
    candidateId: IdSchema,
    requestedAt: z.iso.datetime(),
    strategyLabel: z.string().min(1).max(200),
    buildPrompt: z.string().min(1).max(50_000),
    transcript: TranscriptArtifactSchema,
    contract: AcceptanceContractSchema,
    sandbox: z
      .object({
        language: z
          .enum(["javascript", "python", "typescript"])
          .default("typescript"),
        snapshot: z.string().min(1).max(256).optional(),
        autoStopMinutes: z.number().int().min(5).max(10_080).default(60),
        autoArchiveMinutes: z.number().int().min(5).max(10_080).default(1_440),
      })
      .default({
        language: "typescript",
        autoStopMinutes: 60,
        autoArchiveMinutes: 1_440,
      }),
    limits: z
      .object({
        maxAgentSteps: z.number().int().min(1).max(200).default(60),
        maxRepairRounds: z.number().int().min(0).max(10).default(2),
        wallClockSeconds: z.number().int().min(60).max(7_200).default(1_800),
        maxToolOutputBytes: z
          .number()
          .int()
          .min(1_024)
          .max(1_048_576)
          .default(65_536),
      })
      .default({
        maxAgentSteps: 60,
        maxRepairRounds: 2,
        wallClockSeconds: 1_800,
        maxToolOutputBytes: 65_536,
      }),
  })
  .superRefine((assignment, context) => {
    if (assignment.projectId !== assignment.contract.projectId) {
      context.addIssue({
        code: "custom",
        message: "Assignment and contract project ids must match",
        path: ["projectId"],
      });
    }

    if (
      sha256(assignment.transcript.content) !== assignment.transcript.sha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Transcript content hash does not match transcript.sha256",
        path: ["transcript", "sha256"],
      });
    }
    if (assignment.transcript.sha256 !== assignment.contract.transcriptSha256) {
      context.addIssue({
        code: "custom",
        message: "Assignment transcript does not match the contract transcript",
        path: ["transcript", "sha256"],
      });
    }

    for (const [
      factIndex,
      fact,
    ] of assignment.contract.approvedFacts.entries()) {
      for (const [sourceIndex, source] of fact.sources.entries()) {
        if (source.type !== "transcript") {
          continue;
        }
        const excerpt = assignment.transcript.content.slice(
          source.startOffset,
          source.endOffset,
        );
        if (excerpt !== source.excerpt) {
          context.addIssue({
            code: "custom",
            message:
              "Transcript source offsets do not resolve to the declared excerpt",
            path: [
              "contract",
              "approvedFacts",
              factIndex,
              "sources",
              sourceIndex,
            ],
          });
        }
        if (sha256(source.excerpt) !== source.excerptSha256) {
          context.addIssue({
            code: "custom",
            message: "Transcript excerpt hash does not match its contents",
            path: [
              "contract",
              "approvedFacts",
              factIndex,
              "sources",
              sourceIndex,
              "excerptSha256",
            ],
          });
        }
      }
    }
  });

export type BuildAssignment = z.infer<typeof BuildAssignmentSchema>;

export function contractDigest(contract: AcceptanceContract): string {
  return digestJson(contract);
}

export function assignmentDigest(assignment: BuildAssignment): string {
  return digestJson(assignment);
}
