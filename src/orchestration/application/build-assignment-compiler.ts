import {
  AcceptanceContractSchema,
  BuildAssignmentSchema,
  contractDigest,
  type AcceptanceContract,
  type BuildAssignment,
} from "../../domain/contract.js";
import { sha256 } from "../../lib/canonical-json.js";
import { redactText } from "../../lib/redaction.js";
import {
  CustomerProfileSchema,
  ProposalVersionSchema,
  type CustomerProfile,
  type ProposalVersion,
} from "../domain/project.js";
import {
  assertExactExtractiveEvidence,
  assertFactCitationEntails,
  assertFactCitationIsStandalone,
} from "./proposal-builder.js";

export interface CompileBuildAssignmentsInput {
  projectId: string;
  proposal: ProposalVersion;
  customer: CustomerProfile;
  requestedAt: string;
  sandboxSnapshot?: string;
}

export interface CompiledBuildAssignments {
  contract: AcceptanceContract;
  contractHash: string;
  transcript: { content: string; sha256: string };
  assignments: BuildAssignment[];
}

export class ProtectedPiiInBuildContextError extends Error {
  constructor() {
    super("The approved build context contains protected customer PII");
    this.name = "ProtectedPiiInBuildContextError";
  }
}

export class InvalidBuildEvidenceError extends Error {
  constructor(message: string) {
    super(`The approved build evidence is invalid: ${message}`);
    this.name = "InvalidBuildEvidenceError";
  }
}

