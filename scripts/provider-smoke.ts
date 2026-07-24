import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { BraintrustTrace } from "../src/adapters/braintrust/braintrust-trace.js";
import { CodeRabbitCli } from "../src/adapters/coderabbit/coderabbit-cli.js";
import { DaytonaSandboxProvider } from "../src/adapters/daytona/daytona-sandbox.js";
import { ElevenLabsSpeechEngine } from "../src/adapters/elevenlabs/elevenlabs-speech-engine.js";
import { FireworksModel } from "../src/adapters/fireworks/fireworks-model.js";
import { loadConfig } from "../src/config.js";
import { BraintrustOrchestrationTrace } from "../src/orchestration/adapters/braintrust/braintrust-orchestration-trace.js";
import { FlyCliDeploymentAdapter } from "../src/orchestration/adapters/build/fly-cli-deployment.js";
import { HttpBuildBackendAdapter } from "../src/orchestration/adapters/build/http-build-backend.js";
import { ResendMailAdapter } from "../src/orchestration/adapters/providers/resend-mail.js";
import { StripePaymentAdapter } from "../src/orchestration/adapters/providers/stripe-payment.js";
import { loadOrchestrationConfig } from "../src/orchestration/runtime/config.js";

interface HealthProvider {
  health(signal?: AbortSignal): Promise<void>;
}

async function main(): Promise<void> {
  if (existsSync(".env")) {
    loadEnvFile(".env");
  }
  const buildConfig = loadConfig();
  const orchestrationConfig = loadOrchestrationConfig();
  const daytona = new DaytonaSandboxProvider(buildConfig);
  let daytonaClosed = true;
  try {
    const providers: Readonly<Record<string, HealthProvider>> = {
      daytona,
      fireworks: new FireworksModel(buildConfig),
      braintrustBuild: new BraintrustTrace(buildConfig),
      braintrustOrchestration: new BraintrustOrchestrationTrace({
        apiKey: orchestrationConfig.BRAINTRUST_API_KEY,
        apiUrl: orchestrationConfig.BRAINTRUST_API_URL,
        appUrl: orchestrationConfig.BRAINTRUST_APP_URL,
        projectName: orchestrationConfig.BRAINTRUST_PROJECT_NAME,
      }),
      coderabbit: new CodeRabbitCli(buildConfig),
      stripe: new StripePaymentAdapter({
        secretKey: orchestrationConfig.STRIPE_SECRET_KEY,
        webhookSecret: orchestrationConfig.STRIPE_WEBHOOK_SECRET,
        successUrl: orchestrationConfig.STRIPE_SUCCESS_URL,
        cancelUrl: orchestrationConfig.STRIPE_CANCEL_URL,
        productName: orchestrationConfig.STRIPE_PRODUCT_NAME,
        expectedLivemode: orchestrationConfig.STRIPE_EXPECTED_LIVEMODE,
        webhookEndpointUrl: providerWebhookUrl(
          orchestrationConfig.ORCHESTRATION_PUBLIC_BASE_URL,
          "stripe",
        ),
      }),
      resend: new ResendMailAdapter({
        apiKey: orchestrationConfig.RESEND_API_KEY,
        webhookSecret: orchestrationConfig.RESEND_WEBHOOK_SECRET,
        sendingDomain: senderDomain(
          orchestrationConfig.ORCHESTRATION_FROM_EMAIL,
        ),
        receivingDomain: orchestrationConfig.ORCHESTRATION_REPLY_DOMAIN,
        webhookEndpointUrl: providerWebhookUrl(
          orchestrationConfig.ORCHESTRATION_PUBLIC_BASE_URL,
          "resend",
        ),
      }),
      buildBackend: new HttpBuildBackendAdapter({
        baseUrl: orchestrationConfig.BUILD_BACKEND_BASE_URL,
        bearerToken: orchestrationConfig.BUILD_BACKEND_INTERNAL_TOKEN,
        requestTimeoutMs: orchestrationConfig.BUILD_BACKEND_REQUEST_TIMEOUT_MS,
        expectedDaytonaSnapshot: orchestrationConfig.DAYTONA_BUILD_SNAPSHOT,
      }),
      fly: new FlyCliDeploymentAdapter({
        accessToken: orchestrationConfig.FLY_ACCESS_TOKEN,
        organizationSlug: orchestrationConfig.FLY_ORG_SLUG,
        appNamePrefix: orchestrationConfig.FLY_APP_NAME_PREFIX,
        primaryRegion: orchestrationConfig.FLY_PRIMARY_REGION,
        executable: orchestrationConfig.FLYCTL_BIN,
        healthPath: orchestrationConfig.FLY_HEALTH_PATH,
      }),
    };
    const results: Array<readonly [string, "healthy" | "unhealthy"]> =
      await Promise.all(
        Object.entries(providers).map(async ([name, provider]) => {
          try {
            await provider.health(AbortSignal.timeout(20_000));
            return [name, "healthy"] as const;
          } catch {
            return [name, "unhealthy"] as const;
          }
        }),
      );
    let elevenLabsStatus: "healthy" | "unhealthy" | "unconfigured" =
      "unconfigured";
    if (
      buildConfig.ELEVENLABS_API_KEY &&
      buildConfig.ELEVENLABS_SPEECH_ENGINE_ID
    ) {
      try {
        await new ElevenLabsSpeechEngine(buildConfig).health(
          AbortSignal.timeout(20_000),
        );
        elevenLabsStatus = "healthy";
      } catch {
        elevenLabsStatus = "unhealthy";
      }
    }
    const statuses = {
      ...Object.fromEntries(results),
      elevenlabs: elevenLabsStatus,
    };
    process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
    if (
      results.some(([, status]) => status !== "healthy") ||
      elevenLabsStatus !== "healthy"
    ) {
      process.exitCode = 1;
    }
  } finally {
    try {
      await daytona.close(AbortSignal.timeout(5_000));
    } catch {
      daytonaClosed = false;
      process.exitCode = 1;
    }
    orchestrationConfig.ORCHESTRATION_ENCRYPTION_KEY_BASE64.fill(0);
    orchestrationConfig.ORCHESTRATION_REPLY_SECRET_BASE64.fill(0);
    if (!daytonaClosed) {
      process.stderr.write("Daytona provider cleanup failed\n");
    }
  }
}

function providerWebhookUrl(
  publicBaseUrl: string,
  provider: "resend" | "stripe",
): string {
  const url = new URL(publicBaseUrl);
  url.pathname = `${url.pathname.replace(/\/?$/, "/")}v1/orchestration/webhooks/${provider}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function senderDomain(sender: string): string {
  const displayAddress = /<([^<>]+)>$/.exec(sender);
  const address = displayAddress?.[1] ?? sender;
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1) {
    throw new Error("Orchestration sender address is invalid");
  }
  return address.slice(separator + 1).toLowerCase();
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Provider smoke check could not start (${errorName(error)})\n`,
  );
  process.exitCode = 1;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
