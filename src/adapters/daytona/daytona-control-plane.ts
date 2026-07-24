import { createRequire } from "node:module";

import type { SandboxMetrics } from "@daytona/sdk";

import { digestJson, sha256 } from "../../lib/canonical-json.js";
import { DAYTONA_PINNED_SNAPSHOT_INPUTS } from "./daytona-snapshot-attestation.js";

const require = createRequire(import.meta.url);
const daytonaPackage = require("@daytona/sdk/package.json") as {
  version?: unknown;
};

export const DAYTONA_SDK_VERSION =
  typeof daytonaPackage.version === "string"
    ? daytonaPackage.version
    : "unknown";

export const DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION =
  "buildlabs.daytona.sdk-otel-safe.v1";

export type DaytonaReadinessState =
  | "unconfigured"
  | "configured"
  | "healthy"
  | "degraded"
  | "end_to_end_verified";

export type DaytonaSandboxRole =
  "builder" | "verifier-commands" | "verifier-delivery" | "frozen-preview";

export type DaytonaAcquisitionPhase =
  | "queue"
  | "claim_or_create"
  | "readiness"
  | "docker"
  | "browser_proof"
  | "snapshot_restart"
  | "retry"
  | "teardown";

export type DaytonaFailureCode =
  | "aborted"
  | "authentication"
  | "attestation"
  | "conflict"
  | "not_found"
  | "otel_export"
  | "provider"
  | "quota"
  | "rate_limited"
  | "timeout"
  | "unknown";

export interface DaytonaContentFreeLabels {
  runId: string;
  projectId: string;
  candidateId: string;
  role: DaytonaSandboxRole;
}

export interface DaytonaCapabilityStatus {
  state: DaytonaReadinessState;
  reasonCode: string;
  checkedAt: string;
  evidenceSha256?: string;
  evidenceValidatedAt?: string;
}

export interface DaytonaRateLimitSignal {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
}

export interface DaytonaAccountLimits {
  source: "account_api" | "response_headers" | "unavailable";
  regions?: Array<{
    target: string;
    sandboxClass: string;
    cpu: { used: number; limit: number };
    memoryGiB: { used: number; limit: number };
    diskGiB: { used: number; limit: number };
    perSandbox: {
      maxCpu?: number;
      maxMemoryGiB?: number;
      maxDiskGiB?: number;
    };
  }>;
  sandboxes?: {
    used: number;
    limit: number;
  };
  snapshots?: {
    used: number;
    limit: number;
  };
  volumes?: {
    used: number;
    limit: number;
  };
  rateLimit?: DaytonaRateLimitSignal;
}

export interface DaytonaWarmPoolSummary {
  snapshot: string;
  target: string;
  desiredSize: number;
  readySize: number;
  errorCode?: string;
}

export interface DaytonaReadinessEvidence {
  checkedAt: string;
  apiConfigured: boolean;
  apiReachable: boolean;
  sdkVersion: string;
  expectedSnapshot: string;
  snapshot?: {
    name: string;
    state: string;
    target?: string;
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
  };
  snapshotAttestation: "missing" | "invalid" | "verified" | "runtime_verified";
  attestedProbe?: {
    payloadSha256: string;
    validatedAt: string;
  };
  lifecycleTransport:
    | "automatic_unobserved"
    | "event_stream_observed"
    | "polling_fallback_observed"
    | "deprecated_polling_policy";
  signedPreviewProbe?: "passed" | "failed";
  metrics?: {
    latest: "passed" | "failed" | "not_probed";
    historical: "passed" | "failed" | "not_probed";
  };
  sdkOtel: {
    requested?: boolean;
    enabled: boolean;
    exporterConfigured: boolean;
    contentPolicyAttested: boolean;
    exportProbe?: "passed" | "failed";
  };
  sandboxOtel: {
    accountConfigured: boolean | "unknown";
    contentPolicyAttested: boolean;
    exportProbe?: "passed" | "failed";
  };
  controllerTelemetry?: {
    persistent: boolean;
    writeProbe?: "passed" | "failed" | "not_probed";
    failureCode?: DaytonaFailureCode;
  };
  warmPoolRoles: DaytonaSandboxRole[];
  warmPools?: DaytonaWarmPoolSummary[];
  accountLimits?: DaytonaAccountLimits;
  computerUseProbe?: "passed" | "failed";
  customPreviewProxyConfigured: boolean;
}

export interface DaytonaReadinessReport {
  schema: "buildlabs.daytona.readiness.v1";
  generatedAt: string;
  overall: DaytonaReadinessState;
  sdkVersion: string;
  snapshot: string;
  capabilities: {
    api: DaytonaCapabilityStatus;
    snapshotSupplyChain: DaytonaCapabilityStatus;
    regionResources: DaytonaCapabilityStatus;
    lifecycleEventTransport: DaytonaCapabilityStatus;
    signedPreviews: DaytonaCapabilityStatus;
    metrics: DaytonaCapabilityStatus;
    sdkOtel: DaytonaCapabilityStatus;
    sandboxOtel: DaytonaCapabilityStatus;
    controllerTelemetry: DaytonaCapabilityStatus;
    warmPools: DaytonaCapabilityStatus;
    accountLimits: DaytonaCapabilityStatus;
    computerUseDiagnostics: DaytonaCapabilityStatus;
    customPreviewProxy: DaytonaCapabilityStatus;
  };
  accountLimits?: DaytonaAccountLimits;
  warmPools: DaytonaWarmPoolSummary[];
}

