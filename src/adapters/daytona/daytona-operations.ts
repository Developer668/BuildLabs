import { randomUUID } from "node:crypto";

import type { Sandbox } from "@daytona/sdk";

import { digestJson, sha256 } from "../../lib/canonical-json.js";
import {
  classifyDaytonaFailure,
  daytonaOpaqueResourceRef,
  type DaytonaAcquisitionMeasurement,
  type DaytonaSandboxRole,
} from "./daytona-control-plane.js";

const MAX_ASYNC_LOG_BYTES = 4 * 1_024 * 1_024;
const DEFAULT_ASYNC_CLEANUP_TIMEOUT_MILLISECONDS = 30_000;
const MAX_ASYNC_CLEANUP_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_COMPUTER_USE_STOP_TIMEOUT_MILLISECONDS = 30_000;
const MAX_COMPUTER_USE_STOP_TIMEOUT_MILLISECONDS = 120_000;
const CONTROLLER_OWNER = "buildlabs-controller";
const MANAGED_ROLES = new Set<DaytonaSandboxRole>([
  "builder",
  "verifier-commands",
  "verifier-delivery",
  "frozen-preview",
]);

export interface DaytonaAsyncProcessPort {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    request: {
      command: string;
      runAsync: true;
      suppressInputEcho: true;
    },
    timeoutSeconds: number,
  ): Promise<{ cmdId?: string }>;
  getSessionCommand(
    sessionId: string,
    commandId: string,
  ): Promise<{ exitCode?: number }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
  ): Promise<{ output?: string; stdout?: string; stderr?: string }>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface DaytonaAsyncExecutionReceipt {
  schema: "buildlabs.daytona.async-execution.v1";
  commandSha256: string;
  sessionRef: string;
  commandRef: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: "completed" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  sandboxTerminated: boolean;
  failureCode?: ReturnType<typeof classifyDaytonaFailure>;
}

