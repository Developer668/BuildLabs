import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDaytonaReadinessReport,
  classifyDaytonaFailure,
  createDaytonaRoleAcquisitionPolicy,
  DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION,
  evaluateDaytonaWarmPoolEligibility,
  parseDaytonaWarmPoolRoles,
  resolveDaytonaSdkOtelPolicy,
  verifyDaytonaWarmPoolClaim,
  type DaytonaReadinessEvidence,
  type DaytonaWarmPoolCreateRequest,
  type DaytonaWarmSandboxObservation,
} from "../src/adapters/daytona/daytona-control-plane.js";
import {
  assertDaytonaSnapshotAttestation,
  assertDaytonaProvisionerSource,
  assertDaytonaSnapshotRuntime,
  assertFreshDaytonaSnapshotAttestation,
  createDaytonaSnapshotAttestation,
  DAYTONA_PINNED_SNAPSHOT_INPUTS,
  DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA,
  type DaytonaSnapshotAttestationPayload,
} from "../src/adapters/daytona/daytona-snapshot-attestation.js";
import { daytonaScriptFailureRecord } from "../src/adapters/daytona/daytona-script-safety.js";
import { DaytonaJsonlTelemetry } from "../src/adapters/daytona/daytona-telemetry.js";
import { sha256 } from "../src/lib/canonical-json.js";

const SNAPSHOT = "buildlabs-dind-browser-v2";
const TARGET = "us";
const VALIDATED_AT = "2026-07-24T12:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function acquisitionPolicy() {
  return createDaytonaRoleAcquisitionPolicy({
    role: "verifier-delivery",
    snapshot: SNAPSHOT,
    target: TARGET,
    snapshotResources: {
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 10,
    },
    warmPoolEnabled: true,
  });
}

function warmSandbox(
  overrides: Partial<DaytonaWarmSandboxObservation> = {},
): DaytonaWarmSandboxObservation {
  return {
    id: "sandbox-warm-1",
    warmPoolId: "pool-1",
    snapshot: SNAPSHOT,
    target: TARGET,
    user: "daytona",
    cpu: 2,
    memoryGiB: 4,
    diskGiB: 10,
    ...overrides,
  };
}

function attestationPayload(
  overrides: {
    snapshotName?: string;
    snapshotId?: string;
    chromiumVersion?: string;
    validatedAt?: string;
  } = {},
): DaytonaSnapshotAttestationPayload {
  return {
    schema: DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA,
    provisionerSourceSha256: SHA_A,
    imageInputs: DAYTONA_PINNED_SNAPSHOT_INPUTS,
    snapshot: {
      id: overrides.snapshotId ?? "snapshot-1",
      name: overrides.snapshotName ?? SNAPSHOT,
      state: "active",
      imageName: "docker",
      ref: "docker:28.3.3-dind",
      sandboxClass: "container",
      regionIds: [TARGET],
      resources: {
        cpu: 2,
        memoryGiB: 4,
        diskGiB: 10,
      },
      buildInfo: {
        snapshotRef: "snapshot-ref",
        dockerfileSha256: SHA_B,
        contextHashesSha256: SHA_C,
      },
      createdAt: "2026-07-24T11:00:00.000Z",
      updatedAt: VALIDATED_AT,
    },
    validation: {
      validatedAt: overrides.validatedAt ?? VALIDATED_AT,
      chromiumVersion: overrides.chromiumVersion ?? "Chromium 140.0.7339.80",
      dockerServerVersion: "28.3.3",
      dindReady: true,
      renderedChromiumProof: true,
      staleDomRaceBlocked: true,
      signedPreviewIngress: true,
      resourceMetrics: {
        latest: true,
        historical: true,
      },
      networkBlockAll: {
        directIpEgressBlocked: true,
        registryEgressBlocked: true,
        loopbackPreserved: true,
        reappliedAfterRestart: true,
      },
    },
  };
}

