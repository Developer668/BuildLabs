import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";

import {
  createDaytonaRoleAcquisitionPolicy,
  DaytonaAccountApi,
  daytonaOpaqueResourceRef,
  evaluateDaytonaWarmPoolEligibility,
  parseDaytonaWarmPoolRoles,
  verifyDaytonaWarmPoolClaim,
  type DaytonaWarmSandboxObservation,
} from "../src/adapters/daytona/daytona-control-plane.js";
import {
  benchmarkDaytonaControlPlane,
  assertNoDaytonaBearerMaterial,
} from "../src/adapters/daytona/daytona-operations.js";
import { DaytonaSandboxProvider } from "../src/adapters/daytona/daytona-sandbox.js";
import { installDaytonaScriptFailureRedaction } from "../src/adapters/daytona/daytona-script-safety.js";
import {
  assertFreshDaytonaSnapshotAttestation,
  readDaytonaSnapshotAttestation,
} from "../src/adapters/daytona/daytona-snapshot-attestation.js";
import { loadConfig } from "../src/config.js";
import {
  BuildAssignmentSchema,
  type BuildAssignment,
} from "../src/domain/contract.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type { ExportedWorkspace, SandboxSession } from "../src/ports/index.js";

installDaytonaScriptFailureRedaction("benchmark");

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const iterations = parseIterations(process.argv.slice(2));
const attestation = await readDaytonaSnapshotAttestation(
  config.DAYTONA_SNAPSHOT_ATTESTATION_PATH,
);
assertFreshDaytonaSnapshotAttestation(attestation);
if (attestation.payload.snapshot.name !== config.DAYTONA_BUILD_SNAPSHOT) {
  throw new Error("Daytona benchmark snapshot attestation does not match");
}

const provider = new DaytonaSandboxProvider(config);
await provider.health(AbortSignal.timeout(30_000));

const daytona = new Daytona({
  apiKey: config.DAYTONA_API_KEY,
  apiUrl: config.DAYTONA_API_URL,
  ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
  otelEnabled: config.DAYTONA_OTEL_ENABLED,
});
const accountApi = new DaytonaAccountApi(
  config.DAYTONA_API_URL,
  config.DAYTONA_API_KEY,
);
const benchmarkSnapshotNames = new Set<string>();
let providerClosed = false;
let benchmarkOutput: Record<string, unknown> | undefined;
let benchmarkFailure: unknown;

