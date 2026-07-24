import { randomUUID } from "node:crypto";

import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  deliveryContainerRunCommand,
  DaytonaSandboxProvider,
  type DaytonaClientPort,
} from "../src/adapters/daytona/daytona-sandbox.js";
import { loadConfig } from "../src/config.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type { FrozenPreviewMaterializationRequest } from "../src/ports/index.js";

describe("Daytona frozen preview materialization", () => {
  it("serves a fresh proven-snapshot sandbox when the original sandbox is stopped", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );

    await expect(
      harness.provider.getPreview("original-sandbox", 3000, 600),
    ).rejects.toThrow("Original sandbox is stopped");
    await expect(
      harness.provider.materializeFrozenPreview(request),
    ).resolves.toMatchObject({
      url: "https://isolated-preview.example/signed",
    });

    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `buildlapse-preview-${request.eventId}`,
        snapshot: request.snapshotId,
        public: false,
        ephemeral: true,
        autoStopInterval: 12,
        ttlMinutes: 12,
        labels: {
          "buildlapse.purpose": "proven-preview",
          "buildlapse.run-id": request.runId,
          "buildlapse.event-id": request.eventId,
          "buildlapse.artifact-id": request.artifactId,
          "buildlapse.revision": request.revisionHash.slice(0, 32),
          "buildlapse.effect-key": sha256(request.idempotencyKey).slice(0, 32),
          "buildlapse.effect-input": frozenPreviewEffectInputDigest(request),
        },
      }),
      { timeout: 120 },
    );
    const encodedContainerCommand = Buffer.from(
      deliveryContainerRunCommand("buildlapse-proof", 3000),
      "utf8",
    ).toString("base64");
    expect(
      harness.executeCommand.mock.calls.some(([command]) =>
        command.includes(encodedContainerCommand),
      ),
    ).toBe(true);
    expect(harness.updateNetworkSettings).toHaveBeenCalledWith({
      networkBlockAll: true,
    });
    expect(harness.originalPreview).toHaveBeenCalledTimes(1);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    const [probeUrl, probeInit] = harness.probe.mock.calls[0]!;
    expect(probeUrl).toBe("https://isolated-preview.example/signed");
    expect(probeInit).toMatchObject({
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(probeInit?.signal).toBeInstanceOf(AbortSignal);
    const probeHeaders = new Headers(probeInit?.headers);
    expect(probeHeaders.has("authorization")).toBe(false);
    expect(probeHeaders.has("cookie")).toBe(false);
    expect(harness.deleteIsolated).not.toHaveBeenCalled();
  });

  it("fails closed when the signed HTTPS preview remains unavailable", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 503 }),
    );

    await expect(
      harness.provider.materializeFrozenPreview(request),
    ).rejects.toThrow("HTTP 503");
    expect(harness.probe).toHaveBeenCalledTimes(3);
    expect(harness.deleteIsolated).not.toHaveBeenCalled();
  });

  it("rejects stale revision or artifact markers from an otherwise healthy preview", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "x-buildlapse-revision": "0".repeat(64),
            "x-buildlapse-artifact-sha256": request.artifactSha256,
          },
        }),
    );

    await expect(
      harness.provider.materializeFrozenPreview(request),
    ).rejects.toThrow("identity markers");
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.deleteIsolated).not.toHaveBeenCalled();
  });

  it("reuses the exact labeled sandbox when the materialization response is retried", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );

    const first = await harness.provider.materializeFrozenPreview(request);
    const replay = await harness.provider.materializeFrozenPreview(request);

    expect(first.url).toBe("https://isolated-preview.example/signed");
    expect(replay.url).toBe(first.url);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.list).toHaveBeenCalledTimes(2);
    expect(harness.startIsolated).not.toHaveBeenCalled();
    expect(harness.setTtl).toHaveBeenCalledTimes(2);
    expect(harness.deleteIsolated).not.toHaveBeenCalled();
  });

  it("serializes concurrent materialization attempts for the same proven event", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );

    await expect(
      Promise.all([
        harness.provider.materializeFrozenPreview(request),
        harness.provider.materializeFrozenPreview(request),
      ]),
    ).resolves.toHaveLength(2);
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the deterministic sandbox name when Daytona loses the create response", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );
    harness.loseNextCreateResponse();

    await expect(
      harness.provider.materializeFrozenPreview(request),
    ).resolves.toMatchObject({
      url: "https://isolated-preview.example/signed",
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.get).toHaveBeenCalledWith(
      `buildlapse-preview-${request.eventId}`,
    );
    expect(harness.deleteIsolated).not.toHaveBeenCalled();
  });

  it("fails closed when Daytona reports duplicate sandboxes for one event identity", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );
    harness.list.mockImplementationOnce(() =>
      (async function* () {
        await Promise.resolve();
        yield {} as Sandbox;
        yield {} as Sandbox;
      })(),
    );

    await expect(
      harness.provider.materializeFrozenPreview(request),
    ).rejects.toThrow("Multiple Daytona sandboxes");
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("rejects replaying one provider idempotency key with different preview input", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );
    await harness.provider.materializeFrozenPreview(request);

    await expect(
      harness.provider.materializeFrozenPreview({
        ...request,
        expiresInSeconds: request.expiresInSeconds + 60,
      }),
    ).rejects.toThrow("idempotency key was reused with different input");
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled Daytona identity lookup before creating a sandbox", async () => {
    const request = frozenPreviewRequest();
    const harness = frozenPreviewHarness(
      request,
      () => new Response(null, { status: 200 }),
    );
    const iterator = (async function* () {
      await new Promise<void>(() => {
        // Deliberately unresolved provider read.
      });
      yield {} as Sandbox;
    })();
    harness.list.mockReturnValueOnce(iterator);
    const controller = new AbortController();
    const materialization = harness.provider.materializeFrozenPreview(
      request,
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(harness.list).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await expect(materialization).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(harness.create).not.toHaveBeenCalled();
  });
});