export function compileBuildAssignments(
  input: CompileBuildAssignmentsInput,
): CompiledBuildAssignments {
  const proposal = ProposalVersionSchema.parse(input.proposal);
  const customer = CustomerProfileSchema.parse(input.customer);
  assertNoProtectedPii(normalizedBuildContext(proposal), customer);
  const evidence = compileEvidenceTranscript(proposal);
  assertNoProtectedPii(evidence.transcript.content, customer);
  const transcript = evidence.transcript;
  const sourceById = new Map(
    proposal.sources.map((source) => [source.sourceId, source]),
  );
  const verifyProposalItemEvidence = (
    subjectId: string,
    statement: string,
    sourceIds: readonly string[],
  ): void => {
    for (const sourceId of sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) {
        throw new InvalidBuildEvidenceError(
          `${subjectId} references missing source ${sourceId}`,
        );
      }
      assertExactExtractiveEvidence(statement, source.excerpt, subjectId);
      assertNoProtectedPii(source.excerpt, customer);
      if (source.kind === "research") {
        const fullCapture = proposal.sources.find(
          (candidate) =>
            candidate.kind === "research" &&
            candidate.url === source.url &&
            candidate.capturedAt === source.capturedAt &&
            candidate.captureDigest === source.captureDigest &&
            candidate.startOffset === 0 &&
            candidate.endOffset >= source.endOffset &&
            candidate.endOffset === candidate.excerpt.length &&
            candidate.excerptDigest === candidate.captureDigest,
        );
        if (!fullCapture || fullCapture.kind !== "research") {
          throw new InvalidBuildEvidenceError(
            `${subjectId} has no digest-bound research capture`,
          );
        }
        assertFactCitationIsStandalone(
          fullCapture.excerpt,
          source.excerpt,
          source.startOffset,
        );
        continue;
      }
      const location = evidence.sourceLocations.get(source.sourceId);
      if (
        !location ||
        transcript.content.slice(location.startOffset, location.endOffset) !==
          source.excerpt ||
        sha256(source.excerpt) !== source.excerptDigest
      ) {
        throw new InvalidBuildEvidenceError(
          `${subjectId} is not bound to its persisted minimized conversation excerpt`,
        );
      }
      assertFactCitationIsStandalone(
        transcript.content,
        source.excerpt,
        location.startOffset,
      );
    }
  };
  for (const deliverable of proposal.plan.deliverables) {
    verifyProposalItemEvidence(
      `deliverable ${deliverable.itemId}`,
      deliverable.text,
      deliverable.sourceIds,
    );
  }
  for (const requirement of proposal.contract.requirements) {
    verifyProposalItemEvidence(
      `requirement ${requirement.requirementId}`,
      requirement.description,
      requirement.sourceIds,
    );
  }

  const approvedFacts = proposal.contract.approvedFacts.map((fact) => {
    const sources = fact.sourceIds.map((sourceId) => {
      const source = sourceById.get(sourceId);
      if (!source) {
        throw new InvalidBuildEvidenceError(
          `fact ${fact.factId} references missing source ${sourceId}`,
        );
      }
      assertFactCitationEntails(fact.statement, source.excerpt);
      assertNoProtectedPii(source.excerpt, customer);
      if (source.kind === "research") {
        const fullCapture = proposal.sources.find(
          (candidate) =>
            candidate.kind === "research" &&
            candidate.url === source.url &&
            candidate.capturedAt === source.capturedAt &&
            candidate.captureDigest === source.captureDigest &&
            candidate.startOffset === 0 &&
            candidate.endOffset >= source.endOffset &&
            candidate.endOffset === candidate.excerpt.length &&
            candidate.excerptDigest === candidate.captureDigest,
        );
        if (!fullCapture || fullCapture.kind !== "research") {
          throw new InvalidBuildEvidenceError(
            `fact ${fact.factId} has no digest-bound research capture`,
          );
        }
        assertFactCitationIsStandalone(
          fullCapture.excerpt,
          source.excerpt,
          source.startOffset,
        );
        if (source.excerpt.length > 4_000) {
          throw new InvalidBuildEvidenceError(
            `fact ${fact.factId} research citation exceeds the build-contract limit`,
          );
        }
        return {
          type: "research" as const,
          url: source.url,
          capturedAt: source.capturedAt,
          excerpt: source.excerpt,
          excerptSha256: source.excerptDigest,
        };
      }

      const location = evidence.sourceLocations.get(source.sourceId);
      if (!location) {
        throw new InvalidBuildEvidenceError(
          `fact ${fact.factId} is not bound to the exact minimized conversation`,
        );
      }
      const resolvedExcerpt = transcript.content.slice(
        location.startOffset,
        location.endOffset,
      );
      if (
        resolvedExcerpt !== source.excerpt ||
        sha256(resolvedExcerpt) !== source.excerptDigest
      ) {
        throw new InvalidBuildEvidenceError(
          `fact ${fact.factId} offsets do not resolve to its persisted excerpt`,
        );
      }
      assertFactCitationIsStandalone(
        transcript.content,
        source.excerpt,
        location.startOffset,
      );
      return {
        type: "transcript" as const,
        transcriptSha256: transcript.sha256,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        excerpt: source.excerpt,
        excerptSha256: source.excerptDigest,
      };
    });
    return {
      id: fact.factId,
      statement: fact.statement,
      sources,
    };
  });

  const contract = AcceptanceContractSchema.parse({
    version: 1,
    contractRevision: proposal.contract.version,
    contractId: proposal.contract.contractId,
    projectId: input.projectId,
    transcriptSha256: transcript.sha256,
    approvedAt: proposal.createdAt,
    approvedFacts,
    forbiddenClaims: proposal.contract.forbiddenClaims,
    requirements: proposal.contract.requirements.map((requirement) => ({
      id: requirement.requirementId,
      description: requirement.description,
      priority: requirement.priority,
      verifiers: requirement.verifiers,
    })),
    verification: proposal.contract.verification,
  });
  const hash = contractDigest(contract);
  const assignments = proposal.strategyLabels.map((strategyLabel, index) => {
    const stable = sha256(
      `${input.projectId}:${proposal.version}:${index + 1}:${proposal.digest}`,
    ).slice(0, 32);
    return BuildAssignmentSchema.parse({
      assignmentId: `assignment:${stable}`,
      projectId: input.projectId,
      candidateId: `candidate:${stable}`,
      requestedAt: input.requestedAt,
      strategyLabel,
      buildPrompt: [
        proposal.buildPrompt,
        "",
        `Approved proposal version: ${proposal.version}`,
        `Strategy for this candidate: ${strategyLabel}`,
        "Implement the complete cumulative Acceptance Contract. Use no business facts outside the approved contract.",
      ].join("\n"),
      transcript,
      contract,
      sandbox: {
        language: "typescript",
        ...(input.sandboxSnapshot ? { snapshot: input.sandboxSnapshot } : {}),
        autoStopMinutes: 60,
        autoArchiveMinutes: 1_440,
      },
      limits: {
        maxAgentSteps: 60,
        maxRepairRounds: 2,
        wallClockSeconds: 1_800,
        maxToolOutputBytes: 65_536,
      },
    });
  });

  return { contract, contractHash: hash, transcript, assignments };
}

type ProposalSource = ProposalVersion["sources"][number];
type ConversationSource = Exclude<ProposalSource, { kind: "research" }>;

interface EvidenceTranscript {
  transcript: { content: string; sha256: string };
  sourceLocations: Map<string, { startOffset: number; endOffset: number }>;
}

