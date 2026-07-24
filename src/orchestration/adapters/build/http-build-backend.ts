import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

import {
  OutboxEventSchema,
  ProvenArtifactSchema,
  type OutboxEvent,
} from "../../../domain/artifact.js";
import {
  assignmentDigest,
  BuildAssignmentSchema,
  contractDigest,
  Sha256Schema,
  type BuildAssignment,
} from "../../../domain/contract.js";
import {
  CustomerBuildObservationSchema,
  type CustomerBuildObservation,
} from "../../../domain/customer-observability.js";
import {
  RunStageSchema,
  RunStatusSchema,
  type BuildRun,
} from "../../../domain/run.js";
import {
  MAX_PROVEN_PREVIEW_TTL_SECONDS,
  MIN_PROVEN_PREVIEW_TTL_SECONDS,
} from "../../ports/build-backend.js";
import type {
  BuildBackendPort,
  CustomerBuildObservationRequest,
  BuildDispatchReceipt,
  BuildRunSnapshot,
  FrozenProvenPreview,
  ProvenEventPollRequest,
  ProvenPreviewRequest,
  ValidatedProvenArtifact,
} from "../../ports/build-backend.js";
import { BuildAdapterError } from "./build-adapter-error.js";
import { validateArtifactWorkspace } from "./validated-artifact-workspace.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PREVIEW_REQUEST_TIMEOUT_MS = 6 * 60_000;
const DEFAULT_ARTIFACT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_OUTBOX_LIMIT = 100;
const DEFAULT_POLL_ATTEMPTS = 1;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 500 * 1_024 * 1_024;

const BuildRunSchema = z
  .object({
    id: z.uuid(),
    assignmentId: z.string().min(1).max(128),
    assignmentHash: Sha256Schema,
    projectId: z.string().min(1).max(128),
    candidateId: z.string().min(1).max(128),
    contractHash: Sha256Schema,
    status: RunStatusSchema,
    stage: RunStageSchema,
    slotId: z.number().int().positive().optional(),
    fencingToken: z.number().int().nonnegative().optional(),
    sandboxId: z.string().min(1).max(512).optional(),
    revisionHash: Sha256Schema.optional(),
    previewPort: z.number().int().min(1).max(65_535).optional(),
    cancelRequested: z.boolean(),
    errorCode: z.string().min(1).max(256).optional(),
    errorMessage: z.string().min(1).max(4_000).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
  })
  .strict();

const BuildDispatchResponseSchema = z
  .object({
    created: z.boolean(),
    run: BuildRunSchema,
  })
  .strict();

const BuildRunSnapshotSchema = z
  .object({
    run: BuildRunSchema,
    artifact: ProvenArtifactSchema.nullable(),
  })
  .strict();

const CancelBuildResponseSchema = z.object({ run: BuildRunSchema }).strict();

const ProvenEventsResponseSchema = z
  .object({
    events: z.array(OutboxEventSchema).max(1_000),
  })
  .strict();

