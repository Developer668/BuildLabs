import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaytonaNotFoundError, type Daytona, type Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  assembleReadableGraphemeText,
  assertObservableInteractionTransition,
  canReuseRenderedTileProof,
  cleanupFailedDaytonaSandbox,
  DaytonaDockerRuntimeError,
  DaytonaSandboxProvider,
  DaytonaSandboxSession,
  decideProofNetworkRequest,
  deleteDaytonaSessionIfPresent,
  deliveryContainerRunCommand,
  executeBoundedSandboxCommandAsync,
  executeBoundedSandboxCommand,
  ensureDockerRuntime,
  hasSufficientReadablePixelEvidence,
  initializeDaytonaSandboxWithDockerRetry,
  normalizeSameOriginRoutePaths,
  parseRenderedPageInspectionOutput,
  planScrollTileOffsets,
  recaptureExactPixelBaseline,
  RENDERED_PAGE_INSPECTOR_SOURCE,
} from "../src/adapters/daytona/daytona-sandbox.js";
import {
  createDaytonaSnapshotAttestation,
  DAYTONA_PINNED_SNAPSHOT_INPUTS,
  DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA,
  writeDaytonaSnapshotAttestation,
} from "../src/adapters/daytona/daytona-snapshot-attestation.js";
import type { AppConfig } from "../src/config.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { assignment } from "./fixtures.js";

const screenshotTile = (label: string) => {
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(label),
  ]);
  return {
    digest: sha256(bytes),
    base64: bytes.toString("base64"),
  };
};
const TILE_ONE = screenshotTile("one");
const TILE_TWO = screenshotTile("two");

function commandEnvelope(stdout: string, exitCode = 0): string {
  const bytes = Buffer.from(stdout, "utf8");
  return [
    "BUILDLABS_COMMAND_RESULT_V1",
    String(exitCode),
    String(bytes.byteLength),
    "0",
    String(bytes.byteLength),
    "0",
    bytes.toString("base64"),
    "",
    "",
  ].join("\n");
}

function pixelBaselinePage(captures: readonly Buffer[]) {
  let captureIndex = 0;
  return {
    waitForTimeout: vi.fn(() => Promise.resolve()),
    screenshot: vi.fn(() => {
      const capture = captures[captureIndex];
      captureIndex += 1;
      return capture
        ? Promise.resolve(capture)
        : Promise.reject(new Error("Unexpected pixel-baseline capture"));
    }),
  };
}

