import {
  AcceptanceContractContentSchema,
  IntakeSchema,
  ProposalVersionSchema,
  acceptanceContractDigest,
  proposalDigest,
  type Intake,
  type ProposalSource,
  type ProposalVersion,
} from "../domain/project.js";
import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import { redactText } from "../../lib/redaction.js";
import type { WebsiteResearchCapture } from "../ports/website-research.js";
import {
  ConversationAnalysisSchema,
  ProposalPlanSchema,
  type ConversationAnalysis,
  type ProposalPlan,
} from "./fireworks-orchestration-reasoner.js";
import {
  findStandaloneEvidenceOffset,
  isSameExtractiveEvidence,
  isStandaloneEvidenceAt,
} from "./evidence-grounding.js";
import type { EvidenceCitation } from "./contract-compiler.js";

export interface BuildProposalVersionInput {
  projectId: string;
  version: number;
  parentVersion?: number;
  priorProposal?: ProposalVersion;
  commercialBasisVersion?: number;
  changeRationale?: string;
  createdAt: string;
  intake: Intake;
  minimizedConversation: string;
  conversationSegments?: ConversationEvidenceSegment[];
  analysis: ConversationAnalysis;
  plan: ProposalPlan;
  research: WebsiteResearchCapture[];
  disallowedPiiValues: string[];
}

export type ConversationEvidenceSegment =
  | {
      kind: "intake";
      intakeId: string;
      contentDigest: string;
      minimizedContent: string;
    }
  | {
      kind: "customer_message";
      messageId: string;
      contentDigest: string;
      minimizedContent: string;
    };

export class UnverifiedProposalEvidenceError extends Error {
  constructor(message: string) {
    super(`Proposal evidence is not verified: ${message}`);
    this.name = "UnverifiedProposalEvidenceError";
  }
}

export class UnverifiedQuoteEvidenceError extends UnverifiedProposalEvidenceError {
  readonly clarificationQuestion =
    "Please confirm one exact, one-time, all-inclusive total and an explicit three-letter ISO currency code, such as USD 2,500 total. The current checkout cannot represent subscriptions, recurring cadence, deposits, balances, installments, or additional taxes and fees.";

  constructor(message: string) {
    super(message);
    this.name = "UnverifiedQuoteEvidenceError";
  }
}

export class UnconfirmedResearchEvidenceError extends UnverifiedProposalEvidenceError {
  readonly clarificationQuestion =
    "Research findings are provisional inspiration until you confirm them. Please reply with the exact business facts, scope, or design directions from the researched site that you approve for this project.";

  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedResearchEvidenceError";
  }
}

export class PiiInBuildPlanError extends Error {
  constructor() {
    super("The generated build plan contains protected customer PII");
    this.name = "PiiInBuildPlanError";
  }
}

export class UnsupportedAssetEvidenceError extends Error {
  readonly clarificationQuestion =
    "Please provide the exact approved asset files and usage instructions; this build cannot safely infer or copy logos, images, fonts, or video from a conversation or webpage.";

  constructor() {
    super(
      "Requested assets require an explicit customer clarification and approved asset-ingestion path",
    );
    this.name = "UnsupportedAssetEvidenceError";
  }
}