const FrozenProvenPreviewSchema = z
  .object({
    kind: z.literal("frozen_proven_preview"),
    eventId: z.uuid(),
    runId: z.uuid(),
    artifactId: z.uuid(),
    revisionHash: Sha256Schema,
    artifactSha256: Sha256Schema,
    snapshotId: z.string().min(1).max(128),
    url: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const BuildBackendReadinessSchema = z
  .object({
    status: z.literal("ready"),
    component: z.literal("build-agent-backend"),
    providers: z
      .object({
        daytona: z.literal("healthy"),
        fireworks: z.literal("healthy"),
        coderabbit: z.literal("healthy"),
        braintrust: z.literal("healthy"),
      })
      .passthrough(),
    configuration: z
      .object({
        daytonaSnapshot: z.string().min(1).max(256),
      })
      .strict(),
    checkedAt: z.iso.datetime(),
  })
  .strict();

export interface HttpBuildBackendAdapterOptions {
  baseUrl: string;
  bearerToken: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  previewRequestTimeoutMs?: number;
  artifactRequestTimeoutMs?: number;
  now?: () => Date;
  artifactTempDirectory?: string;
  maxArtifactBytes?: number;
  expectedDaytonaSnapshot?: string;
}

export class HttpBuildBackendAdapter implements BuildBackendPort {
  readonly #baseUrl: URL;
  readonly #bearerToken: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #previewRequestTimeoutMs: number;
  readonly #artifactRequestTimeoutMs: number;
  readonly #now: () => Date;
  readonly #artifactTempDirectory: string | undefined;
  readonly #maxArtifactBytes: number;
  readonly #expectedDaytonaSnapshot: string | undefined;

  constructor(options: HttpBuildBackendAdapterOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#bearerToken = validateBearerToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = validateRequestTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#previewRequestTimeoutMs = validateRequestTimeout(
      options.previewRequestTimeoutMs ?? DEFAULT_PREVIEW_REQUEST_TIMEOUT_MS,
    );
    this.#artifactRequestTimeoutMs = validateRequestTimeout(
      options.artifactRequestTimeoutMs ?? DEFAULT_ARTIFACT_REQUEST_TIMEOUT_MS,
    );
    this.#now = options.now ?? (() => new Date());
    this.#artifactTempDirectory = options.artifactTempDirectory;
    this.#maxArtifactBytes = validateMaxArtifactBytes(
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    );
    this.#expectedDaytonaSnapshot = options.expectedDaytonaSnapshot;
    if (
      this.#expectedDaytonaSnapshot !== undefined &&
      (this.#expectedDaytonaSnapshot.trim() !== this.#expectedDaytonaSnapshot ||
        this.#expectedDaytonaSnapshot.length === 0 ||
        this.#expectedDaytonaSnapshot.length > 256)
    ) {
      throw new BuildAdapterError(
        "build-backend",
        "configuration",
        "INVALID_INPUT",
      );
    }
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.#request(
      "v1/integrations/probe",
      { method: "POST" },
      signal,
      "health",
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new BuildAdapterError(
        "build-backend",
        "health",
        "PROVIDER_FAILURE",
      );
    }
    const result = parseProviderJson(
      BuildBackendReadinessSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "health",
    );
    if (
      this.#expectedDaytonaSnapshot !== undefined &&
      result.configuration.daytonaSnapshot !== this.#expectedDaytonaSnapshot
    ) {
      throw new BuildAdapterError("build-backend", "health", "POLICY_BLOCKED");
    }
  }

  async dispatchBuild(
    input: BuildAssignment,
    signal?: AbortSignal,
  ): Promise<BuildDispatchReceipt> {
    const assignment = parseAssignment(input, "dispatch_build");
    const digest = assignmentDigest(assignment);
    const response = await this.#request(
      "/v1/build-runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `build-dispatch:${assignment.assignmentId}:${digest}`,
        },
        body: JSON.stringify(assignment),
      },
      signal,
      "dispatch_build",
    );
    if (response.status !== 200 && response.status !== 202) {
      throw new BuildAdapterError(
        "build-backend",
        "dispatch_build",
        response.status === 409 ? "POLICY_BLOCKED" : "PROVIDER_FAILURE",
      );
    }
    const result = parseProviderJson(
      BuildDispatchResponseSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "dispatch_build",
    );
    const run = result.run as BuildRun;
    verifyRunAssignment(run, assignment, digest, "dispatch_build");
    if (result.created !== (response.status === 202)) {
      throw new BuildAdapterError(
        "build-backend",
        "dispatch_build",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return { created: result.created, run };
  }

  async getBuildRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<BuildRunSnapshot> {
    const normalizedRunId = parseUuid(runId, "get_build_run");
    const response = await this.#request(
      `/v1/build-runs/${encodeURIComponent(normalizedRunId)}`,
      { method: "GET" },
      signal,
      "get_build_run",
    );
    if (response.status !== 200) {
      throw new BuildAdapterError(
        "build-backend",
        "get_build_run",
        "PROVIDER_FAILURE",
      );
    }
    const snapshot = parseProviderJson(
      BuildRunSnapshotSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "get_build_run",
    );
    const normalizedSnapshot = {
      run: snapshot.run as BuildRun,
      artifact: snapshot.artifact,
    };
    verifyRunSnapshot(normalizedSnapshot, normalizedRunId);
    return normalizedSnapshot;
  }

  async getCustomerBuildObservation(
    request: CustomerBuildObservationRequest,
    signal?: AbortSignal,
  ): Promise<CustomerBuildObservation> {
    const runId = parseUuid(request.runId, "customer_build_observation");
    const afterSequence = boundedObservationInteger(
      request.afterSequence ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
      "afterSequence",
    );
    const limit = boundedObservationInteger(
      request.limit ?? 100,
      1,
      250,
      "limit",
    );
    const query = new URLSearchParams({
      after: String(afterSequence),
      limit: String(limit),
    });
    const response = await this.#request(
      `/v1/build-runs/${encodeURIComponent(runId)}/customer-observability?${query.toString()}`,
      { method: "GET" },
      signal,
      "customer_build_observation",
    );
    if (response.status !== 200) {
      throw new BuildAdapterError(
        "build-backend",
        "customer_build_observation",
        "PROVIDER_FAILURE",
      );
    }
    const observation = parseProviderJson(
      CustomerBuildObservationSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "customer_build_observation",
    );
    if (observation.runId !== runId) {
      throw new BuildAdapterError(
        "build-backend",
        "customer_build_observation",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return observation;
  }

  async cancelBuild(runId: string, signal?: AbortSignal): Promise<BuildRun> {
    const normalizedRunId = parseUuid(runId, "cancel_build");
    const response = await this.#request(
      `/v1/build-runs/${encodeURIComponent(normalizedRunId)}/cancel`,
      {
        method: "POST",
        headers: {
          "idempotency-key": `build-cancel:${normalizedRunId}`,
        },
      },
      signal,
      "cancel_build",
    );
    if (response.status !== 202) {
      throw new BuildAdapterError(
        "build-backend",
        "cancel_build",
        "PROVIDER_FAILURE",
      );
    }
    const result = parseProviderJson(
      CancelBuildResponseSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "cancel_build",
    );
    if (result.run.id !== normalizedRunId) {
      throw new BuildAdapterError(
        "build-backend",
        "cancel_build",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return result.run as BuildRun;
  }

  async pollProvenEvents(
    request: ProvenEventPollRequest = {},
    signal?: AbortSignal,
  ): Promise<OutboxEvent[]> {
    const options = validatePollRequest(request);
    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      const query = new URLSearchParams({
        limit: String(options.limit),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        ...(options.runIds ? { runIds: options.runIds.join(",") } : {}),
      });
      const response = await this.#request(
        `/v1/outbox?${query.toString()}`,
        { method: "GET" },
        signal,
        "poll_proven_events",
      );
      if (response.status !== 200) {
        throw new BuildAdapterError(
          "build-backend",
          "poll_proven_events",
          "PROVIDER_FAILURE",
        );
      }
      const result = parseProviderJson(
        ProvenEventsResponseSchema,
        await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
        "poll_proven_events",
      );
      verifyProvenEvents(result.events, options.limit, options.runIds);
      if (result.events.length > 0) {
        return result.events;
      }
      if (attempt < options.maxAttempts && options.intervalMs > 0) {
        try {
          await delay(options.intervalMs, undefined, { signal });
        } catch {
          throw new BuildAdapterError(
            "build-backend",
            "poll_proven_events",
            "ABORTED",
          );
        }
      }
    }
    return [];
  }

  async acknowledgeProvenEvent(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalizedEventId = parseUuid(eventId, "acknowledge_proven_event");
    const response = await this.#request(
      `/v1/outbox/${encodeURIComponent(normalizedEventId)}/ack`,
      {
        method: "POST",
        headers: {
          "idempotency-key": `proven-event-ack:${normalizedEventId}`,
        },
      },
      signal,
      "acknowledge_proven_event",
    );
    if (response.status !== 204) {
      throw new BuildAdapterError(
        "build-backend",
        "acknowledge_proven_event",
        "PROVIDER_FAILURE",
      );
    }
  }

  async getProvenPreview(
    request: ProvenPreviewRequest,
    signal?: AbortSignal,
  ): Promise<FrozenProvenPreview> {
    const parsedEvent = OutboxEventSchema.safeParse(request.event);
    if (
      !parsedEvent.success ||
      !Number.isInteger(request.ttlSeconds) ||
      request.ttlSeconds < MIN_PROVEN_PREVIEW_TTL_SECONDS ||
      request.ttlSeconds > MAX_PROVEN_PREVIEW_TTL_SECONDS ||
      !validIdempotencyKey(request.idempotencyKey)
    ) {
      throw new BuildAdapterError(
        "build-backend",
        "get_proven_preview",
        "INVALID_INPUT",
      );
    }
    const event = parsedEvent.data;
    const body = {
      artifactId: event.payload.artifact.artifactId,
      artifactSha256: event.payload.artifact.sha256,
      eventId: event.eventId,
      expiresInSeconds: request.ttlSeconds,
      revisionHash: event.revisionHash,
    };
    const response = await this.#request(
      `/v1/build-runs/${encodeURIComponent(event.runId)}/proven-preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      signal,
      "get_proven_preview",
      this.#previewRequestTimeoutMs,
    );
    if (response.status !== 200) {
      throw new BuildAdapterError(
        "build-backend",
        "get_proven_preview",
        "PROVIDER_FAILURE",
      );
    }
    const preview = parseProviderJson(
      FrozenProvenPreviewSchema,
      await readBoundedText(response, MAX_JSON_RESPONSE_BYTES),
      "get_proven_preview",
    );
    verifyFrozenPreview(preview, event, request.ttlSeconds, this.#now());
    return preview;
  }

  async downloadProvenArtifact(
    input: OutboxEvent,
    signal?: AbortSignal,
  ): Promise<ValidatedProvenArtifact> {
    const parsedEvent = OutboxEventSchema.safeParse(input);
    if (
      !parsedEvent.success ||
      parsedEvent.data.payload.artifact.sizeBytes > this.#maxArtifactBytes
    ) {
      throw new BuildAdapterError(
        "build-backend",
        "download_artifact",
        "INVALID_INPUT",
      );
    }
    const event = parsedEvent.data;
    const artifact = event.payload.artifact;
    const response = await this.#request(
      artifact.uri,
      {
        method: "GET",
        headers: { accept: "application/gzip" },
      },
      signal,
      "download_artifact",
      this.#artifactRequestTimeoutMs,
    );
    if (response.status !== 200 || !response.body) {
      throw new BuildAdapterError(
        "build-backend",
        "download_artifact",
        "PROVIDER_FAILURE",
      );
    }
    verifyArtifactHeaders(
      response.headers,
      artifact.sizeBytes,
      artifact.sha256,
    );
    return validateArtifactWorkspace({
      event,
      body: response.body,
      ...(this.#artifactTempDirectory
        ? { temporaryParentDirectory: this.#artifactTempDirectory }
        : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async #request(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    operation: string,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await this.#fetch(resolveServicePath(this.#baseUrl, path), {
        ...init,
        headers: {
          authorization: `Bearer ${this.#bearerToken}`,
          accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal: combinedSignal,
      });
    } catch {
      throw new BuildAdapterError(
        "build-backend",
        operation,
        combinedSignal.aborted ? "ABORTED" : "PROVIDER_FAILURE",
      );
    }
  }
}

