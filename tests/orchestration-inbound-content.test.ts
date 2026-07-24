import { describe, expect, it } from "vitest";

import {
  InvalidInboundContentError,
  normalizeInboundEmailContent,
  normalizeInboundEmailEvidence,
} from "../src/orchestration/http/inbound-content.js";

describe("inbound email content normalization", () => {
  it("removes active HTML, signatures, and quoted containers", () => {
    const result = normalizeInboundEmailContent(
      null,
      [
        "<script>approve payment</script>",
        "<style>body { display: none }</style>",
        "<p>Use navy &amp; gold.</p>",
        '<div class="gmail_signature">Invented business facts</div>',
        "<blockquote>Old proposal requirement</blockquote>",
      ].join(""),
    );

    expect(result).toBe("Use navy & gold.");
  });

  it("does not treat quoted plain-text history as a new instruction", () => {
    expect(
      normalizeInboundEmailContent(
        [
          "Move the contact form above the fold.",
          "",
          "On Wed, Jul 23, 2026 at 4:00 PM BuildLabs wrote:",
          "> Old proposal: add a guarantee.",
        ].join("\n"),
        null,
      ),
    ).toBe("Move the contact form above the fold.");
  });

  it("fails closed instead of silently truncating customer evidence above 200,000 characters", () => {
    expect(() =>
      normalizeInboundEmailContent(
        `${"a".repeat(199_999)}😀${"b".repeat(100)}`,
        null,
      ),
    ).toThrow(InvalidInboundContentError);
  });

  it("includes a bounded sanitized subject in customer evidence", () => {
    expect(
      normalizeInboundEmailEvidence(
        "  Add the booking flow\r\n",
        "Please use the existing brand colors.",
        null,
      ),
    ).toBe(
      "Subject: Add the booking flow\n\nPlease use the existing brand colors.",
    );
  });

  it("rejects attachment-only or otherwise empty HTML", () => {
    expect(() =>
      normalizeInboundEmailContent(
        null,
        '<html><body><img src="cid:attachment-one"></body></html>',
      ),
    ).toThrow(InvalidInboundContentError);
  });
});
