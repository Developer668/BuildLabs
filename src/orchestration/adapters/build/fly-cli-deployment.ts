import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  OutboxEventSchema,
  type OutboxEvent,
} from "../../../domain/artifact.js";
import { digestJson, sha256 } from "../../../lib/canonical-json.js";
import { ValidatedProvenArtifact } from "../../ports/build-backend.js";
import type {
  DeployProvenArtifactRequest,
  FlyDeploymentPort,
  FlyDeploymentReceipt,
} from "../../ports/deployment.js";
import { BuildAdapterError } from "./build-adapter-error.js";
import { computeWorkspaceSha256 } from "./validated-artifact-workspace.js";

const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_MAX_ATTEMPTS = 6;
const DEFAULT_HEALTH_INITIAL_DELAY_MS = 1_000;
const DEFAULT_HEALTH_MAX_DELAY_MS = 10_000;
const DEFAULT_RELEASE_MAX_ATTEMPTS = 8;
const DEFAULT_RELEASE_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RELEASE_MAX_DELAY_MS = 10_000;
const MAX_PROVIDER_STDOUT_BYTES = 2 * 1_024 * 1_024;
const MAX_APP_DETAILS_BYTES = 64 * 1_024;
const MAX_FLY_APP_NAME_LENGTH = 63;
const FLY_MACHINES_API_ORIGIN = "https://api.machines.dev";
const RELEASE_KEY_LABEL = "io.buildlabs.release-key";
const ARTIFACT_SHA256_LABEL = "io.buildlabs.artifact-sha256";
const FLY_RELEASE_ID_METADATA = "fly_release_id";
const FLY_RELEASE_VERSION_METADATA = "fly_release_version";
const SERVABLE_MACHINE_STATES = new Set(["started", "stopped", "suspended"]);
const SHA256_IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * flyctl must expose the documented Machines API fields below. The adapter
 * intentionally fails closed when a flyctl version omits image labels,
 * image_ref.digest, or release metadata; it never derives an image digest.
 */
export const FLY_MACHINE_LIST_PROOF_REQUIREMENT =
  "flyctl machine list --app <app> --json must return a JSON array whose every Machine contains id, instance_id, state, image_ref.digest, image_ref.labels[io.buildlabs.release-key], image_ref.labels[io.buildlabs.artifact-sha256], config.metadata.fly_release_id, and config.metadata.fly_release_version";

const FlyMachineSchema = z
  .object({
    id: z.string().regex(PROVIDER_IDENTIFIER_PATTERN),
    instance_id: z.string().regex(PROVIDER_IDENTIFIER_PATTERN),
    state: z.string().min(1).max(64),
    config: z
      .object({
        metadata: z.record(z.string(), z.string()),
      })
      .passthrough(),
    image_ref: z
      .object({
        digest: z.string().regex(SHA256_IMAGE_DIGEST_PATTERN),
        labels: z.record(z.string(), z.string()),
      })
      .passthrough(),
  })
  .passthrough();

const FlyMachineListSchema = z.array(FlyMachineSchema).max(256);
const FlyAppDetailsSchema = z
  .object({
    name: z.string().min(1).max(MAX_FLY_APP_NAME_LENGTH),
    organization: z
      .object({
        slug: z.string().min(1).max(128),
      })
      .passthrough(),
  })
  .passthrough();

export interface SpawnInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  timeoutMs: number;
  captureStdout: boolean;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout?: string;
}

export type SpawnCommand = (
  invocation: SpawnInvocation,
  signal?: AbortSignal,
) => Promise<SpawnResult>;

export type DeploymentSleep = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

export interface FlyCliDeploymentAdapterOptions {
  accessToken: string;
  organizationSlug: string;
  appNamePrefix?: string;
  primaryRegion: string;
  executable?: string;
  spawnCommand?: SpawnCommand;
  apiFetch?: typeof fetch;
  fetch?: typeof fetch;
  sleep?: DeploymentSleep;
  now?: () => Date;
  deployTimeoutMs?: number;
  operationTimeoutMs?: number;
  healthPath?: string;
  healthRequestTimeoutMs?: number;
  healthMaxAttempts?: number;
  healthInitialDelayMs?: number;
  healthMaxDelayMs?: number;
  releaseMaxAttempts?: number;
  releaseInitialDelayMs?: number;
  releaseMaxDelayMs?: number;
}

interface FlyMachineObservation {
  machineId: string;
  instanceId: string;
  state: string;
  releaseId: string;
  releaseVersion: number;
  imageDigest: string;
  labels: Readonly<Record<string, string>>;
}