export function buildProposalVersion(
  rawInput: BuildProposalVersionInput,
): ProposalVersion {
  const intake = IntakeSchema.parse(rawInput.intake);
  const analysis = ConversationAnalysisSchema.parse(rawInput.analysis);
  const plan = ProposalPlanSchema.parse(rawInput.plan);
  const priorProposal = rawInput.priorProposal
    ? ProposalVersionSchema.parse(rawInput.priorProposal)
    : undefined;
  if (
    priorProposal &&
    (priorProposal.version !== rawInput.parentVersion ||
      priorProposal.contract.projectId !== rawInput.projectId)
  ) {
    throw new UnverifiedProposalEvidenceError(
      "prior proposal does not match the immediate project parent",
    );
  }
  assertConversationAuthorizesContractItems(plan);
  assertRequirementPriorityGrounding(plan);
  assertPlanContractCoverage(plan);
  const conversationSegments = rawInput.conversationSegments ?? [
    {
      kind: "intake" as const,
      intakeId: intake.intakeId,
      contentDigest: intake.contentDigest,
      minimizedContent: rawInput.minimizedConversation,
    },
  ];
  const canonicalConversation = conversationSegments
    .map((segment) => segment.minimizedContent)
    .join("\n\n");
  if (canonicalConversation !== rawInput.minimizedConversation) {
    throw new UnverifiedProposalEvidenceError(
      "conversation segments do not match the canonical conversation",
    );
  }
  assertTextHasNoProtectedPii(
    canonicalConversation,
    rawInput.disallowedPiiValues,
  );
  const quote = analysis.quote;
  if (!quote) {
    throw new UnverifiedProposalEvidenceError("an agreed quote is missing");
  }
  if (
    !conversationSegments.some((segment) =>
      hasStandaloneEvidence(segment.minimizedContent, quote.evidenceExcerpt),
    )
  ) {
    throw new UnverifiedProposalEvidenceError(
      "the agreed quote must cite one exact complete conversation sentence or line",
    );
  }
  assertQuoteEvidenceMatches(
    quote.evidenceExcerpt,
    quote.amountMinor,
    quote.currency,
  );
  assertNoProtectedPii(plan, rawInput.disallowedPiiValues);

  const generalSourceIds: string[] = [];
  const sources: ProposalSource[] = conversationSegments.map(
    (segment, index) => {
      const sourceId = `source-message-v${rawInput.version}-${index + 1}`;
      generalSourceIds.push(sourceId);
      if (segment.kind === "intake") {
        const minimizedContentDigest = sha256(segment.minimizedContent);
        return {
          sourceId,
          kind: "intake" as const,
          intakeId: segment.intakeId,
          contentDigest: segment.contentDigest,
          minimizedContentDigest,
          startOffset: 0,
          endOffset: segment.minimizedContent.length,
          excerpt: segment.minimizedContent,
          excerptDigest: minimizedContentDigest,
        };
      }
      const minimizedContentDigest = sha256(segment.minimizedContent);
      return {
        sourceId,
        kind: "customer_message" as const,
        messageId: segment.messageId,
        contentDigest: segment.contentDigest,
        minimizedContentDigest,
        startOffset: 0,
        endOffset: segment.minimizedContent.length,
        excerpt: segment.minimizedContent,
        excerptDigest: minimizedContentDigest,
      };
    },
  );
  const generalSourceId = generalSourceIds[0];
  if (!generalSourceId) {
    throw new UnverifiedProposalEvidenceError(
      "at least one conversation source is required",
    );
  }
  const researchCaptureByUrl = new Map<string, WebsiteResearchCapture>();
  for (const [index, capture] of rawInput.research.entries()) {
    assertResearchProvenance(capture);
    if (sha256(capture.textExcerpt) !== capture.sha256) {
      throw new UnverifiedProposalEvidenceError(
        `research capture ${capture.url} has an invalid digest`,
      );
    }
    assertResearchHasNoPromptInjection(capture);
    const sourceId = `source-research-v${rawInput.version}-${index + 1}`;
    const url = new URL(capture.finalUrl);
    if (researchCaptureByUrl.has(url.toString())) {
      throw new UnverifiedProposalEvidenceError(
        `research capture ${capture.url} duplicates one final URL`,
      );
    }
    sources.push({
      sourceId,
      kind: "research",
      url: url.toString(),
      requestedUrl: capture.requestedUrl,
      finalUrl: url.toString(),
      redirectChain: [...capture.redirectChain],
      ...(capture.canonicalUrl ? { canonicalUrl: capture.canonicalUrl } : {}),
      ...(capture.title ? { title: capture.title } : {}),
      ...(capture.publisher ? { publisher: capture.publisher } : {}),
      capturedAt: capture.capturedAt,
      retrievedAt: capture.retrievedAt,
      captureDigest: capture.sha256,
      startOffset: 0,
      endOffset: capture.textExcerpt.length,
      excerpt: capture.textExcerpt,
      excerptDigest: capture.sha256,
      promptInjectionChecked: true,
    });
    researchCaptureByUrl.set(url.toString(), capture);
  }
  const priorFullConversationSources = (priorProposal?.sources ?? []).filter(
    (
      source,
    ): source is Extract<
      ProposalSource,
      { kind: "intake" | "customer_message" }
    > =>
      (source.kind === "intake" || source.kind === "customer_message") &&
      source.startOffset === 0 &&
      source.endOffset === source.excerpt.length &&
      source.excerptDigest === source.minimizedContentDigest,
  );
  const copiedPriorFullSourceIds = new Map<string, string>();

  const bindEvidence = (
    subjectKind: "fact" | "deliverable" | "requirement",
    subjectId: string,
    index: number,
    statement: string,
    citation: EvidenceCitation,
  ): {
    sourceId: string;
    evidenceBasis: "customer_conversation" | "confirmed_research";
  } => {
    assertExactExtractiveEvidence(statement, citation.excerpt, subjectKind);
    if (citation.kind === "research") {
      throw new UnconfirmedResearchEvidenceError(
        subjectKind === "fact"
          ? `research-only claim ${subjectId} cannot become an approved business fact until the customer confirms it in the conversation`
          : `research-only evidence cannot authorize ${subjectKind} ${subjectId}; commercial scope and requirements require exact customer-conversation evidence`,
      );
    }
    const sourceId = `source-${subjectKind}-v${rawInput.version}-${index + 1}`;
    const segmentIndex = conversationSegments.findIndex((segment) =>
      hasStandaloneEvidence(segment.minimizedContent, citation.excerpt),
    );
    const segment = conversationSegments[segmentIndex];
    if (segment) {
      const startOffset = findStandaloneEvidenceOffset(
        segment.minimizedContent,
        citation.excerpt,
      );
      sources.push(
        segment.kind === "intake"
          ? {
              sourceId,
              kind: "intake",
              intakeId: segment.intakeId,
              contentDigest: segment.contentDigest,
              minimizedContentDigest: sha256(segment.minimizedContent),
              startOffset,
              endOffset: startOffset + citation.excerpt.length,
              excerpt: citation.excerpt,
              excerptDigest: sha256(citation.excerpt),
            }
          : {
              sourceId,
              kind: "customer_message",
              messageId: segment.messageId,
              contentDigest: segment.contentDigest,
              minimizedContentDigest: sha256(segment.minimizedContent),
              startOffset,
              endOffset: startOffset + citation.excerpt.length,
              excerpt: citation.excerpt,
              excerptDigest: sha256(citation.excerpt),
            },
      );
      return { sourceId, evidenceBasis: "customer_conversation" };
    }

    const priorFullSource = priorFullConversationSources.find((source) =>
      hasStandaloneEvidence(source.excerpt, citation.excerpt),
    );
    if (!priorFullSource) {
      throw new UnverifiedProposalEvidenceError(
        `${subjectKind} ${subjectId} lacks its exact conversation excerpt`,
      );
    }
    const originKey =
      priorFullSource.kind === "intake"
        ? `intake:${priorFullSource.intakeId}`
        : `customer_message:${priorFullSource.messageId}`;
    if (!copiedPriorFullSourceIds.has(originKey)) {
      const fullSourceId = `source-prior-full-v${rawInput.version}-${copiedPriorFullSourceIds.size + 1}`;
      copiedPriorFullSourceIds.set(originKey, fullSourceId);
      sources.push({ ...priorFullSource, sourceId: fullSourceId });
    }
    const startOffset = findStandaloneEvidenceOffset(
      priorFullSource.excerpt,
      citation.excerpt,
    );
    sources.push({
      ...priorFullSource,
      sourceId,
      startOffset,
      endOffset: startOffset + citation.excerpt.length,
      excerpt: citation.excerpt,
      excerptDigest: sha256(citation.excerpt),
    });
    return { sourceId, evidenceBasis: "customer_conversation" };
  };

  const factEvidence = plan.contractDraft.approvedFacts.map((fact, index) =>
    bindEvidence("fact", fact.id, index, fact.statement, fact.citation),
  );
  const deliverableEvidence = plan.scopeItems.map((item, index) =>
    bindEvidence("deliverable", item.id, index, item.text, item.citation),
  );
  const requirementEvidence = plan.contractDraft.requirements.map(
    (requirement, index) =>
      bindEvidence(
        "requirement",
        requirement.id,
        index,
        requirement.description,
        requirement.citation,
      ),
  );

  assertNoUnsupportedAssetDependency(canonicalConversation);

  const factSourceIds = factEvidence.map((evidence) => evidence.sourceId);
  const deliverableSourceIds = deliverableEvidence.map(
    (evidence) => evidence.sourceId,
  );
  const requirementSourceIds = requirementEvidence.map(
    (evidence) => evidence.sourceId,
  );

  const contractContent = AcceptanceContractContentSchema.parse({
    contractId: `${rawInput.projectId}:contract:v${rawInput.version}`,
    projectId: rawInput.projectId,
    version: rawInput.version,
    ...(rawInput.parentVersion === undefined
      ? {}
      : { parentVersion: rawInput.parentVersion }),
    approvedFacts: plan.contractDraft.approvedFacts.map((fact, index) => ({
      factId: fact.id,
      statement: fact.statement,
      sourceIds: [factSourceIds[index] ?? generalSourceId],
    })),
    forbiddenClaims: plan.contractDraft.forbiddenClaims,
    requirements: plan.contractDraft.requirements.map((requirement, index) => {
      const evidence = requirementEvidence[index];
      const sourceId = requirementSourceIds[index];
      if (!evidence || !sourceId) {
        throw new UnverifiedProposalEvidenceError(
          `requirement ${requirement.id} lacks exact evidence`,
        );
      }
      return {
        requirementId: requirement.id,
        description: requirement.description,
        priority: requirement.priority,
        sourceIds: [sourceId],
        evidenceBasis: evidence.evidenceBasis,
        verificationBasis: "system_policy" as const,
        verifiers: requirement.verifiers,
      };
    }),
    verification: plan.contractDraft.verification,
    createdAt: rawInput.createdAt,
  });
  const contract = {
    ...contractContent,
    digest: acceptanceContractDigest(contractContent),
  };
  assertVerifiersDoNotBroadenEvidence(plan);
  const derivedBuildPrompt = deriveEvidenceBoundBuildPrompt(plan);
  const strategyLabels = [
    "requirements-first",
    "accessibility-first",
    "interaction-first",
    "resilience-first",
  ].slice(0, plan.strategyLabels.length);
  const groundedCustomerCopy = deriveGroundedCustomerCopy(
    plan,
    deliverableSourceIds,
    requirementSourceIds,
  );

  const proposalContent = {
    proposalId: `${rawInput.projectId}:proposal:v${rawInput.version}`,
    version: rawInput.version,
    ...(rawInput.parentVersion === undefined
      ? {}
      : { parentVersion: rawInput.parentVersion }),
    ...(rawInput.commercialBasisVersion === undefined
      ? {}
      : { commercialBasisVersion: rawInput.commercialBasisVersion }),
    ...(rawInput.changeRationale === undefined
      ? {}
      : { changeRationale: rawInput.changeRationale }),
    projectTitle: groundedCustomerCopy.title,
    buildPrompt: derivedBuildPrompt,
    strategyLabels,
    sources,
    plan: {
      summary: {
        text: groundedCustomerCopy.summary,
        sourceIds: groundedCustomerCopy.sourceIds,
      },
      deliverables: plan.scopeItems.map((item, index) => {
        const evidence = deliverableEvidence[index];
        const sourceId = deliverableSourceIds[index];
        if (!evidence || !sourceId) {
          throw new UnverifiedProposalEvidenceError(
            `deliverable ${item.id} lacks exact evidence`,
          );
        }
        return {
          itemId: item.id,
          text: item.text,
          sourceIds: [sourceId],
          evidenceBasis: evidence.evidenceBasis,
        };
      }),
      requirements: contract.requirements.map((requirement) => ({
        itemId: requirement.requirementId,
        text: requirement.description,
        priority: requirement.priority,
        sourceIds: requirement.sourceIds,
        evidenceBasis: requirement.evidenceBasis,
        verificationBasis: requirement.verificationBasis,
      })),
      approvedFacts: contract.approvedFacts.map((fact, index) => {
        const evidence = factEvidence[index];
        if (!evidence) {
          throw new UnverifiedProposalEvidenceError(
            `fact ${fact.factId} lacks exact evidence`,
          );
        }
        return {
          itemId: fact.factId,
          text: fact.statement,
          sourceIds: fact.sourceIds,
          evidenceBasis: evidence.evidenceBasis,
        };
      }),
      assets: plan.assets,
      exclusions: plan.contractDraft.forbiddenClaims,
      unknowns: plan.clarificationQuestions,
    },
    quote: {
      amountMinor: quote.amountMinor,
      currency: quote.currency,
    },
    contract,
    createdAt: rawInput.createdAt,
  };
  return ProposalVersionSchema.parse({
    ...proposalContent,
    digest: proposalDigest(proposalContent),
  });
}

