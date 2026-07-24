import { z } from "zod";

import { OutboxEventSchema } from "../../domain/artifact.js";
import { digestJson, sha256 } from "../../lib/canonical-json.js";

export const OrchestrationIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const OrchestrationSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CurrencySchema = z.string().regex(/^[a-z]{3}$/);
export const TimestampSchema = z.iso.datetime();

export const PiiCategorySchema = z.enum([
  "name",
  "email",
  "phone",
  "postal_address",
  "government_identifier",
  "financial",
  "account_identifier",
  "other_sensitive",
]);

export const PiiSpanSchema = z
  .object({
    category: PiiCategorySchema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    valueDigest: OrchestrationSha256Schema,
    confidence: z.number().min(0).max(1),
    handling: z.enum(["retain_in_profile", "tokenize", "discard"]),
  })
  .strict()
  .superRefine((span, context) => {
    if (span.endOffset <= span.startOffset) {
      context.addIssue({
        code: "custom",
        message: "PII endOffset must be greater than startOffset",
        path: ["endOffset"],
      });
    }
  });

const IntakeBaseFields = {
  intakeId: OrchestrationIdSchema,
  receivedAt: TimestampSchema,
  content: z.string().min(1).max(1_500_000),
  contentDigest: OrchestrationSha256Schema,
  piiSpans: z.array(PiiSpanSchema).max(5_000),
} as const;

const ProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const VoiceIntakeSchema = z
  .object({
    kind: z.literal("voice"),
    ...IntakeBaseFields,
    source: z
      .object({
        provider: z.literal("elevenlabs"),
        conversationId: OrchestrationIdSchema,
      })
      .strict(),
  })
  .strict();

