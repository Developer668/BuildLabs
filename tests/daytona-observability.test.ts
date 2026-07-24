import { describe, expect, it } from "vitest";

import { daytonaTelemetryLabels } from "../src/adapters/daytona/daytona-sandbox.js";
import { loadConfig } from "../src/config.js";

describe("Daytona sandbox observability", () => {
  it("correlates Daytona telemetry with the BuildLabs run", () => {
    expect(
      daytonaTelemetryLabels("run-123", {
        projectId: "project:alpha",
        candidateId: "candidate_4",
      }),
    ).toBe(
      "buildlabs_run_id=run-123," +
        "buildlabs_project_id=project:alpha," +
        "buildlabs_candidate_id=candidate_4," +
        "buildlabs_sandbox_role=builder",
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
    ).toContain("buildlabs_sandbox_role=verifier-delivery");
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