try {
  const initialWarmInventory = await accountApi.observeWarmSandboxes(
    AbortSignal.timeout(15_000),
  );
  const exactWarmPoolAvailable =
    parseDaytonaWarmPoolRoles(config.DAYTONA_WARM_POOL_ROLES).includes(
      "verifier-commands",
    ) && initialWarmInventory.sandboxes.some(isExactWarmPoolSandbox);
  const report = await benchmarkDaytonaControlPlane({
    iterations,
    coldCreation: async () => {
      const warmInventory = await accountApi.observeWarmSandboxes(
        AbortSignal.timeout(15_000),
      );
      const preexistingWarmSandboxIds = new Set(
        warmInventory.sandboxes.map((sandbox) => sandbox.id),
      );
      const startedAt = performance.now();
      const sandbox = await createBenchmarkSandbox(daytona, "builder", true);
      try {
        await sandbox.refreshData();
        assertBenchmarkSandbox(
          sandbox,
          "builder",
          true,
          preexistingWarmSandboxIds,
        );
        return {
          durationMs: performance.now() - startedAt,
          resourceRef: daytonaOpaqueResourceRef(sandbox.id),
        };
      } finally {
        await sandbox.delete(120, true);
      }
    },
    ...(exactWarmPoolAvailable
      ? {
          warmClaim: async () => {
            const inventory = await accountApi.observeWarmSandboxes(
              AbortSignal.timeout(15_000),
            );
            const before = inventory.sandboxes.filter(isExactWarmPoolSandbox);
            if (before.length === 0) {
              throw new Error(
                "The exact-match Daytona warm pool became unavailable",
              );
            }
            const startedAt = performance.now();
            const sandbox = await createBenchmarkSandbox(
              daytona,
              "verifier-commands",
              false,
            );
            try {
              await sandbox.refreshData();
              assertBenchmarkSandbox(sandbox, "verifier-commands", false);
              const claim = verifyDaytonaWarmPoolClaim({
                before,
                returnedSandbox: {
                  id: sandbox.id,
                  ...(sandbox.snapshot ? { snapshot: sandbox.snapshot } : {}),
                  target: sandbox.target,
                  user: sandbox.user,
                  cpu: sandbox.cpu,
                  memoryGiB: sandbox.memory,
                  diskGiB: sandbox.disk,
                },
                policy: {
                  role: "verifier-commands",
                  snapshot: config.DAYTONA_BUILD_SNAPSHOT,
                  ...(config.DAYTONA_TARGET
                    ? { target: config.DAYTONA_TARGET }
                    : {}),
                  snapshotResources: attestation.payload.snapshot.resources,
                  warmPoolEnabled: true,
                  requireUnusedSandbox: true,
                  requireFreshSnapshot: true,
                  allowMutableBuilderFork: false,
                  allowLinkedSandbox: false,
                  createTimeoutSeconds: 120,
                  readinessTimeoutSeconds: 120,
                  teardownTimeoutSeconds: 120,
                },
              });
              if (claim.outcome !== "verified_pool_hit") {
                throw new Error(
                  "Daytona warm claim could not be independently observed",
                );
              }
              const unused = await sandbox.process.executeCommand(
                [
                  "set -euo pipefail",
                  "marker=/tmp/.buildlabs-controller-claimed",
                  'test ! -e "$marker"',
                  "umask 077",
                  'printf "%s\\n" claimed > "$marker"',
                ].join("\n"),
                undefined,
                {},
                15,
              );
              if (unused.exitCode !== 0) {
                throw new Error(
                  "Daytona warm benchmark sandbox was not unused",
                );
              }
              return {
                durationMs: performance.now() - startedAt,
                resourceRef: claim.sandboxRef,
                claim: "verified_pool_hit" as const,
              };
            } finally {
              await sandbox.delete(120, true);
            }
          },
        }
      : {}),
    proofCompletion: runControllerAttestedProof,
  });
  await provider.close(AbortSignal.timeout(180_000));
  providerClosed = true;
  await cleanupBenchmarkSnapshots(daytona, benchmarkSnapshotNames);
  benchmarkOutput = {
    ...report,
    acquisitionMeasurements: provider.acquisitionMeasurements(),
  };
} catch (error) {
  benchmarkFailure = error;
}

const cleanup = await Promise.allSettled([
  ...(providerClosed ? [] : [provider.close(AbortSignal.timeout(180_000))]),
  cleanupBenchmarkSnapshots(daytona, benchmarkSnapshotNames),
]);
const failures = cleanup
  .filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  .map((result) => result.reason as unknown);
try {
  await daytona[Symbol.asyncDispose]();
} catch (error) {
  failures.push(error);
}
if (benchmarkFailure !== undefined || failures.length > 0) {
  throw new AggregateError(
    benchmarkFailure === undefined ? failures : [benchmarkFailure, ...failures],
    "Daytona benchmark or deterministic cleanup did not complete",
  );
}
if (!benchmarkOutput) {
  throw new Error("Daytona benchmark produced no report");
}
assertNoDaytonaBearerMaterial(benchmarkOutput);
process.stdout.write(`${JSON.stringify(benchmarkOutput)}\n`);

