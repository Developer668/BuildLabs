import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { BraintrustTrace } from "./adapters/braintrust/braintrust-trace.js";
import { CodeRabbitCli } from "./adapters/coderabbit/coderabbit-cli.js";
import { DaytonaSandboxProvider } from "./adapters/daytona/daytona-sandbox.js";
import { ElevenLabsSpeechEngine } from "./adapters/elevenlabs/elevenlabs-speech-engine.js";
import { FilesystemArtifactStore } from "./adapters/filesystem/artifact-store.js";
import { FireworksModel } from "./adapters/fireworks/fireworks-model.js";
import { SqliteRunStore } from "./adapters/sqlite/run-store.js";
import { BuildRunExecutor } from "./application/build-run-executor.js";
import { BuildScheduler } from "./application/build-scheduler.js";
import { recoverInterruptedRunSandboxes } from "./application/run-recovery.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http/server.js";
import { redactValue } from "./lib/redaction.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const store = new SqliteRunStore({
  path: config.BUILDLABS_DATABASE_PATH,
  slotCount: config.BUILDLABS_SLOT_COUNT,
});
const sandboxProvider = new DaytonaSandboxProvider(config);
const artifactStore = new FilesystemArtifactStore(
  config.BUILDLABS_ARTIFACT_DIR,
);
const model = new FireworksModel(config);
const reviewer = new CodeRabbitCli(config);
const trace = new BraintrustTrace(config);
const elevenLabs =
  config.ELEVENLABS_API_KEY && config.ELEVENLABS_SPEECH_ENGINE_ID
    ? new ElevenLabsSpeechEngine(config)
    : undefined;
const executor = new BuildRunExecutor({
  store,
  sandboxProvider,
  artifactStore,
  model,
  reviewer,
  trace,
});
const scheduler = new BuildScheduler(store, executor, {
  leaseMilliseconds: config.BUILDLABS_LEASE_MILLISECONDS,
});
const server = createHttpServer({
  config,
  store,
  scheduler,
  sandboxProvider,
  model,
  reviewer,
  trace,
  ...(elevenLabs ? { elevenLabs } : {}),
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  server.log.info({ signal }, "Stopping build-agent backend");
  try {
    await scheduler.stop();
  } catch (error) {
    server.log.error(
      { error: redactValue(error) },
      "Build scheduler shutdown failed",
    );
  }
  try {
    await server.close();
  } catch (error) {
    server.log.error(
      { error: redactValue(error) },
      "HTTP server shutdown failed",
    );
  }
  try {
    await sandboxProvider.close(AbortSignal.timeout(5_000));
  } catch (error) {
    server.log.error(
      { error: redactValue(error) },
      "Daytona client shutdown failed",
    );
  }
  store.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  const recovery = await recoverInterruptedRunSandboxes(
    store,
    sandboxProvider,
    AbortSignal.timeout(120_000),
  );
  if (recovery.recoveredRunCount > 0) {
    server.log.info(
      {
        recoveredRunCount: recovery.recoveredRunCount,
        deletedSandboxCount: recovery.deletedSandboxCount,
      },
      "Recovered interrupted build runs",
    );
  }
  if (recovery.failedSandboxIds.length > 0) {
    server.log.warn(
      {
        sandboxIds: recovery.failedSandboxIds,
      },
      "Some interrupted Daytona sandboxes could not be deleted",
    );
  }
  await server.listen({ host: config.HOST, port: config.PORT });
  scheduler.start();
} catch (error) {
  server.log.error(
    { error: redactValue(error) },
    "Build-agent backend failed to start",
  );
  await shutdown("startup_failure");
  process.exitCode = 1;
}