function frozenPreviewRequest(): FrozenPreviewMaterializationRequest {
  const revisionHash = sha256(`frozen revision:${randomUUID()}`);
  return {
    snapshotId: `buildlapse-12345678-${revisionHash.slice(0, 12)}`,
    runId: randomUUID(),
    eventId: randomUUID(),
    artifactId: randomUUID(),
    artifactSha256: sha256(`artifact:${randomUUID()}`),
    revisionHash,
    port: 3000,
    expiresInSeconds: 600,
    idempotencyKey: `preview:materialize:${randomUUID()}`,
  };
}

function frozenPreviewHarness(
  request: FrozenPreviewMaterializationRequest,
  response: () => Response,
) {
  const originalPreview = vi
    .fn()
    .mockRejectedValue(new Error("Original sandbox is stopped and mutated"));
  const deleteIsolated = vi.fn().mockResolvedValue(undefined);
  const executeCommand = vi.fn(
    (
      _command: string,
      _workDir?: string,
      _environment?: Record<string, string>,
      _timeoutSeconds?: number,
    ) =>
      Promise.resolve({
        exitCode: 0,
        result: "BUILDLAPSE_COMMAND_RESULT_V1\n0\n0\n0\n0\n0\n\n\n",
      }),
  );
  const startIsolated = vi.fn().mockResolvedValue(undefined);
  const setTtl = vi.fn().mockResolvedValue(undefined);
  const sandboxLabels = {
    "buildlapse.purpose": "proven-preview",
    "buildlapse.run-id": request.runId,
    "buildlapse.event-id": request.eventId,
    "buildlapse.artifact-id": request.artifactId,
    "buildlapse.revision": request.revisionHash.slice(0, 32),
    "buildlapse.effect-key": sha256(request.idempotencyKey).slice(0, 32),
    "buildlapse.effect-input": frozenPreviewEffectInputDigest(request),
  };
  const setLabels = vi.fn((labels: Record<string, string>) => {
    Object.assign(sandboxLabels, labels);
    return Promise.resolve({ ...sandboxLabels });
  });
  const updateNetworkSettings = vi.fn().mockResolvedValue(undefined);
  const isolatedSandbox = {
    id: "isolated-preview-sandbox",
    snapshot: request.snapshotId,
    public: false,
    state: "started",
    labels: sandboxLabels,
    refreshData: vi.fn().mockResolvedValue(undefined),
    start: startIsolated,
    setLabels,
    setTtl,
    updateNetworkSettings,
    getWorkDir: vi.fn().mockResolvedValue("/workspace"),
    getSignedPreviewUrl: vi.fn().mockResolvedValue({
      url: "https://isolated-preview.example/signed",
    }),
    delete: deleteIsolated,
    process: {
      executeCommand,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi
        .fn()
        .mockResolvedValue({ cmdId: "preview-command" }),
    },
  } as unknown as Sandbox;
  const originalSandbox = {
    getSignedPreviewUrl: originalPreview,
  } as unknown as Sandbox;
  const create = vi.fn().mockResolvedValue(isolatedSandbox);
  let recoverCreatedSandboxByName = false;
  const get = vi.fn((sandboxId: string) =>
    Promise.resolve(
      recoverCreatedSandboxByName &&
        sandboxId === `buildlapse-preview-${request.eventId}`
        ? isolatedSandbox
        : originalSandbox,
    ),
  );
  const list = vi.fn(() => {
    const existing = create.mock.calls.length > 0 ? [isolatedSandbox] : [];
    return (async function* () {
      await Promise.resolve();
      yield* existing;
    })();
  });
  const client = {
    create,
    get,
    list,
    snapshot: {
      get: vi.fn().mockResolvedValue({
        name: request.snapshotId,
        state: "active",
      }),
    },
  } as unknown as DaytonaClientPort;
  const probe = vi.fn(
    (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(response()),
  );
  return {
    provider: new DaytonaSandboxProvider(testConfig(), client, probe),
    create,
    deleteIsolated,
    executeCommand,
    get,
    list,
    loseNextCreateResponse: () => {
      recoverCreatedSandboxByName = true;
      create.mockRejectedValueOnce(
        new Error("Daytona create response was not received"),
      );
    },
    originalPreview,
    probe,
    setTtl,
    startIsolated,
    updateNetworkSettings,
  };
}

function frozenPreviewEffectInputDigest(
  request: FrozenPreviewMaterializationRequest,
): string {
  return sha256(
    JSON.stringify({
      artifactId: request.artifactId,
      artifactSha256: request.artifactSha256,
      eventId: request.eventId,
      expiresInSeconds: request.expiresInSeconds,
      port: request.port,
      revisionHash: request.revisionHash,
      runId: request.runId,
      snapshotId: request.snapshotId,
    }),
  ).slice(0, 32);
}

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DAYTONA_API_KEY: "d".repeat(20),
    FIREWORKS_API_KEY: "f".repeat(20),
    BRAINTRUST_API_KEY: "b".repeat(20),
    CODERABBIT_AUTH_MODE: "oauth",
  });
}
