import { describe, expect, it } from "vitest";

import {
  FireworksOrchestrationReasoner,
  type ConversationAnalysis,
} from "../src/orchestration/application/fireworks-orchestration-reasoner.js";
import type {
  AgentMessage,
  AgentToolDefinition,
  ModelPort,
  ModelTurn,
} from "../src/ports/index.js";

describe("FireworksOrchestrationReasoner", () => {
  it("accepts only a typed intake tool result", async () => {
    const result: ConversationAnalysis = {
      customer: {
        name: "Jordan Lee",
        email: "jordan@example.com",
      },
      piiSpans: [
        {
          type: "person_name",
          startOffset: 5,
          endOffset: 15,
          confidence: 0.99,
        },
      ],
      quote: {
        amountMinor: 250_000,
        currency: "usd",
        evidenceExcerpt: "USD 2,500",
      },
      researchTargets: [
        {
          url: "https://missionpeak.example",
          purpose: "Review the caller's existing visual identity.",
          consentEvidenceExcerpt: "Please look at our current website",
        },
      ],
      clarificationQuestions: [],
    };
    const model = new StaticModel({
      content: null,
      toolCalls: [
        {
          id: "call-one",
          name: "submit_intake_analysis",
          argumentsJson: JSON.stringify(result),
        },
      ],
    });
    const reasoner = new FireworksOrchestrationReasoner(model);

    await expect(
      reasoner.analyzeConversation({
        channel: "voice",
        conversation:
          "I am Jordan Lee. Please look at our current website. We agreed on USD 2,500.",
        researchConsent: true,
      }),
    ).resolves.toEqual(result);
    expect(model.lastTools?.map((tool) => tool.name)).toEqual([
      "submit_intake_analysis",
    ]);
  });

  it("fails closed when Fireworks does not return the required tool", async () => {
    const reasoner = new FireworksOrchestrationReasoner(
      new StaticModel({ content: "Looks good", toolCalls: [] }),
    );

    await expect(
      reasoner.analyzeConversation({
        channel: "email",
        conversation: "Build me a website.",
        researchConsent: false,
      }),
    ).rejects.toThrow("submit_intake_analysis");
  });
});

class StaticModel implements ModelPort {
  lastTools: AgentToolDefinition[] | undefined;

  constructor(private readonly turn: ModelTurn) {}

  complete(
    _messages: AgentMessage[],
    tools: AgentToolDefinition[],
  ): Promise<ModelTurn> {
    this.lastTools = tools;
    return Promise.resolve(this.turn);
  }

  evaluateContract(): never {
    throw new Error("not used");
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}