export const EmailIntakeSchema = z
  .object({
    kind: z.literal("email"),
    ...IntakeBaseFields,
    subject: z.string().min(1).max(998).optional(),
    source: z
      .object({
        provider: ProviderSchema,
        providerMessageId: OrchestrationIdSchema,
        threadId: OrchestrationIdSchema.optional(),
        signatureVerified: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const TextIntakeSchema = z
  .object({
    kind: z.literal("text"),
    ...IntakeBaseFields,
    source: z
      .object({
        provider: ProviderSchema,
        providerMessageId: OrchestrationIdSchema,
        conversationId: OrchestrationIdSchema.optional(),
        signatureVerified: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const IntakeSchema = z
  .discriminatedUnion("kind", [
    VoiceIntakeSchema,
    EmailIntakeSchema,
    TextIntakeSchema,
  ])
  .superRefine((intake, context) => {
    if (sha256(intake.content) !== intake.contentDigest) {
      context.addIssue({
        code: "custom",
        message: "Intake contentDigest does not match content",
        path: ["contentDigest"],
      });
    }

    for (const [index, span] of intake.piiSpans.entries()) {
      if (span.endOffset > intake.content.length) {
        context.addIssue({
          code: "custom",
          message: "PII span exceeds intake content",
          path: ["piiSpans", index, "endOffset"],
        });
        continue;
      }
      const value = intake.content.slice(span.startOffset, span.endOffset);
      if (sha256(value) !== span.valueDigest) {
        context.addIssue({
          code: "custom",
          message: "PII valueDigest does not match the referenced content",
          path: ["piiSpans", index, "valueDigest"],
        });
      }
    }
  });

export const ContactEmailSchema = z
  .object({
    value: z.email(),
    verified: z.boolean(),
    verifiedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((email, context) => {
    if (email.verified && !email.verifiedAt) {
      context.addIssue({
        code: "custom",
        message: "verifiedAt is required for a verified email",
        path: ["verifiedAt"],
      });
    }
  });

export const ContactPhoneSchema = z
  .object({
    value: z.string().min(3).max(64),
    verified: z.boolean(),
    verifiedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((phone, context) => {
    if (phone.verified && !phone.verifiedAt) {
      context.addIssue({
        code: "custom",
        message: "verifiedAt is required for a verified phone",
        path: ["verifiedAt"],
      });
    }
  });

export const ResearchConsentSchema = z
  .object({
    granted: z.boolean(),
    scope: z.literal("own_business_only"),
    capturedAt: TimestampSchema.optional(),
    sourceIntakeId: OrchestrationIdSchema.optional(),
  })
  .strict()
  .superRefine((consent, context) => {
    if (consent.granted && (!consent.capturedAt || !consent.sourceIntakeId)) {
      context.addIssue({
        code: "custom",
        message:
          "Granted research consent requires capturedAt and sourceIntakeId",
      });
    }
  });

export const CustomerProfileSchema = z
  .object({
    profileId: OrchestrationIdSchema,
    displayName: z.string().min(1).max(300).optional(),
    email: ContactEmailSchema.optional(),
    phone: ContactPhoneSchema.optional(),
    organizationName: z.string().min(1).max(500).optional(),
    preferredChannel: z.enum(["email", "text", "voice"]).optional(),
    researchConsent: ResearchConsentSchema,
  })
  .strict();

export const IntakeProposalSourceSchema = z
  .object({
    sourceId: OrchestrationIdSchema,
    kind: z.literal("intake"),
    intakeId: OrchestrationIdSchema,
    contentDigest: OrchestrationSha256Schema,
    minimizedContentDigest: OrchestrationSha256Schema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    excerpt: z.string().min(1).max(1_500_000),
    excerptDigest: OrchestrationSha256Schema,
  })
  .strict()
  .superRefine((source, context) => {
    if (source.endOffset <= source.startOffset) {
      context.addIssue({
        code: "custom",
        message: "Source endOffset must be greater than startOffset",
        path: ["endOffset"],
      });
    }
    if (source.endOffset - source.startOffset !== source.excerpt.length) {
      context.addIssue({
        code: "custom",
        message: "Source offsets must span the exact minimized excerpt",
        path: ["excerpt"],
      });
    }
    if (sha256(source.excerpt) !== source.excerptDigest) {
      context.addIssue({
        code: "custom",
        message: "Source excerptDigest does not match excerpt",
        path: ["excerptDigest"],
      });
    }
  });

const ResearchHttpsUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hash.length === 0
  );
}, "Research provenance URLs must be normalized credential-free HTTPS URLs");

const ResearchMetadataTextSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !hasControlCharacter(value),
    "Research metadata must be bounded single-line text",
  );

export const ResearchProposalSourceSchema = z
  .object({
    sourceId: OrchestrationIdSchema,
    kind: z.literal("research"),
    url: ResearchHttpsUrlSchema,
    requestedUrl: ResearchHttpsUrlSchema,
    finalUrl: ResearchHttpsUrlSchema,
    redirectChain: z.array(ResearchHttpsUrlSchema).min(1).max(11),
    canonicalUrl: ResearchHttpsUrlSchema.optional(),
    title: ResearchMetadataTextSchema.max(1_000).optional(),
    publisher: ResearchMetadataTextSchema.max(500).optional(),
    capturedAt: TimestampSchema,
    retrievedAt: TimestampSchema,
    captureDigest: OrchestrationSha256Schema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    excerpt: z.string().min(1).max(10_000),
    excerptDigest: OrchestrationSha256Schema,
    promptInjectionChecked: z.literal(true),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.endOffset <= source.startOffset) {
      context.addIssue({
        code: "custom",
        message: "Research endOffset must be greater than startOffset",
        path: ["endOffset"],
      });
    }
    if (source.endOffset - source.startOffset !== source.excerpt.length) {
      context.addIssue({
        code: "custom",
        message: "Research offsets must span the exact excerpt",
        path: ["excerpt"],
      });
    }
    if (source.url !== source.finalUrl) {
      context.addIssue({
        code: "custom",
        message: "Research url compatibility alias must equal finalUrl",
        path: ["url"],
      });
    }
    if (source.capturedAt !== source.retrievedAt) {
      context.addIssue({
        code: "custom",
        message:
          "Research capturedAt compatibility alias must equal retrievedAt",
        path: ["capturedAt"],
      });
    }
    if (source.redirectChain[0] !== source.requestedUrl) {
      context.addIssue({
        code: "custom",
        message: "Research redirect chain must begin with requestedUrl",
        path: ["redirectChain", 0],
      });
    }
    if (source.redirectChain.at(-1) !== source.finalUrl) {
      context.addIssue({
        code: "custom",
        message: "Research redirect chain must end with finalUrl",
        path: ["redirectChain", source.redirectChain.length - 1],
      });
    }
    if (new Set(source.redirectChain).size !== source.redirectChain.length) {
      context.addIssue({
        code: "custom",
        message: "Research redirect chain cannot contain a loop",
        path: ["redirectChain"],
      });
    }
    if (
      source.canonicalUrl &&
      !researchUrlsShareHostnameTree(source.requestedUrl, source.canonicalUrl)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Research canonicalUrl is outside the authorized hostname tree",
        path: ["canonicalUrl"],
      });
    }
    if (sha256(source.excerpt) !== source.excerptDigest) {
      context.addIssue({
        code: "custom",
        message: "Research excerptDigest does not match excerpt",
        path: ["excerptDigest"],
      });
    }
  });

export const MessageProposalSourceSchema = z
  .object({
    sourceId: OrchestrationIdSchema,
    kind: z.literal("customer_message"),
    messageId: OrchestrationIdSchema,
    contentDigest: OrchestrationSha256Schema,
    minimizedContentDigest: OrchestrationSha256Schema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    excerpt: z.string().min(1).max(1_500_000),
    excerptDigest: OrchestrationSha256Schema,
  })
  .strict()
  .superRefine((source, context) => {
    if (source.endOffset <= source.startOffset) {
      context.addIssue({
        code: "custom",
        message: "Source endOffset must be greater than startOffset",
        path: ["endOffset"],
      });
    }
    if (source.endOffset - source.startOffset !== source.excerpt.length) {
      context.addIssue({
        code: "custom",
        message: "Source offsets must span the exact minimized excerpt",
        path: ["excerpt"],
      });
    }
    if (sha256(source.excerpt) !== source.excerptDigest) {
      context.addIssue({
        code: "custom",
        message: "Source excerptDigest does not match excerpt",
        path: ["excerptDigest"],
      });
    }
  });

export const ProposalSourceSchema = z.discriminatedUnion("kind", [
  IntakeProposalSourceSchema,
  ResearchProposalSourceSchema,
  MessageProposalSourceSchema,
]);

export type ProposalSource = z.infer<typeof ProposalSourceSchema>;

export const EvidenceBasisSchema = z.enum([
  "customer_conversation",
  "confirmed_research",
]);

export const SourcedTextSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    sourceIds: z.array(OrchestrationIdSchema).min(1).max(100),
  })
  .strict();

export const SourcedPlanItemSchema = z
  .object({
    itemId: OrchestrationIdSchema,
    text: z.string().min(1).max(10_000),
    sourceIds: z.array(OrchestrationIdSchema).min(1).max(100),
    evidenceBasis: EvidenceBasisSchema,
  })
  .strict();

export const SourcedRequirementSchema = SourcedPlanItemSchema.extend({
  priority: z.enum(["hard", "preference"]),
  verificationBasis: z.literal("system_policy"),
}).strict();

export const SourcedAssetSchema = z
  .object({
    assetId: OrchestrationIdSchema,
    url: z.url(),
    description: z.string().min(1).max(2_000),
    sourceIds: z.array(OrchestrationIdSchema).min(1).max(100),
  })
  .strict();

export const SourcedProposalPlanSchema = z
  .object({
    summary: SourcedTextSchema,
    deliverables: z.array(SourcedPlanItemSchema).min(1).max(500),
    requirements: z.array(SourcedRequirementSchema).min(1).max(500),
    approvedFacts: z.array(SourcedPlanItemSchema).max(500),
    assets: z.array(SourcedAssetSchema).max(500),
    exclusions: z.array(z.string().min(1).max(5_000)).max(500),
    unknowns: z.array(z.string().min(1).max(5_000)).max(500),
  })
  .strict();

export const MoneyQuoteSchema = z
  .object({
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: CurrencySchema,
  })
  .strict();

export type MoneyQuote = z.infer<typeof MoneyQuoteSchema>;

export const ContractCommandVerifierSchema = z
  .object({
    kind: z.literal("command"),
    command: z.string().min(1).max(2_000),
    timeoutSeconds: z.number().int().min(1).max(900),
  })
  .strict();

export const ContractHttpVerifierSchema = z
  .object({
    kind: z.literal("http"),
    path: z
      .string()
      .min(1)
      .max(1_000)
      .refine(
        (path) =>
          path.startsWith("/") &&
          !path.startsWith("//") &&
          !path.includes("\\"),
        "HTTP verifier path must be origin-relative",
      ),
    expectedStatus: z.number().int().min(100).max(599),
    bodyIncludes: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

export const ContractSemanticVerifierSchema = z
  .object({
    kind: z.literal("semantic"),
    criterion: z.string().min(1).max(2_000),
  })
  .strict();

export const ContractVerifierSchema = z.discriminatedUnion("kind", [
  ContractCommandVerifierSchema,
  ContractHttpVerifierSchema,
  ContractSemanticVerifierSchema,
]);

export const ContractApprovedFactSchema = z
  .object({
    factId: OrchestrationIdSchema,
    statement: z.string().min(1).max(2_000),
    sourceIds: z.array(OrchestrationIdSchema).min(1).max(100),
  })
  .strict();

export const ContractRequirementSchema = z
  .object({
    requirementId: OrchestrationIdSchema,
    description: z.string().min(1).max(2_000),
    priority: z.enum(["hard", "preference"]),
    sourceIds: z.array(OrchestrationIdSchema).min(1).max(100),
    evidenceBasis: EvidenceBasisSchema,
    verificationBasis: z.literal("system_policy"),
    verifiers: z.array(ContractVerifierSchema).max(20),
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

const AcceptanceContractContentFieldsSchema = z
  .object({
    contractId: OrchestrationIdSchema,
    projectId: OrchestrationIdSchema,
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive().optional(),
    approvedFacts: z.array(ContractApprovedFactSchema).max(500),
    forbiddenClaims: z.array(z.string().min(1).max(2_000)).max(500),
    requirements: z.array(ContractRequirementSchema).min(1).max(500),
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
    createdAt: TimestampSchema,
  })
  .strict();

type AcceptanceContractContentFields = z.infer<
  typeof AcceptanceContractContentFieldsSchema
>;

function validateAcceptanceContract(
  contract: AcceptanceContractContentFields,
  context: z.RefinementCtx,
): void {
  if (contract.version === 1 && contract.parentVersion !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Acceptance Contract version 1 cannot have a parentVersion",
      path: ["parentVersion"],
    });
  }
  if (contract.version > 1 && contract.parentVersion !== contract.version - 1) {
    context.addIssue({
      code: "custom",
      message:
        "A revised Acceptance Contract must reference the immediately prior version",
      path: ["parentVersion"],
    });
  }

  const factIds = new Set<string>();
  for (const [index, fact] of contract.approvedFacts.entries()) {
    if (factIds.has(fact.factId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate approved fact id: ${fact.factId}`,
        path: ["approvedFacts", index, "factId"],
      });
    }
    factIds.add(fact.factId);
  }

  const requirementIds = new Set<string>();
  for (const [index, requirement] of contract.requirements.entries()) {
    if (requirementIds.has(requirement.requirementId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate requirement id: ${requirement.requirementId}`,
        path: ["requirements", index, "requirementId"],
      });
    }
    requirementIds.add(requirement.requirementId);
  }
}

export const AcceptanceContractContentSchema =
  AcceptanceContractContentFieldsSchema.superRefine(validateAcceptanceContract);

export type AcceptanceContractContent = z.infer<
  typeof AcceptanceContractContentSchema
>;

export function acceptanceContractDigest(
  input: AcceptanceContractContent,
): string {
  return digestJson(AcceptanceContractContentSchema.parse(input));
}

export const OrchestrationAcceptanceContractSchema =
  AcceptanceContractContentFieldsSchema.extend({
    digest: OrchestrationSha256Schema,
  })
    .strict()
    .superRefine((contract, context) => {
      validateAcceptanceContract(contract, context);
      const { digest, ...content } = contract;
      if (digestJson(content) !== digest) {
        context.addIssue({
          code: "custom",
          message:
            "Acceptance Contract digest does not match its immutable contents",
          path: ["digest"],
        });
      }
    });

export type OrchestrationAcceptanceContract = z.infer<
  typeof OrchestrationAcceptanceContractSchema
>;

const ProposalVersionContentFieldsSchema = z
  .object({
    proposalId: OrchestrationIdSchema,
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive().optional(),
    commercialBasisVersion: z.number().int().positive().optional(),
    changeRationale: z.string().min(1).max(10_000).optional(),
    projectTitle: z.string().min(1).max(500),
    buildPrompt: z.string().min(1).max(100_000),
    strategyLabels: z.array(z.string().min(1).max(200)).min(1).max(4),
    sources: z.array(ProposalSourceSchema).min(1).max(2_000),
    plan: SourcedProposalPlanSchema,
    quote: MoneyQuoteSchema,
    contract: OrchestrationAcceptanceContractSchema,
    createdAt: TimestampSchema,
  })
  .strict();

type ProposalVersionContentFields = z.infer<
  typeof ProposalVersionContentFieldsSchema
>;

function validateProposalContent(
  proposal: ProposalVersionContentFields,
  context: z.RefinementCtx,
): void {
  if (proposal.version === 1 && proposal.parentVersion !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Proposal version 1 cannot have a parentVersion",
      path: ["parentVersion"],
    });
  }
  if (proposal.version > 1 && proposal.parentVersion !== proposal.version - 1) {
    context.addIssue({
      code: "custom",
      message:
        "A revised proposal must reference the immediately prior version",
      path: ["parentVersion"],
    });
  }
  if (
    proposal.commercialBasisVersion !== undefined &&
    proposal.commercialBasisVersion >= proposal.version
  ) {
    context.addIssue({
      code: "custom",
      message:
        "A commercial basis must reference an earlier paid proposal version",
      path: ["commercialBasisVersion"],
    });
  }
  if (proposal.contract.version !== proposal.version) {
    context.addIssue({
      code: "custom",
      message: "Proposal and Acceptance Contract versions must match",
      path: ["contract", "version"],
    });
  }

  const sourceIds = new Set<string>();
  for (const [index, source] of proposal.sources.entries()) {
    if (sourceIds.has(source.sourceId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate proposal sourceId: ${source.sourceId}`,
        path: ["sources", index, "sourceId"],
      });
    }
    sourceIds.add(source.sourceId);
  }

  const conversationSources = proposal.sources.filter(
    (source) => source.kind === "intake" || source.kind === "customer_message",
  );
  const evidenceDigestsByOrigin = new Map<string, string>();
  for (const [index, source] of conversationSources.entries()) {
    const origin =
      source.kind === "intake"
        ? `intake:${source.intakeId}`
        : `customer_message:${source.messageId}`;
    const evidenceDigests = `${source.contentDigest}:${source.minimizedContentDigest}`;
    const priorEvidenceDigests = evidenceDigestsByOrigin.get(origin);
    if (
      priorEvidenceDigests !== undefined &&
      priorEvidenceDigests !== evidenceDigests
    ) {
      context.addIssue({
        code: "custom",
        message:
          "One conversation origin cannot have conflicting evidence digests",
        path: ["sources", index, "minimizedContentDigest"],
      });
    }
    evidenceDigestsByOrigin.set(origin, evidenceDigests);
    const fullSource = conversationSources.find(
      (candidate) =>
        sameConversationOrigin(candidate, source) &&
        candidate.contentDigest === source.contentDigest &&
        candidate.minimizedContentDigest === source.minimizedContentDigest &&
        candidate.startOffset === 0 &&
        candidate.endOffset >= source.endOffset &&
        candidate.endOffset === candidate.excerpt.length &&
        candidate.excerptDigest === candidate.minimizedContentDigest,
    );
    if (!fullSource) {
      context.addIssue({
        code: "custom",
        message:
          "Conversation evidence has no digest-bound full minimized source",
        path: ["sources", index],
      });
      continue;
    }
    if (
      fullSource.excerpt.slice(source.startOffset, source.endOffset) !==
      source.excerpt
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Conversation evidence offsets do not resolve in the full minimized source",
        path: ["sources", index, "excerpt"],
      });
    }
  }

  const researchSources = proposal.sources.filter(
    (source) => source.kind === "research",
  );
  for (const [index, source] of researchSources.entries()) {
    const fullSource = researchSources.find(
      (candidate) =>
        sameResearchProvenance(candidate, source) &&
        candidate.captureDigest === source.captureDigest &&
        candidate.startOffset === 0 &&
        candidate.endOffset >= source.endOffset &&
        candidate.endOffset === candidate.excerpt.length &&
        candidate.excerptDigest === candidate.captureDigest,
    );
    if (!fullSource) {
      context.addIssue({
        code: "custom",
        message: "Research evidence has no digest-bound full capture",
        path: ["sources", index],
      });
      continue;
    }
    if (
      fullSource.excerpt.slice(source.startOffset, source.endOffset) !==
      source.excerpt
    ) {
      context.addIssue({
        code: "custom",
        message: "Research evidence offsets do not resolve in the full capture",
        path: ["sources", index, "excerpt"],
      });
    }
  }

  const sourcedValues = [
    proposal.plan.summary,
    ...proposal.plan.deliverables,
    ...proposal.plan.requirements,
    ...proposal.plan.approvedFacts,
    ...proposal.plan.assets,
    ...proposal.contract.approvedFacts,
    ...proposal.contract.requirements,
  ];
  for (const [valueIndex, value] of sourcedValues.entries()) {
    for (const sourceId of value.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        context.addIssue({
          code: "custom",
          message: `Unknown proposal sourceId: ${sourceId}`,
          path: ["plan", valueIndex, "sourceIds"],
        });
      }
    }
  }

  const evidenceBoundItems = [
    ...proposal.plan.deliverables,
    ...proposal.plan.requirements,
    ...proposal.contract.requirements,
  ];
  const sourceById = new Map(
    proposal.sources.map((source) => [source.sourceId, source]),
  );
  for (const [index, item] of evidenceBoundItems.entries()) {
    const sourceKinds = item.sourceIds
      .map((sourceId) => sourceById.get(sourceId)?.kind)
      .filter((kind): kind is ProposalSource["kind"] => kind !== undefined);
    const expectedKinds =
      item.evidenceBasis === "customer_conversation"
        ? new Set<ProposalSource["kind"]>(["intake", "customer_message"])
        : new Set<ProposalSource["kind"]>(["research"]);
    if (
      sourceKinds.length !== item.sourceIds.length ||
      sourceKinds.some((kind) => !expectedKinds.has(kind))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Proposal item evidenceBasis does not match its exact source kind",
        path: ["plan", index, "evidenceBasis"],
      });
    }
  }

  for (const [collectionName, items] of [
    ["deliverables", proposal.plan.deliverables],
    ["requirements", proposal.plan.requirements],
  ] as const) {
    const itemIds = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (itemIds.has(item.itemId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate ${collectionName} item id: ${item.itemId}`,
          path: ["plan", collectionName, index, "itemId"],
        });
      }
      itemIds.add(item.itemId);
    }
  }

  if (
    new Set(proposal.strategyLabels).size !== proposal.strategyLabels.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Proposal strategyLabels must be unique",
      path: ["strategyLabels"],
    });
  }
}

