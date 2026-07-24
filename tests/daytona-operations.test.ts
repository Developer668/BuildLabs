import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  assertNoDaytonaBearerMaterial,
  benchmarkDaytonaControlPlane,
  captureDaytonaOperatorDiagnostics,
  executeDaytonaAsyncCommand,
  reconcileDaytonaOrphans,
  type DaytonaAsyncProcessPort,
  type DaytonaOperatorArtifactSink,
  type DaytonaOrphanSandbox,
} from "../src/adapters/daytona/daytona-operations.js";

function asyncProcess(
  overrides: Partial<DaytonaAsyncProcessPort> = {},
): DaytonaAsyncProcessPort {
  return {
    createSession: vi.fn().mockResolvedValue(undefined),
    executeSessionCommand: vi.fn().mockResolvedValue({
      cmdId: "provider-command-token-12345678",
    }),
    getSessionCommand: vi.fn().mockResolvedValue({}),
    getSessionCommandLogs: vi.fn().mockResolvedValue({
      stdout: "build complete",
      stderr: "",
    }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function orphanSandbox(input: {
  id: string;
  createdAt: string;
  role?: string;
  owner?: string;
  managed?: string;
  state?: string;
  autoDestroyAt?: string;
  onRefresh?: () => void;
}): DaytonaOrphanSandbox {
  const sandbox: DaytonaOrphanSandbox = {
    id: input.id,
    labels: {
      "buildlabs.owner": input.owner ?? "buildlabs-controller",
      "buildlabs.managed": input.managed ?? "true",
      "buildlabs.role": input.role ?? "builder",
    },
    createdAt: input.createdAt,
    state: input.state ?? "started",
    ...(input.autoDestroyAt ? { autoDestroyAt: input.autoDestroyAt } : {}),
    refreshData: vi.fn(() => {
      input.onRefresh?.();
      return Promise.resolve();
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return sandbox;
}

function orphanClient(sandboxes: DaytonaOrphanSandbox[]) {
  return {
    list: vi.fn(async function* () {
      await Promise.resolve();
      for (const sandbox of sandboxes) {
        yield sandbox;
      }
    }),
  };
}

describe("Daytona deterministic async execution", () => {
  it.each([
    "session creation",
    "command launch",
    "command polling",
    "command logs",
  ] as const)("bounds a never-settling %s call", async (stage) => {
    const neverSettles = new Promise<never>(() => undefined);
    const overrides: Partial<DaytonaAsyncProcessPort> = {};
    if (stage === "session creation") {
      overrides.createSession = vi.fn(() => neverSettles);
    } else if (stage === "command launch") {
      overrides.executeSessionCommand = vi.fn(() => neverSettles);
    } else if (stage === "command polling") {
      overrides.getSessionCommand = vi.fn(() => neverSettles);
    } else {
      overrides.getSessionCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
      overrides.getSessionCommandLogs = vi.fn(() => neverSettles);
    }
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const process = asyncProcess({ ...overrides, deleteSession });
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 25,
      cleanupTimeoutMilliseconds: 25,
      terminateSandbox,
      pollIntervalMilliseconds: 10,
    });

    expect(receipt).toMatchObject({
      outcome: "timed_out",
      failureCode: "timeout",
      sandboxTerminated: true,
    });
    expect(terminateSandbox).toHaveBeenCalledWith("timed_out");
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling session cleanup call", async () => {
    const process = asyncProcess({
      getSessionCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
      deleteSession: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 1_000,
      cleanupTimeoutMilliseconds: 25,
      terminateSandbox,
    });

    expect(receipt).toMatchObject({
      outcome: "failed",
      failureCode: "timeout",
      sandboxTerminated: true,
    });
    expect(terminateSandbox).toHaveBeenCalledWith("provider_failure");
  });

  it("bounds a never-settling sandbox termination call", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const process = asyncProcess({
      getSessionCommand: vi
        .fn()
        .mockRejectedValue(new Error("provider poll failed")),
      deleteSession,
    });
    const terminateSandbox = vi.fn(() => new Promise<never>(() => undefined));

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 1_000,
      cleanupTimeoutMilliseconds: 25,
      terminateSandbox,
    });

    expect(receipt).toMatchObject({
      outcome: "failed",
      sandboxTerminated: false,
    });
    expect(terminateSandbox).toHaveBeenCalledWith("provider_failure");
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("cancels a never-settling poll without waiting for the execution deadline", async () => {
    const controller = new AbortController();
    const process = asyncProcess({
      getSessionCommand: vi.fn(() => new Promise<never>(() => undefined)),
    });
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);
    const cancellation = setTimeout(() => {
      controller.abort();
    }, 10);

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 1_000,
      cleanupTimeoutMilliseconds: 25,
      terminateSandbox,
      signal: controller.signal,
    });
    clearTimeout(cancellation);

    expect(receipt).toMatchObject({
      outcome: "cancelled",
      failureCode: "aborted",
      sandboxTerminated: true,
    });
    expect(terminateSandbox).toHaveBeenCalledWith("cancelled");
  });

  it("terminates the entire sandbox and emits only opaque refs on cancellation", async () => {
    const controller = new AbortController();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const process = asyncProcess({ deleteSession });
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);
    let clock = 0;

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build -- --private-token=secret-value",
      timeoutMilliseconds: 5_000,
      terminateSandbox,
      signal: controller.signal,
      pollIntervalMilliseconds: 10,
      clock: () => clock,
      delay: (milliseconds) => {
        clock += milliseconds;
        controller.abort(new Error("operator cancelled"));
        return Promise.resolve();
      },
    });

    expect(receipt).toMatchObject({
      outcome: "cancelled",
      exitCode: null,
      sandboxTerminated: true,
    });
    expect(terminateSandbox).toHaveBeenCalledOnce();
    expect(terminateSandbox).toHaveBeenCalledWith("cancelled");
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(JSON.stringify(receipt)).not.toContain("secret-value");
    expect(JSON.stringify(receipt)).not.toContain(
      "provider-command-token-12345678",
    );
    expect(() => assertNoDaytonaBearerMaterial(receipt)).not.toThrow();
  });

  it("terminates timed-out work instead of treating session deletion as cancellation", async () => {
    const process = asyncProcess();
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);
    let clock = 0;

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 25,
      terminateSandbox,
      pollIntervalMilliseconds: 10,
      clock: () => clock,
      delay: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
    });

    expect(receipt.outcome).toBe("timed_out");
    expect(receipt.sandboxTerminated).toBe(true);
    expect(terminateSandbox).toHaveBeenCalledWith("timed_out");
  });

  it("terminates uncertain provider failures and returns a redacted receipt", async () => {
    const process = asyncProcess({
      getSessionCommand: vi
        .fn()
        .mockRejectedValue(new Error("provider poll failed")),
    });
    const terminateSandbox = vi.fn().mockResolvedValue(undefined);

    const receipt = await executeDaytonaAsyncCommand({
      process,
      command: "npm run build",
      timeoutMilliseconds: 5_000,
      terminateSandbox,
    });

    expect(receipt).toMatchObject({
      outcome: "failed",
      failureCode: "provider",
      sandboxTerminated: true,
    });
    expect(terminateSandbox).toHaveBeenCalledWith("provider_failure");
    expect(() => assertNoDaytonaBearerMaterial(receipt)).not.toThrow();
  });
});

