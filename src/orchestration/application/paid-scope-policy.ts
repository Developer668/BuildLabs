export interface PaidScopeEvidence {
  deliverables: Array<{
    itemId: string;
    text: string;
  }>;
  requirements: Array<{
    requirementId: string;
    description: string;
  }>;
}

export interface PaidRevisionPlan {
  scopeItems: Array<{
    id: string;
    text: string;
  }>;
  requirements: Array<{
    id: string;
    description: string;
    priority?: "hard" | "preference";
    citation?: {
      kind: "conversation" | "research";
      excerpt: string;
    };
    verifiers?: Array<
      | { kind: "semantic"; criterion: string }
      | { kind: "command" }
      | { kind: "http"; bodyIncludes?: string[] }
    >;
  }>;
}

export class UnpaidScopeExpansionError extends Error {
  readonly clarificationQuestion =
    "This request adds work that is not an exact deliverable in the paid contract. Please confirm the new agreed price and currency so I can send a replacement proposal and payment link.";

  constructor(itemId: string) {
    super(
      `Paid revision introduces commercial scope without exact paid-deliverable evidence: ${itemId}`,
    );
    this.name = "UnpaidScopeExpansionError";
  }
}

const ACKNOWLEDGEMENT_ONLY =
  /^(?:(?:hi|hello|thanks|thank\s+you)[\s,;:!.]*)?(?:looks?\s+good|approved|no\s+changes?|all\s+good|go\s+ahead)[\s,;:!.]*$/iu;
const COURTESY_ONLY = /^(?:hi|hello|thanks|thank\s+you)[\s,;:!.]*$/iu;
const REMOVAL_ONLY =
  /^(?:please[\s,]+)?(?:delete|drop|remove|take\s+out)\b(?!.*\b(?:also|and|plus|then)\b).{1,240}[.!?]*$/iu;
const ADDITIVE_OR_INTEGRATION_ACTION =
  /\b(?:add|allow|build|connect|create|develop|enable|implement|include|install|integrate|introduce|migrate|provide|set\s+up|support)\b/iu;
const CAPABILITY_REQUEST =
  /\b(?:accounts?|api|appointments?|authentication|booking|calendar|cards?|checkout|crm|customer\s+portal|database|e-?commerce|erp|hubspot|integration|log\s*in|mobile\s+app|oauth|payments?|salesforce|sign\s*in|single\s+sign-on|sso|stripe|webhooks?)\b/iu;
const PRESENTATION_EDIT_VERBS = new Set([
  "adjust",
  "change",
  "correct",
  "edit",
  "fix",
  "make",
  "move",
  "rename",
  "reorder",
  "rephrase",
  "revise",
  "rewrite",
  "switch",
  "update",
]);
const PRESENTATION_EDIT_WORDS = new Set([
  "a",
  "above",
  "action",
  "after",
  "alignment",
  "an",
  "as",
  "at",
  "background",
  "before",
  "below",
  "blue",
  "brand",
  "button",
  "call",
  "color",
  "contrast",
  "copy",
  "cta",
  "estimate",
  "field",
  "first",
  "font",
  "footer",
  "for",
  "form",
  "green",
  "header",
  "headline",
  "hero",
  "in",
  "it",
  "label",
  "last",
  "layout",
  "left",
  "less",
  "link",
  "menu",
  "more",
  "nav",
  "navigation",
  "navy",
  "of",
  "on",
  "orange",
  "order",
  "our",
  "page",
  "paragraph",
  "please",
  "position",
  "primary",
  "purple",
  "red",
  "right",
  "secondary",
  "section",
  "site",
  "size",
  "spacing",
  "style",
  "subtitle",
  "text",
  "that",
  "the",
  "theme",
  "this",
  "title",
  "to",
  "typography",
  "visual",
  "white",
  "wording",
  "yellow",
]);

/**
 * Fireworks can explain a scope decision, but only a bounded set of clearly
 * non-commercial edits proceeds without a new agreement. Ambiguous wording
 * fails closed instead of relying on a growing feature-keyword blacklist.
 */
