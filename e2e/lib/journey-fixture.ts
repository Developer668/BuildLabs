/**
 * The single synthetic customer this journey follows. Every downstream
 * assertion (and every canned model answer) is derived from these exact
 * sentences, because the orchestrator only accepts facts that quote the
 * transcript verbatim.
 */
export const JOURNEY_CUSTOMER = {
  name: "Dana Whitfield",
  email: "dana@northwind-journey.example",
  businessName: "Northwind Coffee Roasters",
  amountMinor: 120_000,
  currency: "usd",
} as const;

export const JOURNEY_TRANSCRIPT_TURNS: ReadonlyArray<{
  role: "agent" | "user";
  message: string;
}> = [
  {
    role: "agent",
    message: "Thanks for calling BuildLabs. What would you like us to build?",
  },
  {
    role: "user",
    message:
      "The website must show a headline that says Northwind Coffee Roasters.",
  },
  {
    role: "user",
    message: "The website must show the opening hours on the home page.",
  },
  {
    role: "agent",
    message: "Understood. How should we reach you once the build is proven?",
  },
  {
    role: "user",
    message: `My name is ${JOURNEY_CUSTOMER.name} and my email is ${JOURNEY_CUSTOMER.email}.`,
  },
  {
    role: "user",
    message: "We agreed the price is 1200 USD for this engagement.",
  },
  {
    role: "agent",
    message: "Thank you. We will send the proposal to that address.",
  },
];

/**
 * Mirrors `formatVoiceTranscript` in the voice-intake bridge so the harness can
 * assert on, and cite from, exactly what the orchestrator receives.
 */
export function journeyTranscriptText(): string {
  return JOURNEY_TRANSCRIPT_TURNS.map(
    (turn) =>
      `${turn.role === "agent" ? "Agent" : "Customer"}: ${turn.message}`,
  ).join("\n");
}

/** Sentences that must survive PII minimization and stay citable. */
export const JOURNEY_REQUIREMENT_SENTENCES = [
  "The website must show a headline that says Northwind Coffee Roasters.",
  "The website must show the opening hours on the home page.",
] as const;

export const JOURNEY_QUOTE_SENTENCE =
  "We agreed the price is 1200 USD for this engagement.";