function sameConversationOrigin(
  left:
    | z.infer<typeof IntakeProposalSourceSchema>
    | z.infer<typeof MessageProposalSourceSchema>,
  right:
    | z.infer<typeof IntakeProposalSourceSchema>
    | z.infer<typeof MessageProposalSourceSchema>,
): boolean {
  return left.kind === "intake" && right.kind === "intake"
    ? left.intakeId === right.intakeId
    : left.kind === "customer_message" && right.kind === "customer_message"
      ? left.messageId === right.messageId
      : false;
}

function sameResearchProvenance(
  left: z.infer<typeof ResearchProposalSourceSchema>,
  right: z.infer<typeof ResearchProposalSourceSchema>,
): boolean {
  return (
    left.url === right.url &&
    left.requestedUrl === right.requestedUrl &&
    left.finalUrl === right.finalUrl &&
    left.capturedAt === right.capturedAt &&
    left.retrievedAt === right.retrievedAt &&
    left.title === right.title &&
    left.publisher === right.publisher &&
    left.canonicalUrl === right.canonicalUrl &&
    left.redirectChain.length === right.redirectChain.length &&
    left.redirectChain.every(
      (value, index) => value === right.redirectChain[index],
    )
  );
}

function researchUrlsShareHostnameTree(leftValue: string, rightValue: string) {
  const left = new URL(leftValue).hostname.toLowerCase();
  const right = new URL(rightValue).hostname.toLowerCase();
  return (
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)
  );
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

