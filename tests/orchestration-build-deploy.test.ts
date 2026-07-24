import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as tar from "tar";

import { assignmentDigest, contractDigest } from "../src/domain/contract.js";
import { OutboxEventSchema, type OutboxEvent } from "../src/domain/artifact.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { HttpBuildBackendAdapter } from "../src/orchestration/adapters/build/http-build-backend.js";
import {
  deriveFlyAppName,
  deriveFlyReleaseKey,
  FlyCliDeploymentAdapter,
  type SpawnCommand,
  type SpawnInvocation,
  type SpawnResult,
} from "../src/orchestration/adapters/build/fly-cli-deployment.js";
import { artifact, assignment } from "./fixtures.js";

const TEST_FLY_ORGANIZATION = "buildlabs-production";
const TEST_FLY_REGION = "sjc";

describe("orchestration build and deploy adapters", () => {
  const resources: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((cleanup) => cleanup()));
  });

  it("authenticates the exact build service and snapshot through a prefixed base URL", async () => {
    let authorization: string | undefined;
    const backend = await listenHttp((request, response) => {
      authorization = request.headers.authorization;
      if (
        request.method !== "POST" ||
        request.url !== "/internal/v1/integrations/probe"
      ) {
        respondJson(response, 404, {});
        return;
      }
      respondJson(response, 200, {
        status: "ready",
        component: "build-agent-backend",
        providers: {
          daytona: "healthy",
          fireworks: "healthy",
          coderabbit: "healthy",
          braintrust: "healthy",
        },
        configuration: {
          daytonaSnapshot: "buildlabs-dind-v1",
        },
        checkedAt: "2026-07-24T12:00:00.000Z",
      });
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: `${backend.url}/internal/`,
      bearerToken: "internal-token-with-sufficient-length",
      expectedDaytonaSnapshot: "buildlabs-dind-v1",
    });

    await expect(adapter.health()).resolves.toBeUndefined();
    expect(authorization).toBe("Bearer internal-token-with-sufficient-length");
  });

  it("dispatches a typed assignment with a stable idempotency key", async () => {
    const input = assignment("orchestration-dispatch");
    const run = runForAssignment(input);
    const requests: Array<{
      authorization: string | undefined;
      idempotencyKey: string | undefined;
      body: unknown;
    }> = [];
    const backend = await listenHttp(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/build-runs") {
        respondJson(response, 404, {});
        return;
      }
      requests.push({
        authorization: request.headers.authorization,
        idempotencyKey: header(request, "idempotency-key"),
        body: await readRequestJson(request),
      });
      respondJson(response, requests.length === 1 ? 202 : 200, {
        created: requests.length === 1,
        run,
      });
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    const first = await adapter.dispatchBuild(input);
    const replay = await adapter.dispatchBuild(input);

    expect(first).toMatchObject({ created: true, run });
    expect(replay).toMatchObject({ created: false, run });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toEqual(input);
    expect(requests[0]?.authorization).toBe(
      "Bearer internal-token-with-sufficient-length",
    );
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
    expect(requests[0]?.idempotencyKey).toMatch(/^build-dispatch:/);
  });

  it("fetches and validates a build run snapshot", async () => {
    const input = assignment("orchestration-status");
    const run = runForAssignment(input, {
      id: "22222222-2222-4222-8222-222222222222",
      status: "running",
      stage: "verifying",
    });
    const backend = await listenHttp((request, response) => {
      if (request.url === `/v1/build-runs/${run.id}`) {
        respondJson(response, 200, { run, artifact: null });
        return;
      }
      respondJson(response, 404, {});
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    await expect(adapter.getBuildRun(run.id)).resolves.toEqual({
      run,
      artifact: null,
    });
  });

  it("cancels the exact superseded run with a stable idempotency key", async () => {
    const input = assignment("orchestration-cancel");
    const run = runForAssignment(input, {
      cancelRequested: true,
      status: "running",
      stage: "generating",
    });
    let idempotencyKey: string | undefined;
    const backend = await listenHttp((request, response) => {
      if (
        request.method === "POST" &&
        request.url === `/v1/build-runs/${run.id}/cancel`
      ) {
        idempotencyKey = header(request, "idempotency-key");
        respondJson(response, 202, { run });
        return;
      }
      respondJson(response, 404, {});
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    await expect(adapter.cancelBuild(run.id)).resolves.toEqual(run);
    expect(idempotencyKey).toBe(`build-cancel:${run.id}`);
  });

  it("polls typed proven events and acknowledges replay with a stable key", async () => {
    const event = provenEvent();
    let polls = 0;
    const acknowledgements: Array<string | undefined> = [];
    const backend = await listenHttp((request, response) => {
      if (request.method === "GET" && request.url === "/v1/outbox?limit=25") {
        polls += 1;
        respondJson(response, 200, { events: polls === 1 ? [] : [event] });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === `/v1/outbox/${event.eventId}/ack`
      ) {
        acknowledgements.push(header(request, "idempotency-key"));
        response.writeHead(204).end();
        return;
      }
      respondJson(response, 404, {});
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    await expect(
      adapter.pollProvenEvents({
        limit: 25,
        maxAttempts: 2,
        intervalMs: 0,
      }),
    ).resolves.toEqual([event]);
    await adapter.acknowledgeProvenEvent(event.eventId);
    await adapter.acknowledgeProvenEvent(event.eventId);

    expect(polls).toBe(2);
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements[0]).toBe(acknowledgements[1]);
    expect(acknowledgements[0]).toBe(`proven-event-ack:${event.eventId}`);
  });

  it("binds proof polling to the requested active run identities", async () => {
    const event = provenEvent();
    let requestedUrl: URL | undefined;
    const backend = await listenHttp((request, response) => {
      requestedUrl = new URL(request.url ?? "/", "http://fake.invalid");
      respondJson(response, 200, { events: [event] });
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    await expect(
      adapter.pollProvenEvents({
        projectId: event.payload.projectId,
        runIds: [event.runId],
      }),
    ).resolves.toEqual([event]);
    expect(requestedUrl?.searchParams.get("projectId")).toBe(
      event.payload.projectId,
    );
    expect(requestedUrl?.searchParams.get("runIds")).toBe(event.runId);

    const wrongRunId = randomUUID();
    await expect(
      adapter.pollProvenEvents({ runIds: [wrongRunId] }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("fails closed on a cross-identity proven outbox payload", async () => {
    const event = provenEvent();
    const backend = await listenHttp((_request, response) => {
      respondJson(response, 200, {
        events: [
          {
            ...event,
            payload: {
              ...event.payload,
              runId: randomUUID(),
            },
          },
        ],
      });
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
    });

    await expect(adapter.pollProvenEvents()).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("mints only an identity-bound frozen preview with a bounded TTL", async () => {
    const event = provenEvent();
    const now = new Date("2026-07-23T20:00:00.000Z");
    let requestedUrl: URL | undefined;
    let requestedMethod: string | undefined;
    let requestedIdempotencyKey: string | undefined;
    let requestedBody: unknown;
    let returnMutablePreview = false;
    const backend = await listenHttp(async (request, response) => {
      requestedUrl = new URL(request.url ?? "/", "http://fake.invalid");
      requestedMethod = request.method;
      requestedIdempotencyKey = header(request, "idempotency-key");
      requestedBody = await readRequestJson(request);
      if (returnMutablePreview) {
        respondJson(response, 200, {
          kind: "ephemeral_daytona_preview",
          url: "https://mutable-preview.example",
          expiresAt: "2026-07-23T20:10:00.000Z",
        });
        return;
      }
      respondJson(response, 200, {
        kind: "frozen_proven_preview",
        eventId: event.eventId,
        runId: event.runId,
        artifactId: event.payload.artifact.artifactId,
        revisionHash: event.revisionHash,
        artifactSha256: event.payload.artifact.sha256,
        snapshotId: event.payload.artifact.daytonaSnapshot,
        url: "https://proven-preview.example/review/token",
        expiresAt: "2026-07-23T20:10:00.000Z",
      });
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
      now: () => now,
    });
    const idempotencyKey = `preview:materialize:${event.eventId}`;

    await expect(
      adapter.getProvenPreview({ event, ttlSeconds: 600, idempotencyKey }),
    ).resolves.toMatchObject({
      kind: "frozen_proven_preview",
      eventId: event.eventId,
      artifactSha256: event.payload.artifact.sha256,
    });
    expect(requestedMethod).toBe("POST");
    expect(requestedUrl?.pathname).toBe(
      `/v1/build-runs/${event.runId}/proven-preview`,
    );
    expect(requestedUrl?.search).toBe("");
    expect(requestedIdempotencyKey).toBe(idempotencyKey);
    expect(requestedBody).toMatchObject({
      expiresInSeconds: 600,
      artifactId: event.payload.artifact.artifactId,
    });
    returnMutablePreview = true;
    await expect(
      adapter.getProvenPreview({ event, ttlSeconds: 600, idempotencyKey }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    await expect(
      adapter.getProvenPreview({
        event,
        ttlSeconds: 604_801,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("downloads, verifies, and safely extracts an exact proven artifact", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "buildlabs-orchestration-test-"),
    );
    resources.push(() => rm(temporaryParent, { recursive: true, force: true }));
    const source = join(temporaryParent, "source");
    const archivePath = join(temporaryParent, "candidate.tar.gz");
    await mkdir(source);
    await writeFile(join(source, "Dockerfile"), "FROM node:24-alpine\n");
    await writeFile(join(source, "app.js"), "console.log('proven')\n");
    await tar.c(
      {
        cwd: source,
        file: archivePath,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      ["."],
    );
    const archive = await readFile(archivePath);
    const event = provenEvent(archive);
    const backend = await listenHttp((request, response) => {
      if (
        request.method === "GET" &&
        request.url === event.payload.artifact.uri
      ) {
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": String(archive.byteLength),
          "x-artifact-sha256": sha256(archive),
        });
        response.end(archive);
        return;
      }
      respondJson(response, 404, {});
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
      artifactTempDirectory: temporaryParent,
    });

    const validated = await adapter.downloadProvenArtifact(event);

    await expect(
      readFile(join(validated.directory, "Dockerfile"), "utf8"),
    ).resolves.toBe("FROM node:24-alpine\n");
    expect(validated.sourceSha256).toBe(sha256(archive));
    expect(validated.sourceSizeBytes).toBe(archive.byteLength);
    expect(validated.eventId).toBe(event.eventId);
    await validated.cleanup();
    await expect(lstat(validated.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes partial work when downloaded bytes fail the proven digest", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "buildlabs-orchestration-integrity-"),
    );
    resources.push(() => rm(temporaryParent, { recursive: true, force: true }));
    const source = join(temporaryParent, "source");
    const extractionParent = join(temporaryParent, "extractions");
    const archivePath = join(temporaryParent, "candidate.tar.gz");
    await mkdir(source);
    await mkdir(extractionParent);
    await writeFile(join(source, "Dockerfile"), "FROM node:24-alpine\n");
    await tar.c({ cwd: source, file: archivePath, gzip: true }, ["."]);
    const archive = await readFile(archivePath);
    const tampered = Buffer.from(archive);
    const tamperIndex = Math.floor(tampered.byteLength / 2);
    tampered[tamperIndex] = (tampered[tamperIndex] ?? 0) ^ 1;
    const event = provenEvent(archive);
    const backend = await listenHttp((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(archive.byteLength),
        "x-artifact-sha256": sha256(archive),
      });
      response.end(tampered);
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
      artifactTempDirectory: extractionParent,
    });

    await expect(adapter.downloadProvenArtifact(event)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_FAILED",
    });
    await expect(readdir(extractionParent)).resolves.toEqual([]);
  });

  it("rejects link entries in an otherwise exact artifact archive", async () => {
    const temporaryParent = await mkdtemp(
      join(tmpdir(), "buildlabs-orchestration-unsafe-tar-"),
    );
    resources.push(() => rm(temporaryParent, { recursive: true, force: true }));
    const source = join(temporaryParent, "source");
    const extractionParent = join(temporaryParent, "extractions");
    const archivePath = join(temporaryParent, "candidate.tar.gz");
    await mkdir(source);
    await mkdir(extractionParent);
    await writeFile(join(source, "Dockerfile"), "FROM node:24-alpine\n");
    await symlink("/etc/passwd", join(source, "host-secret"));
    await tar.c({ cwd: source, file: archivePath, gzip: true }, ["."]);
    const archive = await readFile(archivePath);
    const event = provenEvent(archive);
    const backend = await listenHttp((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(archive.byteLength),
        "x-artifact-sha256": sha256(archive),
      });
      response.end(archive);
    });
    resources.push(backend.close);
    const adapter = new HttpBuildBackendAdapter({
      baseUrl: backend.url,
      bearerToken: "internal-token-with-sufficient-length",
      artifactTempDirectory: extractionParent,
    });

    await expect(adapter.downloadProvenArtifact(event)).rejects.toMatchObject({
      code: "UNSAFE_ARCHIVE",
    });
    await expect(readdir(extractionParent)).resolves.toEqual([]);
  });

  it("probes the configured Fly organization and flyctl without mutation", async () => {
    const fakeSpawn = new FakeSpawn(() => successfulSpawn());
    const requestedUrls: string[] = [];
    const apiFetch = ((input: string | URL | Request) => {
      requestedUrls.push(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
    });

    await expect(deployer.health()).resolves.toBeUndefined();
    expect(requestedUrls).toEqual([
      `https://api.machines.dev/v1/apps?org_slug=${TEST_FLY_ORGANIZATION}`,
    ]);
    expect(fakeSpawn.invocations).toHaveLength(1);
    expect(fakeSpawn.invocations[0]).toMatchObject({
      args: ["version"],
      shell: false,
      captureStdout: false,
    });
  });

  it.each([
    ["scheme-relative path", "//attacker.invalid/ready"],
    ["backslash", "/ready\\injected"],
    ["control character", "/ready\tinjected"],
    ["fragment", "/ready#not-sent-over-http"],
  ])("rejects an unsafe Fly health %s", (_case, healthPath) => {
    expect(
      () =>
        new FlyCliDeploymentAdapter({
          accessToken: "fly-secret-token-never-log",
          organizationSlug: TEST_FLY_ORGANIZATION,
          primaryRegion: TEST_FLY_REGION,
          healthPath,
        }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("bounds the complete Fly operation, including preflight before flyctl deploy", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const fakeSpawn = new FakeSpawn(() => ({
      exitCode: 1,
      signal: null,
      stdout: "",
    }));
    const apiFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      })) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
      deployTimeoutMs: 1_000,
      operationTimeoutMs: 1_000,
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(
      fakeSpawn.invocations.some(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toBe(false);
  });

  it("proves Fly release labels, digest, version, and exact-machine health", async () => {
    const { event, validated } = await deploymentFixture(resources);
    let deployed = false;
    const fakeSpawn = new FakeSpawn((invocation) => {
      if (invocation.args[0] === "deploy") {
        deployed = true;
        return successfulSpawn();
      }
      return successfulSpawn(
        flyMachineListJson(event, {
          releaseId: deployed ? "release-5" : "release-4",
          releaseVersion: deployed ? 5 : 4,
          machineId: deployed ? "machine-5" : "machine-4",
          instanceId: deployed ? "instance-5" : "instance-4",
          ...(deployed
            ? {}
            : {
                releaseKey: "e".repeat(64),
                artifactSha256: "f".repeat(64),
              }),
        }),
      );
    });
    const healthRequests: Array<{ url: string; machineId: string | null }> = [];
    let healthAttempts = 0;
    const healthFetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      healthAttempts += 1;
      healthRequests.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        machineId: new Headers(init?.headers).get("fly-force-instance-id"),
      });
      return Promise.resolve(
        new Response(null, { status: healthAttempts < 3 ? 503 : 204 }),
      );
    }) as typeof fetch;
    const token = "fly-secret-token-never-log";
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: token,
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      appNamePrefix: "buildlabs",
      spawnCommand: fakeSpawn.run,
      fetch: healthFetch,
      healthMaxAttempts: 3,
      healthInitialDelayMs: 0,
      healthMaxDelayMs: 0,
      releaseInitialDelayMs: 0,
      releaseMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
      now: () => new Date("2026-07-23T20:30:00.000Z"),
    });

    const receipt = await deployer.deployProvenArtifact({
      event,
      artifact: validated,
    });

    expect(receipt).toMatchObject({
      provider: "fly",
      releaseKey: deriveFlyReleaseKey(event),
      sourceArtifactSha256: event.payload.artifact.sha256,
      flyReleaseId: "release-5",
      flyReleaseVersion: 5,
      imageDigest: `sha256:${"d".repeat(64)}`,
      machineIds: ["machine-5"],
      machineInstanceIds: ["instance-5"],
      verifiedLabels: {
        releaseKey: deriveFlyReleaseKey(event),
        artifactSha256: event.payload.artifact.sha256,
      },
      deploymentAttempted: true,
      recoveredFromProvider: false,
      healthAttempts: 3,
    });
    expect(receipt.productionUrl).toBe(`https://${receipt.appName}.fly.dev/`);
    expect(receipt.appName).toBe(
      deriveFlyAppName("buildlabs", event.payload.projectId),
    );
    expect(healthRequests).toHaveLength(3);
    for (const request of healthRequests) {
      const url = new URL(request.url);
      expect(url.origin + url.pathname).toBe(receipt.productionUrl);
      expect(url.searchParams.get("__buildlabs_release")).toBe(
        receipt.releaseKey,
      );
      expect(request.machineId).toBe("machine-5");
    }
    const deployInvocation = fakeSpawn.invocations.find(
      (invocation) => invocation.args[0] === "deploy",
    );
    expect(deployInvocation).toMatchObject({
      command: "flyctl",
      cwd: validated.directory,
      shell: false,
      captureStdout: false,
    });
    expect(deployInvocation?.args).toContain("--remote-only");
    expect(deployInvocation?.args).toContain("--yes");
    const strategyIndex = deployInvocation?.args.indexOf("--strategy") ?? -1;
    expect(
      deployInvocation?.args.slice(strategyIndex, strategyIndex + 2),
    ).toEqual(["--strategy", "bluegreen"]);
    expect(deployInvocation?.args).toContain(
      `io.buildlabs.release-key=${receipt.releaseKey}`,
    );
    expect(deployInvocation?.args.join(" ")).not.toContain(token);
    expect(
      fakeSpawn.invocations.every(
        (invocation) => invocation.env.FLY_API_TOKEN === token,
      ),
    ).toBe(true);
    expect(
      fakeSpawn.invocations
        .filter((invocation) => invocation.args[0] === "machine")
        .every((invocation) => invocation.captureStdout),
    ).toBe(true);

    const invocationCount = fakeSpawn.invocations.length;
    await writeFile(
      join(validated.directory, "server.js"),
      "console.log('tampered after validation')\n",
    );
    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_FAILED" });
    expect(fakeSpawn.invocations).toHaveLength(invocationCount);
  });

  it.each([200, 201])(
    "creates a missing derived Fly app after Apps API status %i and deploys a Dockerfile-only artifact as a public service",
    async (createStatus) => {
      const { event, validated } = await deploymentFixture(resources);
      event.payload.previewPort = 4173;
      await expect(
        lstat(join(validated.directory, "fly.toml")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const organizationSlug = TEST_FLY_ORGANIZATION;
      const appName = deriveFlyAppName("buildlabs", event.payload.projectId);
      const healthPath = '/ready?probe="fly"';
      let appExists = false;
      let deployed = false;
      let trustedConfigPath: string | undefined;
      let trustedConfigContents: string | undefined;
      const fakeSpawn = new FakeSpawn((invocation) => {
        if (invocation.args[0] === "deploy") {
          const configIndex = invocation.args.indexOf("--config");
          const configPath = invocation.args[configIndex + 1];
          if (configIndex < 0 || !configPath) {
            throw new Error("deploy omitted the trusted Fly config");
          }
          trustedConfigPath = configPath;
          return readFile(configPath, "utf8").then((contents) => {
            trustedConfigContents = contents;
            deployed = true;
            return successfulSpawn();
          });
        }
        if (!appExists) {
          return { exitCode: 1, signal: null };
        }
        return successfulSpawn(deployed ? flyMachineListJson(event) : "[]");
      });
      const appRequests: Array<{
        method: string;
        url: string;
        body?: unknown;
      }> = [];
      const apiFetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const method = init?.method ?? "GET";
        appRequests.push({
          method,
          url,
          ...(typeof init?.body === "string"
            ? { body: JSON.parse(init.body) as unknown }
            : {}),
        });
        if (method === "POST") {
          appExists = true;
          return Promise.resolve(
            Response.json(
              { id: "provider-app-id", created_at: 1_721_774_600_000 },
              { status: createStatus },
            ),
          );
        }
        return Promise.resolve(
          appExists
            ? Response.json({
                id: "provider-app-id",
                name: appName,
                status: "pending",
                organization: {
                  name: "BuildLabs",
                  slug: organizationSlug,
                },
              })
            : new Response(null, { status: 404 }),
        );
      }) as typeof fetch;
      const deployer = new FlyCliDeploymentAdapter({
        accessToken: "fly-org-token-never-log",
        organizationSlug,
        appNamePrefix: "buildlabs",
        primaryRegion: TEST_FLY_REGION,
        healthPath,
        spawnCommand: fakeSpawn.run,
        apiFetch,
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        releaseInitialDelayMs: 0,
        releaseMaxDelayMs: 0,
        sleep: () => Promise.resolve(),
      });

      await expect(
        deployer.deployProvenArtifact({ event, artifact: validated }),
      ).resolves.toMatchObject({
        appName,
        deploymentAttempted: true,
        flyReleaseId: "release-5",
      });
      expect(appRequests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
        "GET",
      ]);
      expect(appRequests[1]?.body).toEqual({
        app_name: appName,
        org_slug: organizationSlug,
      });
      expect(trustedConfigContents).toBe(
        [
          `app = "${appName}"`,
          'primary_region = "sjc"',
          "",
          "[deploy]",
          '  strategy = "bluegreen"',
          "",
          "[http_service]",
          "  internal_port = 4173",
          "  force_https = true",
          "",
          "[[http_service.checks]]",
          '  grace_period = "10s"',
          '  interval = "15s"',
          '  method = "GET"',
          '  path = "/ready?probe=\\"fly\\""',
          '  protocol = "http"',
          '  timeout = "5s"',
          "",
        ].join("\n"),
      );
      expect(trustedConfigPath).toBeDefined();
      expect(trustedConfigPath?.startsWith(`${validated.directory}/`)).toBe(
        false,
      );
      await expect(lstat(trustedConfigPath!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("recovers an existing app after an ambiguous machine-list preflight without trying to recreate it", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const appName = deriveFlyAppName("buildlabs", event.payload.projectId);
    let inspections = 0;
    const fakeSpawn = new FakeSpawn(() => {
      inspections += 1;
      return inspections === 1
        ? { exitCode: 1, signal: null }
        : successfulSpawn(flyMachineListJson(event));
    });
    const appMethods: string[] = [];
    const apiFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      appMethods.push(init?.method ?? "GET");
      return Promise.resolve(
        Response.json({
          id: "provider-app-id",
          name: appName,
          status: "deployed",
          organization: {
            name: "BuildLabs",
            slug: TEST_FLY_ORGANIZATION,
          },
        }),
      );
    }) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-app-scoped-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).resolves.toMatchObject({
      appName,
      deploymentAttempted: false,
      recoveredFromProvider: true,
    });
    expect(appMethods).toEqual(["GET"]);
    expect(
      fakeSpawn.invocations.some(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toBe(false);
  });

  it("recovers when another worker wins the unique Fly app creation race", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const appName = deriveFlyAppName("buildlabs", event.payload.projectId);
    let appExists = false;
    let deployed = false;
    const fakeSpawn = new FakeSpawn((invocation) => {
      if (invocation.args[0] === "deploy") {
        deployed = true;
        return successfulSpawn();
      }
      if (!appExists) {
        return { exitCode: 1, signal: null };
      }
      return successfulSpawn(deployed ? flyMachineListJson(event) : "[]");
    });
    const appMethods: string[] = [];
    const apiFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      appMethods.push(method);
      if (method === "POST") {
        appExists = true;
        return Promise.resolve(new Response(null, { status: 409 }));
      }
      return Promise.resolve(
        appExists
          ? Response.json({
              id: "provider-app-id",
              name: appName,
              status: "pending",
              organization: {
                name: "BuildLabs",
                slug: TEST_FLY_ORGANIZATION,
              },
            })
          : new Response(null, { status: 404 }),
      );
    }) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-org-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      releaseInitialDelayMs: 0,
      releaseMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).resolves.toMatchObject({
      appName,
      deploymentAttempted: true,
      flyReleaseId: "release-5",
    });
    expect(appMethods).toEqual(["GET", "POST", "GET"]);
  });

  it("fails closed when a missing Fly app cannot be created or recovered", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const token = "fly-org-token-never-log";
    const fakeSpawn = new FakeSpawn(() => ({
      exitCode: 1,
      signal: null,
    }));
    const appMethods: string[] = [];
    const apiFetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      appMethods.push(method);
      if (method === "POST") {
        throw new Error(`sanitized boundary must discard ${token}`);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: token,
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    let failure: unknown;
    try {
      await deployer.deployProvenArtifact({ event, artifact: validated });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      operation: "ensure_app",
      code: "PROVIDER_FAILURE",
    });
    expect(String(failure)).not.toContain(token);
    expect(appMethods).toEqual(["GET", "POST", "GET"]);
    expect(
      fakeSpawn.invocations.some(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toBe(false);
  });

  it("rejects a derived Fly app that resolves to a different organization", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const appName = deriveFlyAppName("buildlabs", event.payload.projectId);
    const fakeSpawn = new FakeSpawn(() => ({
      exitCode: 1,
      signal: null,
    }));
    const apiFetch = (() =>
      Promise.resolve(
        Response.json({
          id: "provider-app-id",
          name: appName,
          status: "deployed",
          organization: {
            name: "Different organization",
            slug: "different-organization",
          },
        }),
      )) as typeof fetch;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-org-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch,
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({
      operation: "inspect_app",
      code: "POLICY_BLOCKED",
    });
    expect(
      fakeSpawn.invocations.some(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toBe(false);
  });

  it("recovers an already-current deterministic release without redeploying", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const fakeSpawn = new FakeSpawn(() =>
      successfulSpawn(flyMachineListJson(event)),
    );
    let appApiRequests = 0;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      apiFetch: () => {
        appApiRequests += 1;
        return Promise.reject(
          new Error("app-scoped token must not need org API"),
        );
      },
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).resolves.toMatchObject({
      deploymentAttempted: false,
      recoveredFromProvider: true,
      flyReleaseId: "release-5",
      flyReleaseVersion: 5,
    });
    expect(
      fakeSpawn.invocations.some(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toBe(false);
    expect(appApiRequests).toBe(0);
  });

  it("recovers provider success after the flyctl deploy response is lost", async () => {
    const { event, validated } = await deploymentFixture(resources);
    let deployed = false;
    const fakeSpawn = new FakeSpawn((invocation) => {
      if (invocation.args[0] === "deploy") {
        deployed = true;
        throw new Error("connection dropped after provider accepted deploy");
      }
      return successfulSpawn(
        flyMachineListJson(event, {
          releaseId: deployed ? "release-5" : "release-4",
          releaseVersion: deployed ? 5 : 4,
          ...(deployed
            ? {}
            : {
                releaseKey: "e".repeat(64),
                artifactSha256: "f".repeat(64),
              }),
        }),
      );
    });
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
      releaseInitialDelayMs: 0,
      releaseMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).resolves.toMatchObject({
      deploymentAttempted: true,
      recoveredFromProvider: true,
      flyReleaseVersion: 5,
    });
    expect(
      fakeSpawn.invocations.filter(
        (invocation) => invocation.args[0] === "deploy",
      ),
    ).toHaveLength(1);
  });

  it("rejects a stale app 2xx when Fly never proves the requested release", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const fakeSpawn = new FakeSpawn((invocation) =>
      invocation.args[0] === "deploy"
        ? successfulSpawn()
        : successfulSpawn(
            flyMachineListJson(event, {
              releaseId: "release-4",
              releaseVersion: 4,
              releaseKey: "e".repeat(64),
              artifactSha256: "f".repeat(64),
            }),
          ),
    );
    let healthRequests = 0;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      fetch: () => {
        healthRequests += 1;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
      releaseMaxAttempts: 2,
      releaseInitialDelayMs: 0,
      releaseMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "RELEASE_VERIFICATION_FAILED" });
    expect(healthRequests).toBe(0);
  });

  it("fences a vN to vN+1 change around an otherwise successful health request", async () => {
    const { event, validated } = await deploymentFixture(resources);
    let inspections = 0;
    const fakeSpawn = new FakeSpawn(() => {
      inspections += 1;
      return successfulSpawn(
        flyMachineListJson(event, {
          releaseId: inspections < 3 ? "release-5" : "release-6",
          releaseVersion: inspections < 3 ? 5 : 6,
          instanceId: inspections < 3 ? "instance-5" : "instance-6",
        }),
      );
    });
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "RELEASE_FENCED" });
    expect(inspections).toBe(3);
  });

  it("fails health when the exact proven release remains unhealthy", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const fakeSpawn = new FakeSpawn(() =>
      successfulSpawn(flyMachineListJson(event)),
    );
    let healthRequests = 0;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      fetch: () => {
        healthRequests += 1;
        return Promise.resolve(new Response(null, { status: 503 }));
      },
      healthMaxAttempts: 2,
      healthInitialDelayMs: 0,
      healthMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "HEALTH_CHECK_FAILED" });
    expect(healthRequests).toBe(2);
  });

  it("fails closed when flyctl omits documented image-label proof", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const incompleteMachine = JSON.parse(flyMachineListJson(event)) as Array<{
      image_ref: { labels?: Record<string, string> };
    }>;
    delete incompleteMachine[0]?.image_ref.labels;
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: "fly-secret-token-never-log",
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: new FakeSpawn(() =>
        successfulSpawn(JSON.stringify(incompleteMachine)),
      ).run,
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
    });

    await expect(
      deployer.deployProvenArtifact({ event, artifact: validated }),
    ).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
  });

  it("sanitizes a failed deploy that cannot be recovered by release key", async () => {
    const { event, validated } = await deploymentFixture(resources);
    const token = "fly-secret-token-never-log";
    const fakeSpawn = new FakeSpawn((invocation) => {
      if (invocation.args[0] === "deploy") {
        throw new Error(`provider output contained ${token}`);
      }
      return successfulSpawn(
        flyMachineListJson(event, {
          releaseId: "release-4",
          releaseVersion: 4,
          releaseKey: "e".repeat(64),
          artifactSha256: "f".repeat(64),
        }),
      );
    });
    const deployer = new FlyCliDeploymentAdapter({
      accessToken: token,
      organizationSlug: TEST_FLY_ORGANIZATION,
      primaryRegion: TEST_FLY_REGION,
      spawnCommand: fakeSpawn.run,
      fetch: () => Promise.resolve(new Response(null, { status: 200 })),
      releaseMaxAttempts: 2,
      releaseInitialDelayMs: 0,
      releaseMaxDelayMs: 0,
      sleep: () => Promise.resolve(),
    });

    let sanitizedFailure: unknown;
    try {
      await deployer.deployProvenArtifact({ event, artifact: validated });
    } catch (error) {
      sanitizedFailure = error;
    }
    expect(sanitizedFailure).toMatchObject({ code: "DEPLOYMENT_FAILED" });
    expect(String(sanitizedFailure)).not.toContain(token);
  });
});

