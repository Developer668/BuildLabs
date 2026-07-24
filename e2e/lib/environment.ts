import { createHash } from "node:crypto";

/**
 * Deterministic, obviously-fake credentials. Nothing here is a real secret and
 * nothing here reaches a real provider: every outbound HTTPS request from a
 * spawned service is tunnelled to the local stub.
 */
export const JOURNEY_SECRETS = {
  buildBackendToken: "buildlabs-journey-build-backend-token-a1",
  orchestrationToken: "buildlabs-journey-orchestration-token-b2",
  dashboardAliasSecret: "buildlabs-journey-dashboard-alias-secret-c3",
  operatorToken: "buildlabs-journey-operator-token",
  stripeSecretKey: "sk_test_buildlabsjourneystub0000000000",
  stripeWebhookSecret: "whsec_buildlabsjourneystripe000000000",
  resendApiKey: "re_buildlabs_journey_stub_key_0001",
  resendWebhookSecret: `whsec_${base64Secret("resend-webhook")}`,
  fireworksApiKey: "fw_buildlabs_journey_stub_key_0001",
  braintrustApiKey: "bt_buildlabs_journey_stub_key_0001",
  daytonaApiKey: "dt_buildlabs_journey_stub_key_0001",
  flyAccessToken: "fly_buildlabs_journey_stub_token_0001",
  elevenLabsApiKey: "sk_buildlabs_journey_stub_elevenlabs_0001",
  elevenLabsWebhookSecret: "wsec_buildlabs_journey_elevenlabs_0001",
  elevenLabsCapabilitySecret: "buildlabs-journey-elevenlabs-capability-01",
  elevenLabsToolSecret: "buildlabs-journey-elevenlabs-tool-secret-01",
  elevenLabsCustomLlmSecret: "buildlabs-journey-elevenlabs-custom-llm-01",
  voiceSessionSecret: "buildlabs-journey-voice-session-secret-0001",
  encryptionKeyBase64: base64Secret("state-encryption"),
  replySecretBase64: base64Secret("reply-address"),
} as const;

export const JOURNEY_HOSTS = {
  dashboard: "dashboard.journey.buildlabs.test",
  orchestrator: "orchestrator.journey.buildlabs.test",
  sendingDomain: "journey.buildlabs.test",
  replyDomain: "reply.journey.buildlabs.test",
} as const;

export const JOURNEY_ELEVENLABS = {
  agentId: "agent_journeystub0000000000000001",
  branchId: "agtbrch_journeystub00000000000001",
  agentVersionId: "agtvrsn_journeystub00000000000001",
} as const;

export interface ServiceEndpoints {
  buildBackendPort: number;
  orchestratorPort: number;
  dashboardPort: number;
  voicePort: number;
}

export interface StubWiring {
  proxyPort: number;
  certificatePath: string;
}

function proxyEnvironment(stub: StubWiring | undefined): NodeJS.ProcessEnv {
  if (!stub) {
    return {};
  }
  const proxyUrl = `http://127.0.0.1:${String(stub.proxyPort)}`;
  return {
    // Node 24+ routes both `fetch` and `node:https` through the env proxy, so
    // providers whose SDK base URL is hard-coded (Stripe, Resend, ElevenLabs)
    // are intercepted without touching product source.
    NODE_OPTIONS: "--use-env-proxy",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    NODE_EXTRA_CA_CERTS: stub.certificatePath,
  };
}

export function buildBackendEnvironment(input: {
  endpoints: ServiceEndpoints;
  runDirectory: string;
  stub?: StubWiring;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(input.endpoints.buildBackendPort),
    BUILDLABS_DATABASE_PATH: `${input.runDirectory}/build-agent.db`,
    BUILDLABS_ARTIFACT_DIR: `${input.runDirectory}/artifacts`,
    BUILDLABS_INTERNAL_TOKEN: JOURNEY_SECRETS.buildBackendToken,
    BUILDLABS_SLOT_COUNT: "1",
    DAYTONA_API_KEY: JOURNEY_SECRETS.daytonaApiKey,
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_SNAPSHOT_ATTESTATION_PATH: `${input.runDirectory}/daytona-attestation.json`,
    DAYTONA_TELEMETRY_PATH: `${input.runDirectory}/daytona-telemetry.jsonl`,
    FIREWORKS_API_KEY: JOURNEY_SECRETS.fireworksApiKey,
    FIREWORKS_BASE_URL: "https://api.fireworks.ai/inference/v1",
    BRAINTRUST_API_KEY: JOURNEY_SECRETS.braintrustApiKey,
    BRAINTRUST_API_URL: "https://api.braintrust.dev",
    BRAINTRUST_APP_URL: "https://www.braintrust.dev",
    CODERABBIT_AUTH_MODE: "preauthenticated",
    CODERABBIT_AUTH_HOME: `${input.runDirectory}/coderabbit-home`,
    ...proxyEnvironment(input.stub),
  };
}