export const ProposalVersionContentSchema =
  ProposalVersionContentFieldsSchema.superRefine(validateProposalContent);

export type ProposalVersionContent = z.infer<
  typeof ProposalVersionContentSchema
>;

export function proposalDigest(input: ProposalVersionContent): string {
  return digestJson(ProposalVersionContentSchema.parse(input));
}

export const ProposalVersionSchema = ProposalVersionContentFieldsSchema.extend({
  digest: OrchestrationSha256Schema,
})
  .strict()
  .superRefine((proposal, context) => {
    validateProposalContent(proposal, context);
    const { digest, ...content } = proposal;
    if (digestJson(content) !== digest) {
      context.addIssue({
        code: "custom",
        message: "Proposal digest does not match its immutable contents",
        path: ["digest"],
      });
    }
  });

export type ProposalVersion = z.infer<typeof ProposalVersionSchema>;

export const CheckoutSessionSchema = z
  .object({
    sessionId: OrchestrationIdSchema,
    provider: z.literal("stripe"),
    projectId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: CurrencySchema,
    url: z.url(),
    status: z.enum(["open", "complete", "expired", "cancelled"]),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const PaymentReceiptSchema = z
  .object({
    receiptId: OrchestrationIdSchema,
    provider: z.literal("stripe"),
    providerEventId: OrchestrationIdSchema,
    providerEvidenceDigest: OrchestrationSha256Schema,
    checkoutSessionId: OrchestrationIdSchema,
    paymentIntentId: OrchestrationIdSchema,
    projectId: OrchestrationIdSchema,
    proposalId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    amountReceivedMinor: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    currency: CurrencySchema,
    customerEmailDigest: OrchestrationSha256Schema,
    customerId: OrchestrationIdSchema.nullable(),
    checkoutStatus: z.literal("complete"),
    paymentStatus: z.literal("paid"),
    paymentIntentStatus: z.literal("succeeded"),
    paymentIntentCreatedAt: TimestampSchema,
    status: z.literal("paid"),
    verificationSource: z.enum(["signed_webhook", "provider_api"]),
    providerStateVerified: z.literal(true),
    signatureVerified: z.boolean(),
    signedEventDigest: OrchestrationSha256Schema.optional(),
    paidAt: TimestampSchema,
    verifiedAt: TimestampSchema,
    livemode: z.boolean(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.signatureVerified !==
        (receipt.verificationSource === "signed_webhook") ||
      receipt.signatureVerified !== (receipt.signedEventDigest !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Payment signature evidence must truthfully match its source and signed-event digest",
        path: ["signatureVerified"],
      });
    }
  });

export const BuildRunIdentitySchema = z
  .object({
    runId: OrchestrationIdSchema,
    candidateId: OrchestrationIdSchema,
    assignmentId: OrchestrationIdSchema,
    status: z.enum([
      "queued",
      "running",
      "passed",
      "rejected",
      "failed",
      "cancelled",
    ]),
  })
  .strict();

export const BuildBatchSchema = z
  .object({
    batchId: OrchestrationIdSchema,
    projectId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    paymentReceiptId: OrchestrationIdSchema,
    paymentProposalVersion: z.number().int().positive(),
    contractVersion: z.number().int().positive(),
    contractDigest: OrchestrationSha256Schema,
    buildContractHash: OrchestrationSha256Schema,
    requestedCandidateCount: z.number().int().min(1).max(4),
    runs: z.array(BuildRunIdentitySchema).max(4),
    buildDeadlineAt: TimestampSchema.optional(),
    proofEventDeadlineAt: TimestampSchema.optional(),
    status: z.enum([
      "pending",
      "dispatched",
      "building",
      "verifying",
      "completed",
      "failed",
      "cancelled",
    ]),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.runs.length > batch.requestedCandidateCount) {
      context.addIssue({
        code: "custom",
        message: "Build batch has more runs than requested candidates",
        path: ["runs"],
      });
    }
    if (
      batch.buildDeadlineAt !== undefined &&
      Date.parse(batch.buildDeadlineAt) <= Date.parse(batch.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Build deadline must be later than batch creation",
        path: ["buildDeadlineAt"],
      });
    }
    if (
      batch.proofEventDeadlineAt !== undefined &&
      Date.parse(batch.proofEventDeadlineAt) < Date.parse(batch.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Proof-event deadline cannot predate batch creation",
        path: ["proofEventDeadlineAt"],
      });
    }
    const runIds = new Set<string>();
    const candidateIds = new Set<string>();
    for (const [index, run] of batch.runs.entries()) {
      if (runIds.has(run.runId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate build run id: ${run.runId}`,
          path: ["runs", index, "runId"],
        });
      }
      if (candidateIds.has(run.candidateId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate candidate id: ${run.candidateId}`,
          path: ["runs", index, "candidateId"],
        });
      }
      runIds.add(run.runId);
      candidateIds.add(run.candidateId);
    }
  });