export interface DaytonaRoleAcquisitionPolicy {
  role: DaytonaSandboxRole;
  snapshot: string;
  target?: string;
  snapshotResources: {
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
  };
  warmPoolEnabled: boolean;
  requireUnusedSandbox: true;
  requireFreshSnapshot: true;
  allowMutableBuilderFork: false;
  allowLinkedSandbox: false;
  createTimeoutSeconds: number;
  readinessTimeoutSeconds: number;
  teardownTimeoutSeconds: number;
}

export interface DaytonaWarmPoolCreateRequest {
  snapshot?: string;
  target?: string;
  user?: string;
  resources?: {
    cpu?: number;
    memory?: number;
    disk?: number;
  };
  envVars?: Record<string, string>;
  volumes?: readonly unknown[];
  secrets?: Record<string, string>;
  linkedSandbox?: string;
}

export interface DaytonaWarmPoolEligibility {
  eligible: boolean;
  reasonCodes: string[];
  policySha256: string;
}

export interface DaytonaSdkOtelPolicy {
  requested: boolean;
  enabled: boolean;
  exporterConfigured: boolean;
  contentPolicyAttested: boolean;
}

export interface DaytonaWarmSandboxObservation {
  id: string;
  warmPoolId: string;
  snapshot: string;
  target: string;
  user: string;
  cpu: number;
  memoryGiB: number;
  diskGiB: number;
}

export interface DaytonaWarmClaimEvidence {
  outcome: "verified_pool_hit" | "verified_cold_create" | "unobserved";
  sandboxRef: string;
  observedAt: string;
  evidenceSha256?: string;
}

export interface DaytonaAcquisitionMeasurement {
  schema: "buildlabs.daytona.acquisition.v1";
  measuredAt: string;
  labels: DaytonaContentFreeLabels;
  policySha256: string;
  warmClaim: DaytonaWarmClaimEvidence["outcome"];
  outcome: "passed" | "failed" | "cancelled";
  failureCode?: DaytonaFailureCode;
  phasesMs: Partial<Record<DaytonaAcquisitionPhase, number>>;
  resourceMetrics?: DaytonaResourceMetrics;
}

export interface DaytonaResourceMetrics {
  latest?: DaytonaMetricSample;
  historical?: {
    sampleCount: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
  };
  collectionFailureCode?: DaytonaFailureCode;
}

export interface DaytonaMetricSample {
  cpuCount: number;
  cpuUsedPct: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryCacheBytes: number;
  timestamp: string;
}

export interface DaytonaContentFreeTelemetryEvent {
  schema: "buildlabs.daytona.telemetry.v1";
  emittedAt: string;
  event:
    | "acquisition"
    | "lifecycle"
    | "metrics"
    | "quota"
    | "proof"
    | "reconciliation";
  labels: DaytonaContentFreeLabels;
  outcome: "passed" | "failed" | "cancelled" | "observed";
  phase?: DaytonaAcquisitionPhase;
  durationMs?: number;
  failureCode?: DaytonaFailureCode;
  values?: Record<string, boolean | number | string>;
}

export interface DaytonaTelemetrySink {
  emit(event: DaytonaContentFreeTelemetryEvent): void | Promise<void>;
}

export class DaytonaInMemoryTelemetry implements DaytonaTelemetrySink {
  readonly #events: DaytonaContentFreeTelemetryEvent[] = [];

  constructor(private readonly capacity = 1_000) {}

  emit(event: DaytonaContentFreeTelemetryEvent): void {
    assertDaytonaTelemetryEvent(event);
    this.#events.push(structuredClone(event));
    if (this.#events.length > this.capacity) {
      this.#events.splice(0, this.#events.length - this.capacity);
    }
  }

  snapshot(): DaytonaContentFreeTelemetryEvent[] {
    return this.#events.map((event) => structuredClone(event));
  }
}

export class DaytonaAcquisitionTimer {
  readonly #phaseStartedAt = new Map<DaytonaAcquisitionPhase, number>();
  readonly #phaseDurations = new Map<DaytonaAcquisitionPhase, number>();
  #warmClaim: DaytonaWarmClaimEvidence["outcome"] = "unobserved";

  constructor(
    private readonly labels: DaytonaContentFreeLabels,
    private readonly policySha256: string,
    private readonly clock: () => number = Date.now,
  ) {
    assertContentFreeLabels(labels);
  }

  start(phase: DaytonaAcquisitionPhase): void {
    if (this.#phaseStartedAt.has(phase)) {
      throw new Error(
        `Daytona acquisition phase ${phase} was already measured`,
      );
    }
    this.#phaseStartedAt.set(phase, this.clock());
  }

  end(phase: DaytonaAcquisitionPhase): number {
    const startedAt = this.#phaseStartedAt.get(phase);
    if (startedAt === undefined) {
      throw new Error(`Daytona acquisition phase ${phase} was not started`);
    }
    const duration = Math.max(0, this.clock() - startedAt);
    this.#phaseStartedAt.delete(phase);
    this.#phaseDurations.set(
      phase,
      (this.#phaseDurations.get(phase) ?? 0) + duration,
    );
    return duration;
  }

  setWarmClaim(outcome: DaytonaWarmClaimEvidence["outcome"]): void {
    this.#warmClaim = outcome;
  }

