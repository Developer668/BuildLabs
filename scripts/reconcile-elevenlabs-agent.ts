import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import {
  ElevenLabsAgentReconciler,
  ElevenLabsSdkAgentAdmin,
  bindingsFromEnvironment,
} from "../src/adapters/elevenlabs/agent-reconciler.js";
import { BUILDLABS_ELEVENLABS_AGENT_MANIFEST } from "../src/adapters/elevenlabs/agent-manifest.js";

type Arguments = {
  apply: boolean;
  expectedBaseVersion?: string;
};

function parseArguments(values: string[]): Arguments {
  const apply = values.includes("--apply");
  const expected = values.find((value) =>
    value.startsWith("--expected-base-version="),
  );
  const unexpected = values.filter(
    (value) =>
      value !== "--apply" && !value.startsWith("--expected-base-version="),
  );
  if (unexpected.length > 0) {
    throw new Error("UnknownArgument");
  }
  const expectedBaseVersion = expected?.slice(
    "--expected-base-version=".length,
  );
  if (apply && !expectedBaseVersion) {
    throw new Error("ExpectedBaseVersionRequired");
  }
  if (!apply && expectedBaseVersion) {
    throw new Error("ExpectedBaseVersionRequiresApply");
  }
  return {
    apply,
    ...(expectedBaseVersion ? { expectedBaseVersion } : {}),
  };
}

async function main() {
  if (existsSync(".env")) loadEnvFile(".env");
  const options = parseArguments(process.argv.slice(2));
  const manifest = BUILDLABS_ELEVENLABS_AGENT_MANIFEST;
  const requiredConfiguration = [
    "ELEVENLABS_API_KEY",
    manifest.agent.idEnvironmentVariable,
    manifest.audio.voiceIdEnvironmentVariable,
    manifest.customLlm.publicBaseUrlEnvironmentVariable,
    manifest.customLlm.providerSecretIdEnvironmentVariable,
    manifest.toolSecurity.providerBearerSecretIdEnvironmentVariable,
    manifest.telephony.initializationWebhook
      .providerSecretIdEnvironmentVariable,
    manifest.webhook.providerWebhookIdEnvironmentVariable,
  ];
  const missingConfiguration = requiredConfiguration
    .filter((name) => !(process.env[name]?.trim() || ""))
    .sort();
  if (missingConfiguration.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: options.apply ? "apply" : "plan",
          status: "unconfigured",
          missingCount: missingConfiguration.length,
          missingConfiguration,
          productionTrafficMutation: false,
          irreversibleAccountMutation: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || "";
  if (apiKey.length < 20) throw new Error("ElevenLabsApiKeyInvalid");

  const bindings = bindingsFromEnvironment();
  const reconciler = new ElevenLabsAgentReconciler(
    new ElevenLabsSdkAgentAdmin(apiKey),
  );
  const result =
    options.apply && options.expectedBaseVersion
      ? await reconciler.apply(bindings, options.expectedBaseVersion)
      : await reconciler.plan(bindings);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.mode === "plan" && result.status === "drifted") {
    process.exitCode = 2;
  }
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