export const ProvenCandidateSchema = z
  .object({
    batchId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    event: OutboxEventSchema,
    receivedAt: TimestampSchema,
  })
  .strict();

export const PreviewReceiptSchema = z
  .object({
    receiptId: OrchestrationIdSchema,
    provider: z.literal("daytona"),
    projectId: OrchestrationIdSchema,
    batchId: OrchestrationIdSchema,
    runId: OrchestrationIdSchema,
    candidateId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    revisionHash: OrchestrationSha256Schema,
    artifactDigest: OrchestrationSha256Schema,
    snapshotId: z.string().min(1).max(512),
    url: z.url(),
    expiresAt: TimestampSchema,
    immutable: z.literal(true),
    httpsHealthy: z.literal(true),
    createdAt: TimestampSchema,
    verifiedAt: TimestampSchema,
  })
  .strict();

export const DeploymentReceiptSchema = z
  .object({
    receiptId: OrchestrationIdSchema,
    provider: z.literal("fly"),
    projectId: OrchestrationIdSchema,
    batchId: OrchestrationIdSchema,
    runId: OrchestrationIdSchema,
    candidateId: OrchestrationIdSchema,
    proposalVersion: z.number().int().positive(),
    proposalDigest: OrchestrationSha256Schema,
    revisionHash: OrchestrationSha256Schema,
    artifactDigest: OrchestrationSha256Schema,
    releaseId: OrchestrationIdSchema,
    releaseKey: OrchestrationSha256Schema,
    releaseVersion: z.number().int().positive(),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    workspaceDigest: OrchestrationSha256Schema,
    machineIds: z.array(OrchestrationIdSchema).min(1).max(1_000),
    machineInstanceIds: z.array(OrchestrationIdSchema).min(1).max(1_000),
    deploymentAttempted: z.boolean(),
    recoveredFromProvider: z.boolean(),
    url: z.url(),
    httpsHealthy: z.literal(true),
    deployedAt: TimestampSchema,
    releaseVerifiedAt: TimestampSchema,
    verifiedAt: TimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.machineIds.length !== receipt.machineInstanceIds.length ||
      new Set(receipt.machineIds).size !== receipt.machineIds.length ||
      new Set(receipt.machineInstanceIds).size !==
        receipt.machineInstanceIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Fly machine identities must be unique one-to-one pairs",
        path: ["machineIds"],
      });
    }
    if (
      Date.parse(receipt.releaseVerifiedAt) < Date.parse(receipt.deployedAt) ||
      Date.parse(receipt.verifiedAt) < Date.parse(receipt.releaseVerifiedAt)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Deployment, release verification, and health verification timestamps are out of order",
        path: ["verifiedAt"],
      });
    }
  });

export const MessagePurposeSchema = z.enum([
  "intake",
  "email_verification",
  "clarification",
  "proposal",
  "customer_revision",
  "payment_confirmation",
  "dashboard_access",
  "proven_preview",
  "steering",
  "final_delivery",
  "operator_notice",
]);

export const ProjectMessageSchema = z
  .object({
    messageId: OrchestrationIdSchema,
    direction: z.enum(["inbound", "outbound"]),
    channel: z.enum(["dashboard", "email", "text", "voice"]),
    purpose: MessagePurposeSchema,
    provider: ProviderSchema,
    providerMessageId: OrchestrationIdSchema.optional(),
    rfcMessageId: OrchestrationIdSchema.optional(),
    threadId: OrchestrationIdSchema.optional(),
    inReplyTo: OrchestrationIdSchema.optional(),
    references: z.array(OrchestrationIdSchema).max(500),
    subject: z.string().min(1).max(998).optional(),
    content: z.string().min(1).max(1_500_000),
    contentDigest: OrchestrationSha256Schema,
    senderAuthenticated: z.boolean(),
    deliveryStatus: z.enum([
      "received",
      "pending",
      "sent",
      "delivered",
      "bounced",
      "failed",
    ]),
    createdAt: TimestampSchema,
    deliveryUpdatedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (sha256(message.content) !== message.contentDigest) {
      context.addIssue({
        code: "custom",
        message: "Message contentDigest does not match content",
        path: ["contentDigest"],
      });
    }
    if (
      message.direction === "outbound" &&
      message.channel === "email" &&
      message.provider === "resend" &&
      (!message.rfcMessageId ||
        !/^resend-message:[A-Za-z0-9_-]+$/.test(message.rfcMessageId))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Outbound Resend mail requires a reversible persisted RFC Message-ID",
        path: ["rfcMessageId"],
      });
    }
    if (
      ["delivered", "bounced", "failed"].includes(message.deliveryStatus) &&
      !message.deliveryUpdatedAt
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Terminal mail delivery status requires its provider timestamp",
        path: ["deliveryUpdatedAt"],
      });
    }
  });

export const OrchestrationErrorSchema = z
  .object({
    errorId: OrchestrationIdSchema,
    code: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    category: z.enum(["transient", "permanent", "policy", "security"]),
    message: z.string().min(1).max(20_000),
    retryable: z.boolean(),
    effectKey: IdempotencyKeySchema.optional(),
    occurredAt: TimestampSchema,
  })
  .strict();