export async function executeDaytonaAsyncCommand(input: {
  process: DaytonaAsyncProcessPort;
  command: string;
  timeoutMilliseconds: number;
  terminateSandbox: (
    reason: "cancelled" | "provider_failure" | "timed_out",
  ) => Promise<void>;
  signal?: AbortSignal;
  cleanupTimeoutMilliseconds?: number;
  pollIntervalMilliseconds?: number;
  clock?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  onOutput?: (output: { stdout: string; stderr: string }) => void;
}): Promise<DaytonaAsyncExecutionReceipt> {
  if (
    input.command.length === 0 ||
    input.command.length > 1_000_000 ||
    !Number.isInteger(input.timeoutMilliseconds) ||
    input.timeoutMilliseconds < 1 ||
    input.timeoutMilliseconds > 24 * 60 * 60 * 1_000 ||
    (input.cleanupTimeoutMilliseconds !== undefined &&
      (!Number.isInteger(input.cleanupTimeoutMilliseconds) ||
        input.cleanupTimeoutMilliseconds < 1 ||
        input.cleanupTimeoutMilliseconds >
          MAX_ASYNC_CLEANUP_TIMEOUT_MILLISECONDS))
  ) {
    throw new Error("Daytona async execution policy is invalid");
  }
  const clock = input.clock ?? Date.now;
  const delay =
    input.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
      }));
  const pollInterval = Math.max(
    10,
    Math.min(5_000, input.pollIntervalMilliseconds ?? 500),
  );
  const nonce = randomUUID();
  const sessionId = `buildlabs-async-${nonce}`;
  const started = clock();
  const deadline = started + input.timeoutMilliseconds;
  const startedAt = new Date(started).toISOString();
  const cleanupTimeoutMilliseconds =
    input.cleanupTimeoutMilliseconds ??
    DEFAULT_ASYNC_CLEANUP_TIMEOUT_MILLISECONDS;
  let commandId: string | undefined;
  let terminated = false;
  let outcome: DaytonaAsyncExecutionReceipt["outcome"] = "failed";
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let primaryFailure: unknown;
  let sessionCreationAttempted = false;

  const withinExecutionDeadline = <Value>(
    operation: string,
    execute: () => Promise<Value>,
  ): Promise<Value> =>
    awaitDaytonaOperation({
      execute,
      operation,
      timeoutMilliseconds: Math.max(0, deadline - clock()),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  const withinCleanupDeadline = <Value>(
    operation: string,
    execute: () => Promise<Value>,
  ): Promise<Value> =>
    awaitDaytonaOperation({
      execute,
      operation,
      timeoutMilliseconds: cleanupTimeoutMilliseconds,
    });

  const terminate = async (
    reason: "cancelled" | "provider_failure" | "timed_out",
  ): Promise<void> => {
    try {
      await withinCleanupDeadline("sandbox_termination", () =>
        input.terminateSandbox(reason),
      );
      terminated = true;
    } catch (error) {
      primaryFailure =
        primaryFailure === undefined
          ? error
          : new AggregateError(
              [primaryFailure, error],
              "Daytona async command and sandbox termination failed",
            );
    }
  };

  throwIfAborted(input.signal);
  try {
    sessionCreationAttempted = true;
    await withinExecutionDeadline("session_creation", () =>
      input.process.createSession(sessionId),
    );
    const launched = await withinExecutionDeadline("command_launch", () =>
      input.process.executeSessionCommand(
        sessionId,
        {
          command: input.command,
          runAsync: true,
          suppressInputEcho: true,
        },
        Math.min(
          30,
          Math.max(1, Math.ceil(Math.max(1, deadline - clock()) / 1_000)),
        ),
      ),
    );
    if (!launched.cmdId) {
      throw new Error("Daytona async command did not return a command id");
    }
    const launchedCommandId = launched.cmdId;
    commandId = launchedCommandId;

    for (;;) {
      if (input.signal?.aborted) {
        throw daytonaAsyncAbortError();
      }
      if (clock() >= deadline) {
        throw new DaytonaAsyncOperationTimeoutError("command_poll");
      }
      const command = await withinExecutionDeadline("command_poll", () =>
        input.process.getSessionCommand(sessionId, launchedCommandId),
      );
      if (command.exitCode !== undefined) {
        exitCode = command.exitCode;
        outcome = exitCode === 0 ? "completed" : "failed";
        break;
      }
      await withinExecutionDeadline("poll_delay", () =>
        delay(Math.min(pollInterval, Math.max(1, deadline - clock()))),
      );
    }

    if (!terminated) {
      const logs = await withinExecutionDeadline("command_logs", () =>
        input.process.getSessionCommandLogs(sessionId, launchedCommandId),
      );
      stdout = logs.stdout ?? logs.output ?? "";
      stderr = logs.stderr ?? "";
    }
  } catch (error) {
    primaryFailure = error;
    if (input.signal?.aborted || isDaytonaAsyncAbortError(error)) {
      outcome = "cancelled";
    } else if (error instanceof DaytonaAsyncOperationTimeoutError) {
      outcome = "timed_out";
    } else {
      outcome = "failed";
    }
    if (sessionCreationAttempted && !terminated) {
      await terminate(terminationReason(outcome));
    }
  } finally {
    if (sessionCreationAttempted) {
      try {
        await withinCleanupDeadline("session_deletion", () =>
          input.process.deleteSession(sessionId),
        );
      } catch (cleanupError) {
        if (!terminated && primaryFailure === undefined) {
          primaryFailure = cleanupError;
        }
        if (!terminated) {
          if (outcome !== "cancelled" && outcome !== "timed_out") {
            outcome = "failed";
          }
          await terminate(terminationReason(outcome));
        }
      }
    }
  }

  const boundedStdout = boundedLog(stdout);
  const boundedStderr = boundedLog(stderr);
  const completed = clock();
  input.onOutput?.({
    stdout: boundedStdout.value,
    stderr: boundedStderr.value,
  });
  return {
    schema: "buildlabs.daytona.async-execution.v1",
    commandSha256: sha256(input.command),
    sessionRef: daytonaOpaqueResourceRef(sessionId),
    commandRef: daytonaOpaqueResourceRef(commandId ?? nonce),
    startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: Math.max(0, completed - started),
    outcome,
    exitCode,
    stdoutSha256: sha256(boundedStdout.value),
    stderrSha256: sha256(boundedStderr.value),
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    outputTruncated: boundedStdout.truncated || boundedStderr.truncated,
    sandboxTerminated: terminated,
    ...(primaryFailure === undefined
      ? {}
      : { failureCode: classifyDaytonaFailure(primaryFailure) }),
  };
}

export interface DaytonaOperatorArtifactSink {
  persist(input: {
    kind: "accessibility-tree" | "screenshot";
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<{ artifactRef: string }>;
}

export interface DaytonaOperatorDiagnosticReceipt {
  schema: "buildlabs.daytona.operator-diagnostics.v1";
  audience: "operator";
  proofEligible: false;
  capturedAt: string;
  screenshot: {
    artifactRef: string;
    sha256: string;
    bytes: number;
    width?: number;
    height?: number;
  };
  accessibilityTree: {
    artifactRef: string;
    sha256: string;
    bytes: number;
  };
}

export async function captureDaytonaOperatorDiagnostics(input: {
  sandbox: Pick<Sandbox, "computerUse">;
  operatorAuthorized: boolean;
  artifactSink: DaytonaOperatorArtifactSink;
  signal?: AbortSignal;
  cleanupTimeoutMilliseconds?: number;
}): Promise<DaytonaOperatorDiagnosticReceipt> {
  if (!input.operatorAuthorized) {
    throw new Error("Daytona Computer Use diagnostics require operator access");
  }
  const cleanupTimeoutMilliseconds =
    input.cleanupTimeoutMilliseconds ??
    DEFAULT_COMPUTER_USE_STOP_TIMEOUT_MILLISECONDS;
  if (
    !Number.isInteger(cleanupTimeoutMilliseconds) ||
    cleanupTimeoutMilliseconds < 1 ||
    cleanupTimeoutMilliseconds > MAX_COMPUTER_USE_STOP_TIMEOUT_MILLISECONDS
  ) {
    throw new Error("Daytona Computer Use cleanup policy is invalid");
  }
  throwIfAborted(input.signal);
  await input.sandbox.computerUse.start();
  let receipt: DaytonaOperatorDiagnosticReceipt | undefined;
  let captureFailure: Error | undefined;
  try {
    throwIfAborted(input.signal);
    const [screenshot, accessibilityTree] = await Promise.all([
      input.sandbox.computerUse.screenshot.takeCompressed({
        format: "png",
        quality: 80,
        scale: 1,
        showCursor: false,
      }),
      input.sandbox.computerUse.accessibility.getTree({
        scope: "all",
        maxDepth: 4,
      }),
    ]);
    throwIfAborted(input.signal);
    const screenshotBytes = screenshotResponseBytes(screenshot);
    const treeBytes = Buffer.from(JSON.stringify(accessibilityTree), "utf8");
    const [screenshotArtifact, treeArtifact] = await Promise.all([
      input.artifactSink.persist({
        kind: "screenshot",
        mediaType: "image/png",
        bytes: screenshotBytes,
      }),
      input.artifactSink.persist({
        kind: "accessibility-tree",
        mediaType: "application/json",
        bytes: treeBytes,
      }),
    ]);
    receipt = {
      schema: "buildlabs.daytona.operator-diagnostics.v1",
      audience: "operator",
      proofEligible: false,
      capturedAt: new Date().toISOString(),
      screenshot: {
        artifactRef: screenshotArtifact.artifactRef,
        sha256: sha256(screenshotBytes),
        bytes: screenshotBytes.byteLength,
      },
      accessibilityTree: {
        artifactRef: treeArtifact.artifactRef,
        sha256: sha256(treeBytes),
        bytes: treeBytes.byteLength,
      },
    };
  } catch (error) {
    captureFailure = daytonaAsyncProviderError(error);
  }

  let cleanupFailure: Error | undefined;
  try {
    await awaitDaytonaOperation({
      execute: () => input.sandbox.computerUse.stop(),
      operation: "computer_use_stop",
      timeoutMilliseconds: cleanupTimeoutMilliseconds,
    });
  } catch (error) {
    cleanupFailure = daytonaAsyncProviderError(error);
  }

  if (captureFailure) {
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [captureFailure, cleanupFailure],
        "Daytona Computer Use capture and deterministic cleanup failed",
      );
    }
    throw captureFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
  if (!receipt) {
    throw new Error("Daytona Computer Use diagnostics produced no receipt");
  }
  return receipt;
}

export interface DaytonaOrphanSandbox {
  id: string;
  labels: Record<string, string>;
  createdAt?: string;
  autoDestroyAt?: string;
  state?: string;
  refreshData(): Promise<void>;
  delete(timeoutSeconds: number, wait: boolean): Promise<void>;
}

export interface DaytonaOrphanClient {
  list(query: {
    labels: Record<string, string>;
    createdAtBefore: Date;
  }): AsyncIterable<DaytonaOrphanSandbox>;
}

export interface DaytonaOrphanReconciliationReport {
  schema: "buildlabs.daytona.orphan-reconciliation.v1";
  mode: "dry_run" | "delete";
  reconciledAt: string;
  gracePeriodMs: number;
  scanned: number;
  eligible: number;
  deleted: number;
  skippedActive: number;
  skippedLivePreview: number;
  skippedUnowned: number;
  failures: Array<{
    resourceRef: string;
    failureCode: ReturnType<typeof classifyDaytonaFailure>;
  }>;
  eligibleResourceRefs: string[];
}

export async function reconcileDaytonaOrphans(input: {
  client: DaytonaOrphanClient;
  activeSandboxIds: ReadonlySet<string>;
  gracePeriodMs: number;
  dryRun?: boolean;
  now?: Date;
}): Promise<DaytonaOrphanReconciliationReport> {
  if (
    !Number.isInteger(input.gracePeriodMs) ||
    input.gracePeriodMs < 60_000 ||
    input.gracePeriodMs > 30 * 24 * 60 * 60 * 1_000
  ) {
    throw new Error("Daytona orphan reconciliation grace period is invalid");
  }
  const now = input.now ?? new Date();
  const dryRun = input.dryRun ?? true;
  const cutoff = new Date(now.getTime() - input.gracePeriodMs);
  let scanned = 0;
  let skippedActive = 0;
  let skippedLivePreview = 0;
  let skippedUnowned = 0;
  let deleted = 0;
  const eligibleResourceRefs: string[] = [];
  const failures: DaytonaOrphanReconciliationReport["failures"] = [];

  for await (const sandbox of input.client.list({
    labels: {
      "buildlabs.owner": CONTROLLER_OWNER,
      "buildlabs.managed": "true",
    },
    createdAtBefore: cutoff,
  })) {
    scanned += 1;
    const resourceRef = daytonaOpaqueResourceRef(sandbox.id);
    try {
      await sandbox.refreshData();
      if (!isControllerOwnedSandbox(sandbox, cutoff)) {
        skippedUnowned += 1;
        continue;
      }
      if (input.activeSandboxIds.has(sandbox.id)) {
        skippedActive += 1;
        continue;
      }
      if (isLiveFrozenPreview(sandbox, now)) {
        skippedLivePreview += 1;
        continue;
      }
      eligibleResourceRefs.push(resourceRef);
      if (!dryRun) {
        await sandbox.delete(120, true);
        deleted += 1;
      }
    } catch (error) {
      failures.push({
        resourceRef,
        failureCode: classifyDaytonaFailure(error),
      });
    }
  }

  return {
    schema: "buildlabs.daytona.orphan-reconciliation.v1",
    mode: dryRun ? "dry_run" : "delete",
    reconciledAt: now.toISOString(),
    gracePeriodMs: input.gracePeriodMs,
    scanned,
    eligible: eligibleResourceRefs.length,
    deleted,
    skippedActive,
    skippedLivePreview,
    skippedUnowned,
    failures,
    eligibleResourceRefs,
  };
}

export interface DaytonaBenchmarkReport {
  schema: "buildlabs.daytona.benchmark.v1";
  measuredAt: string;
  isolationPreserved: true;
  proofMode: "controller_attested_fresh_verifiers";
  warmPoolState: "measured" | "unavailable";
  samples: {
    coldCreationMs: number[];
    verifiedWarmClaimMs: number[];
    proofCompletionMs: number[];
  };
  proofReceipts: DaytonaBenchmarkProofReceipt[];
  summary: {
    coldCreation: DistributionSummary;
    verifiedWarmClaim?: DistributionSummary;
    proofCompletion: DistributionSummary;
  };
}

export interface DaytonaBenchmarkProofReceipt {
  builderRef: string;
  commandVerifierRef: string;
  deliveryVerifierRef: string;
  snapshotAttestationSha256: string;
  sourceDigest: string;
  browserVersion: string;
  screenshotSha256s: string[];
  networkBlockAllVerified: true;
  chromiumProofVerified: true;
  frozenPreviewVerified: true;
}

export async function benchmarkDaytonaControlPlane(input: {
  iterations: number;
  coldCreation(): Promise<{
    durationMs: number;
    resourceRef: string;
  }>;
  warmClaim?(): Promise<{
    durationMs: number;
    resourceRef: string;
    claim: "verified_pool_hit";
  }>;
  proofCompletion(): Promise<{
    durationMs: number;
    builderRef: string;
    commandVerifierRef: string;
    deliveryVerifierRef: string;
    snapshotAttestationSha256: string;
    sourceDigest: string;
    browserVersion: string;
    screenshotSha256s: string[];
    networkBlockAllVerified: boolean;
    chromiumProofVerified: boolean;
    frozenPreviewVerified: boolean;
  }>;
}): Promise<DaytonaBenchmarkReport> {
  if (
    !Number.isInteger(input.iterations) ||
    input.iterations < 1 ||
    input.iterations > 20
  ) {
    throw new Error("Daytona benchmark iteration count is invalid");
  }
  const coldCreationMs: number[] = [];
  const verifiedWarmClaimMs: number[] = [];
  const proofCompletionMs: number[] = [];
  const proofReceipts: DaytonaBenchmarkProofReceipt[] = [];
  for (let index = 0; index < input.iterations; index += 1) {
    const cold = await input.coldCreation();
    assertDuration(cold.durationMs);
    coldCreationMs.push(cold.durationMs);

    if (input.warmClaim) {
      const warm = await input.warmClaim();
      assertDuration(warm.durationMs);
      if (warm.claim !== "verified_pool_hit") {
        throw new Error("Daytona benchmark cannot infer a warm-pool hit");
      }
      verifiedWarmClaimMs.push(warm.durationMs);
    }

    const proof = await input.proofCompletion();
    assertDuration(proof.durationMs);
    if (
      new Set([
        proof.builderRef,
        proof.commandVerifierRef,
        proof.deliveryVerifierRef,
      ]).size !== 3 ||
      !proof.networkBlockAllVerified ||
      !proof.chromiumProofVerified ||
      !proof.frozenPreviewVerified ||
      !isSha256(proof.snapshotAttestationSha256) ||
      !isSha256(proof.sourceDigest) ||
      proof.browserVersion.length < 1 ||
      proof.browserVersion.length > 256 ||
      proof.screenshotSha256s.length < 1 ||
      proof.screenshotSha256s.length > 256 ||
      !proof.screenshotSha256s.every(isSha256)
    ) {
      throw new Error("Daytona benchmark did not preserve proof isolation");
    }
    proofCompletionMs.push(proof.durationMs);
    proofReceipts.push({
      builderRef: proof.builderRef,
      commandVerifierRef: proof.commandVerifierRef,
      deliveryVerifierRef: proof.deliveryVerifierRef,
      snapshotAttestationSha256: proof.snapshotAttestationSha256,
      sourceDigest: proof.sourceDigest,
      browserVersion: proof.browserVersion,
      screenshotSha256s: [...proof.screenshotSha256s],
      networkBlockAllVerified: true,
      chromiumProofVerified: true,
      frozenPreviewVerified: true,
    });
  }
  return {
    schema: "buildlabs.daytona.benchmark.v1",
    measuredAt: new Date().toISOString(),
    isolationPreserved: true,
    proofMode: "controller_attested_fresh_verifiers",
    warmPoolState: verifiedWarmClaimMs.length > 0 ? "measured" : "unavailable",
    samples: {
      coldCreationMs,
      verifiedWarmClaimMs,
      proofCompletionMs,
    },
    proofReceipts,
    summary: {
      coldCreation: summarize(coldCreationMs),
      ...(verifiedWarmClaimMs.length > 0
        ? { verifiedWarmClaim: summarize(verifiedWarmClaimMs) }
        : {}),
      proofCompletion: summarize(proofCompletionMs),
    },
  };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function assertNoDaytonaBearerMaterial(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (
    /(?:https?:\/\/|wss?:\/\/)/iu.test(serialized) ||
    /"(?:id|sandboxId|token|url|toolboxProxyUrl)"\s*:/iu.test(serialized) ||
    /(?:bearer|authorization)[\s":]+[A-Za-z0-9._~-]{8,}/iu.test(serialized)
  ) {
    throw new Error("Daytona public record contains provider bearer material");
  }
}

export function benchmarkMeasurementDuration(
  measurement: DaytonaAcquisitionMeasurement,
): number {
  return Object.values(measurement.phasesMs).reduce(
    (total, duration) => total + (duration ?? 0),
    0,
  );
}

function isControllerOwnedSandbox(
  sandbox: DaytonaOrphanSandbox,
  cutoff: Date,
): boolean {
  const role = sandbox.labels["buildlabs.role"];
  return (
    sandbox.labels["buildlabs.owner"] === CONTROLLER_OWNER &&
    sandbox.labels["buildlabs.managed"] === "true" &&
    role !== undefined &&
    MANAGED_ROLES.has(role as DaytonaSandboxRole) &&
    sandbox.createdAt !== undefined &&
    Number.isFinite(Date.parse(sandbox.createdAt)) &&
    new Date(sandbox.createdAt) <= cutoff &&
    sandbox.state !== "destroyed"
  );
}

function isLiveFrozenPreview(
  sandbox: DaytonaOrphanSandbox,
  now: Date,
): boolean {
  if (sandbox.labels["buildlabs.role"] !== "frozen-preview") {
    return false;
  }
  if (
    sandbox.autoDestroyAt === undefined ||
    !Number.isFinite(Date.parse(sandbox.autoDestroyAt))
  ) {
    return true;
  }
  return Date.parse(sandbox.autoDestroyAt) > now.getTime();
}

function boundedLog(value: string): {
  value: string;
  truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_ASYNC_LOG_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: bytes.subarray(0, MAX_ASYNC_LOG_BYTES).toString("utf8"),
    truncated: true,
  };
}

class DaytonaAsyncOperationTimeoutError extends Error {
  override readonly name = "TimeoutError";

  constructor(operation: string) {
    super(`Daytona async ${operation} exceeded its controller deadline`);
  }
}

function daytonaAsyncAbortError(): Error {
  const error = new Error("Daytona async execution was cancelled");
  error.name = "AbortError";
  return error;
}

function isDaytonaAsyncAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function terminationReason(
  outcome: DaytonaAsyncExecutionReceipt["outcome"],
): "cancelled" | "provider_failure" | "timed_out" {
  if (outcome === "cancelled") {
    return "cancelled";
  }
  if (outcome === "timed_out") {
    return "timed_out";
  }
  return "provider_failure";
}

function awaitDaytonaOperation<Value>(input: {
  execute: () => Promise<Value>;
  operation: string;
  timeoutMilliseconds: number;
  signal?: AbortSignal;
}): Promise<Value> {
  if (input.signal?.aborted) {
    return Promise.reject(daytonaAsyncAbortError());
  }
  if (input.timeoutMilliseconds <= 0) {
    return Promise.reject(
      new DaytonaAsyncOperationTimeoutError(input.operation),
    );
  }

  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      fail(daytonaAsyncAbortError());
    };
    const timer = setTimeout(() => {
      fail(new DaytonaAsyncOperationTimeoutError(input.operation));
    }, input.timeoutMilliseconds);
    const cleanup = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (value: Value): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      input.execute().then(succeed, (error: unknown) => {
        fail(daytonaAsyncProviderError(error));
      });
    } catch (error) {
      fail(daytonaAsyncProviderError(error));
    }
  });
}