interface ListeningHttpServer {
  url: string;
  close: () => Promise<void>;
}

async function listenHttp(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<ListeningHttpServer> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake HTTP backend did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string") {
      chunks.push(Buffer.from(value));
    } else if (value instanceof Uint8Array) {
      chunks.push(value);
    } else {
      throw new Error("Unexpected request chunk");
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function runForAssignment(
  input: ReturnType<typeof assignment>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    assignmentId: input.assignmentId,
    assignmentHash: assignmentDigest(input),
    projectId: input.projectId,
    candidateId: input.candidateId,
    contractHash: contractDigest(input.contract),
    status: "queued",
    stage: "queued",
    cancelRequested: false,
    createdAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T20:00:00.000Z",
    ...overrides,
  };
}

function provenEvent(artifactContents?: Uint8Array): OutboxEvent {
  const runId = randomUUID();
  const revisionHash = "c".repeat(64);
  const provenArtifact = artifact(runId, revisionHash);
  if (artifactContents) {
    provenArtifact.sha256 = sha256(artifactContents);
    provenArtifact.sizeBytes = artifactContents.byteLength;
  }
  const traceId = "trace-build-deploy";
  return OutboxEventSchema.parse({
    eventId: randomUUID(),
    type: "candidate.proven",
    runId,
    revisionHash,
    traceId,
    payload: {
      runId,
      projectId: "project-build-deploy",
      candidateId: "candidate-build-deploy",
      contractHash: "a".repeat(64),
      revisionHash,
      sandboxId: "sandbox-build-deploy",
      previewPort: 3000,
      artifact: provenArtifact,
      traceId,
      ranking: {
        provider: "braintrust",
        policyVersion: "braintrust-preference-v1",
        preferenceSatisfaction: 0.9,
        scoreTuple: [0.9],
        traceId,
      },
    },
    createdAt: "2026-07-23T20:00:00.000Z",
  });
}