  complete(
    outcome: DaytonaAcquisitionMeasurement["outcome"],
    options: {
      failure?: unknown;
      resourceMetrics?: DaytonaResourceMetrics;
    } = {},
  ): DaytonaAcquisitionMeasurement {
    for (const phase of this.#phaseStartedAt.keys()) {
      this.end(phase);
    }
    return {
      schema: "buildlabs.daytona.acquisition.v1",
      measuredAt: new Date(this.clock()).toISOString(),
      labels: { ...this.labels },
      policySha256: this.policySha256,
      warmClaim: this.#warmClaim,
      outcome,
      ...(options.failure
        ? { failureCode: classifyDaytonaFailure(options.failure) }
        : {}),
      phasesMs: Object.fromEntries(this.#phaseDurations),
      ...(options.resourceMetrics
        ? { resourceMetrics: options.resourceMetrics }
        : {}),
    };
  }
}

export class DaytonaRoleAcquisitionQueue {
  readonly #active = new Map<DaytonaSandboxRole, number>();
  readonly #pending = new Map<
    DaytonaSandboxRole,
    Array<{
      resolve: (lease: DaytonaAcquisitionQueueLease) => void;
      reject: (error: Error) => void;
      enqueuedAt: number;
      signal?: AbortSignal;
      onAbort?: () => void;
    }>
  >();

  constructor(
    private readonly limits: Readonly<Record<DaytonaSandboxRole, number>>,
    private readonly clock: () => number = Date.now,
  ) {
    for (const limit of Object.values(limits)) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Daytona acquisition queue limit is invalid");
      }
    }
  }

  acquire(
    role: DaytonaSandboxRole,
    signal?: AbortSignal,
  ): Promise<DaytonaAcquisitionQueueLease> {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if ((this.#active.get(role) ?? 0) < this.limits[role]) {
      this.#active.set(role, (this.#active.get(role) ?? 0) + 1);
      return Promise.resolve(this.#lease(role, 0));
    }
    return new Promise<DaytonaAcquisitionQueueLease>((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        enqueuedAt: this.clock(),
        ...(signal ? { signal } : {}),
      } as {
        resolve: (lease: DaytonaAcquisitionQueueLease) => void;
        reject: (error: Error) => void;
        enqueuedAt: number;
        signal?: AbortSignal;
        onAbort?: () => void;
      };
      if (signal) {
        pending.onAbort = () => {
          const queue = this.#pending.get(role);
          const index = queue?.indexOf(pending) ?? -1;
          if (queue && index >= 0) {
            queue.splice(index, 1);
          }
          reject(abortError(signal));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      const queue = this.#pending.get(role) ?? [];
      queue.push(pending);
      this.#pending.set(role, queue);
    });
  }

  #lease(
    role: DaytonaSandboxRole,
    waitedMs: number,
  ): DaytonaAcquisitionQueueLease {
    let released = false;
    return {
      waitedMs,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#release(role);
      },
    };
  }

  #release(role: DaytonaSandboxRole): void {
    const active = this.#active.get(role) ?? 0;
    if (active < 1) {
      throw new Error("Daytona acquisition queue lease was not active");
    }
    const queue = this.#pending.get(role);
    const next = queue?.shift();
    if (!next) {
      this.#active.set(role, active - 1);
      return;
    }
    next.signal?.removeEventListener("abort", next.onAbort!);
    next.resolve(
      this.#lease(role, Math.max(0, this.clock() - next.enqueuedAt)),
    );
  }
}

export interface DaytonaAcquisitionQueueLease {
  waitedMs: number;
  release(): void;
}

export class DaytonaAccountApi {
  readonly #baseUrl: URL;

  constructor(
    apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    this.#baseUrl = new URL(`${apiUrl.replace(/\/+$/u, "")}/`);
  }

  async listWarmPools(signal?: AbortSignal): Promise<{
    pools: DaytonaWarmPoolSummary[];
    rateLimit?: DaytonaRateLimitSignal;
  }> {
    const response = await this.#request("warm-pools", signal);
    const body: unknown = await response.json();
    return {
      pools: parseWarmPools(body),
      ...rateLimitFromHeaders(response.headers),
    };
  }

  async observeWarmSandboxes(signal?: AbortSignal): Promise<{
    sandboxes: DaytonaWarmSandboxObservation[];
    rateLimit?: DaytonaRateLimitSignal;
  }> {
    const response = await this.#request("sandbox?includeWarm=true", signal);
    const body: unknown = await response.json();
    return {
      sandboxes: parseWarmSandboxes(body),
      ...rateLimitFromHeaders(response.headers),
    };
  }

  async getAccountLimits(
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<DaytonaAccountLimits> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(organizationId)) {
      throw new Error("Daytona organization identity is invalid");
    }
    const response = await this.#request(
      `organizations/${encodeURIComponent(organizationId)}/usage`,
      signal,
    );
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error("Daytona account usage response is invalid");
    }
    const snapshotLimit = numberField(body, "totalSnapshotQuota");
    const snapshotUsed = numberField(body, "currentSnapshotUsage");
    const volumeLimit = numberField(body, "totalVolumeQuota");
    const volumeUsed = numberField(body, "currentVolumeUsage");
    if (
      snapshotLimit === undefined ||
      snapshotUsed === undefined ||
      volumeLimit === undefined ||
      volumeUsed === undefined
    ) {
      throw new Error("Daytona account quota response is incomplete");
    }
    const regions = Array.isArray(body.regionUsage)
      ? body.regionUsage.filter(isRecord).map(parseRegionUsage)
      : [];
    return {
      source: "account_api",
      regions,
      snapshots: { used: snapshotUsed, limit: snapshotLimit },
      volumes: { used: volumeUsed, limit: volumeLimit },
      ...rateLimitFromHeaders(response.headers),
    };
  }

  async #request(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchImplementation(
      new URL(path, this.#baseUrl),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        redirect: "error",
        referrerPolicy: "no-referrer",
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) {
      const error = new Error("Daytona account capability API request failed");
      Object.assign(error, { status: response.status });
      throw error;
    }
    return response;
  }
}