interface FlyReleaseIdentity {
  releaseId: string;
  releaseVersion: number;
  imageDigest: string;
  machineIds: readonly string[];
  machineInstanceIds: readonly string[];
}

interface FlyReleaseTarget {
  releaseKey: string;
  artifactSha256: string;
}

interface TrustedFlyConfig {
  path: string;
  cleanup: () => Promise<void>;
}

export class FlyCliDeploymentAdapter implements FlyDeploymentPort {
  readonly #accessToken: string;
  readonly #organizationSlug: string;
  readonly #appNamePrefix: string;
  readonly #primaryRegion: string;
  readonly #executable: string;
  readonly #spawnCommand: SpawnCommand;
  readonly #apiFetch: typeof fetch;
  readonly #fetch: typeof fetch;
  readonly #sleep: DeploymentSleep;
  readonly #now: () => Date;
  readonly #deployTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #healthPath: string;
  readonly #healthRequestTimeoutMs: number;
  readonly #healthMaxAttempts: number;
  readonly #healthInitialDelayMs: number;
  readonly #healthMaxDelayMs: number;
  readonly #releaseMaxAttempts: number;
  readonly #releaseInitialDelayMs: number;
  readonly #releaseMaxDelayMs: number;

  constructor(options: FlyCliDeploymentAdapterOptions) {
    this.#accessToken = validateSecret(options.accessToken);
    this.#organizationSlug = validateOrganizationSlug(options.organizationSlug);
    this.#appNamePrefix = validateAppNamePrefix(
      options.appNamePrefix ?? "buildlabs",
    );
    this.#primaryRegion = validatePrimaryRegion(options.primaryRegion);
    this.#executable = validateExecutable(options.executable ?? "flyctl");
    this.#spawnCommand = options.spawnCommand ?? spawnWithArguments;
    this.#apiFetch = options.apiFetch ?? globalThis.fetch;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep =
      options.sleep ??
      ((milliseconds, signal) =>
        delay(milliseconds, undefined, {
          ...(signal ? { signal } : {}),
        }));
    this.#now = options.now ?? (() => new Date());
    this.#deployTimeoutMs = boundedInteger(
      options.deployTimeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS,
      1_000,
      30 * 60_000,
      "configuration",
    );
    this.#operationTimeoutMs = boundedInteger(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      this.#deployTimeoutMs,
      30 * 60_000,
      "configuration",
    );
    this.#healthPath = validateHealthPath(options.healthPath ?? "/");
    this.#healthRequestTimeoutMs = boundedInteger(
      options.healthRequestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS,
      100,
      60_000,
      "configuration",
    );
    this.#healthMaxAttempts = boundedInteger(
      options.healthMaxAttempts ?? DEFAULT_HEALTH_MAX_ATTEMPTS,
      1,
      20,
      "configuration",
    );
    this.#healthInitialDelayMs = boundedInteger(
      options.healthInitialDelayMs ?? DEFAULT_HEALTH_INITIAL_DELAY_MS,
      0,
      60_000,
      "configuration",
    );
    this.#healthMaxDelayMs = boundedInteger(
      options.healthMaxDelayMs ?? DEFAULT_HEALTH_MAX_DELAY_MS,
      this.#healthInitialDelayMs,
      60_000,
      "configuration",
    );
    this.#releaseMaxAttempts = boundedInteger(
      options.releaseMaxAttempts ?? DEFAULT_RELEASE_MAX_ATTEMPTS,
      1,
      30,
      "configuration",
    );
    this.#releaseInitialDelayMs = boundedInteger(
      options.releaseInitialDelayMs ?? DEFAULT_RELEASE_INITIAL_DELAY_MS,
      0,
      60_000,
      "configuration",
    );
    this.#releaseMaxDelayMs = boundedInteger(
      options.releaseMaxDelayMs ?? DEFAULT_RELEASE_MAX_DELAY_MS,
      this.#releaseInitialDelayMs,
      60_000,
      "configuration",
    );
  }

  async health(signal?: AbortSignal): Promise<void> {
    const appsUrl = new URL("/v1/apps", FLY_MACHINES_API_ORIGIN);
    appsUrl.searchParams.set("org_slug", this.#organizationSlug);
    const apiProbe = this.#requestAppApi(
      appsUrl,
      { method: "GET" },
      signal,
    ).then(async (response) => {
      const healthy = response.status === 200;
      await disposeResponse(response);
      if (!healthy) {
        throw new BuildAdapterError("fly", "health", "PROVIDER_FAILURE");
      }
    });
    const cliProbe = this.#spawnCommand(
      {
        command: this.#executable,
        args: ["version"],
        cwd: process.cwd(),
        env: childEnvironment(this.#accessToken),
        shell: false,
        timeoutMs: 30_000,
        captureStdout: false,
      },
      signal,
    ).then((result) => {
      if (result.exitCode !== 0 || result.signal !== null) {
        throw new BuildAdapterError("fly", "health", "PROVIDER_FAILURE");
      }
    });
    const checks = await Promise.allSettled([apiProbe, cliProbe]);
    if (checks.some((check) => check.status === "rejected")) {
      throw new BuildAdapterError(
        "fly",
        "health",
        signal?.aborted ? "ABORTED" : "PROVIDER_FAILURE",
      );
    }
  }

  async deployProvenArtifact(
    request: DeployProvenArtifactRequest,
    signal?: AbortSignal,
  ): Promise<FlyDeploymentReceipt> {
    const operationDeadline = AbortSignal.timeout(this.#operationTimeoutMs);
    const operationSignal = signal
      ? AbortSignal.any([signal, operationDeadline])
      : operationDeadline;
    try {
      return await this.#deployProvenArtifact(request, operationSignal);
    } catch (error) {
      if (
        operationSignal.aborted &&
        !(
          error instanceof BuildAdapterError &&
          (error.code === "RELEASE_FENCED" ||
            error.code === "ARTIFACT_INTEGRITY_FAILED" ||
            error.code === "POLICY_BLOCKED")
        )
      ) {
        throw new BuildAdapterError("fly", "deploy", "ABORTED");
      }
      throw error;
    }
  }

  async #deployProvenArtifact(
    request: DeployProvenArtifactRequest,
    signal: AbortSignal,
  ): Promise<FlyDeploymentReceipt> {
    const parsedEvent = OutboxEventSchema.safeParse(request.event);
    if (
      !parsedEvent.success ||
      !(request.artifact instanceof ValidatedProvenArtifact)
    ) {
      throw new BuildAdapterError("fly", "deploy", "POLICY_BLOCKED");
    }
    const event = parsedEvent.data;
    const artifact = request.artifact;
    verifyArtifactCapability(event, artifact);
    const workspaceSha256 = await revalidateWorkspace(artifact);
    const appName = deriveFlyAppName(
      this.#appNamePrefix,
      event.payload.projectId,
    );
    const releaseKey = deriveFlyReleaseKey(event);
    const productionUrl = `https://${appName}.fly.dev/`;
    const target: FlyReleaseTarget = {
      releaseKey,
      artifactSha256: event.payload.artifact.sha256,
    };
    const preflightMachines = await this.#ensureAppAndInspect(
      appName,
      artifact.directory,
      signal,
    );
    let release = targetReleaseIdentity(preflightMachines, target);
    let recoveredFromProvider = release !== undefined;
    let deploymentAttempted = false;

    const preflightTargetMachines = preflightMachines.filter((machine) =>
      isTarget(machine, target),
    );
    if (!release && preflightTargetMachines.length > 0) {
      const partialTarget = coherentReleaseIdentity(preflightTargetMachines);
      if (!partialTarget) {
        throw new BuildAdapterError("fly", "inspect_release", "RELEASE_FENCED");
      }
      release = await this.#awaitTargetRelease(
        appName,
        artifact.directory,
        target,
        partialTarget.releaseVersion - 1,
        signal,
      );
      recoveredFromProvider = true;
    }

    const baseline = coherentReleaseIdentity(preflightMachines);
    if (!release && preflightMachines.length > 0 && !baseline) {
      throw new BuildAdapterError("fly", "inspect_release", "RELEASE_FENCED");
    }

    const invocation: SpawnInvocation = {
      command: this.#executable,
      args: [
        "deploy",
        artifact.directory,
        "--app",
        appName,
        "--remote-only",
        "--yes",
        "--strategy",
        "bluegreen",
        "--dockerfile",
        join(artifact.directory, event.payload.artifact.dockerfilePath),
        "--image-label",
        `buildlabs-${releaseKey.slice(0, 40)}`,
        "--label",
        `${RELEASE_KEY_LABEL}=${releaseKey}`,
        "--label",
        `${ARTIFACT_SHA256_LABEL}=${event.payload.artifact.sha256}`,
        "--deploy-retries",
        "2",
        "--wait-timeout",
        `${String(Math.ceil(this.#deployTimeoutMs / 1_000))}s`,
      ],
      cwd: artifact.directory,
      env: childEnvironment(this.#accessToken),
      shell: false,
      timeoutMs: this.#deployTimeoutMs,
      captureStdout: false,
    };

    if (!release) {
      deploymentAttempted = true;
      let deployResponseWasLost: boolean;
      try {
        const result = await this.#deployWithTrustedConfig(
          invocation,
          appName,
          event.payload.previewPort,
          signal,
        );
        deployResponseWasLost = result.exitCode !== 0 || result.signal !== null;
      } catch (error) {
        if (signal?.aborted) {
          throw new BuildAdapterError("fly", "deploy", "ABORTED");
        }
        if (error instanceof BuildAdapterError) {
          throw error;
        }
        deployResponseWasLost = true;
      }
      if ((await revalidateWorkspace(artifact)) !== workspaceSha256) {
        throw new BuildAdapterError(
          "fly",
          "deploy",
          "ARTIFACT_INTEGRITY_FAILED",
        );
      }
      try {
        release = await this.#awaitTargetRelease(
          appName,
          artifact.directory,
          target,
          baseline?.releaseVersion ?? 0,
          signal,
        );
      } catch (error) {
        if (
          deployResponseWasLost &&
          error instanceof BuildAdapterError &&
          error.code === "RELEASE_VERIFICATION_FAILED"
        ) {
          throw new BuildAdapterError("fly", "deploy", "DEPLOYMENT_FAILED");
        }
        throw error;
      }
      recoveredFromProvider = deployResponseWasLost;
    }

    if (!release) {
      throw new BuildAdapterError(
        "fly",
        "verify_release",
        "RELEASE_VERIFICATION_FAILED",
      );
    }
    const releaseVerifiedAt = safeNow(this.#now);
    const deployedAt = releaseVerifiedAt;
    const health = await this.#verifyHealth(
      productionUrl,
      appName,
      artifact.directory,
      target,
      release,
      signal,
    );
    const healthVerifiedAt = safeNow(this.#now);
    return {
      provider: "fly",
      appName,
      releaseKey,
      projectId: event.payload.projectId,
      candidateId: event.payload.candidateId,
      contractHash: event.payload.contractHash,
      revisionHash: event.revisionHash,
      sourceArtifactSha256: event.payload.artifact.sha256,
      workspaceSha256,
      flyReleaseId: health.release.releaseId,
      flyReleaseVersion: health.release.releaseVersion,
      imageDigest: health.release.imageDigest,
      machineIds: [...health.release.machineIds],
      machineInstanceIds: [...health.release.machineInstanceIds],
      verifiedLabels: {
        releaseKey,
        artifactSha256: event.payload.artifact.sha256,
      },
      deploymentAttempted,
      recoveredFromProvider,
      productionUrl,
      deployedAt,
      releaseVerifiedAt,
      healthVerifiedAt,
      healthAttempts: health.attempts,
    };
  }

  async #deployWithTrustedConfig(
    invocation: SpawnInvocation,
    appName: string,
    previewPort: number,
    signal: AbortSignal | undefined,
  ): Promise<SpawnResult> {
    const trustedConfig = await createTrustedFlyConfig(
      appName,
      this.#primaryRegion,
      previewPort,
      this.#healthPath,
    );
    try {
      return await this.#spawnCommand(
        {
          ...invocation,
          args: [...invocation.args, "--config", trustedConfig.path],
        },
        signal,
      );
    } finally {
      await trustedConfig.cleanup();
    }
  }

  async #ensureAppAndInspect(
    appName: string,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<FlyMachineObservation[]> {
    try {
      return await this.#inspectMachines(appName, cwd, signal);
    } catch (error) {
      if (
        !(error instanceof BuildAdapterError) ||
        error.code !== "PROVIDER_FAILURE"
      ) {
        throw error;
      }
    }

    const existing = await this.#getApp(appName, signal);
    if (existing) {
      verifyAppIdentity(existing, appName, this.#organizationSlug);
      return this.#inspectMachines(appName, cwd, signal);
    }

    try {
      await this.#createApp(appName, signal);
    } catch (error) {
      if (error instanceof BuildAdapterError && error.code === "ABORTED") {
        throw error;
      }
      // A timeout or non-201 can mean Fly committed the unique-name create
      // before the response was lost, or another worker won the same race.
    }

    const provisioned = await this.#getApp(appName, signal);
    if (!provisioned) {
      throw new BuildAdapterError("fly", "ensure_app", "PROVIDER_FAILURE");
    }
    verifyAppIdentity(provisioned, appName, this.#organizationSlug);
    return this.#inspectMachines(appName, cwd, signal);
  }

  async #getApp(
    appName: string,
    signal: AbortSignal | undefined,
  ): Promise<z.infer<typeof FlyAppDetailsSchema> | undefined> {
    const response = await this.#requestAppApi(
      new URL(
        `/v1/apps/${encodeURIComponent(appName)}`,
        FLY_MACHINES_API_ORIGIN,
      ),
      { method: "GET" },
      signal,
    );
    if (response.status === 404) {
      await disposeResponse(response);
      return undefined;
    }
    if (response.status !== 200) {
      await disposeResponse(response);
      throw new BuildAdapterError("fly", "inspect_app", "PROVIDER_FAILURE");
    }
    let body: string;
    try {
      body = await readBoundedResponseText(response, MAX_APP_DETAILS_BYTES);
    } catch {
      throw new BuildAdapterError(
        "fly",
        "inspect_app",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(body) as unknown;
    } catch {
      throw new BuildAdapterError(
        "fly",
        "inspect_app",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    const parsed = FlyAppDetailsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new BuildAdapterError(
        "fly",
        "inspect_app",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return parsed.data;
  }

  async #createApp(
    appName: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const response = await this.#requestAppApi(
      new URL("/v1/apps", FLY_MACHINES_API_ORIGIN),
      {
        method: "POST",
        body: JSON.stringify({
          app_name: appName,
          org_slug: this.#organizationSlug,
        }),
      },
      signal,
    );
    const created = response.status === 200 || response.status === 201;
    await disposeResponse(response);
    if (!created) {
      throw new BuildAdapterError("fly", "create_app", "PROVIDER_FAILURE");
    }
  }

  async #requestAppApi(
    url: URL,
    init: Pick<RequestInit, "body" | "method">,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(
      Math.min(this.#deployTimeoutMs, 60_000),
    );
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    try {
      return await this.#apiFetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#accessToken}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: requestSignal,
      });
    } catch {
      throw new BuildAdapterError(
        "fly",
        "app_api",
        signal?.aborted ? "ABORTED" : "PROVIDER_FAILURE",
      );
    }
  }

  async #awaitTargetRelease(
    appName: string,
    cwd: string,
    target: FlyReleaseTarget,
    baselineReleaseVersion: number,
    signal: AbortSignal | undefined,
  ): Promise<FlyReleaseIdentity> {
    for (let attempt = 1; attempt <= this.#releaseMaxAttempts; attempt += 1) {
      const machines = await this.#inspectMachines(appName, cwd, signal);
      const release = targetReleaseIdentity(machines, target);
      if (release) {
        if (release.releaseVersion <= baselineReleaseVersion) {
          throw new BuildAdapterError(
            "fly",
            "verify_release",
            "RELEASE_FENCED",
          );
        }
        return release;
      }
      if (
        machines.some(
          (machine) =>
            machine.releaseVersion > baselineReleaseVersion &&
            !isTarget(machine, target),
        )
      ) {
        throw new BuildAdapterError("fly", "verify_release", "RELEASE_FENCED");
      }
      if (attempt < this.#releaseMaxAttempts) {
        await this.#sleepWithBackoff(
          attempt,
          this.#releaseInitialDelayMs,
          this.#releaseMaxDelayMs,
          signal,
          "verify_release",
        );
      }
    }
    throw new BuildAdapterError(
      "fly",
      "verify_release",
      "RELEASE_VERIFICATION_FAILED",
    );
  }

  async #verifyHealth(
    productionUrl: string,
    appName: string,
    cwd: string,
    targetRelease: FlyReleaseTarget,
    expectedRelease: FlyReleaseIdentity,
    signal: AbortSignal | undefined,
  ): Promise<{ attempts: number; release: FlyReleaseIdentity }> {
    for (let attempt = 1; attempt <= this.#healthMaxAttempts; attempt += 1) {
      const before = requireSameTargetRelease(
        await this.#inspectMachines(appName, cwd, signal),
        targetRelease,
        expectedRelease,
      );
      let healthy = true;
      for (const machineId of before.machineIds) {
        const target = new URL(this.#healthPath, productionUrl);
        target.searchParams.set(
          "__buildlabs_release",
          targetRelease.releaseKey,
        );
        target.searchParams.set("__buildlabs_attempt", String(attempt));
        const timeoutSignal = AbortSignal.timeout(this.#healthRequestTimeoutMs);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        try {
          const response = await this.#fetch(target, {
            method: "GET",
            headers: {
              accept: "text/html,application/json;q=0.9",
              "fly-force-instance-id": machineId,
            },
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
            signal: requestSignal,
          });
          if (response.status < 200 || response.status >= 300) {
            healthy = false;
          }
          try {
            await response.body?.cancel();
          } catch {
            // Body disposal is best effort; status and release fencing decide.
          }
        } catch {
          if (signal?.aborted) {
            throw new BuildAdapterError("fly", "health_check", "ABORTED");
          }
          healthy = false;
        }
      }
      const after = requireSameTargetRelease(
        await this.#inspectMachines(appName, cwd, signal),
        targetRelease,
        expectedRelease,
      );
      if (!sameReleaseIdentity(before, after)) {
        throw new BuildAdapterError("fly", "health_check", "RELEASE_FENCED");
      }
      if (healthy) {
        return { attempts: attempt, release: after };
      }

      if (attempt < this.#healthMaxAttempts) {
        await this.#sleepWithBackoff(
          attempt,
          this.#healthInitialDelayMs,
          this.#healthMaxDelayMs,
          signal,
          "health_check",
        );
      }
    }
    throw new BuildAdapterError("fly", "health_check", "HEALTH_CHECK_FAILED");
  }

  async #inspectMachines(
    appName: string,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<FlyMachineObservation[]> {
    const invocation: SpawnInvocation = {
      command: this.#executable,
      args: ["machine", "list", "--app", appName, "--json"],
      cwd,
      env: childEnvironment(this.#accessToken),
      shell: false,
      timeoutMs: Math.min(this.#deployTimeoutMs, 60_000),
      captureStdout: true,
    };
    let result: SpawnResult;
    try {
      result = await this.#spawnCommand(invocation, signal);
    } catch {
      throw new BuildAdapterError(
        "fly",
        "inspect_release",
        signal?.aborted ? "ABORTED" : "PROVIDER_FAILURE",
      );
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      throw new BuildAdapterError("fly", "inspect_release", "PROVIDER_FAILURE");
    }
    if (
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_PROVIDER_STDOUT_BYTES
    ) {
      throw new BuildAdapterError(
        "fly",
        "inspect_release",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return parseMachineObservations(result.stdout);
  }

  async #sleepWithBackoff(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<void> {
    const backoff = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
    try {
      await this.#sleep(backoff, signal);
    } catch {
      throw new BuildAdapterError("fly", operation, "ABORTED");
    }
  }
}

async function createTrustedFlyConfig(
  appName: string,
  primaryRegion: string,
  previewPort: number,
  healthPath: string,
): Promise<TrustedFlyConfig> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "buildlabs-fly-config-"));
    const configDirectory = directory;
    const path = join(configDirectory, "fly.toml");
    const contents = [
      `app = "${appName}"`,
      `primary_region = "${primaryRegion}"`,
      "",
      "[deploy]",
      '  strategy = "bluegreen"',
      "",
      "[http_service]",
      `  internal_port = ${String(previewPort)}`,
      "  force_https = true",
      "",
      "[[http_service.checks]]",
      '  grace_period = "10s"',
      '  interval = "15s"',
      '  method = "GET"',
      `  path = "${escapeTomlBasicString(healthPath)}"`,
      '  protocol = "http"',
      '  timeout = "5s"',
      "",
    ].join("\n");
    await writeFile(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return {
      path,
      cleanup: async () => {
        try {
          await rm(configDirectory, { force: true, recursive: true });
        } catch {
          throw new BuildAdapterError(
            "fly",
            "cleanup_config",
            "PROVIDER_FAILURE",
          );
        }
      },
    };
  } catch (error) {
    if (directory !== undefined) {
      try {
        await rm(directory, { force: true, recursive: true });
      } catch {
        // The sanitized preparation failure remains authoritative.
      }
    }
    if (error instanceof BuildAdapterError) {
      throw error;
    }
    throw new BuildAdapterError("fly", "prepare_config", "PROVIDER_FAILURE");
  }
}