function deriveGroundedCustomerCopy(
  plan: ProposalPlan,
  deliverableSourceIds: string[],
  requirementSourceIds: string[],
): {
  title: string;
  summary: string;
  sourceIds: string[];
} {
  const firstDeliverable = plan.scopeItems[0]?.text;
  if (!firstDeliverable) {
    throw new UnverifiedProposalEvidenceError(
      "customer-facing copy requires at least one grounded deliverable",
    );
  }
  const candidates = [
    ...plan.contractDraft.requirements
      .map((requirement, index) => ({
        id: requirement.id,
        text: requirement.description,
        sourceId: requirementSourceIds[index],
      }))
      .filter((item) => item.id.startsWith("change-")),
    ...plan.scopeItems.map((item, index) => ({
      id: item.id,
      text: item.text,
      sourceId: deliverableSourceIds[index],
    })),
    ...plan.contractDraft.requirements
      .map((requirement, index) => ({
        id: requirement.id,
        text: requirement.description,
        sourceId: requirementSourceIds[index],
      }))
      .filter((item) => !item.id.startsWith("change-")),
  ];
  const selected: Array<{ text: string; sourceId: string }> = [];
  let summaryLength = 0;
  for (const candidate of candidates) {
    if (
      !candidate.sourceId ||
      selected.some((item) =>
        isSameExtractiveEvidence(item.text, candidate.text),
      )
    ) {
      continue;
    }
    const separatorLength = selected.length === 0 ? 0 : 1;
    if (
      selected.length >= 100 ||
      summaryLength + separatorLength + candidate.text.length > 20_000
    ) {
      continue;
    }
    selected.push({ text: candidate.text, sourceId: candidate.sourceId });
    summaryLength += separatorLength + candidate.text.length;
  }
  if (selected.length === 0) {
    throw new UnverifiedProposalEvidenceError(
      "customer-facing summary has no bounded grounded item",
    );
  }
  return {
    title:
      firstDeliverable.length <= 500
        ? firstDeliverable
        : `Evidence-backed project ${sha256(firstDeliverable).slice(0, 16)}`,
    summary: selected.map((item) => item.text).join("\n"),
    sourceIds: selected.map((item) => item.sourceId),
  };
}