export function createDaytonaRoleAcquisitionPolicy(input: {
  role: DaytonaSandboxRole;
  snapshot: string;
  target?: string;
  snapshotResources: DaytonaRoleAcquisitionPolicy["snapshotResources"];
  warmPoolEnabled: boolean;
  createTimeoutSeconds?: number;
  readinessTimeoutSeconds?: number;
  teardownTimeoutSeconds?: number;
}): DaytonaRoleAcquisitionPolicy {
  if (
    !isSafeLabelValue(input.snapshot) ||
    (input.target !== undefined && !isSafeLabelValue(input.target)) ||
    !isPositiveNumber(input.snapshotResources.cpu) ||
    !isPositiveNumber(input.snapshotResources.memoryGiB) ||
    !isPositiveNumber(input.snapshotResources.diskGiB)
  ) {
    throw new Error("Daytona acquisition policy is invalid");
  }
  return {
    role: input.role,
    snapshot: input.snapshot,
    ...(input.target ? { target: input.target } : {}),
    snapshotResources: { ...input.snapshotResources },
    warmPoolEnabled: input.warmPoolEnabled,
    requireUnusedSandbox: true,
    requireFreshSnapshot: true,
    allowMutableBuilderFork: false,
    allowLinkedSandbox: false,
    createTimeoutSeconds: boundedSeconds(input.createTimeoutSeconds, 120),
    readinessTimeoutSeconds: boundedSeconds(input.readinessTimeoutSeconds, 120),
    teardownTimeoutSeconds: boundedSeconds(input.teardownTimeoutSeconds, 120),
  };
}

export function evaluateDaytonaWarmPoolEligibility(
  policy: DaytonaRoleAcquisitionPolicy,
  request: DaytonaWarmPoolCreateRequest,
): DaytonaWarmPoolEligibility {
  const reasonCodes: string[] = [];
  if (!policy.warmPoolEnabled) {
    reasonCodes.push("role_disabled");
  }
  if (request.snapshot !== policy.snapshot) {
    reasonCodes.push("snapshot_mismatch");
  }
  if (request.target !== undefined && request.target !== policy.target) {
    reasonCodes.push("target_mismatch");
  }
  if (request.user !== undefined && request.user !== "daytona") {
    reasonCodes.push("custom_user");
  }
  if (request.resources !== undefined) {
    reasonCodes.push("custom_resources");
  }
  if (request.envVars && Object.keys(request.envVars).length > 0) {
    reasonCodes.push("custom_environment");
  }
  if (request.volumes && request.volumes.length > 0) {
    reasonCodes.push("custom_volumes");
  }
  if (request.secrets && Object.keys(request.secrets).length > 0) {
    reasonCodes.push("custom_secrets");
  }
  if (request.linkedSandbox !== undefined) {
    reasonCodes.push("linked_sandbox");
  }
  return {
    eligible: reasonCodes.length === 0,
    reasonCodes,
    policySha256: digestJson(policy),
  };
}

export function verifyDaytonaWarmPoolClaim(input: {
  before?: readonly DaytonaWarmSandboxObservation[];
  returnedSandbox: {
    id: string;
    snapshot?: string;
    target: string;
    user: string;
    cpu: number;
    memoryGiB: number;
    diskGiB: number;
  };
  policy: DaytonaRoleAcquisitionPolicy;
  observedAt?: string;
}): DaytonaWarmClaimEvidence {
  const sandboxRef = daytonaOpaqueResourceRef(input.returnedSandbox.id);
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!input.before) {
    return { outcome: "unobserved", sandboxRef, observedAt };
  }
  const claimed = input.before.find(
    (sandbox) => sandbox.id === input.returnedSandbox.id,
  );
  if (!claimed) {
    return {
      outcome: "unobserved",
      sandboxRef,
      observedAt,
      evidenceSha256: digestJson({
        beforeRefs: input.before.map((entry) =>
          daytonaOpaqueResourceRef(entry.id),
        ),
        returnedRef: sandboxRef,
      }),
    };
  }
  if (
    claimed.snapshot !== input.policy.snapshot ||
    claimed.snapshot !== input.returnedSandbox.snapshot ||
    claimed.target !== input.returnedSandbox.target ||
    (input.policy.target !== undefined &&
      (claimed.target !== input.policy.target ||
        input.returnedSandbox.target !== input.policy.target)) ||
    claimed.user !== "daytona" ||
    input.returnedSandbox.user !== "daytona" ||
    claimed.cpu !== input.policy.snapshotResources.cpu ||
    claimed.memoryGiB !== input.policy.snapshotResources.memoryGiB ||
    claimed.diskGiB !== input.policy.snapshotResources.diskGiB ||
    input.returnedSandbox.cpu !== input.policy.snapshotResources.cpu ||
    input.returnedSandbox.memoryGiB !==
      input.policy.snapshotResources.memoryGiB ||
    input.returnedSandbox.diskGiB !== input.policy.snapshotResources.diskGiB
  ) {
    throw new Error(
      "Daytona warm-pool claim did not match the role acquisition policy",
    );
  }
  return {
    outcome: "verified_pool_hit",
    sandboxRef,
    observedAt,
    evidenceSha256: digestJson({
      before: {
        ref: daytonaOpaqueResourceRef(claimed.id),
        poolRef: daytonaOpaqueResourceRef(claimed.warmPoolId),
        snapshot: claimed.snapshot,
        target: claimed.target,
        user: claimed.user,
        cpu: claimed.cpu,
        memoryGiB: claimed.memoryGiB,
        diskGiB: claimed.diskGiB,
      },
      returned: {
        ref: sandboxRef,
        snapshot: input.returnedSandbox.snapshot,
        target: input.returnedSandbox.target,
        user: input.returnedSandbox.user,
        cpu: input.returnedSandbox.cpu,
        memoryGiB: input.returnedSandbox.memoryGiB,
        diskGiB: input.returnedSandbox.diskGiB,
      },
    }),
  };
}

