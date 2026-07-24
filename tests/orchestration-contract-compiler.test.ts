import { describe, expect, it } from "vitest";

import {
  compileAcceptanceContract,
  ContractDraftSchema,
  UnsupportedCitationError,
} from "../src/orchestration/application/contract-compiler.js";
import { sha256 } from "../src/lib/canonical-json.js";

const conversation = [
  "Mission Peak Electric serves Fremont.",
  "The customer wants a homepage with an estimate form.",
].join("\n");

describe("compileAcceptanceContract", () => {
  it("turns only exact conversation and research excerpts into approved facts", () => {
    const draft = ContractDraftSchema.parse({
      approvedFacts: [
        {
          id: "business-name",
          statement: "Mission Peak Electric serves Fremont.",
          citation: {
            kind: "conversation",
            excerpt: "Mission Peak Electric serves Fremont",
          },
        },
        {
          id: "brand-color",
          statement: "Our signature navy identity is used everywhere.",
          citation: {
            kind: "research",
            url: "https://missionpeak.example/about",
            excerpt: "Our signature navy identity is used everywhere",
          },
        },
      ],
      forbiddenClaims: ["24/7 emergency service"],
      requirements: [
        {
          id: "homepage",
          description: "The customer wants a homepage with an estimate form.",
          priority: "hard",
          citation: {
            kind: "conversation",
            excerpt: "The customer wants a homepage with an estimate form",
          },
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: ["Mission Peak Electric", "Estimate"],
            },
          ],
        },
      ],
      verification: {
        origin: "system_policy",
        policyId: "buildlapse-proof-gate-v1",
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm run start",
        previewPort: 3000,
      },
    });

    const contract = compileAcceptanceContract({
      contractId: "contract-project-one-v1",
      projectId: "project-one",
      conversation,
      approvedAt: "2026-07-23T12:00:00.000Z",
      draft,
      research: [
        {
          url: "https://missionpeak.example/about",
          capturedAt: "2026-07-23T11:00:00.000Z",
          text: "About us. Our signature navy identity is used everywhere.",
        },
      ],
    });

    expect(contract.transcriptSha256).toBe(sha256(conversation));
    expect(contract.approvedFacts[0]?.sources[0]).toMatchObject({
      type: "transcript",
      startOffset: 0,
      endOffset: "Mission Peak Electric serves Fremont".length,
      excerpt: "Mission Peak Electric serves Fremont",
    });
    expect(contract.approvedFacts[1]?.sources[0]).toMatchObject({
      type: "research",
      url: "https://missionpeak.example/about",
      excerpt: "Our signature navy identity is used everywhere",
    });
  });

  it("fails closed when a proposed fact has no exact source excerpt", () => {
    const draft = ContractDraftSchema.parse({
      approvedFacts: [
        {
          id: "invented-hours",
          statement: "The business is open around the clock.",
          citation: {
            kind: "conversation",
            excerpt: "open 24 hours",
          },
        },
      ],
      forbiddenClaims: [],
      requirements: [
        {
          id: "homepage",
          description: "The customer wants a homepage with an estimate form.",
          priority: "hard",
          citation: {
            kind: "conversation",
            excerpt: "The customer wants a homepage with an estimate form",
          },
          verifiers: [{ kind: "http", path: "/", expectedStatus: 200 }],
        },
      ],
      verification: {
        origin: "system_policy",
        policyId: "buildlapse-proof-gate-v1",
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm run start",
        previewPort: 3000,
      },
    });

    expect(() =>
      compileAcceptanceContract({
        contractId: "contract-project-one-v1",
        projectId: "project-one",
        conversation,
        approvedAt: "2026-07-23T12:00:00.000Z",
        draft,
        research: [],
      }),
    ).toThrow(UnsupportedCitationError);
  });
});