function parseMachineObservations(
  providerJson: string,
): FlyMachineObservation[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(providerJson) as unknown;
  } catch {
    throw new BuildAdapterError(
      "fly",
      "inspect_release",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const parsed = FlyMachineListSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new BuildAdapterError(
      "fly",
      "inspect_release",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const machineIds = new Set<string>();
  const observations = parsed.data.map((machine) => {
    const releaseId = machine.config.metadata[FLY_RELEASE_ID_METADATA];
    const releaseVersionValue =
      machine.config.metadata[FLY_RELEASE_VERSION_METADATA];
    const releaseVersion = Number(releaseVersionValue);
    if (
      !releaseId ||
      releaseId.length > 256 ||
      /[\0\r\n]/.test(releaseId) ||
      !releaseVersionValue ||
      !/^[1-9]\d*$/.test(releaseVersionValue) ||
      !Number.isSafeInteger(releaseVersion) ||
      machineIds.has(machine.id)
    ) {
      throw new BuildAdapterError(
        "fly",
        "inspect_release",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    machineIds.add(machine.id);
    return {
      machineId: machine.id,
      instanceId: machine.instance_id,
      state: machine.state,
      releaseId,
      releaseVersion,
      imageDigest: machine.image_ref.digest,
      labels: machine.image_ref.labels,
    };
  });
  return observations.sort((left, right) =>
    left.machineId.localeCompare(right.machineId),
  );
}

function verifyAppIdentity(
  app: z.infer<typeof FlyAppDetailsSchema>,
  expectedName: string,
  expectedOrganizationSlug: string,
): void {
  if (
    app.name !== expectedName ||
    app.organization.slug !== expectedOrganizationSlug
  ) {
    throw new BuildAdapterError("fly", "inspect_app", "POLICY_BLOCKED");
  }
}

async function disposeResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status code is sufficient; response disposal is best effort.
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (/^\d+$/.test(declaredLength) === false ||
      Number(declaredLength) > maximumBytes)
  ) {
    await disposeResponse(response);
    throw new Error("Fly response exceeded limit");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Fly response returned an invalid body chunk");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Fly response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function coherentReleaseIdentity(
  machines: readonly FlyMachineObservation[],
): FlyReleaseIdentity | undefined {
  if (machines.length === 0) {
    return undefined;
  }
  const first = machines[0];
  if (
    !first ||
    !machines.every(
      (machine) =>
        machine.releaseId === first.releaseId &&
        machine.releaseVersion === first.releaseVersion &&
        machine.imageDigest === first.imageDigest,
    )
  ) {
    return undefined;
  }
  return releaseIdentity(first, machines);
}

function targetReleaseIdentity(
  machines: readonly FlyMachineObservation[],
  target: FlyReleaseTarget,
): FlyReleaseIdentity | undefined {
  if (
    machines.length === 0 ||
    !machines.every(
      (machine) =>
        SERVABLE_MACHINE_STATES.has(machine.state) && isTarget(machine, target),
    )
  ) {
    return undefined;
  }
  return coherentReleaseIdentity(machines);
}

function releaseIdentity(
  first: FlyMachineObservation,
  machines: readonly FlyMachineObservation[],
): FlyReleaseIdentity {
  return {
    releaseId: first.releaseId,
    releaseVersion: first.releaseVersion,
    imageDigest: first.imageDigest,
    machineIds: machines.map((machine) => machine.machineId),
    machineInstanceIds: machines.map((machine) => machine.instanceId),
  };
}

function isTarget(
  machine: FlyMachineObservation,
  target: FlyReleaseTarget,
): boolean {
  return (
    machine.labels[RELEASE_KEY_LABEL] === target.releaseKey &&
    machine.labels[ARTIFACT_SHA256_LABEL] === target.artifactSha256
  );
}

function requireSameTargetRelease(
  machines: readonly FlyMachineObservation[],
  target: FlyReleaseTarget,
  expected: FlyReleaseIdentity,
): FlyReleaseIdentity {
  const current = targetReleaseIdentity(machines, target);
  if (!current || !sameReleaseIdentity(current, expected)) {
    throw new BuildAdapterError("fly", "health_check", "RELEASE_FENCED");
  }
  return current;
}

function sameReleaseIdentity(
  left: FlyReleaseIdentity,
  right: FlyReleaseIdentity,
): boolean {
  return (
    left.releaseId === right.releaseId &&
    left.releaseVersion === right.releaseVersion &&
    left.imageDigest === right.imageDigest &&
    equalStrings(left.machineIds, right.machineIds) &&
    equalStrings(left.machineInstanceIds, right.machineInstanceIds)
  );
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function deriveFlyAppName(prefix: string, projectId: string): string {
  const normalizedPrefix = validateAppNamePrefix(prefix);
  const slug =
    projectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const suffix = sha256(projectId).slice(0, 10);
  const available =
    MAX_FLY_APP_NAME_LENGTH - normalizedPrefix.length - suffix.length - 2;
  const projectPart = slug.slice(0, Math.max(1, available)).replace(/-+$/g, "");
  return `${normalizedPrefix}-${projectPart || "p"}-${suffix}`;
}

export function deriveFlyReleaseKey(event: OutboxEvent): string {
  return digestJson({
    version: 1,
    provider: "fly",
    projectId: event.payload.projectId,
    candidateId: event.payload.candidateId,
    contractHash: event.payload.contractHash,
    revisionHash: event.revisionHash,
    artifactSha256: event.payload.artifact.sha256,
  });
}

function verifyArtifactCapability(
  event: OutboxEvent,
  artifact: ValidatedProvenArtifact,
): void {
  try {
    artifact.assertUsable();
  } catch {
    throw new BuildAdapterError("fly", "deploy", "POLICY_BLOCKED");
  }
  if (
    artifact.eventId !== event.eventId ||
    artifact.runId !== event.runId ||
    artifact.projectId !== event.payload.projectId ||
    artifact.candidateId !== event.payload.candidateId ||
    artifact.contractHash !== event.payload.contractHash ||
    artifact.revisionHash !== event.revisionHash ||
    artifact.artifactId !== event.payload.artifact.artifactId ||
    artifact.sourceSha256 !== event.payload.artifact.sha256 ||
    artifact.sourceSizeBytes !== event.payload.artifact.sizeBytes
  ) {
    throw new BuildAdapterError("fly", "deploy", "POLICY_BLOCKED");
  }
}

async function revalidateWorkspace(
  artifact: ValidatedProvenArtifact,
): Promise<string> {
  let digest: string;
  try {
    artifact.assertUsable();
    digest = await computeWorkspaceSha256(artifact.directory);
  } catch {
    throw new BuildAdapterError(
      "fly",
      "validate_artifact",
      "ARTIFACT_INTEGRITY_FAILED",
    );
  }
  if (digest !== artifact.workspaceSha256) {
    throw new BuildAdapterError(
      "fly",
      "validate_artifact",
      "ARTIFACT_INTEGRITY_FAILED",
    );
  }
  return digest;
}

function childEnvironment(accessToken: string): Record<string, string> {
  const environment: Record<string, string> = {
    FLY_API_TOKEN: accessToken,
    NO_COLOR: "1",
  };
  for (const name of [
    "HOME",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TMPDIR",
    "USERPROFILE",
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function spawnWithArguments(
  invocation: SpawnInvocation,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    try {
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: invocation.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      if (invocation.captureStdout) {
        child.stdout?.on("data", (chunk: Buffer | string) => {
          if (settled) {
            return;
          }
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutBytes += bytes.byteLength;
          if (stdoutBytes > MAX_PROVIDER_STDOUT_BYTES) {
            settled = true;
            child.kill("SIGKILL");
            reject(new Error("flyctl output exceeded limit"));
            return;
          }
          stdoutChunks.push(bytes);
        });
      } else {
        child.stdout?.resume();
      }
      child.stderr?.resume();
      child.once("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("flyctl process failed"));
        }
      });
      child.once("close", (exitCode, closeSignal) => {
        if (!settled) {
          settled = true;
          resolve({
            exitCode,
            signal: closeSignal,
            ...(invocation.captureStdout
              ? { stdout: Buffer.concat(stdoutChunks).toString("utf8") }
              : {}),
          });
        }
      });
    } catch {
      reject(new Error("flyctl process failed"));
    }
  });
}

function validateSecret(value: string): string {
  if (
    value.trim().length < 16 ||
    value.trim() !== value ||
    value.length > 8_192 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return value;
}

function validateAppNamePrefix(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 24 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return normalized;
}

function validateOrganizationSlug(value: string): string {
  if (
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return value;
}

function validatePrimaryRegion(value: string): string {
  if (
    value.length === 0 ||
    value.length > 32 ||
    value.trim() !== value ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return value;
}

function validateExecutable(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    /[\0\r\n]/.test(value) ||
    value.trim() !== value
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return value;
}

function validateHealthPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1_000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    hasControlCharacter(value)
  ) {
    throw new BuildAdapterError("fly", "configuration", "INVALID_INPUT");
  }
  return value;
}

function escapeTomlBasicString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  operation: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BuildAdapterError("fly", operation, "INVALID_INPUT");
  }
  return value;
}

function safeNow(now: () => Date): string {
  let value: Date;
  try {
    value = now();
  } catch {
    throw new BuildAdapterError("fly", "clock", "PROVIDER_FAILURE");
  }
  if (!Number.isFinite(value.getTime())) {
    throw new BuildAdapterError("fly", "clock", "PROVIDER_FAILURE");
  }
  return value.toISOString();
}