function resolveServicePath(baseUrl: URL, path: string): URL {
  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, baseUrl);
}

function parseAssignment(
  input: BuildAssignment,
  operation: string,
): BuildAssignment {
  const result = BuildAssignmentSchema.safeParse(input);
  if (!result.success) {
    throw new BuildAdapterError("build-backend", operation, "INVALID_INPUT");
  }
  return result.data;
}

function verifyRunAssignment(
  run: BuildRun,
  assignment: BuildAssignment,
  digest: string,
  operation: string,
): void {
  if (
    run.assignmentId !== assignment.assignmentId ||
    run.assignmentHash !== digest ||
    run.projectId !== assignment.projectId ||
    run.candidateId !== assignment.candidateId ||
    run.contractHash !== contractDigest(assignment.contract)
  ) {
    throw new BuildAdapterError(
      "build-backend",
      operation,
      "INVALID_PROVIDER_RESPONSE",
    );
  }
}

function parseProviderJson<T>(
  schema: z.ZodType<T>,
  text: string,
  operation: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      operation,
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BuildAdapterError(
      "build-backend",
      operation,
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return result.data;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw new BuildAdapterError(
      "build-backend",
      "read_response",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw new BuildAdapterError(
          "build-backend",
          "read_response",
          "INVALID_PROVIDER_RESPONSE",
        );
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof BuildAdapterError) {
      throw error;
    }
    throw new BuildAdapterError(
      "build-backend",
      "read_response",
      "PROVIDER_FAILURE",
    );
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function validateBearerToken(value: string): string {
  if (
    value.trim().length < 16 ||
    value.trim() !== value ||
    value.length > 4_096 ||
    /[\r\n]/.test(value)
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  return value;
}

function validateRequestTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 30 * 60_000) {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  return value;
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/.test(value)
  );
}

function validateMaxArtifactBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1_024 ||
    value > 2 * 1_024 * 1_024 * 1_024
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  return value;
}

