/**
 * Canned structured outputs for the orchestrator's three Fireworks tools.
 *
 * These are deliberately derived from the request the orchestrator sends rather
 * than hard-coded: the contract compiler only accepts citations that appear
 * verbatim in the (PII-minimized) conversation it passes in, so the stub quotes
 * the text it was handed instead of guessing what survived minimization.
 */

export interface StubModelRequest {
  toolName: string;
  input: Record<string, unknown>;
}

const AMOUNT_MINOR = 120_000;
const CURRENCY = "usd";

export function answerForTool(request: StubModelRequest): unknown {
  switch (request.toolName) {
    case "submit_intake_analysis":
      return intakeAnalysis(request.input);
    case "submit_proposal_plan":
      return proposalPlan(request.input);
    case "submit_change_classification":
      return changeClassification();
    default:
      throw new Error(`No canned answer for tool ${request.toolName}`);
  }
}

function intakeAnalysis(input: Record<string, unknown>): unknown {
  const conversation = stringField(input, "conversation");
  const email = firstMatch(conversation, /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  const name = firstMatch(conversation, /My name is ([^.]+?) and my email is/);
  const quoteSentence = sentenceContaining(conversation, "the price is");
  const spans: Array<Record<string, unknown>> = [];
  if (email) {
    spans.push(piiSpan(conversation, email, "email"));
  }
  if (name) {
    spans.push(piiSpan(conversation, name, "person_name"));
  }
  return {
    customer: {
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
    },
    piiSpans: spans.filter((span) => span.startOffset !== -1),
    quote: quoteSentence
      ? {
          amountMinor: AMOUNT_MINOR,
          currency: CURRENCY,
          evidenceExcerpt: quoteSentence,
        }
      : null,
    researchTargets: [],
    clarificationQuestions: [],
  };
}

function proposalPlan(input: Record<string, unknown>): unknown {
  const conversation = stringField(input, "minimizedConversation");
  const requirementSentences = conversation
    .split("\n")
    .map((line) => line.replace(/^(?:Agent|Customer):\s*/, "").trim())
    .filter((line) => /^The website must /.test(line));
  if (requirementSentences.length === 0) {
    throw new Error(
      "The minimized conversation carried no citable requirement sentence",
    );
  }
  const scopeItems = requirementSentences.map((sentence, index) => ({
    id: `scope-${index + 1}`,
    text: sentence,
    citation: { kind: "conversation", excerpt: sentence },
  }));
  const requirements = requirementSentences.map((sentence, index) => ({
    id: `req-${index + 1}`,
    description: sentence,
    priority: "hard" as const,
    citation: { kind: "conversation", excerpt: sentence },
    verifiers: [
      {
        kind: "http" as const,
        path: "/",
        expectedStatus: 200,
        bodyIncludes: [keyPhrase(sentence)],
      },
    ],
  }));
  return {
    title: requirementSentences[0] ?? "Journey build",
    summary: requirementSentences.join(" "),
    scopeItems,
    buildPrompt: [
      "Build a single-page static site served by a Node HTTP server on port 8080.",
      ...requirementSentences,
    ].join("\n"),
    strategyLabels: ["static-site"],
    contractDraft: {
      approvedFacts: requirementSentences.map((sentence, index) => ({
        id: `fact-${index + 1}`,
        statement: sentence,
        citation: { kind: "conversation", excerpt: sentence },
      })),
      forbiddenClaims: [
        "award winning",
        "trusted by thousands",
        "money back guarantee",
      ],
      requirements,
      verification: {
        origin: "system_policy",
        policyId: "buildlabs-proof-gate-v1",
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm start",
        previewPort: 8080,
      },
    },
    assets: [],
    clarificationQuestions: [],
  };
}

function changeClassification(): unknown {
  return {
    kind: "no_scope_change",
    explanation: "The journey fixture never changes scope after payment.",
    supersededScopeItems: [],
    supersededRequirementIds: [],
    supersededFactIds: [],
  };
}

function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Model input is missing the ${key} field`);
  }
  return value;
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(value);
  return match?.[1] ?? match?.[0];
}

function sentenceContaining(
  conversation: string,
  needle: string,
): string | undefined {
  return conversation
    .split("\n")
    .map((line) => line.replace(/^(?:Agent|Customer):\s*/, "").trim())
    .find((line) => line.includes(needle));
}

function piiSpan(
  conversation: string,
  value: string,
  type: string,
): Record<string, unknown> {
  const startOffset = conversation.indexOf(value);
  return {
    type,
    startOffset,
    endOffset: startOffset + value.length,
    confidence: 0.99,
  };
}

/**
 * The rendered-page verifier needs a phrase the built site can actually show.
 * Quoting the whole requirement sentence would force the build to print the
 * requirement itself, so take the distinctive noun phrase instead.
 */
function keyPhrase(sentence: string): string {
  const match = /must show (?:a headline that says )?(?:the )?([^.]+)/.exec(
    sentence,
  );
  return (match?.[1] ?? sentence).replace(/ on the home page$/, "").trim();
}
