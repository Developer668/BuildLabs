import { describe, expect, it } from "vitest";

import {
  DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION,
  resolveDaytonaSdkOtelPolicy,
} from "../src/adapters/daytona/daytona-control-plane.js";
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

  it("parses the Daytona OTEL request without treating it as policy approval", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DAYTONA_API_KEY: "d".repeat(20),
      DAYTONA_OTEL_ENABLED: "true",
      FIREWORKS_API_KEY: "f".repeat(20),
      BRAINTRUST_API_KEY: "b".repeat(20),
      CODERABBIT_AUTH_MODE: "oauth",
    });

    expect(config.DAYTONA_OTEL_ENABLED).toBe(true);
    expect(
      resolveDaytonaSdkOtelPolicy({
        requested: config.DAYTONA_OTEL_ENABLED,
        exporterConfigured: true,
        safePolicyAttestation: config.DAYTONA_OTEL_SAFE_POLICY_ATTESTATION,
      }).enabled,
    ).toBe(false);
  });

  it("requires the exact reviewed policy value before SDK OTEL can enable", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DAYTONA_API_KEY: "d".repeat(20),
      DAYTONA_OTEL_ENABLED: "true",
      DAYTONA_OTEL_SAFE_POLICY_ATTESTATION:
        DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION,
      FIREWORKS_API_KEY: "f".repeat(20),
      BRAINTRUST_API_KEY: "b".repeat(20),
      CODERABBIT_AUTH_MODE: "oauth",
    });

    expect(
      resolveDaytonaSdkOtelPolicy({
        requested: config.DAYTONA_OTEL_ENABLED,
        exporterConfigured: true,
        safePolicyAttestation: config.DAYTONA_OTEL_SAFE_POLICY_ATTESTATION,
      }).enabled,
    ).toBe(true);
  });
});