function readinessEvidence(
  overrides: Partial<DaytonaReadinessEvidence> = {},
): DaytonaReadinessEvidence {
  return {
    checkedAt: VALIDATED_AT,
    apiConfigured: true,
    apiReachable: true,
    sdkVersion: "0.200.1",
    expectedSnapshot: SNAPSHOT,
    snapshot: {
      name: SNAPSHOT,
      state: "active",
      target: TARGET,
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 10,
    },
    snapshotAttestation: "runtime_verified",
    attestedProbe: {
      payloadSha256: SHA_A,
      validatedAt: VALIDATED_AT,
    },
    lifecycleTransport: "event_stream_observed",
    signedPreviewProbe: "passed",
    metrics: {
      latest: "passed",
      historical: "passed",
    },
    sdkOtel: {
      enabled: true,
      exporterConfigured: true,
      contentPolicyAttested: true,
      exportProbe: "passed",
    },
    sandboxOtel: {
      accountConfigured: true,
      contentPolicyAttested: true,
      exportProbe: "passed",
    },
    warmPoolRoles: ["verifier-delivery"],
    warmPools: [
      {
        snapshot: SNAPSHOT,
        target: TARGET,
        desiredSize: 1,
        readySize: 1,
      },
    ],
    accountLimits: {
      source: "account_api",
      snapshots: { used: 1, limit: 100 },
      volumes: { used: 0, limit: 100 },
    },
    computerUseProbe: "passed",
    customPreviewProxyConfigured: false,
    ...overrides,
  };
}