function deriveEvidenceBoundBuildPrompt(plan: ProposalPlan): string {
  return [
    "Implement only this evidence-bound Acceptance Contract.",
    "",
    "DELIVERABLES:",
    ...plan.scopeItems.map((item) => `[${item.id}] ${item.text}`),
    "",
    "CUSTOMER REQUIREMENTS:",
    ...plan.contractDraft.requirements.map(
      (requirement) =>
        `[${requirement.id}] (${requirement.priority}) ${requirement.description}`,
    ),
    "",
    "APPROVED BUSINESS FACTS:",
    ...plan.contractDraft.approvedFacts.map(
      (fact) => `[${fact.id}] ${fact.statement}`,
    ),
    "",
    "FORBIDDEN CLAIMS:",
    ...plan.contractDraft.forbiddenClaims.map((claim) => `- ${claim}`),
    "",
    "Do not add scope, business claims, contact details, or instructions that are absent from the evidence-bound items above.",
  ].join("\n");
}

export function assertVerifiersDoNotBroadenEvidence(plan: ProposalPlan): void {
  const approvedEvidence = [
    ...plan.scopeItems.map((item) => item.text),
    ...plan.contractDraft.requirements.map(
      (requirement) => requirement.description,
    ),
    ...plan.contractDraft.approvedFacts.map((fact) => fact.statement),
  ].map((value) => value.toLocaleLowerCase("en-US"));
  const allowedCommands = new Set([
    plan.contractDraft.verification.buildCommand,
    ...plan.contractDraft.verification.testCommands,
    plan.contractDraft.verification.previewCommand,
  ]);
  for (const requirement of plan.contractDraft.requirements) {
    for (const verifier of requirement.verifiers) {
      if (
        verifier.kind === "semantic" &&
        !isSameExtractiveEvidence(requirement.description, verifier.criterion)
      ) {
        throw new UnverifiedProposalEvidenceError(
          `system verifier for requirement ${requirement.id} adds uncited semantic scope`,
        );
      }
      if (
        verifier.kind === "http" &&
        verifier.bodyIncludes.some(
          (expected) =>
            !approvedEvidence.some((evidence) =>
              evidence.includes(expected.toLocaleLowerCase("en-US")),
            ),
        )
      ) {
        throw new UnverifiedProposalEvidenceError(
          `system verifier for requirement ${requirement.id} asserts uncited response text`,
        );
      }
      if (
        verifier.kind === "command" &&
        !allowedCommands.has(verifier.command)
      ) {
        throw new UnverifiedProposalEvidenceError(
          `system verifier for requirement ${requirement.id} executes an unapproved policy command`,
        );
      }
    }
  }
}