export function orchestratorEnvironment(input: {
  endpoints: ServiceEndpoints;
  runDirectory: string;
  stub?: StubWiring;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    ORCHESTRATION_HOST: "127.0.0.1",
    ORCHESTRATION_PORT: String(input.endpoints.orchestratorPort),
    ORCHESTRATION_DATABASE_PATH: `${input.runDirectory}/orchestration.db`,
    ORCHESTRATION_ENCRYPTION_KEY_BASE64: JOURNEY_SECRETS.encryptionKeyBase64,
    ORCHESTRATION_REPLY_SECRET_BASE64: JOURNEY_SECRETS.replySecretBase64,
    ORCHESTRATION_INTERNAL_TOKEN: JOURNEY_SECRETS.orchestrationToken,
    ORCHESTRATION_REPLY_DOMAIN: JOURNEY_HOSTS.replyDomain,
    ORCHESTRATION_FROM_EMAIL: `BuildLabs <builds@${JOURNEY_HOSTS.sendingDomain}>`,
    ORCHESTRATION_PUBLIC_BASE_URL: `https://${JOURNEY_HOSTS.orchestrator}`,
    // The regression guard for the dead-end login link: mail must point at the
    // dashboard origin, which is the only origin serving /dashboard/projects.
    ORCHESTRATION_DASHBOARD_BASE_URL: `https://${JOURNEY_HOSTS.dashboard}`,
    ORCHESTRATION_RECONCILE_INTERVAL_MS: "1000",
    ORCHESTRATION_EFFECT_RETRY_INITIAL_MS: "200",
    ORCHESTRATION_EFFECT_RETRY_MAX_MS: "2000",
    ORCHESTRATION_ARTIFACT_TEMP_DIRECTORY: `${input.runDirectory}/artifact-temp`,
    FIREWORKS_API_KEY: JOURNEY_SECRETS.fireworksApiKey,
    FIREWORKS_BASE_URL: "https://api.fireworks.ai/inference/v1",
    BRAINTRUST_API_KEY: JOURNEY_SECRETS.braintrustApiKey,
    BRAINTRUST_API_URL: "https://api.braintrust.dev",
    BRAINTRUST_APP_URL: "https://www.braintrust.dev",
    STRIPE_SECRET_KEY: JOURNEY_SECRETS.stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: JOURNEY_SECRETS.stripeWebhookSecret,
    STRIPE_SUCCESS_URL: `https://${JOURNEY_HOSTS.sendingDomain}/checkout/paid`,
    STRIPE_CANCEL_URL: `https://${JOURNEY_HOSTS.sendingDomain}/checkout/cancelled`,
    STRIPE_EXPECTED_LIVEMODE: "false",
    RESEND_API_KEY: JOURNEY_SECRETS.resendApiKey,
    RESEND_WEBHOOK_SECRET: JOURNEY_SECRETS.resendWebhookSecret,
    BUILD_BACKEND_BASE_URL: `http://127.0.0.1:${String(input.endpoints.buildBackendPort)}`,
    BUILD_BACKEND_INTERNAL_TOKEN: JOURNEY_SECRETS.buildBackendToken,
    FLY_ACCESS_TOKEN: JOURNEY_SECRETS.flyAccessToken,
    FLY_ORG_SLUG: "buildlabs-journey",
    FLY_PRIMARY_REGION: "sjc",
    ...proxyEnvironment(input.stub),
  };
}

export function dashboardEnvironment(input: {
  endpoints: ServiceEndpoints;
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    COPILOTKIT_TELEMETRY_DISABLED: "true",
    BUILDLABS_ORCHESTRATION_URL: `http://127.0.0.1:${String(input.endpoints.orchestratorPort)}`,
    BUILDLABS_DASHBOARD_ALIAS_SECRET: JOURNEY_SECRETS.dashboardAliasSecret,
    BUILDLABS_OPERATOR_TOKEN: JOURNEY_SECRETS.operatorToken,
    BUILDLABS_INTERNAL_TOKEN: JOURNEY_SECRETS.orchestrationToken,
  };
}

export function voiceIntakeEnvironment(input: {
  endpoints: ServiceEndpoints;
  stub?: StubWiring;
}): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${String(input.endpoints.voicePort)}`;
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    ELEVENLABS_API_KEY: JOURNEY_SECRETS.elevenLabsApiKey,
    ELEVENLABS_AGENT_ID: JOURNEY_ELEVENLABS.agentId,
    ELEVENLABS_BRANCH_ID: JOURNEY_ELEVENLABS.branchId,
    ELEVENLABS_AGENT_VERSION_ID: JOURNEY_ELEVENLABS.agentVersionId,
    ELEVENLABS_CAPABILITY_SECRET: JOURNEY_SECRETS.elevenLabsCapabilitySecret,
    ELEVENLABS_TOOL_SECRET: JOURNEY_SECRETS.elevenLabsToolSecret,
    ELEVENLABS_CUSTOM_LLM_SECRET: JOURNEY_SECRETS.elevenLabsCustomLlmSecret,
    ELEVENLABS_WEBHOOK_SECRET: JOURNEY_SECRETS.elevenLabsWebhookSecret,
    VOICE_SESSION_SECRET: JOURNEY_SECRETS.voiceSessionSecret,
    VOICE_INTAKE_ALLOWED_ORIGINS: origin,
    FIREWORKS_API_KEY: JOURNEY_SECRETS.fireworksApiKey,
    FIREWORKS_VOICE_MODEL: "accounts/fireworks/models/kimi-k2p6",
    ORCHESTRATION_INTERNAL_TOKEN: JOURNEY_SECRETS.orchestrationToken,
    BUILDLABS_ORCHESTRATION_URL: `http://127.0.0.1:${String(input.endpoints.orchestratorPort)}`,
    ...proxyEnvironment(input.stub),
  };
}

function base64Secret(label: string): string {
  return createHash("sha256")
    .update(`buildlabs-journey-e2e:${label}`, "utf8")
    .digest()
    .toString("base64");
}