describe("Daytona operator-only Computer Use diagnostics", () => {
  it("marks screenshots and accessibility trees permanently proof-ineligible", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const png = Buffer.from("operator screenshot");
    const sandbox = {
      computerUse: {
        start,
        stop,
        screenshot: {
          takeCompressed: vi.fn().mockResolvedValue({
            image: png.toString("base64"),
          }),
        },
        accessibility: {
          getTree: vi.fn().mockResolvedValue({
            role: "document",
            name: "operator diagnostic",
          }),
        },
      },
    } as unknown as Pick<Sandbox, "computerUse">;
    const persistedKinds: string[] = [];

    const receipt = await captureDaytonaOperatorDiagnostics({
      sandbox,
      operatorAuthorized: true,
      artifactSink: {
        persist: vi.fn(
          (artifact: Parameters<DaytonaOperatorArtifactSink["persist"]>[0]) => {
            persistedKinds.push(artifact.kind);
            return Promise.resolve({
              artifactRef: `artifact-${artifact.kind}`,
            });
          },
        ),
      },
    });

    expect(receipt.audience).toBe("operator");
    expect(receipt.proofEligible).toBe(false);
    expect(receipt.screenshot.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.accessibilityTree.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedKinds.sort()).toEqual(["accessibility-tree", "screenshot"]);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails closed when Computer Use stop fails after a successful capture", async () => {
    const stopFailure = new Error("provider stop failed");
    const stop = vi.fn().mockRejectedValue(stopFailure);
    const sandbox = {
      computerUse: {
        start: vi.fn().mockResolvedValue(undefined),
        stop,
        screenshot: {
          takeCompressed: vi.fn().mockResolvedValue({
            image: Buffer.from("operator screenshot").toString("base64"),
          }),
        },
        accessibility: {
          getTree: vi.fn().mockResolvedValue({ role: "document" }),
        },
      },
    } as unknown as Pick<Sandbox, "computerUse">;

    await expect(
      captureDaytonaOperatorDiagnostics({
        sandbox,
        operatorAuthorized: true,
        artifactSink: {
          persist: vi.fn(({ kind }) =>
            Promise.resolve({ artifactRef: `artifact-${kind}` }),
          ),
        },
      }),
    ).rejects.toBe(stopFailure);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling Computer Use stop call", async () => {
    const stop = vi.fn(() => new Promise<never>(() => undefined));
    const sandbox = {
      computerUse: {
        start: vi.fn().mockResolvedValue(undefined),
        stop,
        screenshot: {
          takeCompressed: vi.fn().mockResolvedValue({
            image: Buffer.from("operator screenshot").toString("base64"),
          }),
        },
        accessibility: {
          getTree: vi.fn().mockResolvedValue({ role: "document" }),
        },
      },
    } as unknown as Pick<Sandbox, "computerUse">;

    await expect(
      captureDaytonaOperatorDiagnostics({
        sandbox,
        operatorAuthorized: true,
        cleanupTimeoutMilliseconds: 25,
        artifactSink: {
          persist: vi.fn(({ kind }) =>
            Promise.resolve({ artifactRef: `artifact-${kind}` }),
          ),
        },
      }),
    ).rejects.toThrow("computer_use_stop exceeded its controller deadline");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("preserves capture and cleanup failures in one aggregate error", async () => {
    const captureFailure = new Error("screenshot capture failed");
    const cleanupFailure = new Error("provider stop failed");
    const stop = vi.fn().mockRejectedValue(cleanupFailure);
    const sandbox = {
      computerUse: {
        start: vi.fn().mockResolvedValue(undefined),
        stop,
        screenshot: {
          takeCompressed: vi.fn().mockRejectedValue(captureFailure),
        },
        accessibility: {
          getTree: vi.fn().mockResolvedValue({ role: "document" }),
        },
      },
    } as unknown as Pick<Sandbox, "computerUse">;
    let observedFailure: unknown;

    try {
      await captureDaytonaOperatorDiagnostics({
        sandbox,
        operatorAuthorized: true,
        artifactSink: { persist: vi.fn() },
      });
    } catch (error) {
      observedFailure = error;
    }

    expect(observedFailure).toBeInstanceOf(AggregateError);
    expect((observedFailure as AggregateError).errors).toEqual([
      captureFailure,
      cleanupFailure,
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects non-operator capture before starting Computer Use", async () => {
    const start = vi.fn();
    const sandbox = {
      computerUse: {
        start,
      },
    } as unknown as Pick<Sandbox, "computerUse">;

    await expect(
      captureDaytonaOperatorDiagnostics({
        sandbox,
        operatorAuthorized: false,
        artifactSink: {
          persist: vi.fn(),
        },
      }),
    ).rejects.toThrow("require operator access");
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://preview.example.invalid/secret" },
    { sandboxId: "sandbox-provider-id" },
    { token: "provider-token-value" },
    { authorization: "Bearer provider-token-value" },
    { nested: { toolboxProxyUrl: "wss://proxy.example.invalid" } },
  ])("rejects bearer-bearing public records", (value) => {
    expect(() => assertNoDaytonaBearerMaterial(value)).toThrow(
      "provider bearer material",
    );
  });
});

describe("Daytona orphan reconciliation", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z");
  const OLD = "2026-07-24T09:00:00.000Z";
  const YOUNG = "2026-07-24T11:30:00.000Z";
  const GRACE = 60 * 60 * 1_000;

  it("defaults to dry-run and revalidates ownership, age, role, and active state", async () => {
    const eligible = orphanSandbox({
      id: "raw-sandbox-id-12345678",
      createdAt: OLD,
    });
    const active = orphanSandbox({ id: "active", createdAt: OLD });
    const young = orphanSandbox({ id: "young", createdAt: YOUNG });
    const wrongRole = orphanSandbox({
      id: "wrong-role",
      createdAt: OLD,
      role: "unmanaged-role",
    });
    const staleOwnership = orphanSandbox({
      id: "ownership-changed",
      createdAt: OLD,
    });
    staleOwnership.refreshData = vi.fn(() => {
      staleOwnership.labels["buildlabs.owner"] = "another-controller";
      return Promise.resolve();
    });
    const client = orphanClient([
      eligible,
      active,
      young,
      wrongRole,
      staleOwnership,
    ]);

    const report = await reconcileDaytonaOrphans({
      client,
      activeSandboxIds: new Set(["active"]),
      gracePeriodMs: GRACE,
      now: NOW,
    });

    expect(report).toMatchObject({
      mode: "dry_run",
      scanned: 5,
      eligible: 1,
      deleted: 0,
      skippedActive: 1,
      skippedUnowned: 3,
      failures: [],
    });
    expect(report.eligibleResourceRefs).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("raw-sandbox-id-12345678");
    expect(client.list).toHaveBeenCalledWith({
      labels: {
        "buildlabs.owner": "buildlabs-controller",
        "buildlabs.managed": "true",
      },
      createdAtBefore: new Date("2026-07-24T11:00:00.000Z"),
    });
  });

  it("deletes only a refreshed controller-owned orphan after explicit opt-in", async () => {
    const eligible = orphanSandbox({ id: "eligible-delete", createdAt: OLD });
    const active = orphanSandbox({ id: "active-delete", createdAt: OLD });

    const report = await reconcileDaytonaOrphans({
      client: orphanClient([eligible, active]),
      activeSandboxIds: new Set(["active-delete"]),
      gracePeriodMs: GRACE,
      dryRun: false,
      now: NOW,
    });

    expect(report).toMatchObject({
      mode: "delete",
      eligible: 1,
      deleted: 1,
      skippedActive: 1,
    });
    expect(report.deleted).toBe(1);
  });

  it("preserves a live frozen preview until its provider TTL expires", async () => {
    const livePreview = orphanSandbox({
      id: "live-preview",
      createdAt: OLD,
      role: "frozen-preview",
      autoDestroyAt: "2026-07-24T13:00:00.000Z",
    });
    const expiredPreview = orphanSandbox({
      id: "expired-preview",
      createdAt: OLD,
      role: "frozen-preview",
      autoDestroyAt: "2026-07-24T11:30:00.000Z",
    });

    const report = await reconcileDaytonaOrphans({
      client: orphanClient([livePreview, expiredPreview]),
      activeSandboxIds: new Set(),
      gracePeriodMs: GRACE,
      dryRun: false,
      now: NOW,
    });

    expect(report).toMatchObject({
      eligible: 1,
      deleted: 1,
      skippedLivePreview: 1,
    });
  });
});

describe("Daytona benchmark isolation", () => {
  it("reports cold, verified pool, and isolated proof timings independently", async () => {
    const report = await benchmarkDaytonaControlPlane({
      iterations: 2,
      coldCreation: vi
        .fn()
        .mockResolvedValueOnce({ durationMs: 120, resourceRef: "cold-1" })
        .mockResolvedValueOnce({ durationMs: 100, resourceRef: "cold-2" }),
      warmClaim: vi
        .fn()
        .mockResolvedValueOnce({
          durationMs: 30,
          resourceRef: "warm-1",
          claim: "verified_pool_hit",
        })
        .mockResolvedValueOnce({
          durationMs: 20,
          resourceRef: "warm-2",
          claim: "verified_pool_hit",
        }),
      proofCompletion: vi.fn().mockResolvedValue({
        durationMs: 250,
        builderRef: "builder",
        commandVerifierRef: "commands",
        deliveryVerifierRef: "delivery",
        snapshotAttestationSha256: "a".repeat(64),
        sourceDigest: "b".repeat(64),
        browserVersion: "Chromium 140.0",
        screenshotSha256s: ["c".repeat(64)],
        networkBlockAllVerified: true,
        chromiumProofVerified: true,
        frozenPreviewVerified: true,
      }),
    });

    expect(report.isolationPreserved).toBe(true);
    expect(report.samples).toEqual({
      coldCreationMs: [120, 100],
      verifiedWarmClaimMs: [30, 20],
      proofCompletionMs: [250, 250],
    });
    expect(report.summary.verifiedWarmClaim).toMatchObject({
      count: 2,
      minMs: 20,
      maxMs: 30,
    });
  });

  it("refuses to benchmark an inferred warm claim", async () => {
    await expect(
      benchmarkDaytonaControlPlane({
        iterations: 1,
        coldCreation: () =>
          Promise.resolve({
            durationMs: 100,
            resourceRef: "cold",
          }),
        warmClaim: () =>
          Promise.resolve({
            durationMs: 20,
            resourceRef: "warm",
            claim: "verified_cold_create" as never,
          }),
        proofCompletion: () =>
          Promise.resolve({
            durationMs: 250,
            builderRef: "builder",
            commandVerifierRef: "commands",
            deliveryVerifierRef: "delivery",
            snapshotAttestationSha256: "a".repeat(64),
            sourceDigest: "b".repeat(64),
            browserVersion: "Chromium 140.0",
            screenshotSha256s: ["c".repeat(64)],
            networkBlockAllVerified: true,
            chromiumProofVerified: true,
            frozenPreviewVerified: true,
          }),
      }),
    ).rejects.toThrow("cannot infer a warm-pool hit");
  });

  it("reports warm-pool timing unavailable without fabricating a claim", async () => {
    const report = await benchmarkDaytonaControlPlane({
      iterations: 1,
      coldCreation: () =>
        Promise.resolve({ durationMs: 100, resourceRef: "cold" }),
      proofCompletion: () =>
        Promise.resolve({
          durationMs: 250,
          builderRef: "builder",
          commandVerifierRef: "commands",
          deliveryVerifierRef: "delivery",
          snapshotAttestationSha256: "a".repeat(64),
          sourceDigest: "b".repeat(64),
          browserVersion: "Chromium 140.0",
          screenshotSha256s: ["c".repeat(64)],
          networkBlockAllVerified: true,
          chromiumProofVerified: true,
          frozenPreviewVerified: true,
        }),
    });

    expect(report.warmPoolState).toBe("unavailable");
    expect(report.samples.verifiedWarmClaimMs).toEqual([]);
    expect(report.summary).not.toHaveProperty("verifiedWarmClaim");
  });

  it.each([
    {
      builderRef: "same",
      commandVerifierRef: "same",
      deliveryVerifierRef: "delivery",
      networkBlockAllVerified: true,
      chromiumProofVerified: true,
      frozenPreviewVerified: true,
    },
    {
      builderRef: "builder",
      commandVerifierRef: "commands",
      deliveryVerifierRef: "delivery",
      networkBlockAllVerified: false,
      chromiumProofVerified: true,
      frozenPreviewVerified: true,
    },
    {
      builderRef: "builder",
      commandVerifierRef: "commands",
      deliveryVerifierRef: "delivery",
      networkBlockAllVerified: true,
      chromiumProofVerified: false,
      frozenPreviewVerified: true,
    },
    {
      builderRef: "builder",
      commandVerifierRef: "commands",
      deliveryVerifierRef: "delivery",
      sourceDigest: "not-a-controller-digest",
      networkBlockAllVerified: true,
      chromiumProofVerified: true,
      frozenPreviewVerified: true,
    },
    {
      builderRef: "builder",
      commandVerifierRef: "commands",
      deliveryVerifierRef: "delivery",
      networkBlockAllVerified: true,
      chromiumProofVerified: true,
      frozenPreviewVerified: false,
    },
  ])("fails closed when proof isolation is not preserved", async (proof) => {
    await expect(
      benchmarkDaytonaControlPlane({
        iterations: 1,
        coldCreation: () =>
          Promise.resolve({
            durationMs: 100,
            resourceRef: "cold",
          }),
        warmClaim: () =>
          Promise.resolve({
            durationMs: 20,
            resourceRef: "warm",
            claim: "verified_pool_hit",
          }),
        proofCompletion: () =>
          Promise.resolve({
            durationMs: 250,
            snapshotAttestationSha256: "a".repeat(64),
            sourceDigest: "b".repeat(64),
            browserVersion: "Chromium 140.0",
            screenshotSha256s: ["c".repeat(64)],
            ...proof,
          }),
      }),
    ).rejects.toThrow("did not preserve proof isolation");
  });
});
