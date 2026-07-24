import { describe, expect, it } from "vitest";

import { daytonaTelemetryLabels } from "../src/adapters/daytona/daytona-sandbox.js";
import { loadConfig } from "../src/config.js";

describe("Daytona sandbox observability", () => {
  it("correlates Daytona telemetry with the Buildlapse run", () => {
    expect(
      daytonaTelemetryLabels("run-123", {
        projectId: "project:alpha",
        candidateId: "candidate_4",
      }),
    ).toBe(
      "buildlapse_run_id=run-123," +
        "buildlapse_project_id=project:alpha," +
        "buildlapse_candidate_id=candidate_4," +
        "buildlapse_sandbox_role=builder",
    );
  });

  it("distinguishes trusted delivery verification from builder activity", () => {
    expect(
      daytonaTelemetryLabels(
        "run-123",
        {
          projectId: "project:alpha",
          candidateId: "candidate_4",
        },
        "verifier-delivery",
      ),
    ).toContain("buildlapse_sandbox_role=verifier-delivery");
  });

  it("rejects delimiter injection into Daytona telemetry labels", () => {
    expect(() =>
      daytonaTelemetryLabels("run-123,forged=true", {
        projectId: "project:alpha",
        candidateId: "candidate_4",
      }),
    ).toThrow("Daytona telemetry label value is invalid");
  });

  it("parses the Daytona OTEL switch as an explicit boolean", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DAYTONA_API_KEY: "d".repeat(20),
      DAYTONA_OTEL_ENABLED: "true",
      FIREWORKS_API_KEY: "f".repeat(20),
      BRAINTRUST_API_KEY: "b".repeat(20),
      CODERABBIT_AUTH_MODE: "oauth",
    });

    expect(config.DAYTONA_OTEL_ENABLED).toBe(true);
  });
});