export function buildDaytonaReadinessReport(
  evidence: DaytonaReadinessEvidence,
): DaytonaReadinessReport {
  const checkedAt = evidence.checkedAt;
  const status = (
    state: DaytonaReadinessState,
    reasonCode: string,
    proof?: unknown,
    evidenceValidatedAt?: string,
  ): DaytonaCapabilityStatus => ({
    state,
    reasonCode,
    checkedAt,
    ...(proof === undefined ? {} : { evidenceSha256: digestJson(proof) }),
    ...(evidenceValidatedAt ? { evidenceValidatedAt } : {}),
  });

  const api = !evidence.apiConfigured
    ? status("unconfigured", "api_credentials_missing")
    : evidence.apiReachable
      ? status("healthy", "api_reachable", {
          sdkVersion: evidence.sdkVersion,
        })
      : status("degraded", "api_unreachable");

  const snapshotSupplyChain =
    evidence.snapshotAttestation === "runtime_verified"
      ? status("end_to_end_verified", "runtime_attestation_verified", {
          snapshot: evidence.expectedSnapshot,
          attestation: evidence.attestedProbe,
        })
      : evidence.snapshotAttestation === "verified"
        ? status(
            "healthy",
            "attestation_verified",
            evidence.attestedProbe,
            evidence.attestedProbe?.validatedAt,
          )
        : status(
            evidence.apiConfigured ? "degraded" : "unconfigured",
            evidence.snapshotAttestation === "missing"
              ? "attestation_missing"
              : "attestation_invalid",
          );

  const snapshot = evidence.snapshot;
  const pinnedResources = DAYTONA_PINNED_SNAPSHOT_INPUTS.resources;
  const regionResources =
    snapshot?.name === evidence.expectedSnapshot &&
    snapshot.state === "active" &&
    snapshot.cpu === pinnedResources.cpu &&
    snapshot.memoryGiB === pinnedResources.memoryGiB &&
    snapshot.diskGiB === pinnedResources.diskGiB
      ? status("healthy", "snapshot_active", snapshot)
      : status(
          evidence.apiConfigured ? "degraded" : "unconfigured",
          snapshot ? "snapshot_policy_mismatch" : "snapshot_unavailable",
        );

  const lifecycleEventTransport = !evidence.apiConfigured
    ? status("unconfigured", "lifecycle_api_unconfigured")
    : evidence.lifecycleTransport === "event_stream_observed"
      ? status("end_to_end_verified", "event_stream_observed")
      : evidence.lifecycleTransport === "polling_fallback_observed"
        ? status("degraded", "polling_fallback_observed")
        : evidence.lifecycleTransport === "deprecated_polling_policy"
          ? status("degraded", "deprecated_polling_configured")
          : status("configured", "automatic_transport_unobservable");

  const signedPreviews = !evidence.apiConfigured
    ? status("unconfigured", "signed_preview_api_unconfigured")
    : evidence.signedPreviewProbe === "passed"
      ? status(
          "end_to_end_verified",
          "signed_preview_ingress_verified",
          evidence.attestedProbe,
          evidence.attestedProbe?.validatedAt,
        )
      : evidence.signedPreviewProbe === "failed"
        ? status("degraded", "signed_preview_probe_failed")
        : status("configured", "signed_preview_not_probed");

  const metrics = !evidence.apiConfigured
    ? status("unconfigured", "metrics_api_unconfigured")
    : evidence.metrics?.latest === "passed" &&
        evidence.metrics.historical === "passed"
      ? status(
          "end_to_end_verified",
          "metrics_queried",
          evidence.attestedProbe,
          evidence.attestedProbe?.validatedAt,
        )
      : evidence.metrics?.latest === "passed"
        ? status("healthy", "latest_metrics_queried")
        : evidence.metrics?.latest === "failed" ||
            evidence.metrics?.historical === "failed"
          ? status("degraded", "metrics_probe_failed")
          : status("configured", "metrics_not_probed");

  const sdkOtel = otelStatus("sdk", evidence.sdkOtel, checkedAt);
  const sandboxOtel =
    evidence.sandboxOtel.accountConfigured === false
      ? status("unconfigured", "sandbox_otel_account_unconfigured")
      : evidence.sandboxOtel.accountConfigured === "unknown"
        ? status("unconfigured", "sandbox_otel_account_state_unknown")
        : !evidence.sandboxOtel.contentPolicyAttested
          ? status("degraded", "sandbox_otel_content_policy_unattested")
          : evidence.sandboxOtel.exportProbe === "passed"
            ? status("end_to_end_verified", "sandbox_otel_export_verified")
            : evidence.sandboxOtel.exportProbe === "failed"
              ? status("degraded", "sandbox_otel_export_failed")
              : status("configured", "sandbox_otel_export_not_probed");
  const controllerTelemetry = !evidence.controllerTelemetry?.persistent
    ? status("unconfigured", "controller_telemetry_not_persistent")
    : evidence.controllerTelemetry.failureCode ||
        evidence.controllerTelemetry.writeProbe === "failed"
      ? status("degraded", "controller_telemetry_write_failed", undefined)
      : evidence.controllerTelemetry.writeProbe === "passed"
        ? status("end_to_end_verified", "controller_telemetry_write_verified")
        : status("configured", "controller_telemetry_write_not_probed");

  const configuredPools = evidence.warmPools?.filter((pool) =>
    evidence.warmPoolRoles.some(
      () =>
        pool.snapshot === evidence.expectedSnapshot &&
        (snapshot?.target === undefined || pool.target === snapshot.target),
    ),
  );
  const warmPools =
    evidence.warmPoolRoles.length === 0
      ? status("unconfigured", "warm_pool_roles_disabled")
      : !evidence.warmPools
        ? status("degraded", "warm_pool_inventory_unavailable")
        : configuredPools && configuredPools.length > 0
          ? configuredPools.some((pool) => pool.readySize > 0)
            ? status("healthy", "warm_pool_ready", configuredPools)
            : status("degraded", "warm_pool_empty", configuredPools)
          : status("unconfigured", "warm_pool_not_configured");

  const limitFailureReason = evidence.accountLimits
    ? accountLimitFailureReason(evidence.accountLimits)
    : undefined;
  const accountLimits = evidence.accountLimits
    ? status(
        evidence.accountLimits.source === "unavailable" || limitFailureReason
          ? "degraded"
          : "healthy",
        evidence.accountLimits.source === "unavailable"
          ? "account_limits_unavailable"
          : (limitFailureReason ?? "account_limits_observed"),
        evidence.accountLimits,
      )
    : status("unconfigured", "account_limits_not_probed");

  const computerUseDiagnostics = !evidence.apiConfigured
    ? status("unconfigured", "computer_use_api_unconfigured")
    : evidence.computerUseProbe === "passed"
      ? status("end_to_end_verified", "computer_use_operator_probe_passed")
      : evidence.computerUseProbe === "failed"
        ? status("degraded", "computer_use_operator_probe_failed")
        : status("configured", "computer_use_not_probed");

  const customPreviewProxy = evidence.customPreviewProxyConfigured
    ? status("configured", "custom_preview_proxy_external_configuration")
    : status("unconfigured", "custom_preview_proxy_not_configured");

  const capabilities = {
    api,
    snapshotSupplyChain,
    regionResources,
    lifecycleEventTransport,
    signedPreviews,
    metrics,
    sdkOtel,
    sandboxOtel,
    controllerTelemetry,
    warmPools,
    accountLimits,
    computerUseDiagnostics,
    customPreviewProxy,
  };
  const core = [api, snapshotSupplyChain, regionResources, signedPreviews];
  const overall = !evidence.apiConfigured
    ? "unconfigured"
    : core.some((entry) => entry.state === "degraded")
      ? "degraded"
      : core.every((entry) => entry.state === "end_to_end_verified")
        ? "end_to_end_verified"
        : core.every((entry) =>
              ["healthy", "end_to_end_verified"].includes(entry.state),
            )
          ? "healthy"
          : "configured";

  return {
    schema: "buildlabs.daytona.readiness.v1",
    generatedAt: checkedAt,
    overall,
    sdkVersion: evidence.sdkVersion,
    snapshot: evidence.expectedSnapshot,
    capabilities,
    ...(evidence.accountLimits
      ? { accountLimits: structuredClone(evidence.accountLimits) }
      : {}),
    warmPools: evidence.warmPools?.map((pool) => ({ ...pool })) ?? [],
  };
}