function daytonaAsyncProviderError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("Daytona async provider operation failed");
}

function screenshotResponseBytes(value: unknown): Uint8Array {
  if (typeof value !== "object" || value === null) {
    throw new Error("Daytona Computer Use screenshot response is invalid");
  }
  const record = value as Record<string, unknown>;
  const encoded = [
    record.image,
    record.data,
    record.screenshot,
    record.base64,
  ].find((candidate): candidate is string => typeof candidate === "string");
  if (!encoded || encoded.length > 64 * 1_024 * 1_024) {
    throw new Error("Daytona Computer Use screenshot bytes are unavailable");
  }
  const normalized = encoded.includes(",")
    ? encoded.slice(encoded.indexOf(",") + 1)
    : encoded;
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.byteLength === 0) {
    throw new Error("Daytona Computer Use screenshot is empty");
  }
  return bytes;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Daytona operation aborted", "AbortError");
  }
}

interface DistributionSummary {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function summarize(values: number[]): DistributionSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1)!,
  };
}

function percentile(sorted: number[], percentileValue: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index]!;
}

function assertDuration(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Daytona benchmark duration is invalid");
  }
}

export function daytonaDiagnosticEvidenceDigest(
  receipt: DaytonaOperatorDiagnosticReceipt,
): string {
  return digestJson(receipt);
}