function compileEvidenceTranscript(
  proposal: ProposalVersion,
): EvidenceTranscript {
  const originOrder: string[] = [];
  const roots = new Map<string, ConversationSource>();
  for (const source of proposal.sources) {
    if (source.kind === "research") {
      continue;
    }
    const origin = conversationOriginKey(source);
    if (!originOrder.includes(origin)) {
      originOrder.push(origin);
    }
    const isDigestBoundRoot =
      source.startOffset === 0 &&
      source.endOffset === source.excerpt.length &&
      source.excerptDigest === source.minimizedContentDigest;
    const existing = roots.get(origin);
    if (
      isDigestBoundRoot &&
      (!existing || source.endOffset > existing.endOffset)
    ) {
      roots.set(origin, source);
    }
  }
  if (roots.size === 0) {
    throw new InvalidBuildEvidenceError(
      "no digest-bound minimized conversation was persisted",
    );
  }

  const contentParts: string[] = [];
  const originBaseOffsets = new Map<string, number>();
  let contentLength = 0;
  for (const origin of originOrder) {
    const root = roots.get(origin);
    if (!root) {
      throw new InvalidBuildEvidenceError(
        "a conversation source has no digest-bound minimized root",
      );
    }
    if (sha256(root.excerpt) !== root.minimizedContentDigest) {
      throw new InvalidBuildEvidenceError(
        "a minimized conversation root failed digest verification",
      );
    }
    if (contentParts.length > 0) {
      contentLength += 2;
    }
    originBaseOffsets.set(origin, contentLength);
    contentParts.push(root.excerpt);
    contentLength += root.excerpt.length;
  }

  const content = contentParts.join("\n\n");
  if (content.length === 0 || content.length > 1_500_000) {
    throw new InvalidBuildEvidenceError(
      "the minimized conversation is empty or exceeds the assignment limit",
    );
  }
  const sourceLocations = new Map<
    string,
    { startOffset: number; endOffset: number }
  >();
  for (const source of proposal.sources) {
    if (source.kind === "research") {
      continue;
    }
    const baseOffset = originBaseOffsets.get(conversationOriginKey(source));
    if (baseOffset === undefined) {
      throw new InvalidBuildEvidenceError(
        `source ${source.sourceId} has no minimized conversation root`,
      );
    }
    const startOffset = baseOffset + source.startOffset;
    const endOffset = baseOffset + source.endOffset;
    if (content.slice(startOffset, endOffset) !== source.excerpt) {
      throw new InvalidBuildEvidenceError(
        `source ${source.sourceId} does not resolve to its exact minimized excerpt`,
      );
    }
    sourceLocations.set(source.sourceId, { startOffset, endOffset });
  }

  return {
    transcript: { content, sha256: sha256(content) },
    sourceLocations,
  };
}

function conversationOriginKey(source: ConversationSource): string {
  const providerId =
    source.kind === "intake" ? source.intakeId : source.messageId;
  return [
    source.kind,
    providerId,
    source.contentDigest,
    source.minimizedContentDigest,
  ].join(":");
}

function normalizedBuildContext(proposal: ProposalVersion): string {
  return [
    "BUILD INSTRUCTIONS:",
    proposal.buildPrompt,
    "",
    "DELIVERABLES:",
    ...proposal.plan.deliverables.map(
      (item) => `[${item.itemId}] ${item.text}`,
    ),
    "",
    "APPROVED BUSINESS FACTS:",
    ...proposal.contract.approvedFacts.map(
      (fact) => `[${fact.factId}] ${fact.statement}`,
    ),
    "",
    "REQUIREMENTS:",
    ...proposal.contract.requirements.map(
      (requirement) =>
        `[${requirement.requirementId}] (${requirement.priority}) ${requirement.description}`,
    ),
    "",
    "FORBIDDEN CLAIMS:",
    ...proposal.contract.forbiddenClaims.map((claim) => `- ${claim}`),
  ].join("\n");
}

function assertNoProtectedPii(
  content: string,
  customer: CustomerProfile,
): void {
  const protectedValues = [
    customer.displayName,
    customer.email?.value,
    customer.phone?.value,
  ].filter((value): value is string => Boolean(value?.trim()));
  const normalized = content.toLocaleLowerCase();
  if (
    protectedValues.some((value) =>
      normalized.includes(value.toLocaleLowerCase()),
    ) ||
    redactText(content) !== content
  ) {
    throw new ProtectedPiiInBuildContextError();
  }
}
