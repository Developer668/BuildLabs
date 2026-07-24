import { describe, expect, it } from "vitest";

import { redactText, redactValue } from "../src/lib/redaction.js";

describe("redaction", () => {
  it("does not corrupt UUIDs while redacting standalone phone numbers", () => {
    const uuid = "12345678-9012-4890-a123-123456789012";
    expect(redactText(uuid)).toBe(uuid);
    expect(redactText(`Call 510-555-1212; receipt ${uuid}`)).toBe(
      `Call [PHONE]; receipt ${uuid}`,
    );
  });

  it("preserves useful native Error fields without leaking secrets", () => {
    const secret = `fw_${"s".repeat(32)}`;
    const error = new Error(
      `Provider rejected Bearer ${secret} for alice@example.com`,
    );

    const redacted = redactValue(error);

    expect(redacted).not.toBeNull();
    expect(typeof redacted).toBe("object");
    const fields = redacted as Record<string, unknown>;
    expect(fields.name).toBe("Error");
    expect(fields.message).toContain("Bearer [REDACTED]");
    expect(typeof fields.stack).toBe("string");
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(redacted)).not.toContain("alice@example.com");
  });

  it.each([
    ["Braintrust", `bt_${"b".repeat(32)}`],
    ["CodeRabbit", `cr_${"c".repeat(32)}`],
    ["CopilotKit", `cpk-${"p".repeat(32)}`],
    ["Daytona", `dtn_${"d".repeat(32)}`],
    ["ElevenLabs", `sk_${"e".repeat(32)}`],
    ["Fireworks", `fw_${"f".repeat(32)}`],
  ])(
    "redacts %s credential formats in arbitrary provider errors",
    (_name, secret) => {
      const redacted = JSON.stringify(
        redactValue(new Error(`Provider failed with credential ${secret}`)),
      );

      expect(redacted).not.toContain(secret);
      expect(redacted).toContain("[REDACTED_TOKEN]");
    },
  );
});