export function assertRequirementPriorityGrounding(plan: ProposalPlan): void {
  for (const requirement of plan.contractDraft.requirements) {
    if (
      requirement.priority === "preference" &&
      (requirement.citation.kind !== "conversation" ||
        !hasExplicitPreferenceLanguage(requirement.citation.excerpt))
    ) {
      throw new UnverifiedProposalEvidenceError(
        `requirement ${requirement.id} may be a preference only when its exact customer citation explicitly says it is optional or preferred`,
      );
    }
  }
}

export function assertPlanContractCoverage(plan: ProposalPlan): void {
  for (const scopeItem of plan.scopeItems) {
    const covered = plan.contractDraft.requirements.some(
      (requirement) =>
        requirement.priority === "hard" &&
        requirement.verifiers.length > 0 &&
        isSameExtractiveEvidence(scopeItem.text, requirement.description) &&
        requirement.citation.kind === scopeItem.citation.kind &&
        isSameExtractiveEvidence(
          scopeItem.citation.excerpt,
          requirement.citation.excerpt,
        ),
    );
    if (!covered) {
      throw new UnverifiedProposalEvidenceError(
        `deliverable ${scopeItem.id} is not covered by an equal-evidence hard verified requirement`,
      );
    }
  }
}

function assertConversationAuthorizesContractItems(plan: ProposalPlan): void {
  const researchOnly =
    plan.scopeItems.find((item) => item.citation.kind === "research") ??
    plan.contractDraft.requirements.find(
      (requirement) => requirement.citation.kind === "research",
    ) ??
    plan.contractDraft.approvedFacts.find(
      (fact) => fact.citation.kind === "research",
    );
  if (!researchOnly) {
    return;
  }
  if ("statement" in researchOnly) {
    throw new UnconfirmedResearchEvidenceError(
      `research-only claim ${researchOnly.id} cannot become an approved business fact until the customer confirms it in the conversation`,
    );
  }
  const subject =
    "description" in researchOnly
      ? `requirement ${researchOnly.id}`
      : `deliverable ${researchOnly.id}`;
  throw new UnconfirmedResearchEvidenceError(
    `research-only evidence cannot authorize ${subject}; the customer must confirm it in the conversation`,
  );
}