function parseUuid(value: string, operation: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new BuildAdapterError("build-backend", operation, "INVALID_INPUT");
  }
  return result.data;
}

function boundedObservationInteger(
  value: number,
  minimum: number,
  maximum: number,
  _field: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BuildAdapterError(
      "build-backend",
      "customer_build_observation",
      "INVALID_INPUT",
    );
  }
  return value;
}

function validatePollRequest(request: ProvenEventPollRequest): {
  limit: number;
  projectId?: string;
  runIds?: string[];
  maxAttempts: number;
  intervalMs: number;
} {
  const result = z
    .object({
      limit: z.number().int().min(1).max(1_000).default(DEFAULT_OUTBOX_LIMIT),
      projectId: z.string().min(1).max(128).optional(),
      runIds: z
        .array(z.uuid())
        .min(1)
        .max(4)
        .refine((runIds) => new Set(runIds).size === runIds.length)
        .optional(),
      maxAttempts: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(DEFAULT_POLL_ATTEMPTS),
      intervalMs: z
        .number()
        .int()
        .min(0)
        .max(60_000)
        .default(DEFAULT_POLL_INTERVAL_MS),
    })
    .strict()
    .safeParse(request);
  if (!result.success) {
    throw new BuildAdapterError(
      "build-backend",
      "poll_proven_events",
      "INVALID_INPUT",
    );
  }
  return {
    limit: result.data.limit,
    maxAttempts: result.data.maxAttempts,
    intervalMs: result.data.intervalMs,
    ...(result.data.projectId ? { projectId: result.data.projectId } : {}),
    ...(result.data.runIds ? { runIds: [...new Set(result.data.runIds)] } : {}),
  };
}