export function customerChangeRequiresRequote(
  paidScope: PaidScopeEvidence,
  customerChange: string,
): boolean {
  const exactPaidEvidence = new Set([
    ...paidScope.deliverables.map((item) => normalizeEvidence(item.text)),
    ...paidScope.requirements.map((item) =>
      normalizeEvidence(item.description),
    ),
  ]);
  const paidEvidenceTokens = new Set(
    [...exactPaidEvidence].flatMap((evidence) => evidence.split(" ")),
  );
  const evidenceUnits = customerChange
    .split(/(?<=[.!?])\s+|\r?\n+/u)
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);

  return evidenceUnits.some((unit) => {
    const normalized = normalizeEvidence(unit);
    if (exactPaidEvidence.has(normalized)) {
      return false;
    }
    if (ACKNOWLEDGEMENT_ONLY.test(unit) || COURTESY_ONLY.test(unit)) {
      return false;
    }
    if (ADDITIVE_OR_INTEGRATION_ACTION.test(unit)) {
      return true;
    }
    if (REMOVAL_ONLY.test(unit)) {
      return false;
    }
    if (CAPABILITY_REQUEST.test(unit)) {
      return true;
    }
    return !isBoundedPresentationEdit(unit, paidEvidenceTokens);
  });
}

/**
 * A model's `within_paid_scope` label cannot authorize new contract work.
 * The cumulative revision may retain exact purchased items; anything else
 * returns to the commercial proposal/payment loop.
 */
export function assertPaidRevisionUsesExactCommercialScope(
  paidScope: PaidScopeEvidence,
  revision: PaidRevisionPlan,
  customerChange: string,
): void {
  const paidDeliverables = new Map(
    paidScope.deliverables.map((item) => [item.itemId, item.text]),
  );
  for (const item of revision.scopeItems) {
    if (paidDeliverables.get(item.id) !== item.text) {
      throw new UnpaidScopeExpansionError(`deliverable:${item.id}`);
    }
  }

  const paidRequirements = new Map(
    paidScope.requirements.map((item) => [
      item.requirementId,
      item.description,
    ]),
  );
  for (const requirement of revision.requirements) {
    if (paidRequirements.get(requirement.id) === requirement.description) {
      continue;
    }
    const citation = requirement.citation;
    if (
      !requirement.id.startsWith("change-") ||
      citation?.kind !== "conversation" ||
      !isSameExtractiveEvidence(requirement.description, citation.excerpt) ||
      findStandaloneEvidenceOffset(customerChange, citation.excerpt) < 0 ||
      customerChangeRequiresRequote(paidScope, citation.excerpt) ||
      (requirement.priority !== "hard" &&
        !(
          requirement.priority === "preference" &&
          hasExplicitPreferenceLanguage(citation.excerpt)
        )) ||
      !requirement.verifiers?.some(
        (verifier) =>
          verifier.kind === "http" &&
          verifier.bodyIncludes?.some((expected) =>
            isSameExtractiveEvidence(requirement.description, expected),
          ),
      )
    ) {
      throw new UnpaidScopeExpansionError(`requirement:${requirement.id}`);
    }
  }
}

function hasExplicitPreferenceLanguage(excerpt: string): boolean {
  return /\b(?:if\s+possible|nice[-\s]+to[-\s]+have|not\s+required|optional(?:ly)?|prefer(?:ence|red)?|would\s+be\s+nice)\b/iu.test(
    excerpt,
  );
}

function isBoundedPresentationEdit(
  unit: string,
  paidEvidenceTokens: ReadonlySet<string>,
): boolean {
  const tokens = normalizeEvidence(unit).split(" ").filter(Boolean);
  const firstContentToken = tokens[0] === "please" ? tokens[1] : tokens[0];
  if (!firstContentToken || !PRESENTATION_EDIT_VERBS.has(firstContentToken)) {
    return false;
  }
  return tokens.every(
    (token) =>
      PRESENTATION_EDIT_VERBS.has(token) ||
      PRESENTATION_EDIT_WORDS.has(token) ||
      paidEvidenceTokens.has(token),
  );
}

function normalizeEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
import {
  findStandaloneEvidenceOffset,
  isSameExtractiveEvidence,
} from "./evidence-grounding.js";