export const EffectTypeSchema = z.enum([
  "research_business",
  "send_email_verification",
  "send_dashboard_login",
  "send_clarification",
  "create_checkout_session",
  "expire_checkout_session",
  "send_proposal",
  "reconcile_payment",
  "send_payment_confirmation",
  "send_dashboard_access",
  "send_steering_acknowledgement",
  "dispatch_build_batch",
  "cancel_build_run",
  "acknowledge_proven_event",
  "materialize_proven_preview",
  "refresh_proven_preview",
  "send_proven_preview",
  "reconcile_mail_delivery",
  "deploy_proven_candidate",
  "verify_deployment",
  "persist_proof_summary_snapshot",
  "send_final_delivery",
]);

export const DurableEffectSchema = z
  .object({
    key: IdempotencyKeySchema,
    type: EffectTypeSchema,
    status: z.enum(["pending", "completed", "failed"]),
    attempts: z.number().int().nonnegative(),
    inputDigest: OrchestrationSha256Schema,
    providerId: OrchestrationIdSchema.optional(),
    receiptDigest: OrchestrationSha256Schema.optional(),
    proofSnapshotId: OrchestrationIdSchema.optional(),
    proofSnapshotDigest: OrchestrationSha256Schema.optional(),
    error: OrchestrationErrorSchema.optional(),
    nextAttemptAt: TimestampSchema.optional(),
    nextCheckAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    completedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((effect, context) => {
    if (effect.status === "completed" && !effect.completedAt) {
      context.addIssue({
        code: "custom",
        message: "A completed effect requires completedAt",
        path: ["completedAt"],
      });
    }
    if (effect.status === "failed" && !effect.error) {
      context.addIssue({
        code: "custom",
        message: "A failed effect requires an error",
        path: ["error"],
      });
    }
    if (effect.status !== "pending" && effect.nextAttemptAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a pending effect may have a next retry time",
        path: ["nextAttemptAt"],
      });
    }
    if (effect.nextAttemptAt !== undefined && !effect.error) {
      context.addIssue({
        code: "custom",
        message: "A scheduled retry requires its last safe error",
        path: ["error"],
      });
    }
    if (effect.status !== "pending" && effect.nextCheckAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a pending effect may have a next provider check time",
        path: ["nextCheckAt"],
      });
    }
    if (
      effect.nextAttemptAt !== undefined &&
      effect.nextCheckAt !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A failed retry and a healthy provider recheck cannot be scheduled together",
        path: ["nextCheckAt"],
      });
    }
    const proofBoundEffect =
      effect.type === "persist_proof_summary_snapshot" ||
      effect.type === "send_final_delivery";
    if (
      effect.type === "persist_proof_summary_snapshot" &&
      effect.status !== "failed" &&
      (!effect.proofSnapshotId || !effect.proofSnapshotDigest)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Proof publication and delivery effects require an exact snapshot identity and digest",
        path: ["proofSnapshotId"],
      });
    }
    if (
      (effect.proofSnapshotId === undefined) !==
      (effect.proofSnapshotDigest === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Proof snapshot identity and digest must be stored together",
        path: ["proofSnapshotId"],
      });
    }
    if (
      !proofBoundEffect &&
      (effect.proofSnapshotId !== undefined ||
        effect.proofSnapshotDigest !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only proof publication and delivery effects may bind a snapshot",
        path: ["proofSnapshotId"],
      });
    }
  });

export const ProjectLifecycleStatusSchema = z.enum([
  "intake_received",
  "needs_clarification",
  "researching",
  "proposal_drafting",
  "awaiting_customer_revision",
  "awaiting_payment",
  "payment_verification_failed",
  "paid",
  "building",
  "verifying",
  "no_proven_candidate",
  "preview_ready",
  "revision_pending",
  "deploying",
  "deployment_verification_failed",
  "delivering",
  "completed",
  "cancelled",
  "failed",
  "needs_operator_attention",
]);

export type ProjectLifecycleStatus = z.infer<
  typeof ProjectLifecycleStatusSchema
>;