function hasExplicitPreferenceLanguage(excerpt: string): boolean {
  return /\b(?:if\s+possible|nice[-\s]+to[-\s]+have|not\s+required|optional(?:ly)?|prefer(?:ence|red)?|would\s+be\s+nice)\b/iu.test(
    excerpt,
  );
}

export function assertQuoteEvidenceMatches(
  excerpt: string,
  amountMinor: number,
  currency: string,
): void {
  const normalizedEvidence = excerpt.toLocaleLowerCase();
  if (hasUnsupportedCheckoutTerms(normalizedEvidence)) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt contains commercial terms the current one-time Checkout model cannot represent",
    );
  }
  const hasPositiveAgreement =
    /\b(?:agreed?|accepted?|approved?|confirmed?|settled)\b/u.test(
      normalizedEvidence,
    );
  const hasRejectionOrCondition =
    /\b(?:cannot|can't|could not|declin(?:e|ed|ing)|reject(?:ed|ing)?|refus(?:e|ed|ing)|unless|if|provided that|subject to)\b/u.test(
      normalizedEvidence,
    );
  const hasTentativePriceLanguage =
    /\b(?:budget|consider(?:ed|ing)?|estimate(?:d)?|might|maybe|proposal|proposed|tentative|up to)\b/u.test(
      normalizedEvidence,
    );
  if (
    /\b(?:not|never|no|didn't|did not|haven't|have not|without)\b/u.test(
      normalizedEvidence,
    ) ||
    hasRejectionOrCondition ||
    (hasTentativePriceLanguage && !hasPositiveAgreement) ||
    !hasPositiveAgreement
  ) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt must explicitly and positively state an agreed price",
    );
  }
  const numericMatches = excerpt.match(/\d[\d,]*(?:\.\d{1,3})?/g);
  if (!numericMatches || numericMatches.length !== 1) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt has no single unambiguous numeric amount",
    );
  }
  const normalizedCurrency = currency.toLowerCase();
  const fractionDigits = currencyFractionDigits(normalizedCurrency);
  const normalizedNumber = numericMatches[0].replaceAll(",", "");
  const [wholePart, fractionPart = ""] = normalizedNumber.split(".");
  if (fractionPart.length > fractionDigits) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt has unsupported fractional precision",
    );
  }
  const parsedMinor =
    Number(wholePart) * 10 ** fractionDigits +
    Number(fractionPart.padEnd(fractionDigits, "0"));
  if (!Number.isSafeInteger(parsedMinor) || parsedMinor !== amountMinor) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt amount does not match the proposed minor-unit amount",
    );
  }
  const explicitCurrencies: Array<[RegExp, string]> = [
    [/\bUSD\b|\bUS dollars?\b|\bUnited States dollars?\b/i, "usd"],
    [/\bEUR\b|\beuros?\b/i, "eur"],
    [/\bGBP\b|\bBritish pounds?(?: sterling)?\b|\bpounds? sterling\b/i, "gbp"],
    [/\bJPY\b|\bJapanese yen\b/i, "jpy"],
    [/\bCAD\b|\bCanadian dollars?\b/i, "cad"],
    [/\bAUD\b|\bAustralian dollars?\b/i, "aud"],
  ];
  const detected = explicitCurrencies
    .filter(([pattern]) => pattern.test(excerpt))
    .map(([, code]) => code);
  if (
    detected.length === 0 ||
    detected.some((code) => code !== normalizedCurrency)
  ) {
    throw new UnverifiedQuoteEvidenceError(
      "the quote excerpt currency does not match the proposed currency",
    );
  }
}