function verifyProvenEvents(
  events: OutboxEvent[],
  requestedLimit: number,
  requestedRunIds?: readonly string[],
): void {
  if (events.length > requestedLimit) {
    throw new BuildAdapterError(
      "build-backend",
      "poll_proven_events",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const eventIds = new Set<string>();
  const allowedRunIds = requestedRunIds ? new Set(requestedRunIds) : undefined;
  for (const event of events) {
    if (
      eventIds.has(event.eventId) ||
      event.publishedAt !== undefined ||
      (allowedRunIds !== undefined && !allowedRunIds.has(event.runId))
    ) {
      throw new BuildAdapterError(
        "build-backend",
        "poll_proven_events",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    eventIds.add(event.eventId);
  }
}

function verifyRunSnapshot(
  snapshot: BuildRunSnapshot,
  requestedRunId: string,
): void {
  const { run, artifact } = snapshot;
  if (
    run.id !== requestedRunId ||
    (artifact !== null &&
      (run.status !== "passed" ||
        artifact.runId !== run.id ||
        artifact.revisionHash !== run.revisionHash))
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "get_build_run",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
}

function verifyFrozenPreview(
  preview: FrozenProvenPreview,
  event: OutboxEvent,
  ttlSeconds: number,
  now: Date,
): void {
  let previewUrl: URL;
  try {
    previewUrl = new URL(preview.url);
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      "get_proven_preview",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const expiresAt = Date.parse(preview.expiresAt);
  const latestAllowedExpiry = now.getTime() + ttlSeconds * 1_000 + 5_000;
  if (
    !Number.isFinite(now.getTime()) ||
    preview.eventId !== event.eventId ||
    preview.runId !== event.runId ||
    preview.artifactId !== event.payload.artifact.artifactId ||
    preview.revisionHash !== event.revisionHash ||
    preview.artifactSha256 !== event.payload.artifact.sha256 ||
    preview.snapshotId !== event.payload.artifact.daytonaSnapshot ||
    previewUrl.protocol !== "https:" ||
    previewUrl.username.length > 0 ||
    previewUrl.password.length > 0 ||
    expiresAt <= now.getTime() ||
    expiresAt > latestAllowedExpiry
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "get_proven_preview",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
}

function verifyArtifactHeaders(
  headers: Headers,
  expectedSizeBytes: number,
  expectedSha256: string,
): void {
  const contentLength = headers.get("content-length");
  const digest = headers.get("x-artifact-sha256");
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (
    contentType !== "application/gzip" ||
    contentLength !== String(expectedSizeBytes) ||
    digest !== expectedSha256
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "download_artifact",
      "ARTIFACT_INTEGRITY_FAILED",
    );
  }
}

export const buildBackendResponseSchemas = {
  dispatch: BuildDispatchResponseSchema,
  runSnapshot: BuildRunSnapshotSchema,
  customerBuildObservation: CustomerBuildObservationSchema,
} as const;
