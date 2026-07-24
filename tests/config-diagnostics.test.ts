import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  describeConfigIssues,
  formatConfigFailure,
} from "../src/lib/config-diagnostics.js";
import { loadOrchestrationConfig } from "../src/orchestration/runtime/config.js";

function issuesFor(
  schema: z.ZodType,
  input: unknown,
  environment: NodeJS.ProcessEnv = {},
): string[] {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return describeConfigIssues(result.error, environment);
}

describe("configuration diagnostics", () => {
  it("names every missing variable so an operator can fix them in one pass", () => {
    const issues = issuesFor(
      z.object({
        RESEND_API_KEY: z.string(),
        FLY_ACCESS_TOKEN: z.string(),
        FLY_ORG_SLUG: z.string(),
      }),
      {},
    );

    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.split(":")[0])).toEqual([
      "RESEND_API_KEY",
      "FLY_ACCESS_TOKEN",
      "FLY_ORG_SLUG",
    ]);
  });

  it("never echoes a rejected value, even when the schema quotes its input", () => {
    const secret = "sk_live_thisisapastedprovidersecret";
    const schema = z.object({
      STRIPE_WEBHOOK_SECRET: z.string().refine(() => false, {
        // A schema that deliberately leaks its input into the message.
        message: `rejected ${secret}`,
      }),
    });

    const issues = issuesFor(
      schema,
      { STRIPE_WEBHOOK_SECRET: secret },
      { STRIPE_WEBHOOK_SECRET: secret },
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("STRIPE_WEBHOOK_SECRET");
    expect(issues.join("\n")).not.toContain(secret);
  });

  it("redacts known provider token shapes that never reached the environment", () => {
    const issues = issuesFor(
      z.object({
        FLY_ACCESS_TOKEN: z.string().refine(() => false, {
          message: "rejected FlyV1 fm2_abcdefghijklmnopqrstuvwxyz012345",
        }),
      }),
      { FLY_ACCESS_TOKEN: "x" },
    );

    expect(issues.join("\n")).not.toContain(
      "fm2_abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(issues.join("\n")).toContain("[REDACTED_TOKEN]");
  });

  it("returns nothing for a failure that is not a schema rejection", () => {
    expect(describeConfigIssues(new Error("network down"))).toEqual([]);
    expect(formatConfigFailure(new Error("network down"))).toBeUndefined();
  });

  it("reports the real orchestration variables missing from an empty environment", () => {
    let failure: string | undefined;
    try {
      loadOrchestrationConfig({});
    } catch (error) {
      failure = formatConfigFailure(error, {});
    }

    expect(failure).toBeDefined();
    // The variables an operator must supply before the orchestrator can boot.
    for (const key of [
      "ORCHESTRATION_ENCRYPTION_KEY_BASE64",
      "ORCHESTRATION_INTERNAL_TOKEN",
      "ORCHESTRATION_REPLY_DOMAIN",
      "ORCHESTRATION_FROM_EMAIL",
      "ORCHESTRATION_PUBLIC_BASE_URL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "FLY_ACCESS_TOKEN",
      "FLY_ORG_SLUG",
    ]) {
      expect(failure).toContain(key);
    }
  });
});