export const ProjectAggregateSchema = z
  .object({
    projectId: OrchestrationIdSchema,
    revision: z.number().int().nonnegative(),
    status: ProjectLifecycleStatusSchema,
    intake: IntakeSchema,
    customer: CustomerProfileSchema,
    proposals: z.array(ProposalVersionSchema).max(1_000),
    activeProposalVersion: z.number().int().positive().optional(),
    paidProposalVersion: z.number().int().positive().optional(),
    checkoutSessions: z.array(CheckoutSessionSchema).max(2_000),
    payments: z.array(PaymentReceiptSchema).max(1_000),
    buildBatches: z.array(BuildBatchSchema).max(1_000),
    activeBuildBatchId: OrchestrationIdSchema.optional(),
    provenCandidates: z.array(ProvenCandidateSchema).max(4_000),
    previews: z.array(PreviewReceiptSchema).max(1_000),
    deployments: z.array(DeploymentReceiptSchema).max(1_000),
    messages: z.array(ProjectMessageSchema).max(10_000),
    openClarificationQuestions: z
      .array(z.string().min(1).max(1_000))
      .max(20)
      .default([]),
    effects: z.array(DurableEffectSchema).max(10_000),
    errors: z.array(OrchestrationErrorSchema).max(10_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((project, context) => {
    if (project.customer.researchConsent.sourceIntakeId) {
      if (
        project.customer.researchConsent.sourceIntakeId !==
        project.intake.intakeId
      ) {
        context.addIssue({
          code: "custom",
          message: "Research consent references a different intake",
          path: ["customer", "researchConsent", "sourceIntakeId"],
        });
      }
    }

    const proposalByVersion = new Map<number, ProposalVersion>();
    const proposalIds = new Set<string>();
    for (const [index, proposal] of project.proposals.entries()) {
      if (proposalByVersion.has(proposal.version)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate proposal version: ${proposal.version}`,
          path: ["proposals", index, "version"],
        });
      }
      if (proposalIds.has(proposal.proposalId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate proposal id: ${proposal.proposalId}`,
          path: ["proposals", index, "proposalId"],
        });
      }
      proposalByVersion.set(proposal.version, proposal);
      proposalIds.add(proposal.proposalId);
      if (proposal.contract.projectId !== project.projectId) {
        context.addIssue({
          code: "custom",
          message: "Proposal Acceptance Contract belongs to another project",
          path: ["proposals", index, "contract", "projectId"],
        });
      }
      for (const [sourceIndex, source] of proposal.sources.entries()) {
        if (
          source.kind === "intake" &&
          (source.intakeId !== project.intake.intakeId ||
            source.contentDigest !== project.intake.contentDigest)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Proposal intake evidence is not bound to the original intake",
            path: ["proposals", index, "sources", sourceIndex],
          });
        }
        if (source.kind === "customer_message") {
          const message = project.messages.find(
            (candidate) =>
              candidate.direction === "inbound" &&
              candidate.messageId === source.messageId,
          );
          if (!message || message.contentDigest !== source.contentDigest) {
            context.addIssue({
              code: "custom",
              message:
                "Proposal message evidence is not bound to an original inbound message",
              path: ["proposals", index, "sources", sourceIndex],
            });
          }
        }
      }
    }

    if (
      project.activeProposalVersion !== undefined &&
      !proposalByVersion.has(project.activeProposalVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "activeProposalVersion does not exist",
        path: ["activeProposalVersion"],
      });
    }

    const checkoutSessionIds = new Set<string>();
    for (const [index, checkout] of project.checkoutSessions.entries()) {
      const proposal = proposalByVersion.get(checkout.proposalVersion);
      if (checkoutSessionIds.has(checkout.sessionId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate Checkout Session id: ${checkout.sessionId}`,
          path: ["checkoutSessions", index, "sessionId"],
        });
      }
      checkoutSessionIds.add(checkout.sessionId);
      if (
        !proposal ||
        checkout.projectId !== project.projectId ||
        checkout.proposalDigest !== proposal.digest ||
        checkout.amountMinor !== proposal.quote.amountMinor ||
        checkout.currency !== proposal.quote.currency
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Checkout Session is not bound to the exact project/proposal/amount/currency",
          path: ["checkoutSessions", index],
        });
      }
    }

    const paidVersions = new Set<number>();
    const paymentByReceiptId = new Map<
      string,
      z.infer<typeof PaymentReceiptSchema>
    >();
    const paymentProviderEventIds = new Set<string>();
    for (const [index, payment] of project.payments.entries()) {
      const proposal = proposalByVersion.get(payment.proposalVersion);
      if (!proposal) {
        context.addIssue({
          code: "custom",
          message: "Payment references a missing proposal",
          path: ["payments", index, "proposalVersion"],
        });
        continue;
      }
      if (
        paymentByReceiptId.has(payment.receiptId) ||
        paymentProviderEventIds.has(payment.providerEventId)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Payment receipt and provider event identities must be unique",
          path: ["payments", index],
        });
      }
      paymentByReceiptId.set(payment.receiptId, payment);
      paymentProviderEventIds.add(payment.providerEventId);
      const checkout = project.checkoutSessions.find(
        (session) => session.sessionId === payment.checkoutSessionId,
      );
      if (
        payment.projectId !== project.projectId ||
        payment.proposalId !== proposal.proposalId ||
        payment.proposalDigest !== proposal.digest ||
        payment.amountMinor !== proposal.quote.amountMinor ||
        payment.amountReceivedMinor !== proposal.quote.amountMinor ||
        payment.currency !== proposal.quote.currency ||
        payment.customerEmailDigest !==
          sha256(project.customer.email?.value.trim().toLowerCase() ?? "") ||
        !checkout ||
        checkout.proposalVersion !== payment.proposalVersion ||
        checkout.proposalDigest !== payment.proposalDigest ||
        checkout.amountMinor !== payment.amountMinor ||
        checkout.currency !== payment.currency
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Payment is not bound to this project and the exact proposal digest, amount, and currency",
          path: ["payments", index],
        });
      } else {
        paidVersions.add(payment.proposalVersion);
      }
    }
    if (
      project.paidProposalVersion !== undefined &&
      !paidVersions.has(project.paidProposalVersion)
    ) {
      context.addIssue({
        code: "custom",
        message: "paidProposalVersion lacks a matching verified payment",
        path: ["paidProposalVersion"],
      });
    }
    for (const [index, proposal] of project.proposals.entries()) {
      if (
        proposal.commercialBasisVersion !== undefined &&
        !paidVersions.has(proposal.commercialBasisVersion)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Proposal commercialBasisVersion lacks a matching verified payment",
          path: ["proposals", index, "commercialBasisVersion"],
        });
      }
    }

    const batchById = new Map<string, z.infer<typeof BuildBatchSchema>>();
    for (const [index, batch] of project.buildBatches.entries()) {
      const proposal = proposalByVersion.get(batch.proposalVersion);
      const payment = paymentByReceiptId.get(batch.paymentReceiptId);
      const expectedPaymentVersion =
        proposal?.commercialBasisVersion ?? proposal?.version;
      if (batchById.has(batch.batchId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate build batch id: ${batch.batchId}`,
          path: ["buildBatches", index, "batchId"],
        });
      }
      batchById.set(batch.batchId, batch);
      if (
        !proposal ||
        batch.projectId !== project.projectId ||
        batch.proposalDigest !== proposal.digest ||
        !payment ||
        payment.proposalVersion !== batch.paymentProposalVersion ||
        payment.proposalVersion !== expectedPaymentVersion ||
        batch.contractVersion !== proposal.contract.version ||
        batch.contractDigest !== proposal.contract.digest
      ) {
        context.addIssue({
          code: "custom",
          message: "Build batch is not bound to its project/proposal/contract",
          path: ["buildBatches", index],
        });
      }
    }
    if (
      project.activeBuildBatchId !== undefined &&
      !batchById.has(project.activeBuildBatchId)
    ) {
      context.addIssue({
        code: "custom",
        message: "activeBuildBatchId does not exist",
        path: ["activeBuildBatchId"],
      });
    }
    const activeBatch =
      project.activeBuildBatchId === undefined
        ? undefined
        : batchById.get(project.activeBuildBatchId);

    for (const [index, candidate] of project.provenCandidates.entries()) {
      const batch = batchById.get(candidate.batchId);
      const payload = candidate.event.payload;
      if (
        !batch ||
        payload.projectId !== project.projectId ||
        candidate.proposalVersion !== batch.proposalVersion ||
        candidate.proposalDigest !== batch.proposalDigest ||
        payload.contractHash !== batch.buildContractHash ||
        !batch.runs.some(
          (run) =>
            run.runId === payload.runId &&
            run.candidateId === payload.candidateId,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Proven candidate is not bound to its project/build batch/compiled build contract",
          path: ["provenCandidates", index],
        });
      }
    }

    for (const [index, preview] of project.previews.entries()) {
      const batch = batchById.get(preview.batchId);
      const candidate = project.provenCandidates.find(
        (item) =>
          item.batchId === preview.batchId &&
          item.event.runId === preview.runId &&
          item.event.payload.candidateId === preview.candidateId &&
          item.event.revisionHash === preview.revisionHash,
      );
      if (
        !batch ||
        !candidate ||
        preview.projectId !== project.projectId ||
        preview.proposalVersion !== batch.proposalVersion ||
        preview.proposalDigest !== batch.proposalDigest ||
        preview.artifactDigest !== candidate.event.payload.artifact.sha256 ||
        preview.snapshotId !== candidate.event.payload.artifact.daytonaSnapshot
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Preview is not bound to its exact proven project/batch/revision/artifact",
          path: ["previews", index],
        });
      }
    }

    for (const [index, deployment] of project.deployments.entries()) {
      const batch = batchById.get(deployment.batchId);
      const candidate = project.provenCandidates.find(
        (item) =>
          item.batchId === deployment.batchId &&
          item.event.runId === deployment.runId &&
          item.event.payload.candidateId === deployment.candidateId &&
          item.event.revisionHash === deployment.revisionHash,
      );
      if (
        !batch ||
        !candidate ||
        deployment.projectId !== project.projectId ||
        deployment.proposalVersion !== batch.proposalVersion ||
        deployment.proposalDigest !== batch.proposalDigest ||
        deployment.artifactDigest !== candidate.event.payload.artifact.sha256
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Deployment is not bound to its exact proven project/batch/revision/artifact",
          path: ["deployments", index],
        });
      }
    }

    if (
      [
        "building",
        "verifying",
        "preview_ready",
        "deploying",
        "delivering",
        "completed",
      ].includes(project.status) &&
      !activeBatch
    ) {
      context.addIssue({
        code: "custom",
        message: "Active lifecycle status requires an active build batch",
        path: ["activeBuildBatchId"],
      });
    }
    if (
      project.status === "preview_ready" &&
      activeBatch &&
      !project.previews.some(
        (preview) => preview.batchId === activeBatch.batchId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "preview_ready requires an exact proven preview receipt",
        path: ["previews"],
      });
    }
    if (project.status === "completed" && activeBatch) {
      const deployment = project.deployments.find(
        (candidate) =>
          candidate.batchId === activeBatch.batchId &&
          candidate.proposalVersion === activeBatch.proposalVersion &&
          candidate.proposalDigest === activeBatch.proposalDigest,
      );
      const expectedFinalEffectKey =
        deployment && project.activeProposalVersion !== undefined
          ? `mail:delivery:${project.projectId}:v${project.activeProposalVersion}:${deployment.revisionHash}`
          : undefined;
      const finalMessage = project.messages.find(
        (message) =>
          message.direction === "outbound" &&
          message.purpose === "final_delivery" &&
          message.deliveryStatus === "delivered" &&
          message.providerMessageId !== undefined &&
          activeBatch.proposalVersion === project.activeProposalVersion &&
          expectedFinalEffectKey !== undefined &&
          project.effects.some(
            (effect) =>
              effect.type === "send_final_delivery" &&
              effect.status === "completed" &&
              effect.providerId === message.providerMessageId &&
              effect.key === expectedFinalEffectKey,
          ),
      );
      if (!deployment || !finalMessage) {
        context.addIssue({
          code: "custom",
          message:
            "completed requires an exact verified deployment and delivered final email",
          path: ["status"],
        });
      }
    }

    const uniqueCollections: Array<[string, Array<{ key: string }>, string]> = [
      [
        "messages",
        project.messages.map((message) => ({ key: message.messageId })),
        "messageId",
      ],
      [
        "effects",
        project.effects.map((effect) => ({ key: effect.key })),
        "key",
      ],
      [
        "errors",
        project.errors.map((error) => ({ key: error.errorId })),
        "errorId",
      ],
      [
        "previews",
        project.previews.map((preview) => ({ key: preview.receiptId })),
        "receiptId",
      ],
      [
        "deployments",
        project.deployments.map((deployment) => ({
          key: deployment.receiptId,
        })),
        "receiptId",
      ],
      [
        "provenCandidates",
        project.provenCandidates.map((candidate) => ({
          key: candidate.event.eventId,
        })),
        "eventId",
      ],
    ];
    for (const [collectionName, items, fieldName] of uniqueCollections) {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.key)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${fieldName}: ${item.key}`,
            path: [collectionName, index, fieldName],
          });
        }
        seen.add(item.key);
      }
    }
  });

export type PiiSpan = z.infer<typeof PiiSpanSchema>;
export type Intake = z.infer<typeof IntakeSchema>;
export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;
export type CheckoutSession = z.infer<typeof CheckoutSessionSchema>;
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;
export type BuildRunIdentity = z.infer<typeof BuildRunIdentitySchema>;
export type BuildBatch = z.infer<typeof BuildBatchSchema>;
export type ProvenCandidate = z.infer<typeof ProvenCandidateSchema>;
export type PreviewReceipt = z.infer<typeof PreviewReceiptSchema>;
export type DeploymentReceipt = z.infer<typeof DeploymentReceiptSchema>;
export type ProjectMessage = z.infer<typeof ProjectMessageSchema>;
export type OrchestrationError = z.infer<typeof OrchestrationErrorSchema>;
export type DurableEffect = z.infer<typeof DurableEffectSchema>;
export type ProjectAggregate = z.infer<typeof ProjectAggregateSchema>;

export const CreateProjectInputSchema = z
  .object({
    projectId: OrchestrationIdSchema.optional(),
    idempotencyKey: IdempotencyKeySchema,
    status: z
      .enum(["intake_received", "needs_clarification"])
      .default("intake_received"),
    intake: IntakeSchema,
    customer: CustomerProfileSchema,
  })
  .strict();

export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;
export interface CreateProjectResult {
  project: ProjectAggregate;
  created: boolean;
}

export const EventTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

/*
 * Event payloads are intentionally not arbitrary JSON. They may contain only
 * opaque references, digests, state, and counters. Raw messages, URLs, contact
 * fields, model text, and provider error messages therefore cannot compile or
 * pass validation at this boundary.
 */
export const RedactedEventPayloadSchema = z
  .object({
    previousStatus: ProjectLifecycleStatusSchema.optional(),
    status: ProjectLifecycleStatusSchema.optional(),
    proposalVersion: z.number().int().positive().optional(),
    proposalDigest: OrchestrationSha256Schema.optional(),
    paymentReceiptId: OrchestrationIdSchema.optional(),
    buildBatchId: OrchestrationIdSchema.optional(),
    runId: OrchestrationIdSchema.optional(),
    candidateId: OrchestrationIdSchema.optional(),
    previewReceiptId: OrchestrationIdSchema.optional(),
    deploymentReceiptId: OrchestrationIdSchema.optional(),
    proofSnapshotId: OrchestrationIdSchema.optional(),
    proofSnapshotDigest: OrchestrationSha256Schema.optional(),
    effectKey: IdempotencyKeySchema.optional(),
    effectType: EffectTypeSchema.optional(),
    messageId: OrchestrationIdSchema.optional(),
    messageDigest: OrchestrationSha256Schema.optional(),
    consumedMessageIds: z
      .array(OrchestrationIdSchema)
      .min(1)
      .max(10_000)
      .refine(
        (messageIds) => new Set(messageIds).size === messageIds.length,
        "Consumed message identities must be unique",
      )
      .optional(),
    errorCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .optional(),
    provider: ProviderSchema.optional(),
    providerEventDigest: OrchestrationSha256Schema.optional(),
    correlationId: OrchestrationIdSchema.optional(),
    attempt: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative().optional(),
    reason: z.enum(["deadline_expired", "superseded"]).optional(),
  })
  .strict();

export const ProjectEventInputSchema = z
  .object({
    type: EventTypeSchema,
    actor: z.enum(["system", "customer", "provider", "operator"]),
    payload: RedactedEventPayloadSchema.default({}),
  })
  .strict();

export const ProjectEventSchema = z
  .object({
    eventId: z.uuid(),
    sequence: z.number().int().positive(),
    projectId: OrchestrationIdSchema,
    aggregateRevision: z.number().int().nonnegative(),
    type: EventTypeSchema,
    actor: z.enum(["system", "customer", "provider", "operator"]),
    payload: RedactedEventPayloadSchema,
    occurredAt: TimestampSchema,
  })
  .strict();

export type ProjectEventInput = z.input<typeof ProjectEventInputSchema>;
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;