async function deploymentFixture(
  resources: Array<() => Promise<void>>,
): Promise<{
  event: OutboxEvent;
  validated: Awaited<
    ReturnType<HttpBuildBackendAdapter["downloadProvenArtifact"]>
  >;
}> {
  const temporaryParent = await mkdtemp(
    join(tmpdir(), "buildlabs-orchestration-fly-"),
  );
  resources.push(() => rm(temporaryParent, { recursive: true, force: true }));
  const source = join(temporaryParent, "source");
  const extractionParent = join(temporaryParent, "extractions");
  const archivePath = join(temporaryParent, "candidate.tar.gz");
  await mkdir(source);
  await mkdir(extractionParent);
  await writeFile(join(source, "Dockerfile"), "FROM node:24-alpine\n");
  await writeFile(join(source, "server.js"), "console.log('ready')\n");
  await tar.c({ cwd: source, file: archivePath, gzip: true }, ["."]);
  const archive = await readFile(archivePath);
  const event = provenEvent(archive);
  const backend = await listenHttp((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": String(archive.byteLength),
      "x-artifact-sha256": sha256(archive),
    });
    response.end(archive);
  });
  resources.push(backend.close);
  const buildBackend = new HttpBuildBackendAdapter({
    baseUrl: backend.url,
    bearerToken: "internal-token-with-sufficient-length",
    artifactTempDirectory: extractionParent,
  });
  return {
    event,
    validated: await buildBackend.downloadProvenArtifact(event),
  };
}