describe("Daytona warm-pool acquisition policy", () => {
  it("permits only an exact snapshot request with provider defaults", () => {
    const result = evaluateDaytonaWarmPoolEligibility(acquisitionPolicy(), {
      snapshot: SNAPSHOT,
      target: TARGET,
    });

    expect(result).toMatchObject({
      eligible: true,
      reasonCodes: [],
    });
    expect(result.policySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("makes a cold benchmark request pool-ineligible only by its environment", () => {
    const result = evaluateDaytonaWarmPoolEligibility(acquisitionPolicy(), {
      snapshot: SNAPSHOT,
      target: TARGET,
      envVars: {
        BUILDLABS_BENCHMARK_FORCE_COLD: "true",
      },
    });

    expect(result).toMatchObject({
      eligible: false,
      reasonCodes: ["custom_environment"],
    });
  });

  it("rejects warm-pool configuration for unique frozen previews", () => {
    expect(() =>
      parseDaytonaWarmPoolRoles("verifier-delivery,frozen-preview"),
    ).toThrow("not warm-pool eligible");
  });

  it.each<[string, DaytonaWarmPoolCreateRequest, string]>([
    [
      "wrong snapshot",
      { snapshot: "other-snapshot", target: TARGET },
      "snapshot_mismatch",
    ],
    ["wrong target", { snapshot: SNAPSHOT, target: "eu" }, "target_mismatch"],
    [
      "custom user",
      { snapshot: SNAPSHOT, target: TARGET, user: "root" },
      "custom_user",
    ],
    [
      "custom resources",
      { snapshot: SNAPSHOT, target: TARGET, resources: { cpu: 2 } },
      "custom_resources",
    ],
    [
      "environment injection",
      { snapshot: SNAPSHOT, target: TARGET, envVars: { RUN_ID: "run-1" } },
      "custom_environment",
    ],
    [
      "mounted state",
      { snapshot: SNAPSHOT, target: TARGET, volumes: [{}] },
      "custom_volumes",
    ],
    [
      "sandbox secret",
      { snapshot: SNAPSHOT, target: TARGET, secrets: { TOKEN: "redacted" } },
      "custom_secrets",
    ],
    [
      "mutable builder linkage",
      {
        snapshot: SNAPSHOT,
        target: TARGET,
        linkedSandbox: "builder-sandbox",
      },
      "linked_sandbox",
    ],
  ])("rejects %s as pool-ineligible", (_name, request, reasonCode) => {
    const result = evaluateDaytonaWarmPoolEligibility(
      acquisitionPolicy(),
      request,
    );

    expect(result.eligible).toBe(false);
    expect(result.reasonCodes).toContain(reasonCode);
  });

  it("does not report a pool hit without a pre-claim inventory", () => {
    const result = verifyDaytonaWarmPoolClaim({
      returnedSandbox: warmSandbox(),
      policy: acquisitionPolicy(),
      observedAt: VALIDATED_AT,
    });

    expect(result.outcome).toBe("unobserved");
    expect(result).not.toHaveProperty("evidenceSha256");
    expect(JSON.stringify(result)).not.toContain("sandbox-warm-1");
  });

  it("keeps a pre-list miss unobserved and proves only an exact pool claim", () => {
    const racedOrCold = verifyDaytonaWarmPoolClaim({
      before: [warmSandbox({ id: "different-warm-sandbox" })],
      returnedSandbox: warmSandbox(),
      policy: acquisitionPolicy(),
      observedAt: VALIDATED_AT,
    });
    const pooled = verifyDaytonaWarmPoolClaim({
      before: [warmSandbox()],
      returnedSandbox: warmSandbox(),
      policy: acquisitionPolicy(),
      observedAt: VALIDATED_AT,
    });

    expect(racedOrCold.outcome).toBe("unobserved");
    expect(pooled.outcome).toBe("verified_pool_hit");
    expect(pooled.evidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["snapshot", { snapshot: "wrong-snapshot" }],
    ["target", { target: "eu" }],
    ["user", { user: "root" }],
    ["cpu", { cpu: 4 }],
    ["memory", { memoryGiB: 8 }],
    ["disk", { diskGiB: 20 }],
  ])("fails closed when the observed pool %s drifts", (_name, drift) => {
    expect(() =>
      verifyDaytonaWarmPoolClaim({
        before: [warmSandbox(drift)],
        returnedSandbox: warmSandbox(),
        policy: acquisitionPolicy(),
        observedAt: VALIDATED_AT,
      }),
    ).toThrow("did not match");
  });

  it("rejects a mutually consistent claim from the wrong policy target", () => {
    const wrongTarget = warmSandbox({ target: "eu" });

    expect(() =>
      verifyDaytonaWarmPoolClaim({
        before: [wrongTarget],
        returnedSandbox: wrongTarget,
        policy: acquisitionPolicy(),
        observedAt: VALIDATED_AT,
      }),
    ).toThrow("did not match");
  });
});

describe("Daytona snapshot supply-chain attestations", () => {
  it("rejects a payload whose signed digest no longer matches", () => {
    const valid = createDaytonaSnapshotAttestation(attestationPayload());
    const tampered = structuredClone(valid);
    tampered.payload.validation.chromiumVersion = "Chromium 999.0.0.0";

    expect(() => assertDaytonaSnapshotAttestation(tampered)).toThrow(
      "digest does not match",
    );
  });

  it("rejects stale and future validation records", () => {
    const stale = createDaytonaSnapshotAttestation(
      attestationPayload({ validatedAt: "2026-07-01T00:00:00.000Z" }),
    );
    const future = createDaytonaSnapshotAttestation(
      attestationPayload({ validatedAt: "2026-07-24T12:02:00.000Z" }),
    );

    expect(() =>
      assertFreshDaytonaSnapshotAttestation(
        stale,
        new Date(VALIDATED_AT),
        7 * 24 * 60 * 60 * 1_000,
      ),
    ).toThrow("stale");
    expect(() =>
      assertFreshDaytonaSnapshotAttestation(future, new Date(VALIDATED_AT)),
    ).toThrow("stale");
  });

  it.each([
    [
      "wrong snapshot identity",
      {
        snapshotId: "snapshot-2",
        snapshotName: SNAPSHOT,
        chromiumVersion: "Chromium 140.0.7339.80",
      },
      "identity drifted",
    ],
    [
      "wrong snapshot name",
      {
        snapshotId: "snapshot-1",
        snapshotName: "other-snapshot",
        chromiumVersion: "Chromium 140.0.7339.80",
      },
      "identity drifted",
    ],
    [
      "wrong browser",
      {
        snapshotId: "snapshot-1",
        snapshotName: SNAPSHOT,
        chromiumVersion: "Chromium 141.0.0.0",
      },
      "runtime drifted",
    ],
  ])("rejects runtime drift: %s", (_name, observation, message) => {
    const attestation = createDaytonaSnapshotAttestation(attestationPayload());

    expect(() =>
      assertDaytonaSnapshotRuntime(
        attestation,
        {
          ...observation,
          target: TARGET,
          resources: {
            cpu: 2,
            memoryGiB: 4,
            diskGiB: 10,
          },
          dockerServerVersion: "28.3.3",
        },
        SNAPSHOT,
        TARGET,
      ),
    ).toThrow(message);
  });

  it("rejects image-input policy drift even with a recomputed digest", () => {
    const payload = structuredClone(attestationPayload());
    Object.assign(payload.imageInputs as unknown as { baseImage: string }, {
      baseImage: "docker:latest",
    });

    expect(() => createDaytonaSnapshotAttestation(payload)).toThrow(
      "image inputs drifted",
    );
  });

  it("binds snapshot resources to the pinned image inputs", () => {
    const payload = structuredClone(attestationPayload());
    payload.snapshot.resources.cpu = 4;

    expect(() => createDaytonaSnapshotAttestation(payload)).toThrow(
      "resources drifted",
    );
  });

  it("rejects provisioner source drift", () => {
    const source = Buffer.from("pinned provisioner", "utf8");
    const payload = attestationPayload();
    payload.provisionerSourceSha256 = sha256(source);
    const attestation = createDaytonaSnapshotAttestation(payload);

    expect(() =>
      assertDaytonaProvisionerSource(
        attestation,
        Buffer.from("changed provisioner", "utf8"),
      ),
    ).toThrow("source drifted");
  });

  it("rejects a forged attestation object with a malformed digest", () => {
    const forged = {
      payload: attestationPayload(),
      payloadSha256: "0".repeat(64),
    };

    expect(() => assertDaytonaSnapshotAttestation(forged)).toThrow(
      "digest does not match",
    );
  });
});

describe("Daytona capability state boundaries", () => {
  it("redacts script failures to a classified content-free record", () => {
    const failure = new Error(
      "authorization: Bearer provider-secret https://preview.example",
    );

    expect(daytonaScriptFailureRecord("benchmark", failure)).toEqual({
      schema: "buildlabs.daytona.script-failure.v1",
      script: "benchmark",
      outcome: "failed",
      failureCode: "provider",
    });
  });

  it("reports polling fallback separately from event-stream verification", () => {
    const report = buildDaytonaReadinessReport(
      readinessEvidence({
        lifecycleTransport: "polling_fallback_observed",
      }),
    );

    expect(report.capabilities.lifecycleEventTransport).toMatchObject({
      state: "degraded",
      reasonCode: "polling_fallback_observed",
    });
  });

  it("timestamps attested signed-preview and metric evidence", () => {
    const report = buildDaytonaReadinessReport(readinessEvidence());

    expect(report.capabilities.signedPreviews).toMatchObject({
      state: "end_to_end_verified",
      evidenceValidatedAt: VALIDATED_AT,
    });
    expect(report.capabilities.metrics).toMatchObject({
      state: "end_to_end_verified",
      evidenceValidatedAt: VALIDATED_AT,
    });
  });

  it.each([
    ["undersized disk", { cpu: 2, memoryGiB: 4, diskGiB: 8 }],
    ["oversized CPU", { cpu: 4, memoryGiB: 4, diskGiB: 10 }],
    ["oversized memory", { cpu: 2, memoryGiB: 8, diskGiB: 10 }],
  ])("rejects %s from exact pinned resource readiness", (_name, resources) => {
    const evidence = readinessEvidence();
    evidence.snapshot = {
      ...evidence.snapshot!,
      ...resources,
    };

    const report = buildDaytonaReadinessReport(evidence);

    expect(report.capabilities.regionResources).toMatchObject({
      state: "degraded",
      reasonCode: "snapshot_policy_mismatch",
    });
  });

  it("keeps SDK OTEL disabled until every safe-export gate is explicit", () => {
    expect(
      resolveDaytonaSdkOtelPolicy({
        requested: true,
        exporterConfigured: true,
      }),
    ).toEqual({
      requested: true,
      enabled: false,
      exporterConfigured: true,
      contentPolicyAttested: false,
    });
    expect(
      resolveDaytonaSdkOtelPolicy({
        requested: true,
        exporterConfigured: true,
        safePolicyAttestation: DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION,
      }),
    ).toEqual({
      requested: true,
      enabled: true,
      exporterConfigured: true,
      contentPolicyAttested: true,
    });
  });

  it("reports a requested but policy-blocked SDK OTEL export as degraded", () => {
    const report = buildDaytonaReadinessReport(
      readinessEvidence({
        sdkOtel: {
          requested: true,
          enabled: false,
          exporterConfigured: true,
          contentPolicyAttested: false,
        },
      }),
    );

    expect(report.capabilities.sdkOtel).toMatchObject({
      state: "degraded",
      reasonCode: "sdk_otel_content_policy_unattested",
    });
  });

  it("requires a successful persistent write before verifying controller telemetry", () => {
    const notProbed = buildDaytonaReadinessReport(
      readinessEvidence({
        controllerTelemetry: {
          persistent: true,
          writeProbe: "not_probed",
        },
      }),
    );
    const verified = buildDaytonaReadinessReport(
      readinessEvidence({
        controllerTelemetry: {
          persistent: true,
          writeProbe: "passed",
        },
      }),
    );

    expect(notProbed.capabilities.controllerTelemetry).toMatchObject({
      state: "configured",
      reasonCode: "controller_telemetry_write_not_probed",
    });
    expect(verified.capabilities.controllerTelemetry).toMatchObject({
      state: "end_to_end_verified",
      reasonCode: "controller_telemetry_write_verified",
    });
  });

  it.each([
    [
      "failed export",
      {
        enabled: true,
        exporterConfigured: true,
        contentPolicyAttested: true,
        exportProbe: "failed" as const,
      },
      "sdk_otel_export_failed",
    ],
    [
      "unattested content policy",
      {
        enabled: true,
        exporterConfigured: true,
        contentPolicyAttested: false,
      },
      "sdk_otel_content_policy_unattested",
    ],
  ])("keeps SDK OTEL degraded for %s", (_name, sdkOtel, reasonCode) => {
    const report = buildDaytonaReadinessReport(readinessEvidence({ sdkOtel }));

    expect(report.capabilities.sdkOtel).toMatchObject({
      state: "degraded",
      reasonCode,
    });
  });

  it("does not confuse a configured but unprobed transport with health", () => {
    const evidence = readinessEvidence({
      lifecycleTransport: "automatic_unobserved",
    });
    delete evidence.signedPreviewProbe;
    delete evidence.metrics;
    const report = buildDaytonaReadinessReport(evidence);

    expect(report.capabilities.lifecycleEventTransport.state).toBe(
      "configured",
    );
    expect(report.capabilities.signedPreviews.state).toBe("configured");
    expect(report.capabilities.metrics.state).toBe("configured");
  });

  it.each([
    [
      "regional quota",
      {
        source: "account_api" as const,
        regions: [
          {
            target: TARGET,
            sandboxClass: "container",
            cpu: { used: 100, limit: 100 },
            memoryGiB: { used: 20, limit: 200 },
            diskGiB: { used: 10, limit: 300 },
            perSandbox: {},
          },
        ],
      },
      "account_quota_exhausted",
    ],
    [
      "rate limit",
      {
        source: "response_headers" as const,
        rateLimit: { remaining: 0 },
      },
      "account_rate_limit_exhausted",
    ],
  ])(
    "degrades readiness when the %s is exhausted",
    (_name, accountLimits, reasonCode) => {
      const report = buildDaytonaReadinessReport(
        readinessEvidence({ accountLimits }),
      );

      expect(report.capabilities.accountLimits).toMatchObject({
        state: "degraded",
        reasonCode,
      });
    },
  );

  it("does not label API-backed capabilities configured without an API", () => {
    const report = buildDaytonaReadinessReport(
      readinessEvidence({
        apiConfigured: false,
        apiReachable: false,
      }),
    );

    expect(report.capabilities.lifecycleEventTransport.state).toBe(
      "unconfigured",
    );
    expect(report.capabilities.signedPreviews.state).toBe("unconfigured");
    expect(report.capabilities.metrics.state).toBe("unconfigured");
    expect(report.capabilities.computerUseDiagnostics.state).toBe(
      "unconfigured",
    );
  });

  it.each([
    [
      Object.assign(new Error("provider"), { name: "DaytonaTimeoutError" }),
      "timeout",
    ],
    [new Error("snapshot attestation mismatch"), "attestation"],
    [new Error("OTEL export failed"), "otel_export"],
  ])("redacts provider failures into %s codes", (error, expected) => {
    expect(classifyDaytonaFailure(error)).toBe(expected);
  });
});

describe("Daytona persistent telemetry", () => {
  it("persists only the validated content-free event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildlabs-daytona-otel-"));
    const path = join(directory, "telemetry.jsonl");
    try {
      const telemetry = new DaytonaJsonlTelemetry(path);
      telemetry.emit({
        schema: "buildlabs.daytona.telemetry.v1",
        emittedAt: VALIDATED_AT,
        event: "metrics",
        labels: {
          runId: "run-1",
          projectId: "project-1",
          candidateId: "candidate-1",
          role: "verifier-delivery",
        },
        outcome: "observed",
        values: { cpu_used_pct: 12 },
      });
      await telemetry.flush();

      const record = JSON.parse(
        (await readFile(path, "utf8")).trim(),
      ) as Record<string, unknown>;
      expect(record).toMatchObject({
        schema: "buildlabs.daytona.telemetry.v1",
        event: "metrics",
        outcome: "observed",
      });
      expect(telemetry.failureCode()).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a redacted failure code when persistent export fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buildlabs-daytona-otel-"));
    const blockingPath = join(directory, "not-a-directory");
    try {
      await writeFile(blockingPath, "blocked");
      const telemetry = new DaytonaJsonlTelemetry(
        join(blockingPath, "telemetry.jsonl"),
      );
      telemetry.emit({
        schema: "buildlabs.daytona.telemetry.v1",
        emittedAt: VALIDATED_AT,
        event: "lifecycle",
        labels: {
          runId: "run-1",
          projectId: "project-1",
          candidateId: "candidate-1",
          role: "builder",
        },
        outcome: "failed",
        failureCode: "provider",
      });
      await telemetry.flush();

      expect(telemetry.failureCode()).toBe("otel_export");
      await expect(telemetry.flushOrThrow()).rejects.toThrow(
        "persistent telemetry flush failed (otel_export)",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
