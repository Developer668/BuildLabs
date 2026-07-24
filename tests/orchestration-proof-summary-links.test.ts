import { describe, expect, it } from "vitest";

import {
  InvalidProofSummaryLinkError,
  ProofSummaryLinkCodec,
} from "../src/orchestration/application/proof-summary-links.js";

const grant = {
  snapshotId: "proof-summary:8e93368fce571c426098a80ad6b31d8f",
  snapshotDigest: "a".repeat(64),
};

describe("proof-summary link capabilities", () => {
  it("creates one stable, exact-deployment capability and verifies it", () => {
    const codec = new ProofSummaryLinkCodec({
      publicBaseUrl: "https://orchestrator.buildlabs.example/api/",
      secret: Buffer.alloc(32, 11),
    });

    const first = codec.create(grant);
    const second = codec.create(grant);

    expect(first).toBe(second);
    expect(first).toMatch(
      /^https:\/\/orchestrator\.buildlabs\.example\/api\/v1\/orchestration\/proof-summaries\//,
    );
    expect(codec.parse(new URL(first).pathname.split("/").at(-1)!)).toEqual(
      grant,
    );
    expect(first).not.toContain(grant.snapshotId);
    expect(new URL(first).pathname.length).toBeLessThan(512);
  });

  it("rejects a modified capability without revealing which binding failed", () => {
    const codec = new ProofSummaryLinkCodec({
      publicBaseUrl: "https://orchestrator.buildlabs.example",
      secret: Buffer.alloc(32, 11),
    });
    const token = new URL(codec.create(grant)).pathname.split("/").at(-1)!;
    const modified = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    expect(() => codec.parse(modified)).toThrow(InvalidProofSummaryLinkError);
  });
});