export async function collectDaytonaResourceMetrics(
  sandbox: {
    getMetricsLatest(): Promise<SandboxMetrics>;
    getMetrics(start?: Date, end?: Date): Promise<SandboxMetrics[]>;
  },
  input: {
    includeHistorical: boolean;
    start?: Date;
    end?: Date;
  },
): Promise<DaytonaResourceMetrics> {
  const latest = metricSample(await sandbox.getMetricsLatest());
  if (!input.includeHistorical) {
    return { latest };
  }
  const historical = await sandbox.getMetrics(input.start, input.end);
  return {
    latest,
    historical: {
      sampleCount: historical.length,
      ...(historical[0]
        ? { firstTimestamp: historical[0].timestamp.toISOString() }
        : {}),
      ...(historical.at(-1)
        ? { lastTimestamp: historical.at(-1)!.timestamp.toISOString() }
        : {}),
    },
  };
}

export function classifyDaytonaFailure(error: unknown): DaytonaFailureCode {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const status = errorStatus(error);
  if (error.name === "AbortError" || /abort|cancel/iu.test(error.name)) {
    return "aborted";
  }
  if (/timeout/iu.test(error.name) || status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 409) {
    return "conflict";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 402 || status === 507) {
    return "quota";
  }
  if (/attestation/iu.test(`${error.name} ${error.message}`)) {
    return "attestation";
  }
  if (/otel/iu.test(`${error.name} ${error.message}`)) {
    return "otel_export";
  }
  return "provider";
}

export function daytonaOpaqueResourceRef(id: string): string {
  if (!id) {
    throw new Error("Daytona resource id is required");
  }
  return sha256(`buildlabs:daytona-resource:${id}`);
}

export function assertContentFreeLabels(
  labels: DaytonaContentFreeLabels,
): void {
  for (const value of [
    labels.runId,
    labels.projectId,
    labels.candidateId,
    labels.role,
  ]) {
    if (!isSafeLabelValue(value)) {
      throw new Error("Daytona content-free telemetry label is invalid");
    }
  }
}