async function runControllerAttestedProof(): Promise<{
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
}> {
  const startedAt = performance.now();
  const assignment = benchmarkAssignment();
  const runId = randomUUID();
  const sessions: SandboxSession[] = [];
  let source: ExportedWorkspace | undefined;
  let primaryFailure: unknown;
  let proofResult:
    | {
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
      }
    | undefined;
  try {
    const builder = await provider.create(
      runId,
      assignment,
      AbortSignal.timeout(180_000),
    );
    sessions.push(builder);
    await builder.writeFile(
      "server.mjs",
      [
        'import { createServer } from "node:http";',
        "const port = Number(process.env.PORT ?? 4173);",
        "createServer((_request, response) => {",
        '  response.setHeader("content-type", "text/html; charset=utf-8");',
        '  response.end("<!doctype html><main>BuildLabs benchmark proof</main>");',
        "}).listen(port, '0.0.0.0');",
        "",
      ].join("\n"),
    );
    await builder.writeFile(
      "Dockerfile",
      [
        "FROM node:24-alpine",
        "WORKDIR /app",
        "COPY server.mjs ./server.mjs",
        'CMD ["node", "server.mjs"]',
        "",
      ].join("\n"),
    );
    const builderCheck = await builder.runCommand(
      "node --check server.mjs",
      30,
      AbortSignal.timeout(60_000),
    );
    if (builderCheck.exitCode !== 0) {
      throw new Error("Daytona benchmark builder command failed");
    }
    const builderRevision = await builder.freeze();
    source = await builder.exportWorkspace(builderRevision);
    const revision = {
      ...builderRevision,
      sourceDigest: source.contentDigest,
    };

    const commandVerifier = await provider.createVerifier(
      runId,
      assignment,
      revision,
      source,
      "commands",
      AbortSignal.timeout(180_000),
    );
    sessions.push(commandVerifier);
    const commandCheck = await commandVerifier.runCommand(
      "node --check server.mjs",
      30,
      AbortSignal.timeout(60_000),
    );
    if (
      commandCheck.exitCode !== 0 ||
      (await commandVerifier.currentRevisionDigest()) !== revision.sourceDigest
    ) {
      throw new Error("Daytona benchmark command verifier failed");
    }

    const deliveryVerifier = await provider.createVerifier(
      runId,
      assignment,
      revision,
      source,
      "delivery",
      AbortSignal.timeout(180_000),
    );
    sessions.push(deliveryVerifier);
    const dockerBuild = await deliveryVerifier.runCommand(
      "docker build --pull=false -t buildlabs-proof .",
      240,
      AbortSignal.timeout(300_000),
    );
    if (dockerBuild.exitCode !== 0) {
      throw new Error("Daytona benchmark clean delivery image build failed");
    }
    await deliveryVerifier.sealNetworkForProof(AbortSignal.timeout(30_000));
    await deliveryVerifier.startContainerPreview(
      "buildlabs-proof",
      4_173,
      AbortSignal.timeout(120_000),
    );
    const networkProbe = await deliveryVerifier.runCommand(
      [
        "if curl --silent --show-error --max-time 5 http://1.1.1.1/ >/dev/null 2>&1; then",
        "  exit 1",
        "fi",
        "curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4173/ >/dev/null",
      ].join("\n"),
      20,
      AbortSignal.timeout(30_000),
    );
    const [rendered] = await deliveryVerifier.inspectRenderedPages(
      ["/"],
      4_173,
      30_000,
      AbortSignal.timeout(60_000),
    );
    const networkBlockAllVerified = networkProbe.exitCode === 0;
    const chromiumProofVerified =
      rendered?.status === 200 &&
      rendered.visibleText?.includes("BuildLabs benchmark proof") === true &&
      rendered.screenshotSha256s?.length === 1;
    if (!networkBlockAllVerified || !chromiumProofVerified) {
      throw new Error("Daytona benchmark proof probe failed closed");
    }
    const frozenSnapshotName = `buildlabs-${runId.slice(0, 8)}-${revision.sourceDigest.slice(0, 12)}`;
    benchmarkSnapshotNames.add(frozenSnapshotName);
    await deliveryVerifier.createSnapshot(
      frozenSnapshotName,
      AbortSignal.timeout(360_000),
    );
    const frozenPreview = await provider.materializeFrozenPreview(
      {
        snapshotId: frozenSnapshotName,
        runId,
        projectId: assignment.projectId,
        candidateId: assignment.candidateId,
        eventId: randomUUID(),
        artifactId: randomUUID(),
        artifactSha256: source.archiveSha256,
        revisionHash: revision.sourceDigest,
        port: 4_173,
        expiresInSeconds: 60,
        idempotencyKey: `benchmark:frozen-preview:${randomUUID()}`,
      },
      AbortSignal.timeout(240_000),
    );
    const frozenPreviewVerified =
      Number.isFinite(Date.parse(frozenPreview.expiresAt)) &&
      Date.parse(frozenPreview.expiresAt) > Date.now();
    if (!frozenPreviewVerified) {
      throw new Error("Daytona benchmark frozen preview did not verify");
    }
    proofResult = {
      durationMs: performance.now() - startedAt,
      builderRef: daytonaOpaqueResourceRef(builder.id),
      commandVerifierRef: daytonaOpaqueResourceRef(commandVerifier.id),
      deliveryVerifierRef: daytonaOpaqueResourceRef(deliveryVerifier.id),
      snapshotAttestationSha256: attestation.payloadSha256,
      sourceDigest: revision.sourceDigest,
      browserVersion: attestation.payload.validation.chromiumVersion,
      screenshotSha256s: [...(rendered.screenshotSha256s ?? [])],
      networkBlockAllVerified,
      chromiumProofVerified,
      frozenPreviewVerified: true,
    };
  } catch (error) {
    primaryFailure = error;
  }
  const cleanup = await Promise.allSettled([
    ...sessions.map((session) => session.dispose(AbortSignal.timeout(180_000))),
    ...(source ? [source.cleanup()] : []),
  ]);
  const cleanupFailures: unknown[] = [];
  for (const result of cleanup) {
    if (result.status === "rejected") {
      cleanupFailures.push(result.reason as unknown);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      primaryFailure === undefined
        ? cleanupFailures
        : [primaryFailure, ...cleanupFailures],
      "Daytona benchmark teardown did not complete",
    );
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure instanceof Error
      ? primaryFailure
      : new Error("Daytona benchmark proof failed");
  }
  if (!proofResult) {
    throw new Error("Daytona benchmark proof produced no result");
  }
  return proofResult;
}

