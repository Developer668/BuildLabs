import { describe, expect, it } from "vitest";

import { BuildAssignmentSchema } from "../src/domain/contract.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { assignment } from "./fixtures.js";

describe("Acceptance Contract validation", () => {
  it("requires a verifier for every hard requirement", () => {
    const input = assignment();
    input.contract.requirements[0]!.verifiers = [];
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Hard requirements must have at least one verifier",
    );
  });

  it("keeps semantic verification ranking-only", () => {
    const input = assignment();
    input.contract.requirements[0]!.verifiers = [
      {
        kind: "semantic",
        criterion: "The candidate feels trustworthy.",
      },
    ];
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Semantic verifiers are ranking-only",
    );
  });

  it("rejects fact provenance from a different transcript", () => {
    const input = assignment();
    const source = input.contract.approvedFacts[0]!.sources[0]!;
    if (source.type !== "transcript") {
      throw new Error("Fixture source is not a transcript");
    }
    source.transcriptSha256 = sha256("different transcript");
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Transcript fact source does not match",
    );
  });

  it("rejects tampered research excerpts", () => {
    const input = assignment();
    input.contract.approvedFacts[0]!.sources = [
      {
        type: "research",
        url: "https://example.com/about",
        capturedAt: "2026-07-23T12:00:00.000Z",
        excerpt: "Confirmed business statement",
        excerptSha256: sha256("different contents"),
      },
    ];
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Research excerpt hash does not match",
    );
  });

  it("rejects transcript content that does not match its immutable digest", () => {
    const input = assignment();
    input.transcript.content = "Tampered transcript";
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Transcript content hash does not match",
    );
  });

  it("rejects transcript offsets that do not resolve to the claimed excerpt", () => {
    const input = assignment();
    const source = input.contract.approvedFacts[0]!.sources[0]!;
    if (source.type !== "transcript") {
      throw new Error("Fixture source is not a transcript");
    }
    source.startOffset = 1;
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "Transcript source offsets do not resolve",
    );
  });

  it("rejects network-path HTTP verifiers", () => {
    const input = assignment();
    const verifier = input.contract.requirements[0]!.verifiers[0]!;
    if (verifier.kind !== "http") {
      throw new Error("Fixture verifier is not HTTP");
    }
    verifier.path = "//169.254.169.254/latest/meta-data";
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "HTTP verifier path must be a canonical origin-relative path",
    );
  });

  it("rejects fragmented and non-canonical rendered verifier paths", () => {
    const input = assignment();
    const verifier = input.contract.requirements[0]!.verifiers[0]!;
    if (verifier.kind !== "http") {
      throw new Error("Fixture verifier is not HTTP");
    }
    verifier.path = "/services#pricing";
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "without a fragment",
    );
  });

  it("rejects more than 32 unique controller-requested rendered routes", () => {
    const input = assignment();
    input.contract.requirements = Array.from({ length: 33 }, (_, index) => ({
      id: `route-${index}`,
      description: `Route ${index} is reachable`,
      priority: "hard" as const,
      verifiers: [
        {
          kind: "http" as const,
          path: index === 0 ? "/" : `/route-${index}`,
          expectedStatus: 200,
          bodyIncludes: [],
        },
      ],
    }));
    expect(() => BuildAssignmentSchema.parse(input)).toThrow(
      "at most 32 are allowed",
    );
  });

  it("rejects forbidden-claim fragments that are too short to verify precisely", () => {
    const input = assignment();
    input.contract.forbiddenClaims = ["x"];
    expect(() => BuildAssignmentSchema.parse(input)).toThrow();
  });

  it("requires an explicit preview command and Docker-ready verification shape", () => {
    const input = structuredClone(assignment()) as Record<string, unknown>;
    const contract = input.contract as Record<string, unknown>;
    const verification = contract.verification as Record<string, unknown>;
    delete verification.previewCommand;
    expect(() => BuildAssignmentSchema.parse(input)).toThrow();
  });
});