export function parseDaytonaWarmPoolRoles(
  value: string | undefined,
): DaytonaSandboxRole[] {
  if (!value) {
    return [];
  }
  const allowed = new Set<DaytonaSandboxRole>([
    "builder",
    "verifier-commands",
    "verifier-delivery",
  ]);
  const roles = [...new Set(value.split(",").map((entry) => entry.trim()))];
  if (roles.includes("frozen-preview")) {
    throw new Error(
      "Frozen previews use unique proven snapshots and are not warm-pool eligible",
    );
  }
  if (roles.some((role) => !allowed.has(role as DaytonaSandboxRole))) {
    throw new Error("DAYTONA_WARM_POOL_ROLES contains an unsupported role");
  }
  return roles.filter(Boolean) as DaytonaSandboxRole[];
}

export function resolveDaytonaSdkOtelPolicy(input: {
  requested: boolean;
  exporterConfigured: boolean;
  safePolicyAttestation?: string | undefined;
}): DaytonaSdkOtelPolicy {
  const contentPolicyAttested =
    input.safePolicyAttestation === DAYTONA_SDK_OTEL_SAFE_POLICY_ATTESTATION;
  return {
    requested: input.requested,
    exporterConfigured: input.exporterConfigured,
    contentPolicyAttested,
    enabled:
      input.requested && input.exporterConfigured && contentPolicyAttested,
  };
}

function otelStatus(
  kind: "sdk",
  evidence: DaytonaReadinessEvidence["sdkOtel"],
  checkedAt: string,
): DaytonaCapabilityStatus {
  if (evidence.requested && !evidence.contentPolicyAttested) {
    return {
      state: "degraded",
      reasonCode: `${kind}_otel_content_policy_unattested`,
      checkedAt,
    };
  }
  if (evidence.requested && !evidence.exporterConfigured) {
    return {
      state: "degraded",
      reasonCode: `${kind}_otel_exporter_unconfigured`,
      checkedAt,
    };
  }
  if (!evidence.enabled) {
    return {
      state: "unconfigured",
      reasonCode: `${kind}_otel_disabled`,
      checkedAt,
    };
  }
  if (!evidence.exporterConfigured) {
    return {
      state: "degraded",
      reasonCode: `${kind}_otel_exporter_unconfigured`,
      checkedAt,
    };
  }
  if (!evidence.contentPolicyAttested) {
    return {
      state: "degraded",
      reasonCode: `${kind}_otel_content_policy_unattested`,
      checkedAt,
    };
  }
  if (evidence.exportProbe === "passed") {
    return {
      state: "end_to_end_verified",
      reasonCode: `${kind}_otel_export_verified`,
      checkedAt,
    };
  }
  if (evidence.exportProbe === "failed") {
    return {
      state: "degraded",
      reasonCode: `${kind}_otel_export_failed`,
      checkedAt,
    };
  }
  return {
    state: "configured",
    reasonCode: `${kind}_otel_export_not_probed`,
    checkedAt,
  };
}

function metricSample(sample: SandboxMetrics): DaytonaMetricSample {
  const values = [
    sample.cpuCount,
    sample.cpuUsedPct,
    sample.diskTotal,
    sample.diskUsed,
    sample.memTotal,
    sample.memUsed,
    sample.memCache,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Daytona resource metric sample is invalid");
  }
  return {
    cpuCount: sample.cpuCount,
    cpuUsedPct: sample.cpuUsedPct,
    diskTotalBytes: sample.diskTotal,
    diskUsedBytes: sample.diskUsed,
    memoryTotalBytes: sample.memTotal,
    memoryUsedBytes: sample.memUsed,
    memoryCacheBytes: sample.memCache,
    timestamp: sample.timestamp.toISOString(),
  };
}

function accountLimitFailureReason(
  limits: DaytonaAccountLimits,
): string | undefined {
  if (
    limits.rateLimit?.remaining !== undefined &&
    limits.rateLimit.remaining <= 0
  ) {
    return "account_rate_limit_exhausted";
  }
  const finiteQuotaExhausted = (
    quota: { used: number; limit: number } | undefined,
  ): boolean =>
    quota !== undefined &&
    Number.isFinite(quota.used) &&
    Number.isFinite(quota.limit) &&
    quota.limit > 0 &&
    quota.used >= quota.limit;
  if (
    finiteQuotaExhausted(limits.sandboxes) ||
    finiteQuotaExhausted(limits.snapshots) ||
    finiteQuotaExhausted(limits.volumes) ||
    limits.regions?.some(
      (region) =>
        finiteQuotaExhausted(region.cpu) ||
        finiteQuotaExhausted(region.memoryGiB) ||
        finiteQuotaExhausted(region.diskGiB),
    )
  ) {
    return "account_quota_exhausted";
  }
  return undefined;
}

function parseWarmPools(value: unknown): DaytonaWarmPoolSummary[] {
  return collection(value)
    .map((entry) => {
      const snapshot =
        stringField(entry, "snapshot") ?? stringField(entry, "snapshotName");
      const target =
        stringField(entry, "target") ?? stringField(entry, "region");
      const desiredSize =
        numberField(entry, "pool") ?? numberField(entry, "desiredSize");
      const readySize =
        numberField(entry, "currentSize") ?? numberField(entry, "readySize");
      if (
        snapshot === undefined ||
        target === undefined ||
        desiredSize === undefined ||
        readySize === undefined
      ) {
        return undefined;
      }
      return {
        snapshot,
        target,
        desiredSize,
        readySize,
        ...(stringField(entry, "errorReason")
          ? { errorCode: "provider_reported_error" }
          : {}),
      };
    })
    .filter((entry): entry is DaytonaWarmPoolSummary => entry !== undefined);
}

