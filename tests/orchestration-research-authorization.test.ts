import { describe, expect, it } from "vitest";

import {
  assertExplicitResearchAuthorization,
  UnverifiedResearchAuthorizationError,
} from "../src/orchestration/application/research-authorization.js";

describe("research authorization evidence", () => {
  it("accepts one exact positive sentence naming the caller-owned URL", () => {
    const conversation =
      "Please research our website https://missionpeak.example and use it for inspiration.";
    expect(() =>
      assertExplicitResearchAuthorization(conversation, {
        url: "https://missionpeak.example",
        consentEvidenceExcerpt: conversation,
      }),
    ).not.toThrow();
  });

  it.each([
    "Please research https://missionpeak.example and use it for inspiration.",
    "Please research our competitor's website https://missionpeak.example.",
    "Please research their website https://missionpeak.example.",
  ])(
    "rejects consent that does not establish caller authority for the target: %s",
    (conversation) => {
      expect(() =>
        assertExplicitResearchAuthorization(conversation, {
          url: "https://missionpeak.example",
          consentEvidenceExcerpt: conversation,
        }),
      ).toThrow(UnverifiedResearchAuthorizationError);
    },
  );

  it("accepts explicit authority to represent the business at the named domain", () => {
    const conversation =
      "I am authorized to represent the business at https://missionpeak.example, so please review that site.";
    expect(() =>
      assertExplicitResearchAuthorization(conversation, {
        url: "https://missionpeak.example",
        consentEvidenceExcerpt: conversation,
      }),
    ).not.toThrow();
  });

  it("rejects authority for one business being reused to authorize a different domain", () => {
    const conversation =
      "I represent the business at https://owned.example; please research https://competitor.example.";
    expect(() =>
      assertExplicitResearchAuthorization(conversation, {
        url: "https://competitor.example",
        consentEvidenceExcerpt: conversation,
      }),
    ).toThrow(UnverifiedResearchAuthorizationError);
  });

  it.each([
    "Do not research https://missionpeak.example.",
    "I have a website at https://missionpeak.example.",
    "Maybe research https://missionpeak.example.",
    "You can research another.example, not https://missionpeak.example.",
  ])("rejects absent, ambiguous, or negative consent: %s", (conversation) => {
    expect(() =>
      assertExplicitResearchAuthorization(conversation, {
        url: "https://missionpeak.example",
        consentEvidenceExcerpt: conversation,
      }),
    ).toThrow(UnverifiedResearchAuthorizationError);
  });

  it("rejects a mined substring instead of a complete consent sentence", () => {
    const conversation =
      "For context: please research https://missionpeak.example before planning.";
    expect(() =>
      assertExplicitResearchAuthorization(conversation, {
        url: "https://missionpeak.example",
        consentEvidenceExcerpt: "please research https://missionpeak.example",
      }),
    ).toThrow(UnverifiedResearchAuthorizationError);
  });
});
