import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import { BUILDLABS_ELEVENLABS_AGENT_MANIFEST } from "../src/adapters/elevenlabs/agent-manifest.js";
import {
  ElevenLabsAgentReconciler,
  ElevenLabsSdkAgentAdmin,
  bindingsFromEnvironment,
} from "../src/adapters/elevenlabs/agent-reconciler.js";
import { digestJson } from "../src/lib/canonical-json.js";

const TEST_PREFIX = "BuildLabs Voice / ";
const POLL_INTERVAL_MS = 2_000;
const INVOCATION_TIMEOUT_MS = 180_000;

type TestSummary = {
  id: string;
  name: string;
};

function environmentValue(name: string) {
  const value = process.env[name]?.trim() || "";
  if (value.length < 8) {
    const error = new Error(`${name}Unconfigured`);
    error.name = `${name}Unconfigured`;
    throw error;
  }
  return value;
}

async function listManagedTests(client: ElevenLabsClient) {
  const results: TestSummary[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.conversationalAi.tests.list({
      pageSize: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const test of response.tests) {
      if (test.name.startsWith(TEST_PREFIX)) {
        results.push({ id: test.id, name: test.name });
      }
    }
    cursor = response.hasMore ? response.nextCursor : undefined;
  } while (cursor);
  return results;
}

function testManifestByProviderName() {
  return new Map(
    BUILDLABS_ELEVENLABS_AGENT_MANIFEST.tests.map((test) => [
      `${TEST_PREFIX}${test.key}`,
      test,
    ]),
  );
}

async function waitForInvocation(
  client: ElevenLabsClient,
  invocationId: string,
  expectedAgentId: string,
  expectedBranchId: string,
  expectedTests: ReadonlySet<string>,
  expectedTrialCount: number,
) {
  const deadline = Date.now() + INVOCATION_TIMEOUT_MS;
  while (true) {
    const invocation =
      await client.conversationalAi.tests.invocations.get(invocationId);
    if (
      invocation.agentId !== expectedAgentId ||
      invocation.branchId !== expectedBranchId
    ) {
      throw new Error("TestInvocationBranchMismatch");
    }
    if (invocation.bucketingStatus === "failed") {
      throw new Error("TestInvocationBucketingFailed");
    }
    const pending = invocation.testRuns.some(
      (testRun) => testRun.status === "pending",
    );
    const bucketingPending = invocation.bucketingStatus === "pending";
    if (!pending && !bucketingPending) {
      if (
        invocation.testRuns.length !== expectedTrialCount ||
        invocation.testRuns.some(
          (run) =>
            run.agentId !== expectedAgentId ||
            run.branchId !== expectedBranchId ||
            run.environment !== "testing" ||
            !expectedTests.has(run.testId) ||
            (run.status !== "passed" && run.status !== "failed"),
        )
      ) {
        throw new Error("TestInvocationIncomplete");
      }
      return invocation;
    }
    if (Date.now() >= deadline) throw new Error("TestInvocationTimeout");
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function main() {
  if (existsSync(".env")) loadEnvFile(".env");
  const manifest = BUILDLABS_ELEVENLABS_AGENT_MANIFEST;
  const requiredConfiguration = [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_BRANCH_ID",
    "ELEVENLABS_AGENT_VERSION_ID",
    manifest.agent.idEnvironmentVariable,
    manifest.audio.voiceIdEnvironmentVariable,
    manifest.customLlm.publicBaseUrlEnvironmentVariable,
    manifest.customLlm.providerSecretIdEnvironmentVariable,
    manifest.toolSecurity.providerBearerSecretIdEnvironmentVariable,
    manifest.webhook.providerWebhookIdEnvironmentVariable,
  ];
  const missingConfiguration = requiredConfiguration
    .filter((name) => !(process.env[name]?.trim() || ""))
    .sort();
  if (missingConfiguration.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "unconfigured",
          missingCount: missingConfiguration.length,
          missingConfiguration,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }
  const apiKey = environmentValue("ELEVENLABS_API_KEY");
  const agentId = environmentValue("ELEVENLABS_AGENT_ID");
  const branchId = environmentValue("ELEVENLABS_BRANCH_ID");
  const versionId = environmentValue("ELEVENLABS_AGENT_VERSION_ID");
  const client = new ElevenLabsClient({
    apiKey,
    timeoutInSeconds: 20,
    maxRetries: 0,
  });

  const reconciliation = await new ElevenLabsAgentReconciler(
    new ElevenLabsSdkAgentAdmin(apiKey),
  ).plan(bindingsFromEnvironment());
  if (
    reconciliation.status !== "configured" ||
    reconciliation.branchId !== branchId ||
    reconciliation.expectedBaseVersion !== versionId ||
    reconciliation.changes.some((change) => change.action !== "none")
  ) {
    throw new Error("ManagedConfigurationDrift");
  }

  const branch = await client.conversationalAi.agents.branches.get(
    agentId,
    branchId,
  );
  if (
    branch.name !==
      BUILDLABS_ELEVENLABS_AGENT_MANIFEST.versioning.developmentBranch ||
    branch.isArchived ||
    (branch.currentLivePercentage ?? 0) !== 0
  ) {
    throw new Error("UnsafeTestDeployment");
  }

  const branchAgent = await client.conversationalAi.agents.get(agentId, {
    branchId,
  });
  if (
    branchAgent.versionId !== versionId ||
    branchAgent.branchId !== branchId
  ) {
    throw new Error("AgentVersionFenceMismatch");
  }

  const providerTests = await listManagedTests(client);
  const manifestTests = testManifestByProviderName();
  if (
    providerTests.length !== manifestTests.size ||
    providerTests.some((test) => !manifestTests.has(test.name))
  ) {
    throw new Error("ManagedTestSetDrift");
  }

  const byRepeat = new Map<number, TestSummary[]>();
  for (const test of providerTests) {
    const repeat = manifestTests.get(test.name)!.repeatCount;
    byRepeat.set(repeat, [...(byRepeat.get(repeat) ?? []), test]);
  }

  const completed = [];
  for (const [repeatCount, tests] of [...byRepeat].sort(
    ([left], [right]) => left - right,
  )) {
    const invocation = await client.conversationalAi.agents.runTests(agentId, {
      branchId,
      repeatCount,
      tests: tests
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((test) => ({ testId: test.id })),
    });
    completed.push(
      await waitForInvocation(
        client,
        invocation.id,
        agentId,
        branchId,
        new Set(tests.map((test) => test.id)),
        tests.length * repeatCount,
      ),
    );
  }

  const clusterResults = new Map<
    string,
    { passed: number; failed: number; testIds: Set<string>; runIds: string[] }
  >();
  for (const invocation of completed) {
    for (const run of invocation.testRuns) {
      const providerTest = providerTests.find((test) => test.id === run.testId);
      const manifest = providerTest
        ? manifestTests.get(providerTest.name)
        : undefined;
      if (!manifest) throw new Error("UnknownTestRun");
      const cluster = clusterResults.get(manifest.cluster) ?? {
        passed: 0,
        failed: 0,
        testIds: new Set<string>(),
        runIds: [],
      };
      cluster.testIds.add(run.testId);
      cluster.runIds.push(run.testRunId);
      if (run.status === "passed") cluster.passed += 1;
      else cluster.failed += 1;
      clusterResults.set(manifest.cluster, cluster);
    }
  }

  const clusters = [...clusterResults]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cluster, result]) => {
      const total = result.passed + result.failed;
      return {
        cluster,
        tests: result.testIds.size,
        trials: total,
        passed: result.passed,
        failed: result.failed,
        score:
          total === 0 ? 0 : Math.round((result.passed / total) * 1_000) / 1_000,
        resultDigest: digestJson({
          testIds: [...result.testIds].sort(),
          runIds: result.runIds.sort(),
          passed: result.passed,
          failed: result.failed,
        }),
      };
    });
  const failed = clusters.reduce((sum, cluster) => sum + cluster.failed, 0);
  const expectedTrials = providerTests.reduce(
    (sum, test) => sum + manifestTests.get(test.name)!.repeatCount,
    0,
  );
  const trialCount = clusters.reduce((sum, cluster) => sum + cluster.trials, 0);
  if (trialCount !== expectedTrials) {
    throw new Error("ManagedTrialSetIncomplete");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: failed === 0 ? "simulation_verified" : "simulation_failed",
        agentId,
        branchId,
        versionId,
        invocationIds: completed.map((invocation) => invocation.id).sort(),
        testCount: providerTests.length,
        trialCount,
        clusters,
      },
      null,
      2,
    )}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
  process.exitCode = 1;
}