function parseWarmSandboxes(value: unknown): DaytonaWarmSandboxObservation[] {
  return collection(value)
    .map((entry) => {
      const id = stringField(entry, "id");
      const warmPoolId = stringField(entry, "warmPoolId");
      const snapshot = stringField(entry, "snapshot");
      const target = stringField(entry, "target");
      const user = stringField(entry, "user");
      const cpu = numberField(entry, "cpu");
      const memoryGiB =
        numberField(entry, "memory") ?? numberField(entry, "mem");
      const diskGiB = numberField(entry, "disk");
      if (
        id === undefined ||
        warmPoolId === undefined ||
        snapshot === undefined ||
        target === undefined ||
        user === undefined ||
        cpu === undefined ||
        memoryGiB === undefined ||
        diskGiB === undefined
      ) {
        return undefined;
      }
      return {
        id,
        warmPoolId,
        snapshot,
        target,
        user,
        cpu,
        memoryGiB,
        diskGiB,
      };
    })
    .filter(
      (entry): entry is DaytonaWarmSandboxObservation => entry !== undefined,
    );
}

function parseRegionUsage(
  value: Record<string, unknown>,
): NonNullable<DaytonaAccountLimits["regions"]>[number] {
  const target = stringField(value, "regionId");
  const sandboxClass = stringField(value, "sandboxClass");
  const cpuLimit = numberField(value, "totalCpuQuota");
  const cpuUsed = numberField(value, "currentCpuUsage");
  const memoryLimit = numberField(value, "totalMemoryQuota");
  const memoryUsed = numberField(value, "currentMemoryUsage");
  const diskLimit = numberField(value, "totalDiskQuota");
  const diskUsed = numberField(value, "currentDiskUsage");
  if (
    target === undefined ||
    sandboxClass === undefined ||
    cpuLimit === undefined ||
    cpuUsed === undefined ||
    memoryLimit === undefined ||
    memoryUsed === undefined ||
    diskLimit === undefined ||
    diskUsed === undefined
  ) {
    throw new Error("Daytona regional quota response is incomplete");
  }
  const maxCpu = nullableNumberField(value, "maxCpuPerSandbox");
  const maxMemoryGiB = nullableNumberField(value, "maxMemoryPerSandbox");
  const maxDiskGiB = nullableNumberField(value, "maxDiskPerSandbox");
  return {
    target,
    sandboxClass,
    cpu: { used: cpuUsed, limit: cpuLimit },
    memoryGiB: { used: memoryUsed, limit: memoryLimit },
    diskGiB: { used: diskUsed, limit: diskLimit },
    perSandbox: {
      ...(maxCpu === undefined ? {} : { maxCpu }),
      ...(maxMemoryGiB === undefined ? {} : { maxMemoryGiB }),
      ...(maxDiskGiB === undefined ? {} : { maxDiskGiB }),
    },
  };
}

function collection(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["items", "data", "sandboxes", "warmPools"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }
  return [];
}

function rateLimitFromHeaders(headers: Headers): {
  rateLimit?: DaytonaRateLimitSignal;
} {
  const rateLimit: DaytonaRateLimitSignal = {};
  const limit = integerHeader(headers, "x-ratelimit-limit");
  const remaining = integerHeader(headers, "x-ratelimit-remaining");
  const retryAfter = integerHeader(headers, "retry-after");
  const reset = headers.get("x-ratelimit-reset");
  if (limit !== undefined) {
    rateLimit.limit = limit;
  }
  if (remaining !== undefined) {
    rateLimit.remaining = remaining;
  }
  if (retryAfter !== undefined) {
    rateLimit.retryAfterSeconds = retryAfter;
  }
  if (reset) {
    const timestamp = /^\d+$/u.test(reset)
      ? Number(reset) * 1_000
      : Date.parse(reset);
    if (Number.isFinite(timestamp)) {
      rateLimit.resetAt = new Date(timestamp).toISOString();
    }
  }
  return Object.keys(rateLimit).length > 0 ? { rateLimit } : {};
}

function integerHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function assertDaytonaTelemetryEvent(
  event: DaytonaContentFreeTelemetryEvent,
): void {
  assertContentFreeLabels(event.labels);
  if (
    !Number.isFinite(Date.parse(event.emittedAt)) ||
    (event.durationMs !== undefined &&
      (!Number.isFinite(event.durationMs) || event.durationMs < 0))
  ) {
    throw new Error("Daytona telemetry event is invalid");
  }
  if (
    event.values &&
    Object.entries(event.values).some(
      ([key, value]) =>
        !/^[a-z][a-z0-9_.-]{0,63}$/u.test(key) ||
        (typeof value === "string" && !isSafeLabelValue(value)),
    )
  ) {
    throw new Error("Daytona telemetry values are not content-free");
  }
}

function errorStatus(error: Error): number | undefined {
  const record = error as Error & {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [
    record.status,
    record.statusCode,
    record.response?.status,
  ]) {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return undefined;
}

function boundedSeconds(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > 3_600) {
    throw new Error("Daytona acquisition timeout is invalid");
  }
  return selected;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" && value[key].length > 0
    ? value[key]
    : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function nullableNumberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return value[key] === null ? undefined : numberField(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSafeLabelValue(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Daytona acquisition aborted", "AbortError");
}
