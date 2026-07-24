import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

import { PlivoRestPstnAdmin } from "../src/adapters/plivo/plivo-reconciler.js";

function configured(name: string) {
  return process.env[name]?.trim() || "";
}

function keyedNumberDigest(number: string, secret: string) {
  return createHmac("sha256", secret)
    .update("buildlabs:plivo-probe:number:v1:")
    .update(number)
    .digest("hex");
}

async function main() {
  if (existsSync(".env")) loadEnvFile(".env");
  const authId = configured("PLIVO_AUTH_ID");
  const authToken = configured("PLIVO_AUTH_TOKEN");
  const apiKey = configured("ELEVENLABS_API_KEY");
  const targetNumber = configured("PLIVO_BUILDLABS_NUMBER");
  const reconciliationSecret = configured("PLIVO_RECONCILIATION_SECRET");
  const missingConfiguration = [
    ["PLIVO_AUTH_ID", authId],
    ["PLIVO_AUTH_TOKEN", authToken],
    ["ELEVENLABS_API_KEY", apiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .sort();
  if (missingConfiguration.length > 0) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "unconfigured",
          missingCount: missingConfiguration.length,
          missingConfiguration,
          healthy: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }

  const plivo = new PlivoRestPstnAdmin(authId, authToken);
  const elevenLabs = new ElevenLabsClient({
    apiKey,
    timeoutInSeconds: 20,
  });
  const uris = await plivo.listOriginationUris();
  const trunks = await plivo.listTrunks();
  const numbers = await plivo.listAccountNumbers();
  const phones = await elevenLabs.conversationalAi.phoneNumbers.list({
    provider: "sip_trunk",
  });
  const agents = await elevenLabs.conversationalAi.agents.list({
    pageSize: 100,
  });
  const target =
    targetNumber && /^\+[1-9][0-9]{7,14}$/u.test(targetNumber)
      ? ((await plivo.getAccountNumber(targetNumber)) as Record<
          string,
          unknown
        >)
      : null;
  const targetStatus =
    !targetNumber || !reconciliationSecret
      ? "unconfigured"
      : target?.active !== true || target?.voice_enabled !== true
        ? "unavailable"
        : target.application === null
          ? "available"
          : "in_use";

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "healthy",
        healthy: true,
        plivo: {
          uriCount: uris.length,
          trunkCount: trunks.length,
          numberCount: numbers.length,
          targetNumberStatus: targetStatus,
          ...(targetNumber && reconciliationSecret
            ? {
                targetNumberDigest: keyedNumberDigest(
                  targetNumber,
                  reconciliationSecret,
                ),
              }
            : {}),
        },
        elevenLabs: {
          agentCount: agents.agents.length,
          sipPhoneNumberCount: phones.length,
        },
        configuredForReconciliation:
          targetStatus !== "unconfigured" &&
          Boolean(configured("ELEVENLABS_AGENT_ID")) &&
          Boolean(configured("ELEVENLABS_BRANCH_ID")) &&
          Boolean(configured("ELEVENLABS_AGENT_VERSION_ID")),
        pstnCallVerified: false,
        webhookVerified: false,
        orchestrationE2eVerified: false,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      status: "failed",
      healthy: false,
      error: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
  process.exitCode = 1;
}