interface FlyMachineOverrides {
  releaseId?: string;
  releaseVersion?: number;
  releaseKey?: string;
  artifactSha256?: string;
  imageDigest?: string;
  machineId?: string;
  instanceId?: string;
  state?: string;
}

function flyMachineListJson(
  event: OutboxEvent,
  overrides: FlyMachineOverrides = {},
): string {
  return JSON.stringify([
    {
      id: overrides.machineId ?? "machine-5",
      instance_id: overrides.instanceId ?? "instance-5",
      state: overrides.state ?? "started",
      config: {
        image: "registry.fly.io/buildlabs@sha256:provider-value",
        metadata: {
          fly_release_id: overrides.releaseId ?? "release-5",
          fly_release_version: String(overrides.releaseVersion ?? 5),
        },
      },
      image_ref: {
        digest: overrides.imageDigest ?? `sha256:${"d".repeat(64)}`,
        labels: {
          "io.buildlabs.release-key":
            overrides.releaseKey ?? deriveFlyReleaseKey(event),
          "io.buildlabs.artifact-sha256":
            overrides.artifactSha256 ?? event.payload.artifact.sha256,
        },
      },
    },
  ]);
}

function successfulSpawn(stdout?: string) {
  return {
    exitCode: 0,
    signal: null,
    ...(stdout === undefined ? {} : { stdout }),
  } as const;
}

type FakeSpawnHandler = (
  invocation: SpawnInvocation,
  invocationIndex: number,
) => SpawnResult | Promise<SpawnResult>;

class FakeSpawn {
  readonly invocations: SpawnInvocation[] = [];
  readonly #handler: FakeSpawnHandler;

  constructor(handler: FakeSpawnHandler) {
    this.#handler = handler;
  }

  readonly run: SpawnCommand = async (invocation) => {
    const invocationIndex = this.invocations.length;
    this.invocations.push(invocation);
    return this.#handler(invocation, invocationIndex);
  };
}