async function writeFreshSnapshotAttestation(
  directory: string,
  snapshotName: string,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const path = join(directory, "snapshot-attestation.json");
  await writeDaytonaSnapshotAttestation(
    path,
    createDaytonaSnapshotAttestation({
      schema: DAYTONA_SNAPSHOT_ATTESTATION_SCHEMA,
      provisionerSourceSha256: "a".repeat(64),
      imageInputs: DAYTONA_PINNED_SNAPSHOT_INPUTS,
      snapshot: {
        id: "snapshot-provider-id",
        name: snapshotName,
        state: "active",
        ref: DAYTONA_PINNED_SNAPSHOT_INPUTS.baseImage,
        sandboxClass: "container",
        regionIds: ["us"],
        resources: {
          cpu: 2,
          memoryGiB: 4,
          diskGiB: 10,
        },
        buildInfo: {
          snapshotRef: "snapshot-provider-ref",
          dockerfileSha256: "b".repeat(64),
          contextHashesSha256: "c".repeat(64),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      validation: {
        validatedAt: timestamp,
        chromiumVersion: "Chromium 140.0.7339.80",
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
    }),
  );
  return path;
}

describe("Daytona process session cleanup", () => {
  it("ignores the SDK's classified missing-session error", async () => {
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new DaytonaNotFoundError("not found", 404));

    await expect(
      deleteDaytonaSessionIfPresent({ deleteSession }, "buildlabs-preview"),
    ).resolves.toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith("buildlabs-preview");
  });

  it.each([
    ["provider failure", new Error("provider unavailable")],
    [
      "unclassified 404",
      Object.assign(new Error("not found"), { response: { status: 404 } }),
    ],
  ])("propagates %s errors", async (_name, failure) => {
    await expect(
      deleteDaytonaSessionIfPresent(
        { deleteSession: vi.fn().mockRejectedValue(failure) },
        "buildlabs-preview",
      ),
    ).rejects.toBe(failure);
  });

  it("does not start deletion after cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    controller.abort(cancellation);
    const deleteSession = vi.fn();

    await expect(
      deleteDaytonaSessionIfPresent(
        { deleteSession },
        "buildlabs-preview",
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("waits for an in-flight deletion before observing cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled");
    let completeDeletion: (() => void) | undefined;
    const deleteSession = vi.fn(
      () =>
        new Promise<void>((resolveDeletion) => {
          completeDeletion = resolveDeletion;
        }),
    );
    const cleanup = deleteDaytonaSessionIfPresent(
      { deleteSession },
      "buildlabs-preview",
      controller.signal,
    );
    const settled = vi.fn();
    void cleanup.then(settled, settled);
    const expectation = expect(cleanup).rejects.toBe(cancellation);

    controller.abort(cancellation);
    await Promise.resolve();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    completeDeletion?.();
    await expectation;
    expect(settled).toHaveBeenCalledOnce();
  });
});

describe("Daytona provider lifecycle", () => {
  it("disposes the shared SDK client exactly once", async () => {
    let finish: (() => void) | undefined;
    const asyncDispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const client = {
      [Symbol.asyncDispose]: asyncDispose,
    } as unknown as Daytona;
    const provider = new DaytonaSandboxProvider(
      {
        DAYTONA_BUILD_SNAPSHOT: "buildlabs-test",
      } as AppConfig,
      client,
    );

    const first = provider.close();
    const second = provider.close();
    const third = provider[Symbol.asyncDispose]();
    await Promise.resolve();
    expect(asyncDispose).toHaveBeenCalledOnce();

    finish?.();
    await Promise.all([first, second, third]);
    expect(asyncDispose).toHaveBeenCalledOnce();
  });

  it("probes persistent telemetry without quota data and surfaces write failure on close", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "buildlabs-daytona-readiness-"),
    );
    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "blocked");
    const iterator = {
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const asyncDispose = vi.fn().mockResolvedValue(undefined);
    const client = {
      list: vi.fn(() => iterator),
      snapshot: {
        get: vi.fn().mockResolvedValue({
          name: "buildlabs-test",
          state: "active",
          cpu: 2,
          mem: 4,
          disk: 10,
        }),
      },
      [Symbol.asyncDispose]: asyncDispose,
    } as unknown as Daytona;
    const provider = new DaytonaSandboxProvider(
      {
        DAYTONA_BUILD_SNAPSHOT: "buildlabs-test",
        DAYTONA_TELEMETRY_PATH: join(blockingPath, "telemetry.jsonl"),
      } as AppConfig,
      client,
    );

    try {
      const report = await provider.readinessReport();

      expect(report.capabilities.controllerTelemetry).toMatchObject({
        state: "degraded",
        reasonCode: "controller_telemetry_write_failed",
      });
      expect(provider.telemetryEvents()).toContainEqual(
        expect.objectContaining({
          event: "lifecycle",
          outcome: "observed",
          values: { probe: "persistent-write" },
        }),
      );
      await expect(provider.close()).rejects.toThrow(
        "did not complete deterministic cleanup",
      );
      expect(asyncDispose).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries deterministic deletion when post-create validation fails", async () => {
    const refreshFailure = new Error("sandbox refresh failed");
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const sandbox = {
      id: "created-before-refresh-failure",
      refreshData: vi.fn().mockRejectedValue(refreshFailure),
      delete: deleteSandbox,
    } as unknown as Sandbox;
    const client = {
      create: vi.fn().mockResolvedValue(sandbox),
    } as unknown as Daytona;
    const provider = new DaytonaSandboxProvider(
      {
        DAYTONA_BUILD_SNAPSHOT: "buildlabs-test",
        DAYTONA_WARM_POOL_ROLES: "",
      } as AppConfig,
      client,
    );

    await expect(
      provider.create("run-cleanup", assignment("cleanup")),
    ).rejects.toBe(refreshFailure);
    expect(deleteSandbox).toHaveBeenCalledWith(120, true);
  });

  it("rejects a stale warm-pool sandbox whose claim marker already exists", async () => {
    const snapshotName = "buildlabs-warm-test";
    const directory = await mkdtemp(join(tmpdir(), "buildlabs-daytona-pool-"));
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const updateEnv = vi.fn().mockResolvedValue(undefined);
    const executeCommand = vi.fn((command: string) => {
      if (command === "pwd") {
        return Promise.resolve({ exitCode: 0, result: "/workspace\n" });
      }
      if (command.includes(".buildlabs-controller-claimed")) {
        return Promise.resolve({ exitCode: 1, result: "" });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const sandbox = {
      id: "pooled-sandbox-provider-id",
      snapshot: snapshotName,
      target: "us",
      user: "daytona",
      cpu: 2,
      memory: 4,
      disk: 10,
      linkedSandboxId: null,
      labels: {
        "buildlabs.owner": "buildlabs-controller",
        "buildlabs.managed": "true",
        "buildlabs.role": "builder",
      },
      refreshData: vi.fn().mockResolvedValue(undefined),
      updateEnv,
      getWorkDir: vi.fn().mockResolvedValue("/workspace"),
      process: { executeCommand },
      delete: deleteSandbox,
    } as unknown as Sandbox;
    const create = vi.fn().mockResolvedValue(sandbox);
    const observeWarmPool = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: "pooled-sandbox-provider-id",
              warmPoolId: "warm-pool-provider-id",
              snapshot: snapshotName,
              target: "us",
              user: "daytona",
              cpu: 2,
              memory: 4,
              disk: 10,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    try {
      const attestationPath = await writeFreshSnapshotAttestation(
        directory,
        snapshotName,
      );
      const provider = new DaytonaSandboxProvider(
        {
          DAYTONA_API_KEY: "d".repeat(20),
          DAYTONA_API_URL: "https://app.daytona.io/api",
          DAYTONA_BUILD_SNAPSHOT: snapshotName,
          DAYTONA_TARGET: "us",
          DAYTONA_SNAPSHOT_ATTESTATION_PATH: attestationPath,
          DAYTONA_WARM_POOL_ROLES: "builder",
          DAYTONA_OTEL_ENABLED: false,
        } as AppConfig,
        { create } as unknown as Daytona,
        observeWarmPool,
      );

      await expect(
        provider.create("run-stale-pool", assignment("stale-pool")),
      ).rejects.toThrow("was not unused at controller acquisition");
      expect(observeWarmPool).toHaveBeenCalledOnce();
      expect(updateEnv).toHaveBeenCalledOnce();
      expect(deleteSandbox).toHaveBeenCalledWith(120, true);
      expect(provider.acquisitionMeasurements()).toEqual([
        expect.objectContaining({
          warmClaim: "verified_pool_hit",
          outcome: "failed",
        }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an acquired sandbox linked to mutable builder state", async () => {
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);
    const executeCommand = vi.fn((command: string) => {
      if (command === "pwd") {
        return Promise.resolve({ exitCode: 0, result: "/workspace\n" });
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    const sandbox = {
      id: "linked-sandbox-provider-id",
      snapshot: "buildlabs-test",
      target: "us",
      user: "daytona",
      cpu: 2,
      memory: 4,
      disk: 10,
      linkedSandboxId: "mutable-builder-provider-id",
      labels: {
        "buildlabs.owner": "buildlabs-controller",
        "buildlabs.managed": "true",
        "buildlabs.role": "builder",
      },
      refreshData: vi.fn().mockResolvedValue(undefined),
      getWorkDir: vi.fn().mockResolvedValue("/workspace"),
      process: { executeCommand },
      delete: deleteSandbox,
    } as unknown as Sandbox;
    const provider = new DaytonaSandboxProvider(
      {
        DAYTONA_BUILD_SNAPSHOT: "buildlabs-test",
        DAYTONA_WARM_POOL_ROLES: "",
      } as AppConfig,
      { create: vi.fn().mockResolvedValue(sandbox) } as unknown as Daytona,
    );

    await expect(
      provider.create("run-linked", assignment("linked")),
    ).rejects.toThrow("did not match its role policy");
    expect(
      executeCommand.mock.calls.some(([command]) =>
        command.includes(".buildlabs-controller-claimed"),
      ),
    ).toBe(false);
    expect(deleteSandbox).toHaveBeenCalledWith(120, true);
  });

  it("separates healthy API access from a missing configured snapshot", async () => {
    const iterator = {
      next: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const client = {
      list: vi.fn(() => iterator),
      snapshot: {
        get: vi
          .fn()
          .mockRejectedValue(new DaytonaNotFoundError("missing", 404)),
      },
    } as unknown as Daytona;
    const provider = new DaytonaSandboxProvider(
      {
        DAYTONA_API_KEY: "d".repeat(20),
        DAYTONA_API_URL: "https://app.daytona.io/api",
        DAYTONA_BUILD_SNAPSHOT: "missing-snapshot",
        DAYTONA_WARM_POOL_ROLES: "",
        DAYTONA_OTEL_ENABLED: false,
      } as AppConfig,
      client,
    );

    const report = await provider.readinessReport();

    expect(report.capabilities.api.state).toBe("healthy");
    expect(report.capabilities.regionResources).toMatchObject({
      state: "degraded",
      reasonCode: "snapshot_unavailable",
    });
  });
});

describe("Daytona Docker runtime readiness", () => {
  it("waits through transient daemon startup and uses a clean background session", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, result: "" })
      .mockResolvedValueOnce({ exitCode: 1, result: "" })
      .mockResolvedValueOnce({ exitCode: 0, result: "" });
    const deleteSession = vi
      .fn()
      .mockRejectedValue(new DaytonaNotFoundError("not found", 404));
    const createSession = vi.fn().mockResolvedValue(undefined);
    const executeSessionCommand = vi
      .fn()
      .mockResolvedValue({ cmdId: "dockerd-command" });
    const sandbox = {
      process: {
        createSession,
        deleteSession,
        executeCommand,
        executeSessionCommand,
      },
    } as unknown as Sandbox;

    await ensureDockerRuntime(sandbox, "/workspace", undefined, {
      readinessTimeoutMs: 100,
      pollIntervalMs: 1,
      inspectTimeoutSeconds: 1,
    });

    expect(deleteSession).toHaveBeenCalledWith("buildlabs-dockerd");
    expect(createSession).toHaveBeenCalledWith("buildlabs-dockerd");
    expect(executeSessionCommand).toHaveBeenCalledOnce();
    expect(executeCommand).toHaveBeenCalledTimes(3);
  });

  it("waits for a lifecycle-managed Docker entrypoint without launching a second daemon", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, result: "" })
      .mockResolvedValueOnce({ exitCode: 0, result: "" });
    const process = {
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      executeCommand,
      executeSessionCommand: vi.fn(),
      getEntrypointSession: vi.fn().mockResolvedValue({
        sessionId: "entrypoint",
        commands: [
          {
            id: "entrypoint-dockerd",
            command: "/usr/local/bin/dockerd-entrypoint.sh",
          },
        ],
      }),
      getSessionCommand: vi.fn().mockResolvedValue({
        id: "entrypoint-dockerd",
        command: "/usr/local/bin/dockerd-entrypoint.sh",
      }),
    };
    const sandbox = { process } as unknown as Sandbox;

    await ensureDockerRuntime(sandbox, "/workspace", undefined, {
      readinessTimeoutMs: 100,
      pollIntervalMs: 1,
      inspectTimeoutSeconds: 1,
    });

    expect(process.getEntrypointSession).toHaveBeenCalledOnce();
    expect(process.createSession).not.toHaveBeenCalled();
    expect(process.deleteSession).not.toHaveBeenCalled();
    expect(process.executeSessionCommand).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("fails early with redacted lifecycle-entrypoint exit diagnostics", async () => {
    const process = {
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 1, result: "" }),
      getEntrypointSession: vi.fn().mockResolvedValue({
        sessionId: "entrypoint",
        commands: [
          {
            id: "entrypoint-dockerd",
            command: "/usr/local/bin/dockerd-entrypoint.sh",
          },
        ],
      }),
      getSessionCommand: vi.fn().mockResolvedValue({
        id: "entrypoint-dockerd",
        command: "/usr/local/bin/dockerd-entrypoint.sh",
        exitCode: 125,
      }),
      getEntrypointLogs: vi.fn().mockResolvedValue({
        stderr: "daemon failed fw_abcdefghijklmnop",
      }),
    };
    const sandbox = { process } as unknown as Sandbox;

    await expect(
      ensureDockerRuntime(sandbox, "/workspace", undefined, {
        readinessTimeoutMs: 100,
        pollIntervalMs: 1,
        inspectTimeoutSeconds: 1,
      }),
    ).rejects.toMatchObject({
      name: "DaytonaDockerRuntimeError",
      message:
        "The Daytona sandbox Docker daemon exited before readiness with code 125: daemon failed [REDACTED_TOKEN]",
    });
    expect(process.getEntrypointLogs).toHaveBeenCalledOnce();
  });

  it("fails with bounded, actionable readiness diagnostics", async () => {
    const sandbox = {
      process: {
        createSession: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi
          .fn()
          .mockRejectedValue(new DaytonaNotFoundError("not found", 404)),
        executeCommand: vi
          .fn()
          .mockResolvedValue({ exitCode: 125, result: "" }),
        executeSessionCommand: vi
          .fn()
          .mockResolvedValue({ cmdId: "dockerd-command" }),
      },
    } as unknown as Sandbox;

    await expect(
      ensureDockerRuntime(sandbox, "/workspace", undefined, {
        readinessTimeoutMs: 5,
        pollIntervalMs: 1,
        inspectTimeoutSeconds: 1,
      }),
    ).rejects.toThrow(
      /1-second bound after \d+ probes .*last probe exit code: 125/u,
    );
  });

  it("retries synchronous cleanup and reports an unreclaimed sandbox", async () => {
    const initializationError = new Error("dockerd failed");
    const deleteSandbox = vi
      .fn()
      .mockRejectedValueOnce(new Error("delete unavailable"))
      .mockRejectedValueOnce(new Error("still deleting"))
      .mockResolvedValueOnce(undefined);

    await cleanupFailedDaytonaSandbox(
      { id: "sandbox-transient", delete: deleteSandbox },
      initializationError,
      { attempts: 3, retryDelayMs: 1 },
    );
    expect(deleteSandbox).toHaveBeenCalledTimes(3);
    expect(deleteSandbox).toHaveBeenCalledWith(120, true);

    const permanentCleanupError = new Error("cleanup unavailable");
    await expect(
      cleanupFailedDaytonaSandbox(
        {
          id: "sandbox-unreclaimed",
          delete: vi.fn().mockRejectedValue(permanentCleanupError),
        },
        initializationError,
        { attempts: 2, retryDelayMs: 1 },
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message:
        "Daytona sandbox sandbox-unreclaimed initialization failed and cleanup did not complete after 2 attempts",
      errors: [initializationError, permanentCleanupError],
    });
  });

  it("retries one fresh sandbox only for Docker runtime initialization failures", async () => {
    const firstDelete = vi.fn().mockResolvedValue(undefined);
    const secondDelete = vi.fn().mockResolvedValue(undefined);
    const sandboxes = [
      { id: "sandbox-first", delete: firstDelete },
      { id: "sandbox-second", delete: secondDelete },
    ] as unknown as Sandbox[];
    const createSandbox = vi
      .fn()
      .mockResolvedValueOnce(sandboxes[0])
      .mockResolvedValueOnce(sandboxes[1]);
    const initialize = vi
      .fn()
      .mockRejectedValueOnce(
        new DaytonaDockerRuntimeError("transient daemon failure"),
      )
      .mockResolvedValueOnce("ready");

    await expect(
      initializeDaytonaSandboxWithDockerRetry(
        createSandbox,
        initialize,
        undefined,
        2,
      ),
    ).resolves.toBe("ready");
    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(firstDelete).toHaveBeenCalledWith(120, true);
    expect(secondDelete).not.toHaveBeenCalled();

    const nonDockerDelete = vi.fn().mockResolvedValue(undefined);
    const nonDockerSandbox = {
      id: "sandbox-non-docker",
      delete: nonDockerDelete,
    } as unknown as Sandbox;
    const nonDockerCreate = vi
      .fn<() => Promise<Sandbox>>()
      .mockResolvedValue(nonDockerSandbox);
    const nonDockerFailure = new Error("repository initialization failed");
    await expect(
      initializeDaytonaSandboxWithDockerRetry(
        nonDockerCreate,
        () => Promise.reject(nonDockerFailure),
        undefined,
        2,
      ),
    ).rejects.toBe(nonDockerFailure);
    expect(nonDockerCreate).toHaveBeenCalledOnce();
    expect(nonDockerDelete).toHaveBeenCalledWith(120, true);
  });
});

describe("Daytona verifier source export", () => {
  async function createExportHarness(options?: {
    cleanupFailure?: Error;
    corruptManifest?: boolean;
    downloadFailure?: Error;
  }) {
    const sandboxRoot = await mkdtemp(
      join(tmpdir(), "buildlabs-daytona-export-"),
    );
    const workDir = join(
      sandboxRoot,
      "home",
      ".buildlabs-verifier-delivery-nested",
    );
    await mkdir(workDir, { recursive: true });

    const executeCommand = vi.fn(
      (
        wrapper: string,
        cwd?: string,
        _env?: Record<string, string>,
        timeoutSeconds?: number,
      ) => {
        const cleanupPrefix = Buffer.from("rm -f -- ", "utf8").toString(
          "base64",
        );
        if (options?.cleanupFailure && wrapper.includes(cleanupPrefix)) {
          return Promise.reject(options.cleanupFailure);
        }
        return Promise.resolve({
          exitCode: 0,
          result: execFileSync("/bin/bash", ["-lc", wrapper], {
            cwd,
            encoding: "utf8",
            maxBuffer: 1_048_576,
            timeout: (timeoutSeconds ?? 30) * 1_000,
          }),
        });
      },
    );
    const downloadFile = vi.fn(
      async (remotePath: string, localPath?: string) => {
        if (options?.downloadFailure && remotePath.endsWith(".tar")) {
          throw options.downloadFailure;
        }
        if (
          options?.corruptManifest &&
          remotePath.endsWith(".files") &&
          localPath
        ) {
          await writeFile(localPath, "malformed manifest");
          return;
        }
        const resolvedRemotePath = remotePath.startsWith("/")
          ? remotePath
          : join(sandboxRoot, remotePath);
        if (localPath) {
          await copyFile(resolvedRemotePath, localPath);
          return;
        }
        return readFile(resolvedRemotePath);
      },
    );
    const sandbox = {
      id: "sandbox-nested-verifier",
      process: { executeCommand },
      fs: { downloadFile },
    } as unknown as Sandbox;
    const session = new DaytonaSandboxSession(
      sandbox,
      workDir,
      65_536,
      "verifier-delivery",
    );
    await session.initializeRepository();
    await writeFile(join(workDir, "app.txt"), "nested verifier source\n");
    const revision = await session.freeze();
    const remotePaths = [
      join(workDir, ".buildlabs", `export-${revision.sourceDigest}.files`),
      join(workDir, ".buildlabs", `export-${revision.sourceDigest}.tar`),
    ];
    return {
      downloadFile,
      executeCommand,
      remotePaths,
      revision,
      sandboxRoot,
      session,
    };
  }

  it("downloads nested export files and removes the remote copies", async () => {
    const harness = await createExportHarness();
    let exported:
      Awaited<ReturnType<DaytonaSandboxSession["exportWorkspace"]>> | undefined;
    try {
      exported = await harness.session.exportWorkspace(harness.revision);

      expect(await readFile(join(exported.directory, "app.txt"), "utf8")).toBe(
        "nested verifier source\n",
      );
      expect(
        harness.downloadFile.mock.calls.map(([remotePath]) => remotePath),
      ).toEqual(harness.remotePaths);
      await Promise.all(
        harness.remotePaths.map((path) =>
          expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );
    } finally {
      await exported?.cleanup();
      await rm(harness.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("removes remote export files when manifest validation fails", async () => {
    const harness = await createExportHarness({ corruptManifest: true });
    try {
      await expect(
        harness.session.exportWorkspace(harness.revision),
      ).rejects.toThrow("Frozen Git tree manifest");
      await Promise.all(
        harness.remotePaths.map((path) =>
          expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );
    } finally {
      await rm(harness.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("preserves a download error when remote cleanup also fails", async () => {
    const downloadFailure = new Error("Daytona download unavailable");
    const cleanupFailure = new Error("Daytona cleanup unavailable");
    const harness = await createExportHarness({
      cleanupFailure,
      downloadFailure,
    });
    try {
      await expect(
        harness.session.exportWorkspace(harness.revision),
      ).rejects.toBe(downloadFailure);
      const cleanupPrefix = Buffer.from("rm -f -- ", "utf8").toString("base64");
      expect(
        harness.executeCommand.mock.calls.some(([wrapper]) =>
          String(wrapper).includes(cleanupPrefix),
        ),
      ).toBe(true);
    } finally {
      await rm(harness.sandboxRoot, { recursive: true, force: true });
    }
  });

  it("fails the export when remote cleanup is the only failure", async () => {
    const cleanupFailure = new Error("Daytona cleanup unavailable");
    const harness = await createExportHarness({ cleanupFailure });
    try {
      await expect(
        harness.session.exportWorkspace(harness.revision),
      ).rejects.toBe(cleanupFailure);
    } finally {
      await rm(harness.sandboxRoot, { recursive: true, force: true });
    }
  });
});

describe("Daytona delivery proof network seal", () => {
  it.each(["builder", "verifier-commands"] as const)(
    "does not expose network sealing to the %s sandbox",
    async (role) => {
      const updateNetworkSettings = vi.fn();
      const session = new DaytonaSandboxSession(
        { updateNetworkSettings } as unknown as Sandbox,
        "/workspace",
        65_536,
        role,
      );

      await expect(session.sealNetworkForProof()).rejects.toThrow(
        "restricted to the Daytona delivery verifier",
      );
      expect(updateNetworkSettings).not.toHaveBeenCalled();
    },
  );

  it("applies the official block-all policy and fails closed on provider error", async () => {
    const failure = new Error("Daytona firewall unavailable");
    const updateNetworkSettings = vi.fn().mockRejectedValue(failure);
    const session = new DaytonaSandboxSession(
      { updateNetworkSettings } as unknown as Sandbox,
      "/workspace",
      65_536,
      "verifier-delivery",
    );

    await expect(session.sealNetworkForProof()).rejects.toBe(failure);
    expect(updateNetworkSettings).toHaveBeenCalledWith({
      networkBlockAll: true,
    });
    await expect(
      session.startContainerPreview("buildlabs-candidate", 3_000),
    ).rejects.toThrow("network-sealed Daytona delivery verifier");
  });

  it("reapplies the block-all policy after the promoted snapshot restarts", async () => {
    const operations: string[] = [];
    const updateNetworkSettings = vi.fn(() => {
      operations.push("network-seal");
      return Promise.resolve();
    });
    const sandbox = {
      networkBlockAll: true,
      updateNetworkSettings,
      refreshData: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(() => {
        operations.push("stop");
        return Promise.resolve();
      }),
      _experimental_createSnapshot: vi.fn(() => {
        operations.push("snapshot");
        return Promise.resolve();
      }),
      start: vi.fn(() => {
        operations.push("start");
        return Promise.resolve();
      }),
      process: {
        executeCommand: vi.fn((command: string) => {
          if (command.includes("BUILDLABS_COMMAND_RESULT_V1")) {
            return Promise.resolve({
              exitCode: 0,
              result: commandEnvelope("a".repeat(40)),
            });
          }
          if (command.includes("proven-image.tar")) {
            operations.push("image-archive");
            return Promise.resolve({
              exitCode: 0,
              result: `sha256:${"1".repeat(64)}\n${"2".repeat(64)}\n`,
            });
          }
          operations.push(
            command.includes("proven-snapshot-identity.json")
              ? "snapshot-identity"
              : "docker-ready",
          );
          return Promise.resolve({ exitCode: 0, result: "" });
        }),
      },
    } as unknown as Sandbox;
    const session = new DaytonaSandboxSession(
      sandbox,
      "/workspace",
      65_536,
      "verifier-delivery",
    );

    await session.freeze();
    await session.sealNetworkForProof();
    await session.createSnapshot("buildlabs-promoted-snapshot");

    expect(updateNetworkSettings).toHaveBeenCalledTimes(2);
    expect(updateNetworkSettings).toHaveBeenNthCalledWith(1, {
      networkBlockAll: true,
    });
    expect(updateNetworkSettings).toHaveBeenNthCalledWith(2, {
      networkBlockAll: true,
    });
    expect(operations).toEqual([
      "network-seal",
      "image-archive",
      "snapshot-identity",
      "stop",
      "snapshot",
      "start",
      "network-seal",
      "docker-ready",
    ]);
  });

  it("fails closed when block-all reads back false after snapshot restart", async () => {
    const updateNetworkSettings = vi.fn().mockResolvedValue(undefined);
    const dockerReady = vi
      .fn<() => Promise<{ exitCode: number; result: string }>>()
      .mockResolvedValue({ exitCode: 0, result: "" });
    const executeCommand = vi.fn((command: string) =>
      command.includes("BUILDLABS_COMMAND_RESULT_V1")
        ? Promise.resolve({
            exitCode: 0,
            result: commandEnvelope("a".repeat(40)),
          })
        : command.includes("proven-image.tar")
          ? Promise.resolve({
              exitCode: 0,
              result: `sha256:${"1".repeat(64)}\n${"2".repeat(64)}\n`,
            })
          : command.includes("proven-snapshot-identity.json")
            ? Promise.resolve({ exitCode: 0, result: "" })
            : dockerReady(),
    );
    const sandbox = {
      networkBlockAll: true,
      updateNetworkSettings,
      refreshData: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => {
          sandbox.networkBlockAll = false;
          return Promise.resolve();
        }),
      stop: vi.fn().mockResolvedValue(undefined),
      _experimental_createSnapshot: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      process: {
        executeCommand,
      },
    } as unknown as Sandbox & { networkBlockAll: boolean };
    const session = new DaytonaSandboxSession(
      sandbox,
      "/workspace",
      65_536,
      "verifier-delivery",
    );

    await session.freeze();
    executeCommand.mockClear();
    await session.sealNetworkForProof();
    await expect(
      session.createSnapshot("buildlabs-promoted-snapshot"),
    ).rejects.toThrow("did not retain networkBlockAll");
    expect(updateNetworkSettings).toHaveBeenCalledTimes(2);
    expect(dockerReady).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledTimes(2);
    await expect(
      session.startContainerPreview("buildlabs-candidate", 3_000),
    ).rejects.toThrow("network-sealed Daytona delivery verifier");
  });
});

describe("Daytona rendered-page proof boundary", () => {
  it("publishes the proven container only on sealed sandbox loopback", () => {
    const command = deliveryContainerRunCommand("buildlabs-candidate", 3_000);

    expect(command).toContain("-p 127.0.0.1:3000:3000");
    expect(command).not.toContain("--network host");
  });

  it.each(["verifier-commands", "verifier-delivery"] as const)(
    "does not expose the host-process preview to the %s sandbox",
    async (role) => {
      const session = new DaytonaSandboxSession(
        {} as Sandbox,
        "/workspace",
        65_536,
        role,
      );

      await expect(session.startPreview("npm start", 3_000)).rejects.toThrow(
        "restricted to the Daytona builder sandbox",
      );
    },
  );

  it.each(["builder", "verifier-commands"] as const)(
    "does not expose the proof browser to the %s sandbox",
    async (role) => {
      const session = new DaytonaSandboxSession(
        {} as Sandbox,
        "/workspace",
        65_536,
        role,
      );

      await expect(
        session.inspectRenderedPages(["/"], 3_000, 10_000),
      ).rejects.toThrow("restricted to the Daytona delivery verifier");
    },
  );

  it("emits only readable graphemes from a partially clipped text node", () => {
    const textNode = "ClipPrefix Overflow Hidden Required";
    const visibleCodeUnits = "ClipPrefix".length;
    const segments = Array.from(
      new Intl.Segmenter("en", { granularity: "grapheme" }).segment(textNode),
      ({ segment, index }) => ({
        text: segment,
        readable: index < visibleCodeUnits,
        whitespace: /^\s+$/u.test(segment),
      }),
    );

    expect(assembleReadableGraphemeText(segments)).toBe("ClipPrefix");
    expect(assembleReadableGraphemeText(segments)).not.toContain(
      "Overflow Hidden Required",
    );
  });

  it("binds isolated candidate state before freezing and probing", () => {
    const preCollection = RENDERED_PAGE_INSPECTOR_SOURCE.indexOf(
      "const tiles = await collectProofTiles(",
    );
    const collection = RENDERED_PAGE_INSPECTOR_SOURCE.indexOf(
      "const firstTile = tiles[0]",
      preCollection,
    );
    const freeze = RENDERED_PAGE_INSPECTOR_SOURCE.indexOf(
      "const frozen = await freezeAndVerifyCandidateState(",
    );
    const probe = RENDERED_PAGE_INSPECTOR_SOURCE.indexOf(
      "const inspection = await inspectFrozenTiles(",
      freeze,
    );
    const marker = RENDERED_PAGE_INSPECTOR_SOURCE.indexOf(
      '"DOM.setAttributeValue"',
    );

    expect(preCollection).toBeGreaterThan(0);
    expect(collection).toBeGreaterThan(preCollection);
    expect(freeze).toBeGreaterThan(collection);
    expect(probe).toBeGreaterThan(freeze);
    expect(marker).toBeGreaterThan(0);
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      '"Page.createIsolatedWorld"',
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('"Runtime.evaluate"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('"DOM.getOuterHTML"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "frozenBaselineBuffer.equals(preCollectionBuffer)",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).not.toContain("value: false");
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).not.toContain("page.addStyleTag");
  });

  it("accepts an immediate byte-exact pixel-baseline restoration", async () => {
    const baseline = Buffer.from("baseline pixels");
    const page = pixelBaselinePage([baseline]);
    const summarizeDifference = vi.fn();

    await expect(
      recaptureExactPixelBaseline(
        page,
        baseline,
        Date.now() + 1_000,
        summarizeDifference,
      ),
    ).resolves.toEqual(baseline);

    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
    expect(summarizeDifference).not.toHaveBeenCalled();
  });

  it("requires two consecutive byte-exact captures after an initial mismatch", async () => {
    const baseline = Buffer.from("baseline pixels");
    const page = pixelBaselinePage([
      Buffer.from("transient paint"),
      baseline,
      baseline,
    ]);
    const summarizeDifference = vi.fn();

    await expect(
      recaptureExactPixelBaseline(
        page,
        baseline,
        Date.now() + 1_000,
        summarizeDifference,
      ),
    ).resolves.toEqual(baseline);

    expect(page.screenshot).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenNthCalledWith(1, 32);
    expect(page.waitForTimeout).toHaveBeenNthCalledWith(2, 32);
    expect(summarizeDifference).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "persistent drift",
      captures: Array.from({ length: 5 }, () =>
        Buffer.from("persistent drift"),
      ),
      diagnostic:
        "captures=5,baselineMatches=0,maxConsecutiveBaselineMatches=0,distinctCaptures=1",
    },
    {
      name: "nondeterministic drift",
      captures: [
        Buffer.from("drift a"),
        Buffer.from("baseline pixels"),
        Buffer.from("drift b"),
        Buffer.from("baseline pixels"),
        Buffer.from("drift c"),
      ],
      diagnostic:
        "captures=5,baselineMatches=2,maxConsecutiveBaselineMatches=1,distinctCaptures=4",
    },
  ])("fails closed for $name", async ({ captures, diagnostic }) => {
    const baseline = Buffer.from("baseline pixels");
    const page = pixelBaselinePage(captures);
    const summarizeDifference = vi.fn(() => ({
      differingBytes: 7,
      differingPixels: 3,
      maxChannelDelta: 19,
    }));

    await expect(
      recaptureExactPixelBaseline(
        page,
        baseline,
        Date.now() + 1_000,
        summarizeDifference,
      ),
    ).rejects.toThrow(
      `Rendered-page probe did not restore the exact pixel baseline (${diagnostic},differingBytes=7,differingPixels=3,maxChannelDelta=19)`,
    );

    expect(page.screenshot).toHaveBeenCalledTimes(5);
    expect(page.waitForTimeout).toHaveBeenCalledTimes(4);
    expect(summarizeDifference).toHaveBeenCalledOnce();
    expect(summarizeDifference).toHaveBeenCalledWith(baseline, captures.at(-1));
  });

  it("plans bounded scroll tiles that cover a tall page including its tail", () => {
    expect(planScrollTileOffsets(2_500, 900, 16)).toEqual([0, 900, 1_600]);
    expect(() => planScrollTileOffsets(14_401, 900, 16)).toThrow(
      "16-tile inspection limit",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      '"DOM.scrollIntoViewIfNeeded"',
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain("screenshotSha256s.push");
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "frozen scroll-tile boundary",
    );
  });

  it("reuses parent tile proof only for exact bytes, offset, dimensions, and candidates", () => {
    const tile = {
      offset: 900,
      viewportWidth: 1_440,
      viewportHeight: 900,
      documentWidth: 1_440,
      documentHeight: 4_500,
    };
    expect(canReuseRenderedTileProof(tile, tile, true, true)).toBe(true);
    expect(
      canReuseRenderedTileProof(tile, { ...tile, offset: 1_800 }, true, true),
    ).toBe(false);
    expect(
      canReuseRenderedTileProof(
        tile,
        { ...tile, documentHeight: 5_400 },
        true,
        true,
      ),
    ).toBe(false);
    expect(canReuseRenderedTileProof(tile, tile, false, true)).toBe(false);
    expect(canReuseRenderedTileProof(tile, tile, true, false)).toBe(false);
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "frozenBaselineBuffer.equals(parentTile.baselineBuffer)",
    );
  });

  it("normalizes every same-origin anchor before response classification", () => {
    expect(
      normalizeSameOriginRoutePaths(
        [
          "http://127.0.0.1:3000/services#pricing",
          "http://127.0.0.1:3000/services",
          "http://127.0.0.1:3000/about.html",
          "http://127.0.0.1:3000/brochure.pdf",
          "https://example.com/external",
        ],
        "http://127.0.0.1:3000",
      ),
    ).toEqual(["/about.html", "/brochure.pdf", "/services"]);
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      'response.headerValue("content-type")',
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      'response.headerValue("content-disposition")',
    );
  });

  it("contains a bounded deterministic BFS over frozen same-origin anchors", () => {
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      'querySelectorAll.call(document, "a[href]")',
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "for (let index = 0; index < queue.length; index += 1)",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "Rendered-page route crawl exceeds the 32-route limit",
    );
  });

  it("explores visible controls in fresh network-blocked states", () => {
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "const MAX_INTERACTIONS = 15",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain("blockedAfterLoad = true");
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      ".locator(INTERACTION_SELECTOR)",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "const interactionQueue = [",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "frozenInteractionStateDigest(action)",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "Rendered-page interaction states exceed the bounded state limit",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain("screenshotSha256s.push");
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('kind: "click-fragment"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('kind: "hover"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('kind: "focus"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      '"input,textarea,select,button"',
    );
  });

  it("keeps initial HTTP available while failing closed on sockets and post-load requests", () => {
    expect(
      decideProofNetworkRequest({
        kind: "http",
        blockedAfterLoad: false,
        allowedUrl: true,
        allowInitialWebSockets: false,
      }),
    ).toBe("allow");
    expect(
      decideProofNetworkRequest({
        kind: "websocket",
        blockedAfterLoad: false,
        allowedUrl: true,
        allowInitialWebSockets: false,
      }),
    ).toBe("block-initial-websocket");
    expect(
      decideProofNetworkRequest({
        kind: "http",
        blockedAfterLoad: true,
        allowedUrl: true,
        allowInitialWebSockets: false,
      }),
    ).toBe("block-post-load");
    expect(
      decideProofNetworkRequest({
        kind: "websocket",
        blockedAfterLoad: true,
        allowedUrl: true,
        allowInitialWebSockets: false,
      }),
    ).toBe("block-post-load");
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "Rendered-page interaction attempted blocked network access",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "networkState.blockedAfterLoad = true",
    );
  });

  it("fails closed when an interaction mutates only hidden JavaScript state", () => {
    const baselineDigest = sha256("same rendered state");
    let armed = false;
    const click = (control: "A" | "B") => {
      if (control === "A") {
        armed = true;
        return baselineDigest;
      }
      return armed ? sha256("24/7 emergency service") : baselineDigest;
    };

    expect(() =>
      assertObservableInteractionTransition(baselineDigest, click("A")),
    ).toThrow("changed no controller-observable state");
    expect(armed).toBe(true);
    expect(click("B")).not.toBe(baselineDigest);
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "assertObservableInteractionTransition(",
    );
  });

  it("rejects uninspectable visible surfaces and embedded image bytes", () => {
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain('tagName === "canvas"');
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "visible data or blob image source",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).toContain(
      "unsupported generated pseudo-element content",
    );
    expect(RENDERED_PAGE_INSPECTOR_SOURCE).not.toContain(
      'hasAttribute.call(anchor, "download")',
    );
  });

  it("rejects clipped geometry and one-to-two-pixel glyph slivers", () => {
    expect(
      hasSufficientReadablePixelEvidence({
        visibleAreaRatio: 0.1,
        inspectedPixels: 20,
        readablePixels: 20,
      }),
    ).toBe(false);
    expect(
      hasSufficientReadablePixelEvidence({
        visibleAreaRatio: 1,
        inspectedPixels: 20,
        readablePixels: 2,
      }),
    ).toBe(false);
    expect(
      hasSufficientReadablePixelEvidence({
        visibleAreaRatio: 0.5,
        inspectedPixels: 20,
        readablePixels: 3,
      }),
    ).toBe(true);
  });

  it("parses one success and one error without conflating their shapes", () => {
    expect(
      parseRenderedPageInspectionOutput(
        JSON.stringify({
          version: 2,
          results: [
            {
              path: "/",
              discovered: false,
              status: 200,
              visibleText: "Visible",
              screenshotSha256s: [TILE_ONE.digest, TILE_TWO.digest],
              screenshotBase64s: [TILE_ONE.base64, TILE_TWO.base64],
            },
            {
              path: "/slow",
              discovered: false,
              status: null,
              error: "timed out",
            },
          ],
        }),
        ["/", "/slow"],
      ),
    ).toEqual([
      {
        path: "/",
        status: 200,
        visibleText: "Visible",
        screenshotSha256s: [TILE_ONE.digest, TILE_TWO.digest],
        screenshotBase64s: [TILE_ONE.base64, TILE_TWO.base64],
      },
      { path: "/slow", status: null, error: "timed out" },
    ]);
  });

  it.each([
    {
      path: "/",
      discovered: false,
      status: 200,
      visibleText: "Visible",
      screenshotSha256s: [TILE_ONE.digest],
      screenshotBase64s: [TILE_ONE.base64],
      error: "ambiguous",
    },
    { path: "/", discovered: false, status: null },
  ])("rejects ambiguous renderer output %#", (result) => {
    expect(() =>
      parseRenderedPageInspectionOutput(
        JSON.stringify({ version: 2, results: [result] }),
        ["/"],
      ),
    ).toThrow("invalid");
  });

  it("parses bounded discovered routes and rejects crawl overflow", () => {
    const root = {
      path: "/",
      discovered: false,
      status: 200,
      visibleText: "Root",
      screenshotSha256s: [TILE_ONE.digest],
      screenshotBase64s: [TILE_ONE.base64],
    };
    const discovered = {
      path: "/legacy",
      discovered: true,
      status: 200,
      visibleText: "Final same-origin redirect page",
      screenshotSha256s: [TILE_TWO.digest],
      screenshotBase64s: [TILE_TWO.base64],
    };
    expect(
      parseRenderedPageInspectionOutput(
        JSON.stringify({ version: 2, results: [root, discovered] }),
        ["/"],
      ),
    ).toEqual([
      {
        path: "/",
        status: 200,
        visibleText: "Root",
        screenshotSha256s: [TILE_ONE.digest],
        screenshotBase64s: [TILE_ONE.base64],
      },
      {
        path: "/legacy",
        discovered: true,
        status: 200,
        visibleText: "Final same-origin redirect page",
        screenshotSha256s: [TILE_TWO.digest],
        screenshotBase64s: [TILE_TWO.base64],
      },
    ]);

    expect(() =>
      parseRenderedPageInspectionOutput(
        JSON.stringify({
          version: 2,
          results: [
            root,
            ...Array.from({ length: 32 }, (_, index) => ({
              ...discovered,
              path: `/route-${index}`,
            })),
          ],
        }),
        ["/"],
      ),
    ).toThrow("invalid output");
  });

  it("classifies an actual non-HTML response without fabricating page pixels", () => {
    expect(
      parseRenderedPageInspectionOutput(
        JSON.stringify({
          version: 2,
          results: [
            {
              path: "/",
              discovered: false,
              status: 200,
              visibleText: "Root",
              screenshotSha256s: [TILE_ONE.digest],
              screenshotBase64s: [TILE_ONE.base64],
            },
            {
              path: "/brochure.pdf",
              discovered: true,
              status: 200,
              nonHtmlMediaType: "application/pdf",
            },
          ],
        }),
        ["/"],
      ),
    ).toEqual([
      {
        path: "/",
        status: 200,
        visibleText: "Root",
        screenshotSha256s: [TILE_ONE.digest],
        screenshotBase64s: [TILE_ONE.base64],
      },
      {
        path: "/brochure.pdf",
        discovered: true,
        status: 200,
        nonHtmlMediaType: "application/pdf",
      },
    ]);
  });

  it("rejects screenshot bytes whose digest is not controller-bound", () => {
    expect(() =>
      parseRenderedPageInspectionOutput(
        JSON.stringify({
          version: 2,
          results: [
            {
              path: "/",
              discovered: false,
              status: 200,
              visibleText: "Root",
              screenshotSha256s: ["f".repeat(64)],
              screenshotBase64s: [TILE_ONE.base64],
            },
          ],
        }),
        ["/"],
      ),
    ).toThrow("invalid screenshot bytes");
  });

  it("rejects more than 512 screenshot tiles across rendered routes", () => {
    const rendered = (path: string, discovered: boolean, count: number) => ({
      path,
      discovered,
      status: 200,
      visibleText: path,
      screenshotSha256s: Array.from({ length: count }, () => TILE_ONE.digest),
      screenshotBase64s: Array.from({ length: count }, () => TILE_ONE.base64),
    });
    expect(() =>
      parseRenderedPageInspectionOutput(
        JSON.stringify({
          version: 2,
          results: [
            rendered("/", false, 171),
            rendered("/a", true, 171),
            rendered("/b", true, 171),
          ],
        }),
        ["/"],
      ),
    ).toThrow("excessive screenshot tiles");
  });
});

describe("Daytona command output containment", () => {
  it("bounds the encoded provider response before oversized output reaches Node", async () => {
    let providerEnvelope = "";
    const sandboxProcess = {
      executeCommand: vi.fn(
        (
          wrapper: string,
          cwd?: string,
          _env?: Record<string, string>,
          timeoutSeconds?: number,
        ) => {
          providerEnvelope = execFileSync("/bin/bash", ["-lc", wrapper], {
            cwd,
            encoding: "utf8",
            maxBuffer: 4_096,
            timeout: (timeoutSeconds ?? 30) * 1_000,
          });
          return Promise.resolve({
            exitCode: 0,
            result: providerEnvelope,
          });
        },
      ),
    };
    const command = [
      'node -e "',
      "process.stdout.write('o'.repeat(200000));",
      "process.stderr.write('e'.repeat(200000));",
      "process.exit(23);",
      '"',
    ].join("");

    const result = await executeBoundedSandboxCommand(
      sandboxProcess,
      command,
      process.cwd(),
      30,
      2_048,
    );

    expect(Buffer.byteLength(providerEnvelope, "utf8")).toBeLessThanOrEqual(
      2_048,
    );
    expect(result).toMatchObject({
      exitCode: 23,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(result.stdout).toMatch(/^o+$/);
    expect(result.stderr).toMatch(/^e+$/);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThan(2_048);
    expect(sandboxProcess.executeCommand).toHaveBeenCalledOnce();
    expect(sandboxProcess.executeCommand.mock.calls[0]?.[3]).toBe(30);
  });

  it("does not start a wrapped command after cancellation", async () => {
    const cancellation = new Error("cancelled before command execution");
    const controller = new AbortController();
    controller.abort(cancellation);
    const sandboxProcess = {
      executeCommand: vi.fn(),
    };

    await expect(
      executeBoundedSandboxCommand(
        sandboxProcess,
        "printf unreachable",
        process.cwd(),
        30,
        2_048,
        controller.signal,
      ),
    ).rejects.toBe(cancellation);
    expect(sandboxProcess.executeCommand).not.toHaveBeenCalled();
  });

  it("uses a persistent async session for long commands and records cleanup", async () => {
    let envelope = "";
    const processPort = {
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn(
        (_sessionId: string, request: { command: string }) => {
          envelope = execFileSync("/bin/bash", ["-lc", request.command], {
            encoding: "utf8",
            maxBuffer: 4_096,
          });
          return Promise.resolve({ cmdId: "async-command" });
        },
      ),
      getSessionCommand: vi.fn().mockResolvedValue({ exitCode: 0 }),
      getSessionCommandLogs: vi.fn(() =>
        Promise.resolve({ stdout: envelope, stderr: "", output: envelope }),
      ),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    const deleteSandbox = vi.fn().mockResolvedValue(undefined);

    const execution = await executeBoundedSandboxCommandAsync(
      {
        id: "async-sandbox",
        process: processPort,
        delete: deleteSandbox,
      } as unknown as Pick<Sandbox, "delete" | "id" | "process">,
      "printf async-ok",
      process.cwd(),
      300,
      2_048,
    );

    expect(execution.result).toMatchObject({
      exitCode: 0,
      stdout: "async-ok",
    });
    expect(execution.receipt.commandSha256).toBe(sha256("printf async-ok"));
    expect(execution.receipt.outcome).toBe("completed");
    expect(processPort.deleteSession).toHaveBeenCalledOnce();
    expect(deleteSandbox).not.toHaveBeenCalled();
  });
});