async function cleanupBenchmarkSnapshots(
  client: Daytona,
  snapshotNames: Set<string>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const snapshotName of [...snapshotNames]) {
    let deleted = false;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < 3 && !deleted; attempt += 1) {
      try {
        const snapshot = await boundedSnapshotCleanupCall(
          "snapshot lookup",
          () => client.snapshot.get(snapshotName),
        );
        await boundedSnapshotCleanupCall("snapshot deletion", () =>
          client.snapshot.delete(snapshot),
        );
        deleted = true;
      } catch (error) {
        if (error instanceof DaytonaNotFoundError) {
          deleted = true;
          break;
        }
        lastFailure = error;
        if (attempt < 2) {
          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, 1_000 * (attempt + 1));
          });
        }
      }
    }
    if (deleted) {
      snapshotNames.delete(snapshotName);
    } else {
      failures.push(lastFailure);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Daytona benchmark snapshot cleanup did not complete",
    );
  }
}

function boundedSnapshotCleanupCall<Value>(
  operation: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Daytona benchmark ${operation} exceeded its deadline`));
    }, 30_000);
    execute().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error("Provider failure"));
      },
    );
  });
}

function benchmarkAssignment(): BuildAssignment {
  const transcript = "Build a deterministic benchmark page.";
  const transcriptSha256 = sha256(transcript);
  const projectId = `benchmark-project-${randomUUID()}`;
  return BuildAssignmentSchema.parse({
    assignmentId: `benchmark-assignment-${randomUUID()}`,
    projectId,
    candidateId: `benchmark-candidate-${randomUUID()}`,
    requestedAt: new Date().toISOString(),
    strategyLabel: "Daytona control-plane benchmark",
    buildPrompt: transcript,
    transcript: {
      content: transcript,
      sha256: transcriptSha256,
    },
    contract: {
      version: 1,
      contractRevision: 1,
      contractId: `benchmark-contract-${randomUUID()}`,
      projectId,
      transcriptSha256,
      approvedAt: new Date().toISOString(),
      approvedFacts: [],
      forbiddenClaims: [],
      requirements: [
        {
          id: "rendered-marker",
          description: "Render the benchmark marker",
          priority: "hard",
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: ["BuildLabs benchmark proof"],
            },
          ],
        },
      ],
      verification: {
        buildCommand: "node --check server.mjs",
        testCommands: ["node --check server.mjs"],
        previewCommand: "node server.mjs",
        previewPort: 4_173,
      },
    },
    sandbox: {
      language: "typescript",
      snapshot: config.DAYTONA_BUILD_SNAPSHOT,
      autoStopMinutes: 10,
      autoArchiveMinutes: 30,
    },
    limits: {
      maxAgentSteps: 1,
      maxRepairRounds: 0,
      wallClockSeconds: 600,
      maxToolOutputBytes: 65_536,
    },
  });
}

async function createBenchmarkSandbox(
  client: Daytona,
  role: "builder" | "verifier-commands" | "verifier-delivery",
  forceCold: boolean,
): Promise<Sandbox> {
  const environment = forceCold
    ? {
        BUILDLABS_BENCHMARK_FORCE_COLD: "true",
      }
    : undefined;
  if (environment) {
    const policy = createDaytonaRoleAcquisitionPolicy({
      role,
      snapshot: config.DAYTONA_BUILD_SNAPSHOT,
      ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
      snapshotResources: attestation.payload.snapshot.resources,
      warmPoolEnabled: true,
    });
    const coldEligibility = evaluateDaytonaWarmPoolEligibility(policy, {
      snapshot: config.DAYTONA_BUILD_SNAPSHOT,
      ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
      envVars: environment,
    });
    if (
      coldEligibility.eligible ||
      coldEligibility.reasonCodes.length !== 1 ||
      coldEligibility.reasonCodes[0] !== "custom_environment"
    ) {
      throw new Error(
        "Daytona benchmark cold request did not uniquely exclude warm-pool matching",
      );
    }
  }
  return client.create(
    {
      snapshot: config.DAYTONA_BUILD_SNAPSHOT,
      ...(environment ? { envVars: environment } : {}),
      labels: {
        "buildlabs.owner": "buildlabs-controller",
        "buildlabs.managed": "true",
        "buildlabs.role": role,
        "buildlabs.purpose": "control-plane-benchmark",
      },
      public: false,
      ephemeral: true,
      autoStopInterval: 10,
      ttlMinutes: 30,
    },
    { timeout: 120 },
  );
}

function assertBenchmarkSandbox(
  sandbox: Sandbox,
  role: "builder" | "verifier-commands" | "verifier-delivery",
  forceCold: boolean,
  preexistingWarmSandboxIds: ReadonlySet<string> = new Set(),
): void {
  const resources = attestation.payload.snapshot.resources;
  if (
    sandbox.snapshot !== config.DAYTONA_BUILD_SNAPSHOT ||
    sandbox.user !== "daytona" ||
    (config.DAYTONA_TARGET !== undefined &&
      sandbox.target !== config.DAYTONA_TARGET) ||
    sandbox.cpu !== resources.cpu ||
    sandbox.memory !== resources.memoryGiB ||
    sandbox.disk !== resources.diskGiB ||
    sandbox.linkedSandboxId != null ||
    sandbox.public !== false ||
    sandbox.autoDeleteInterval !== 0 ||
    sandbox.labels["buildlabs.owner"] !== "buildlabs-controller" ||
    sandbox.labels["buildlabs.managed"] !== "true" ||
    sandbox.labels["buildlabs.role"] !== role ||
    sandbox.labels["buildlabs.purpose"] !== "control-plane-benchmark" ||
    (forceCold &&
      (sandbox.env?.BUILDLABS_BENCHMARK_FORCE_COLD !== "true" ||
        preexistingWarmSandboxIds.has(sandbox.id)))
  ) {
    throw new Error("Daytona benchmark sandbox violated acquisition policy");
  }
}

function isExactWarmPoolSandbox(
  sandbox: DaytonaWarmSandboxObservation,
): boolean {
  const resources = attestation.payload.snapshot.resources;
  return (
    sandbox.snapshot === config.DAYTONA_BUILD_SNAPSHOT &&
    (config.DAYTONA_TARGET === undefined ||
      sandbox.target === config.DAYTONA_TARGET) &&
    sandbox.user === "daytona" &&
    sandbox.cpu === resources.cpu &&
    sandbox.memoryGiB === resources.memoryGiB &&
    sandbox.diskGiB === resources.diskGiB
  );
}

function parseIterations(values: string[]): number {
  if (values.length === 0) {
    return 1;
  }
  if (
    values.length !== 2 ||
    values[0] !== "--iterations" ||
    !/^\d+$/u.test(values[1] ?? "")
  ) {
    throw new Error("Usage: benchmark-daytona.ts [--iterations 1..20]");
  }
  return Number(values[1]);
}