function hasUnsupportedCheckoutTerms(excerpt: string): boolean {
  const recurringCadence =
    /\b(?:subscription|recurring|retainer|billing\s+cycle|auto[-\s]?renew(?:al|ing)?|renewal|daily|weekly|biweekly|fortnightly|monthly|quarterly|semiannual(?:ly)?|biannual(?:ly)?|annual(?:ly)?|yearly)\b|\b(?:per|each|every)\s+(?:day|week|month|quarter|year)\b|\/\s*(?:day|week|mo(?:nth)?|quarter|year|yr)\b|\b(?:day|week|month|year)[-\s]+to[-\s]+(?:day|week|month|year)\b/u;
  const stagedPayment =
    /\b(?:deposit|balance|down[-\s]?payment|instal{1,2}ments?|payment\s+plan|milestone\s+payments?|split\s+payments?|partial\s+payments?)\b/u;
  const excludedCharge =
    /(?:\b(?:plus|excluding|excluded|exclusive\s+of|before|subject\s+to|without)\b|\+)\s+(?:any\s+|applicable\s+|sales\s+|processing\s+|service\s+)?(?:tax(?:es)?|vat|fees?|charges?|surcharges?|expenses?|costs?)\b|\b(?:tax(?:es)?|vat|fees?|charges?|surcharges?|expenses?|costs?)\s+(?:are\s+)?(?:extra|additional|excluded|separate|not\s+included|due\s+later|may\s+apply|will\s+apply)\b|\b(?:additional|extra|separate)\s+(?:tax(?:es)?|vat|fees?|charges?|surcharges?|expenses?|costs?)\b/u;
  return (
    recurringCadence.test(excerpt) ||
    stagedPayment.test(excerpt) ||
    excludedCharge.test(excerpt)
  );
}

export function assertFactCitationEntails(
  statement: string,
  excerpt: string,
): void {
  assertExactExtractiveEvidence(statement, excerpt, "business fact");
}

export function assertExactExtractiveEvidence(
  statement: string,
  excerpt: string,
  subject = "proposal item",
): void {
  if (!isSameExtractiveEvidence(statement, excerpt)) {
    throw new UnverifiedProposalEvidenceError(
      `the ${subject} must be the same normalized extractive evidence as its citation`,
    );
  }
}

export function assertFactCitationIsStandalone(
  content: string,
  excerpt: string,
  startOffset: number,
): void {
  if (!isStandaloneEvidenceAt(content, excerpt, startOffset)) {
    throw new UnverifiedProposalEvidenceError(
      "the cited text is not a complete extractive sentence or line",
    );
  }
}

