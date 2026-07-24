import { describe, expect, it } from "vitest";

import {
  PiiSpanSchema,
  identifyAndMinimizePii,
} from "../src/orchestration/application/pii.js";

describe("identifyAndMinimizePii", () => {
  it("merges deterministic contact detection with model-classified PII and preserves offsets", () => {
    const input =
      "I am Jordan Lee. Email jordan@example.com or call +1 (510) 555-0199. Mission Peak Electric serves Fremont.";
    const nameStart = input.indexOf("Jordan Lee");
    const result = identifyAndMinimizePii(input, [
      PiiSpanSchema.parse({
        type: "person_name",
        startOffset: nameStart,
        endOffset: nameStart + "Jordan Lee".length,
        confidence: 0.99,
      }),
    ]);

    expect(result.minimized).toHaveLength(input.length);
    expect(result.minimized).not.toContain("Jordan Lee");
    expect(result.minimized).not.toContain("jordan@example.com");
    expect(result.minimized).not.toContain("(510) 555-0199");
    expect(result.minimized).toContain("Mission Peak Electric serves Fremont.");
    expect(result.findings.map((finding) => finding.type)).toEqual(
      expect.arrayContaining(["person_name", "email", "phone"]),
    );
  });

  it("rejects model spans that do not resolve inside the source text", () => {
    expect(() =>
      identifyAndMinimizePii("short", [
        {
          type: "address",
          startOffset: 0,
          endOffset: 20,
          confidence: 0.9,
        },
      ]),
    ).toThrow();
  });

  it("deterministically removes government, financial, card, and postal identifiers even when the model omits them", () => {
    const input =
      "SSN 123-45-6789, card 4242 4242 4242 4242, account number: ABCD 12345678, home 123 Main Street Apt 4.";
    const result = identifyAndMinimizePii(input, []);

    expect(result.minimized).not.toContain("123-45-6789");
    expect(result.minimized).not.toContain("4242 4242 4242 4242");
    expect(result.minimized).not.toContain("ABCD 12345678");
    expect(result.minimized).not.toContain("123 Main Street");
    expect(result.findings.map((finding) => finding.type)).toEqual(
      expect.arrayContaining(["government_id", "financial", "address"]),
    );
  });
});
