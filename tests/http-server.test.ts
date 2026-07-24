import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElevenLabsSpeechEngine } from "../src/adapters/elevenlabs/elevenlabs-speech-engine.js";
import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import { loadConfig } from "../src/config.js";
import { artifactArchiveFilename } from "../src/domain/artifact.js";
import type { BuildRun } from "../src/domain/run.js";
import { createHttpServer } from "../src/http/server.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type {
  CodeReviewPort,
  ModelPort,
  SandboxProvider,
  StudioToolTraceInput,
  TracePort,
  TraceSpan,
} from "../src/ports/index.js";
import { artifact, assignment, passingEvidence } from "./fixtures.js";

describe("HTTP server", () => {
  const token = "t".repeat(32);
  const elevenLabsToolSecret = "e".repeat(32);
  let store: SqliteRunStore;
  let server: ReturnType<typeof createHttpServer>;
  let wakeCount: number;
  let artifactDirectory: string;
  let trace: HttpTestTrace;
  let webRtcTokenRequests: number;
  let shutdownOrder: string[];
  let providerHealthCalls: Record<
    "coderabbit" | "daytona" | "elevenlabs" | "fireworks",
    number
  >;
  let previewRequests: Array<{
    sandboxId: string;
    port: number;
    expiresInSeconds: number;
  }>;
  let frozenPreviewRequests: Array<{
    snapshotId: string;
    runId: string;
    eventId: string;
    artifactId: string;
    artifactSha256: string;
    revisionHash: string;
    port: number;
    expiresInSeconds: number;
    idempotencyKey: string;
  }>;
  let originalSandboxStopped: boolean;

  beforeEach(async () => {
    wakeCount = 0;
    previewRequests = [];
    frozenPreviewRequests = [];
    originalSandboxStopped = false;
    artifactDirectory = await mkdtemp(
      join(tmpdir(), "buildlabs-http-artifacts-"),
    );
    store = new SqliteRunStore({ path: ":memory:" });
    shutdownOrder = [];
    trace = new HttpTestTrace(shutdownOrder);
    webRtcTokenRequests = 0;
    providerHealthCalls = {
      coderabbit: 0,
      daytona: 0,
      elevenlabs: 0,
      fireworks: 0,
    };
    const healthy = (name: "coderabbit" | "daytona" | "fireworks") => ({
      health: () => {
        providerHealthCalls[name] += 1;
        return Promise.resolve();
      },
      deleteSandbox: () => Promise.resolve(),
    });
    const sandboxProvider = {
      ...healthy("daytona"),
      getPreview: (
        sandboxId: string,
        port: number,
        expiresInSeconds: number,
      ) => {
        if (originalSandboxStopped) {
          return Promise.reject(new Error("Original sandbox is stopped"));
        }
        previewRequests.push({ sandboxId, port, expiresInSeconds });
        return Promise.resolve({
          url: "https://operator-preview.example/review/signed-token",
          expiresAt: new Date(
            Date.now() + expiresInSeconds * 1_000,
          ).toISOString(),
        });
      },
      materializeFrozenPreview: (request: {
        snapshotId: string;
        runId: string;
        eventId: string;
        artifactId: string;
        artifactSha256: string;
        revisionHash: string;
        port: number;
        expiresInSeconds: number;
        idempotencyKey: string;
      }) => {
        frozenPreviewRequests.push(request);
        return Promise.resolve({
          url: "https://isolated-frozen-preview.example/review/signed-token",
          expiresAt: new Date(
            Date.now() + request.expiresInSeconds * 1_000,
          ).toISOString(),
        });
      },
    };
    server = createHttpServer({
      config: loadConfig({
        NODE_ENV: "test",
        BUILDLABS_INTERNAL_TOKEN: token,
        BUILDLABS_ARTIFACT_DIR: artifactDirectory,
        DAYTONA_API_KEY: "d".repeat(20),
        FIREWORKS_API_KEY: "f".repeat(20),
        BRAINTRUST_API_KEY: "b".repeat(20),
        ELEVENLABS_TOOL_SECRET: elevenLabsToolSecret,
        CODERABBIT_AUTH_MODE: "oauth",
      }),
      store,
      scheduler: {
        wake: () => {
          wakeCount += 1;
        },
        cancel: (runId, request) => store.requestCancel(runId, request),
      },
      sandboxProvider: sandboxProvider as unknown as SandboxProvider,
      model: healthy("fireworks") as unknown as ModelPort,
      reviewer: healthy("coderabbit") as unknown as CodeReviewPort,
      trace,
      elevenLabs: {
        attach: () => ({
          close: () => {
            shutdownOrder.push("speech-close");
            return Promise.resolve();
          },
        }),
        health: () => {
          providerHealthCalls.elevenlabs += 1;
          return Promise.resolve();
        },
        createWebRtcToken: () => {
          webRtcTokenRequests += 1;
          return Promise.resolve({ token: "webrtc-session-token" });
        },
      } as unknown as ElevenLabsSpeechEngine,
    });
  });

  afterEach(async () => {
    await server.close();
    store.close();
    await rm(artifactDirectory, { recursive: true, force: true });
  });

  it("keeps liveness public but protects build operations", async () => {
    const health = await server.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const unauthorized = await server.inject({
      method: "POST",
      url: "/v1/build-runs",
      payload: assignment("http-auth"),
    });
    expect(unauthorized.statusCode).toBe(401);
  });

  it("validates, idempotently queues, and exposes a build run", async () => {
    const input = assignment("http-create");
    const created = await server.inject({
      method: "POST",
      url: "/v1/build-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: input,
    });
    expect(created.statusCode).toBe(202);
    const body = created.json<{
      created: boolean;
      run: { id: string; status: string };
    }>();
    expect(body).toMatchObject({
      created: true,
      run: { status: "queued" },
    });
    expect(wakeCount).toBe(1);

    const duplicate = await server.inject({
      method: "POST",
      url: "/v1/build-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: input,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json<{ run: { id: string } }>().run.id).toBe(body.run.id);

    const fetched = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${body.run.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      run: { id: body.run.id, status: "queued" },
      artifact: null,
    });
  });

  it("rejects malformed assignments before queueing them", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/build-runs",
      headers: { authorization: `Bearer ${token}` },
      payload: { assignmentId: "incomplete" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_request" });
    expect(wakeCount).toBe(0);
  });

  it("paginates durable build-run events with an explicit continuation cursor", async () => {
    const run = store.createRun(assignment("http-event-pages")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.updateStage(run.id, lease, "generating");

    const first = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${run.id}/events?limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{
      events: Array<{ sequence: number }>;
      nextAfter: number;
      hasMore: boolean;
    }>();
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const second = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${run.id}/events?after=${firstPage.nextAfter}&limit=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      events: [{ sequence: firstPage.nextAfter + 1 }],
      nextAfter: firstPage.nextAfter + 1,
      hasMore: false,
    });
  });

  it("keeps public readiness local and single-flights authenticated sponsor probes", async () => {
    const response = await server.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      providers: {
        daytona: "configured",
        fireworks: "configured",
        braintrust: "configured",
        coderabbit: "configured",
        copilotkit: "configured",
        elevenlabs: "configured",
      },
    });
    expect(providerHealthCalls).toEqual({
      coderabbit: 0,
      daytona: 0,
      elevenlabs: 0,
      fireworks: 0,
    });
    expect(trace.healthCalls).toBe(0);

    const unauthorizedProbe = await server.inject({
      method: "POST",
      url: "/v1/integrations/probe",
    });
    expect(unauthorizedProbe.statusCode).toBe(401);
    expect(providerHealthCalls).toEqual({
      coderabbit: 0,
      daytona: 0,
      elevenlabs: 0,
      fireworks: 0,
    });

    const probes = await Promise.all(
      Array.from({ length: 10 }, () =>
        server.inject({
          method: "POST",
          url: "/v1/integrations/probe",
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    );
    expect(probes.every((probe) => probe.statusCode === 200)).toBe(true);
    expect(providerHealthCalls).toEqual({
      coderabbit: 1,
      daytona: 1,
      elevenlabs: 1,
      fireworks: 1,
    });
    expect(trace.healthCalls).toBe(1);
    const probeBody = probes[0]!.json<{
      checkedAt: string;
      status: string;
      providers: Record<string, string>;
    }>();
    expect(probeBody.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(probeBody).toMatchObject({
      status: "ready",
      providers: {
        daytona: "healthy",
        fireworks: "healthy",
        braintrust: "healthy",
        coderabbit: "healthy",
        copilotkit: "configured",
        elevenlabs: "healthy",
      },
    });
  });

  it("fails sponsor-complete readiness when ElevenLabs is unconfigured", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      BUILDLABS_INTERNAL_TOKEN: token,
      BUILDLABS_ARTIFACT_DIR: artifactDirectory,
      DAYTONA_API_KEY: "d".repeat(20),
      FIREWORKS_API_KEY: "f".repeat(20),
      BRAINTRUST_API_KEY: "b".repeat(20),
      CODERABBIT_AUTH_MODE: "oauth",
    });
    const healthOnly = {
      health: () => Promise.resolve(),
    };
    const withoutSpeechEngine = createHttpServer({
      config,
      store,
      scheduler: {
        wake: () => undefined,
        cancel: (runId, request) => store.requestCancel(runId, request),
      },
      sandboxProvider: healthOnly as unknown as SandboxProvider,
      model: healthOnly as unknown as ModelPort,
      reviewer: healthOnly as unknown as CodeReviewPort,
      trace,
    });

    try {
      const ready = await withoutSpeechEngine.inject({
        method: "GET",
        url: "/ready",
      });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        status: "not_ready",
        providers: { elevenlabs: "unconfigured" },
      });

      const probe = await withoutSpeechEngine.inject({
        method: "POST",
        url: "/v1/integrations/probe",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(probe.statusCode).toBe(503);
      expect(probe.json()).toMatchObject({
        status: "not_ready",
        providers: {
          daytona: "healthy",
          fireworks: "healthy",
          braintrust: "healthy",
          coderabbit: "healthy",
          copilotkit: "configured",
          elevenlabs: "unconfigured",
        },
      });
    } finally {
      await withoutSpeechEngine.close();
    }
  });

  it("exposes bounded ElevenLabs tools for real studio operations", async () => {
    const run = store.createRun(assignment("http-elevenlabs-tools")).run;
    const conversationId = "conv_http_sensitive";
    const otherConversationId = "conv_http_unrelated";
    const secret = `fw_${"x".repeat(32)}`;
    const explicitCancellationHistory = JSON.stringify({
      "x-elevenlabs-history": true,
      entries: [
        {
          role: "user",
          message: `Please cancel build ${run.id}. Do not retain alice@example.com or ${secret}.`,
        },
      ],
    });
    const internalHeaders = { authorization: `Bearer ${token}` };
    const toolHeaders = {
      authorization: `Bearer ${elevenLabsToolSecret}`,
    };

    const integrations = await server.inject({
      method: "GET",
      url: "/v1/integrations",
      headers: internalHeaders,
    });
    expect(integrations.statusCode).toBe(200);
    expect(integrations.json()).toMatchObject({
      copilotkit: {
        backendStatus: "configured",
        status: "configured",
        transport: "ag-ui",
      },
      elevenlabs: {
        backendStatus: "configured",
        status: "configured",
        speechEngineStatus: "configured",
        webhookToolsStatus: "configured",
        webhookTools: {
          getCandidate: "/v1/integrations/elevenlabs/tools/get-candidate",
          cancelCandidate: "/v1/integrations/elevenlabs/tools/cancel-candidate",
        },
        webhookDynamicVariables: {
          systemConversationId: "system__conversation_id",
          systemConversationHistory: "system__conversation_history",
        },
      },
    });

    const overprivilegedInternalToken = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/get-candidate",
      headers: internalHeaders,
      payload: { runId: run.id },
    });
    expect(overprivilegedInternalToken.statusCode).toBe(401);

    const status = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/get-candidate",
      headers: toolHeaders,
      payload: { runId: run.id, systemConversationId: conversationId },
    });
    expect(status.statusCode).toBe(200);
    const candidate = status.json<{
      updatedAt: string;
      cancellationCapability: string;
    }>();
    expect(candidate).toMatchObject({
      runId: run.id,
      status: "queued",
      artifactAvailable: false,
      previewAvailable: false,
    });
    expect(candidate.cancellationCapability).toMatch(/^v1\.[^.]+\.[^.]+$/);

    const missingCapability = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: conversationId,
        systemConversationHistory: explicitCancellationHistory,
      },
    });
    expect(missingCapability.statusCode).toBe(400);

    const ambiguousCancellation = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: conversationId,
        systemConversationHistory: JSON.stringify({
          "x-elevenlabs-history": true,
          entries: [{ role: "user", message: "Do not cancel the build." }],
        }),
        cancellationCapability: candidate.cancellationCapability,
      },
    });
    expect(ambiguousCancellation.json()).toMatchObject({
      changed: false,
      reason: "cancellation_intent_not_verified",
    });

    const tamperedCapability =
      candidate.cancellationCapability.slice(0, -1) +
      (candidate.cancellationCapability.endsWith("A") ? "B" : "A");
    const tamperedCancellation = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: conversationId,
        systemConversationHistory: explicitCancellationHistory,
        cancellationCapability: tamperedCapability,
      },
    });
    expect(tamperedCancellation.json()).toMatchObject({
      changed: false,
      reason: "cancellation_intent_not_verified",
    });

    const crossConversationCancellation = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: otherConversationId,
        systemConversationHistory: explicitCancellationHistory,
        cancellationCapability: candidate.cancellationCapability,
      },
    });
    expect(crossConversationCancellation.json()).toMatchObject({
      changed: false,
      reason: "cancellation_intent_not_verified",
    });

    const cancellation = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: conversationId,
        systemConversationHistory: explicitCancellationHistory,
        cancellationCapability: candidate.cancellationCapability,
      },
    });
    expect(cancellation.statusCode).toBe(200);
    expect(cancellation.json()).toMatchObject({
      changed: true,
      reason: "cancellation_requested",
      candidate: { cancelRequested: true },
    });
    const replay = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/tools/cancel-candidate",
      headers: toolHeaders,
      payload: {
        runId: run.id,
        systemConversationId: conversationId,
        systemConversationHistory: explicitCancellationHistory,
        cancellationCapability: candidate.cancellationCapability,
      },
    });
    expect(replay.json()).toMatchObject({
      changed: false,
      reason: "candidate_is_terminal",
    });
    const conversationCorrelationId = sha256(
      `studio-conversation:${conversationId}`,
    );
    expect(
      store
        .listEvents(run.id, 0)
        .find((event) => event.type === "run.cancelled")?.payload,
    ).toMatchObject({
      runId: run.id,
      source: "elevenlabs_webhook",
      conversationCorrelationId,
      reasonCode: "explicit_operator_cancellation",
    });
    expect(trace.toolInputs).toHaveLength(6);
    expect(trace.toolInputs).toEqual([
      {
        tool: "get_candidate",
        runId: run.id,
        conversationCorrelationId,
      },
      {
        tool: "cancel_candidate",
        runId: run.id,
        conversationCorrelationId,
      },
      {
        tool: "cancel_candidate",
        runId: run.id,
        conversationCorrelationId,
      },
      {
        tool: "cancel_candidate",
        runId: run.id,
        conversationCorrelationId: sha256(
          `studio-conversation:${otherConversationId}`,
        ),
      },
      {
        tool: "cancel_candidate",
        runId: run.id,
        conversationCorrelationId,
      },
      {
        tool: "cancel_candidate",
        runId: run.id,
        conversationCorrelationId,
      },
    ]);
    const traceJson = JSON.stringify(trace);
    expect(traceJson).not.toContain(conversationId);
    expect(traceJson).not.toContain(otherConversationId);
    expect(traceJson).not.toContain(candidate.cancellationCapability);
    expect(traceJson).not.toContain(secret);
    expect(traceJson).not.toContain("alice@example.com");
  });

  it("mints WebRTC tokens only through internal authentication", async () => {
    const unauthenticated = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/webrtc-token",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const wrongPrincipal = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/webrtc-token",
      headers: {
        authorization: `Bearer ${elevenLabsToolSecret}`,
      },
    });
    expect(wrongPrincipal.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/v1/integrations/elevenlabs/webrtc-token",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ token: "webrtc-session-token" });
    expect(webRtcTokenRequests).toBe(1);
    expect(JSON.stringify(trace)).not.toContain("webrtc-session-token");
  });

  it("acknowledges known outbox events idempotently without accepting unknown ids", async () => {
    const { runId } = await createPassedArtifact(
      "http-outbox-ack",
      Buffer.from("outbox artifact"),
    );
    const event = store.listOutbox(10).find((item) => item.runId === runId)!;
    const headers = { authorization: `Bearer ${token}` };

    const first = await server.inject({
      method: "POST",
      url: `/v1/outbox/${event.eventId}/ack`,
      headers,
    });
    const duplicate = await server.inject({
      method: "POST",
      url: `/v1/outbox/${event.eventId}/ack`,
      headers,
    });
    const unknown = await server.inject({
      method: "POST",
      url: `/v1/outbox/${randomUUID()}/ack`,
      headers,
    });

    expect(first.statusCode).toBe(204);
    expect(duplicate.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(404);
    expect(store.listOutbox(10).some((item) => item.runId === runId)).toBe(
      false,
    );
  });

  it("streams authenticated durable run state to CopilotKit over AG-UI", async () => {
    const run = store.createRun(assignment("http-copilotkit")).run;
    store.requestCancel(run.id);
    const payload = {
      threadId: "studio-project-mission-peak",
      runId: `studio-observation-${randomUUID()}`,
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { buildRunId: run.id },
    };

    const unauthorized = await server.inject({
      method: "POST",
      url: "/v1/integrations/copilotkit/agent",
      payload,
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: "POST",
      url: "/v1/integrations/copilotkit/agent",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const eventTypes = response.body
      .split("\n\n")
      .filter(Boolean)
      .map((record) => {
        const event: unknown = JSON.parse(record.slice("data: ".length));
        if (!event || typeof event !== "object" || !("type" in event)) {
          throw new Error("AG-UI event is missing its type");
        }
        return event.type;
      });
    expect(eventTypes).toEqual([
      "RUN_STARTED",
      "CUSTOM",
      "CUSTOM",
      "STATE_SNAPSHOT",
      "ACTIVITY_SNAPSHOT",
      "RUN_FINISHED",
    ]);
  });

  it("closes an active CopilotKit stream during bounded backend shutdown", async () => {
    const run = store.createRun(assignment("http-copilotkit-shutdown")).run;
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      `${address}/v1/integrations/copilotkit/agent`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: "studio-project-shutdown",
          runId: `studio-observation-${randomUUID()}`,
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: { buildRunId: run.id },
        }),
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader!.read()).done).toBe(false);

    const closed = await Promise.race([
      server.close().then(() => true),
      delay(2_000).then(() => false),
    ]);
    expect(closed).toBe(true);
    const streamEnded = await Promise.race([
      (async () => {
        try {
          for (let reads = 0; reads < 10; reads += 1) {
            if ((await reader!.read()).done) {
              return true;
            }
          }
        } catch {
          return true;
        }
        return false;
      })(),
      delay(2_000).then(() => false),
    ]);
    expect(streamEnded).toBe(true);
  });

  it("closes and drains speech work before flushing Braintrust", async () => {
    await server.close();

    expect(shutdownOrder).toEqual(["speech-close", "trace-flush"]);
  });

  it("authenticates and serves only the exact proven artifact identity", async () => {
    const contents = Buffer.from("portable proven artifact");
    const { runId, provenArtifact } = await createPassedArtifact(
      "http-artifact",
      contents,
    );

    const unauthenticated = await server.inject({
      method: "GET",
      url: provenArtifact.uri,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await server.inject({
      method: "GET",
      url: provenArtifact.uri,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(contents);
    expect(response.headers["content-type"]).toContain("application/gzip");
    expect(response.headers["x-artifact-sha256"]).toBe(provenArtifact.sha256);
    expect(response.headers.etag).toBe(`"${provenArtifact.sha256}"`);

    const wrongArtifact = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${runId}/artifacts/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(wrongArtifact.statusCode).toBe(404);

    const invalidIdentity = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${runId}/artifacts/not-a-uuid`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invalidIdentity.statusCode).toBe(400);
  });

  it("refuses an artifact whose file no longer matches its receipt", async () => {
    const { provenArtifact, archivePath } = await createPassedArtifact(
      "http-artifact-tampered",
      Buffer.from("original artifact"),
    );
    await writeFile(archivePath, "tampered artifact");

    const response = await server.inject({
      method: "GET",
      url: provenArtifact.uri,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "artifact_unavailable" });

    await rm(archivePath, { force: true });
    await symlink("missing-target", archivePath);
    const symlinkResponse = await server.inject({
      method: "GET",
      url: provenArtifact.uri,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(symlinkResponse.statusCode).toBe(409);
  });

  it("mints a customer preview only for the exact pending proven event", async () => {
    const { runId, provenArtifact } = await createPassedArtifact(
      "http-frozen-preview",
      Buffer.from("frozen preview artifact"),
    );
    const [event] = store.listOutbox(10);
    expect(event).toBeDefined();
    const idempotencyKey = `preview:materialize:${event!.eventId}`;

    const response = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey,
      },
      payload: {
        eventId: event!.eventId,
        artifactId: provenArtifact.artifactId,
        artifactSha256: provenArtifact.sha256,
        revisionHash: provenArtifact.revisionHash,
        expiresInSeconds: 600,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "frozen_proven_preview",
      eventId: event!.eventId,
      runId,
      artifactId: provenArtifact.artifactId,
      revisionHash: provenArtifact.revisionHash,
      artifactSha256: provenArtifact.sha256,
      snapshotId: provenArtifact.daytonaSnapshot,
      url: "https://isolated-frozen-preview.example/review/signed-token",
    });
    expect(frozenPreviewRequests).toEqual([
      {
        snapshotId: provenArtifact.daytonaSnapshot,
        runId,
        eventId: event!.eventId,
        artifactId: provenArtifact.artifactId,
        artifactSha256: provenArtifact.sha256,
        revisionHash: provenArtifact.revisionHash,
        port: event!.payload.previewPort,
        expiresInSeconds: 600,
        idempotencyKey,
      },
    ]);
    expect(previewRequests).toHaveLength(0);
  });

  it("serves the proven snapshot even after the original sandbox stops", async () => {
    const { runId, provenArtifact } = await createPassedArtifact(
      "http-frozen-preview-isolated",
      Buffer.from("immutable snapshot artifact"),
    );
    const [event] = store.listOutbox(10);
    expect(event).toBeDefined();
    originalSandboxStopped = true;

    const response = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": `preview:materialize:${event!.eventId}`,
      },
      payload: {
        eventId: event!.eventId,
        artifactId: provenArtifact.artifactId,
        artifactSha256: provenArtifact.sha256,
        revisionHash: provenArtifact.revisionHash,
        expiresInSeconds: 600,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "frozen_proven_preview",
      snapshotId: provenArtifact.daytonaSnapshot,
      url: "https://isolated-frozen-preview.example/review/signed-token",
    });
    expect(frozenPreviewRequests).toHaveLength(1);
    expect(previewRequests).toHaveLength(0);
  });

  it("fails closed for mismatched, expired, or acknowledged proven-preview identities", async () => {
    const { runId, provenArtifact } = await createPassedArtifact(
      "http-frozen-preview-closed",
      Buffer.from("frozen preview fail-closed artifact"),
    );
    const [event] = store.listOutbox(10);
    expect(event).toBeDefined();
    const exactRequest = {
      eventId: event!.eventId,
      artifactId: provenArtifact.artifactId,
      artifactSha256: provenArtifact.sha256,
      revisionHash: provenArtifact.revisionHash,
      expiresInSeconds: 600,
    };
    const previewHeaders = {
      authorization: `Bearer ${token}`,
      "idempotency-key": `preview:materialize:${event!.eventId}`,
    };

    const missingIdempotency = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: exactRequest,
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(frozenPreviewRequests).toHaveLength(0);

    const mismatched = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: previewHeaders,
      payload: {
        ...exactRequest,
        artifactSha256: sha256("different artifact"),
      },
    });
    expect(mismatched.statusCode).toBe(409);
    expect(previewRequests).toHaveLength(0);

    const excessiveTtl = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: previewHeaders,
      payload: {
        ...exactRequest,
        expiresInSeconds: 7 * 24 * 60 * 60 + 1,
      },
    });
    expect(excessiveTtl.statusCode).toBe(400);
    expect(previewRequests).toHaveLength(0);

    store.markOutboxPublished(event!.eventId);
    const acknowledged = await server.inject({
      method: "POST",
      url: `/v1/build-runs/${runId}/proven-preview`,
      headers: previewHeaders,
      payload: exactRequest,
    });
    expect(acknowledged.statusCode).toBe(409);
    expect(previewRequests).toHaveLength(0);
  });

  it("keeps the mutable Daytona preview explicitly operator-only", async () => {
    const input = assignment("http-operator-preview");
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, "operator-sandbox");
    store.setRevision(run.id, lease, sha256("operator revision"), 3000);

    const response = await server.inject({
      method: "GET",
      url: `/v1/build-runs/${run.id}/preview`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: "ephemeral_daytona_preview",
    });
  });

  it("acknowledges a known outbox event idempotently but rejects an unknown event", async () => {
    await createPassedArtifact(
      "http-outbox-ack",
      Buffer.from("outbox acknowledgment artifact"),
    );
    const [event] = store.listOutbox(10);
    expect(event).toBeDefined();
    const acknowledge = () =>
      server.inject({
        method: "POST",
        url: `/v1/outbox/${event!.eventId}/ack`,
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await acknowledge()).statusCode).toBe(204);
    expect((await acknowledge()).statusCode).toBe(204);
    expect(store.listOutbox(10)).toHaveLength(0);

    const unknown = await server.inject({
      method: "POST",
      url: `/v1/outbox/${randomUUID()}/ack`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "outbox_event_not_found" });
  });

  it("returns proof events only for the requested active run identities", async () => {
    const obsolete = await createPassedArtifact(
      "http-outbox-obsolete",
      Buffer.from("obsolete artifact"),
    );
    const active = await createPassedArtifact(
      "http-outbox-active",
      Buffer.from("active artifact"),
    );
    const response = await server.inject({
      method: "GET",
      url:
        "/v1/outbox?" +
        new URLSearchParams({
          limit: "10",
          projectId: "project-mission-peak",
          runIds: active.runId,
        }).toString(),
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ events: Array<{ runId: string }> }>();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ runId: active.runId });
    expect(body.events[0]?.runId).not.toBe(obsolete.runId);
  });

  async function createPassedArtifact(suffix: string, contents: Buffer) {
    const input = assignment(suffix);
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.attachSandbox(run.id, lease, `sandbox-${suffix}`);
    store.attachVerificationSandbox(
      run.id,
      lease,
      `sandbox-verifier-${suffix}`,
      "delivery",
    );
    store.promoteVerificationSandbox(
      run.id,
      lease,
      `sandbox-verifier-${suffix}`,
    );
    const revisionHash = sha256(`revision:${suffix}`);
    store.setRevision(run.id, lease, revisionHash, 3000);
    for (const receipt of passingEvidence(run.id, revisionHash, input)) {
      store.addEvidence(run.id, lease, receipt);
    }
    const provenArtifact = artifact(run.id, revisionHash);
    provenArtifact.sha256 = sha256(contents);
    provenArtifact.sizeBytes = contents.byteLength;
    const archivePath = join(
      artifactDirectory,
      artifactArchiveFilename(provenArtifact),
    );
    await writeFile(archivePath, contents);
    store.recordArtifact(run.id, lease, provenArtifact);
    store.markPassed(run.id, lease, revisionHash, "trace-test");
    return { runId: run.id, provenArtifact, archivePath };
  }
});

class HttpTestTrace implements TracePort {
  readonly toolInputs: StudioToolTraceInput[] = [];
  readonly toolLogs: unknown[] = [];
  healthCalls = 0;

  constructor(private readonly shutdownOrder: string[] = []) {}

  run<T>(
    _run: BuildRun,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(new HttpTestSpan(this.toolLogs));
  }

  studioTool<T>(
    input: StudioToolTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    this.toolInputs.push(structuredClone(input));
    return operation(new HttpTestSpan(this.toolLogs));
  }

  flush(): Promise<void> {
    this.shutdownOrder.push("trace-flush");
    return Promise.resolve();
  }

  health(): Promise<void> {
    this.healthCalls += 1;
    return Promise.resolve();
  }
}

class HttpTestSpan implements TraceSpan {
  readonly traceId = "a".repeat(64);

  constructor(private readonly logs: unknown[]) {}

  log(event: Parameters<TraceSpan["log"]>[0]): void {
    this.logs.push(structuredClone(event));
  }

  child<T>(
    _name: string,
    _type: Parameters<TraceSpan["child"]>[1],
    _input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}