function hasStandaloneEvidence(content: string, excerpt: string): boolean {
  return findStandaloneEvidenceOffset(content, excerpt) >= 0;
}

export function assertNoUnsupportedAssetDependency(content: string): void {
  const asset =
    /\b(?:asset|favicon|font|icon|illustration|image|logo|photo|photograph|video)\b/i;
  if (!asset.test(content)) {
    return;
  }
  if (
    !/\b(?:do not|don't|no|without)\b.{0,40}\b(?:asset|favicon|font|icon|illustration|image|logo|photo|photograph|video)s?\b/i.test(
      content,
    )
  ) {
    throw new UnsupportedAssetEvidenceError();
  }
}

function currencyFractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    throw new UnverifiedQuoteEvidenceError("the quote currency is unsupported");
  }
}

function assertNoProtectedPii(
  plan: ProposalPlan,
  disallowedPiiValues: string[],
): void {
  assertTextHasNoProtectedPii(canonicalJson(plan), disallowedPiiValues);
}

function assertTextHasNoProtectedPii(
  value: string,
  disallowedPiiValues: string[],
): void {
  const buildText = value.toLocaleLowerCase();
  if (
    disallowedPiiValues.some((value) => {
      const normalized = value.trim().toLocaleLowerCase();
      return normalized.length >= 3 && buildText.includes(normalized);
    }) ||
    redactText(buildText) !== buildText
  ) {
    throw new PiiInBuildPlanError();
  }
}

function assertResearchHasNoPromptInjection(
  capture: WebsiteResearchCapture,
): void {
  const untrustedMetadataAndText = [
    capture.title,
    capture.publisher,
    capture.textExcerpt,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  if (
    /\b(?:ignore|disregard|override)\b.{0,80}\b(?:instruction|prompt|system|developer)\b/is.test(
      untrustedMetadataAndText,
    ) ||
    /\b(?:system|assistant|developer)\s*:/i.test(untrustedMetadataAndText)
  ) {
    throw new UnverifiedProposalEvidenceError(
      `research capture ${capture.url} contains prompt-like instructions`,
    );
  }
}

function assertResearchProvenance(capture: WebsiteResearchCapture): void {
  const requestedUrl = normalizeResearchUrl(capture.requestedUrl);
  const finalUrl = normalizeResearchUrl(capture.finalUrl);
  const compatibilityUrl = normalizeResearchUrl(capture.url);
  const redirectChain = capture.redirectChain.map(normalizeResearchUrl);
  if (
    finalUrl !== compatibilityUrl ||
    capture.retrievedAt !== capture.capturedAt ||
    Number.isNaN(Date.parse(capture.retrievedAt)) ||
    redirectChain.length === 0 ||
    redirectChain.length > 11 ||
    redirectChain[0] !== requestedUrl ||
    redirectChain.at(-1) !== finalUrl ||
    new Set(redirectChain).size !== redirectChain.length
  ) {
    throw new UnverifiedProposalEvidenceError(
      `research capture ${capture.url} has inconsistent retrieval provenance`,
    );
  }
  if (capture.canonicalUrl) {
    const canonicalUrl = normalizeResearchUrl(capture.canonicalUrl);
    if (!researchUrlsShareHostnameTree(requestedUrl, canonicalUrl)) {
      throw new UnverifiedProposalEvidenceError(
        `research capture ${capture.url} has an unrelated canonical URL`,
      );
    }
  }
  for (const [label, value, maximum] of [
    ["title", capture.title, 1_000],
    ["publisher", capture.publisher, 500],
  ] as const) {
    if (
      value !== undefined &&
      (value.length === 0 ||
        value.length > maximum ||
        value.trim() !== value ||
        hasControlCharacter(value))
    ) {
      throw new UnverifiedProposalEvidenceError(
        `research capture ${capture.url} has invalid ${label} metadata`,
      );
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeResearchUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnverifiedProposalEvidenceError(
      "research provenance contains an invalid URL",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.toString() !== value
  ) {
    throw new UnverifiedProposalEvidenceError(
      "research provenance contains a non-normalized or unsafe URL",
    );
  }
  return value;
}

function researchUrlsShareHostnameTree(
  leftValue: string,
  rightValue: string,
): boolean {
  const left = new URL(leftValue).hostname.toLowerCase();
  const right = new URL(rightValue).hostname.toLowerCase();
  return (
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
  );
}
