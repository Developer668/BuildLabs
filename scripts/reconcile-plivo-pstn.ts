import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import {
  ElevenLabsSdkSipAdmin,
  PlivoPstnReconciler,
  PlivoRestPstnAdmin,
  plivoBindingsFromEnvironment,
} from "../src/adapters/plivo/plivo-reconciler.js";
import { BUILDLABS_PLIVO_PSTN_MANIFEST } from "../src/adapters/plivo/plivo-manifest.js";

type Arguments = {
  apply: boolean;
  allowNumberRouting: boolean;
  expectedBaseDigest?: string;
};

function parseArguments(values: string[]): Arguments {
  const apply = values.includes("--apply");
  const allowNumberRouting = values.includes("--allow-number-routing");
  const expected = values.find((value) =>
    value.startsWith("--expected-base-digest="),
  );
  const unexpected = values.filter(
    (value) =>
      value !== "--apply" &&
      value !== "--allow-number-routing" &&
      !value.startsWith("--expected-base-digest="),
  );
  if (
    unexpected.length > 0 ||
    values.filter((value) => value === "--apply").length > 1 ||
    values.filter((value) => value === "--allow-number-routing").length > 1 ||
    values.filter((value) => value.startsWith("--expected-base-digest="))
      .length > 1
  ) {
    throw new Error("UnknownOrDuplicateArgument");
  }
  const expectedBaseDigest = expected?.slice("--expected-base-digest=".length);
  if (apply && !expectedBaseDigest) {
    throw new Error("ExpectedBaseDigestRequired");
  }
  if (!apply && (expectedBaseDigest || allowNumberRouting)) {
    throw new Error("ApplyRequiredForMutationArguments");
  }
  return {
    apply,
    allowNumberRouting,
    ...(expectedBaseDigest ? { expectedBaseDigest } : {}),
  };
}

async function main() {
  if (existsSync(".env")) loadEnvFile(".env");
  const options = parseArguments(process.argv.slice(2));
  const manifest = BUILDLABS_PLIVO_PSTN_MANIFEST;
  const requiredConfiguration = [
    manifest.plivo.authIdEnvironmentVariable,
    manifest.plivo.authTokenEnvironmentVariable,
    manifest.plivo.numberEnvironmentVariable,
    manifest.plivo.reconciliationSecretEnvironmentVariable,
    manifest.elevenLabs.apiKeyEnvironmentVariable,
    manifest.elevenLabs.agentIdEnvironmentVariable,
    manifest.elevenLabs.branchIdEnvironmentVariable,
    manifest.elevenLabs.versionIdEnvironmentVariable,
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
          testNumberRoutingMutation: false,
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

  const bindings = plivoBindingsFromEnvironment();
  const reconciler = new PlivoPstnReconciler(
    new PlivoRestPstnAdmin(bindings.plivoAuthId, bindings.plivoAuthToken),
    new ElevenLabsSdkSipAdmin(bindings.elevenLabsApiKey),
  );
  const result =
    options.apply && options.expectedBaseDigest
      ? await reconciler.apply(bindings, options.expectedBaseDigest, {
          allowNumberRouting: options.allowNumberRouting,
        })
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
