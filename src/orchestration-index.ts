import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { FireworksModel } from "./adapters/fireworks/fireworks-model.js";
import type { AppConfig } from "./config.js";
import type { ModelPort } from "./ports/index.js";
import { BraintrustOrchestrationTrace } from "./orchestration/adapters/braintrust/braintrust-orchestration-trace.js";
import { FlyCliDeploymentAdapter } from "./orchestration/adapters/build/fly-cli-deployment.js";
import { HttpBuildBackendAdapter } from "./orchestration/adapters/build/http-build-backend.js";
import { ConsentedWebsiteResearchAdapter } from "./orchestration/adapters/providers/consented-website-research.js";
import { ResendMailAdapter } from "./orchestration/adapters/providers/resend-mail.js";
import { StripePaymentAdapter } from "./orchestration/adapters/providers/stripe-payment.js";
import { SqliteOrchestrationStore } from "./orchestration/adapters/sqlite/orchestration-store.js";
import { FireworksOrchestrationReasoner } from "./orchestration/application/fireworks-orchestration-reasoner.js";
import { OrchestrationAgent } from "./orchestration/application/orchestration-agent.js";
import { CustomerDashboardAccessCodec } from "./orchestration/application/customer-dashboard-access.js";
import { ReplyAddressCodec } from "./orchestration/application/reply-address.js";
import { ProofSummaryLinkCodec } from "./orchestration/application/proof-summary-links.js";
import { TracedOrchestrationReasoner } from "./orchestration/application/traced-orchestration-reasoner.js";
import type { OrchestrationProjectStore } from "./orchestration/domain/store.js";
import {
  createOrchestrationHttpServer,
  InboundMailRecovery,
  type OrchestrationHttpServerOptions,
  type OrchestrationReadinessResult,
} from "./orchestration/http/index.js";
import type { BuildBackendPort } from "./orchestration/ports/build-backend.js";
import type { FlyDeploymentPort } from "./orchestration/ports/deployment.js";
import type { MailPort } from "./orchestration/ports/mail.js";
import type { PaymentPort } from "./orchestration/ports/payment.js";
import type { OrchestrationTracePort } from "./orchestration/ports/trace.js";
import type { WebsiteResearchPort } from "./orchestration/ports/website-research.js";
import {
  assertOrchestrationNodeVersion,
  loadOrchestrationConfig,
  type OrchestrationConfig,
} from "./orchestration/runtime/config.js";
import { createOrchestrationReadinessProbe } from "./orchestration/runtime/readiness.js";
import {
  ReconciliationWorker,
  type ReconciliationProjectIndex,
} from "./orchestration/runtime/reconciliation-worker.js";

type RuntimeStore = OrchestrationProjectStore & ReconciliationProjectIndex;

export interface OrchestrationReadinessDependencies {
  model: Pick<ModelPort, "health">;
  trace: Pick<OrchestrationTracePort, "health">;
  payment: Pick<PaymentPort, "health">;
  mail: Pick<MailPort, "health">;
  buildBackend: Pick<BuildBackendPort, "health">;
  deployment: Pick<FlyDeploymentPort, "health">;
}

export interface OrchestrationRuntimeFactories {
  createStore(config: OrchestrationConfig): RuntimeStore;
  createModel(config: OrchestrationConfig): ModelPort;
  createTrace(config: OrchestrationConfig): OrchestrationTracePort;
  createPayment(config: OrchestrationConfig): PaymentPort;
  createMail(config: OrchestrationConfig): MailPort;
  createResearch(config: OrchestrationConfig): WebsiteResearchPort;
  createBuildBackend(config: OrchestrationConfig): BuildBackendPort;
  createDeployment(config: OrchestrationConfig): FlyDeploymentPort;
  createReadiness(
    config: OrchestrationConfig,
    index: ReconciliationProjectIndex,
    dependencies: OrchestrationReadinessDependencies,
  ): () => Promise<OrchestrationReadinessResult>;
  createHttpServer(options: OrchestrationHttpServerOptions): FastifyInstance;
}

export interface OrchestrationRuntime {
  server: FastifyInstance;
  worker: ReconciliationWorker;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const defaultFactories: OrchestrationRuntimeFactories = {
  createStore: (config) =>
    new SqliteOrchestrationStore({
      path: config.ORCHESTRATION_DATABASE_PATH,
      encryptionKey: Buffer.from(config.ORCHESTRATION_ENCRYPTION_KEY_BASE64),
    }),
  createModel: (config) => {
    // FireworksModel currently accepts the wider build-runtime AppConfig but
    // reads only these three fields. Keep that mismatch isolated here.
    const fireworksConfig = {
      FIREWORKS_API_KEY: config.FIREWORKS_API_KEY,
      FIREWORKS_BASE_URL: config.FIREWORKS_BASE_URL,
      FIREWORKS_MODEL: config.FIREWORKS_MODEL,
    } as AppConfig;
    return new FireworksModel(fireworksConfig);
  },
  createTrace: (config) =>
    new BraintrustOrchestrationTrace({
      apiKey: config.BRAINTRUST_API_KEY,
      apiUrl: config.BRAINTRUST_API_URL,
      appUrl: config.BRAINTRUST_APP_URL,
      projectName: config.BRAINTRUST_PROJECT_NAME,
    }),
  createPayment: (config) =>
    new StripePaymentAdapter({
      secretKey: config.STRIPE_SECRET_KEY,
      webhookSecret: config.STRIPE_WEBHOOK_SECRET,
      successUrl: config.STRIPE_SUCCESS_URL,
      cancelUrl: config.STRIPE_CANCEL_URL,
      productName: config.STRIPE_PRODUCT_NAME,
      expectedLivemode: config.STRIPE_EXPECTED_LIVEMODE,
      webhookEndpointUrl: providerWebhookUrl(
        config.ORCHESTRATION_PUBLIC_BASE_URL,
        "stripe",
      ),
    }),
  createMail: (config) =>
    new ResendMailAdapter({
      apiKey: config.RESEND_API_KEY,
      webhookSecret: config.RESEND_WEBHOOK_SECRET,
      sendingDomain: senderDomain(config.ORCHESTRATION_FROM_EMAIL),
      receivingDomain: config.ORCHESTRATION_REPLY_DOMAIN,
      webhookEndpointUrl: providerWebhookUrl(
        config.ORCHESTRATION_PUBLIC_BASE_URL,
        "resend",
      ),
    }),
  createResearch: () => new ConsentedWebsiteResearchAdapter(),
  createBuildBackend: (config) =>
    new HttpBuildBackendAdapter({
      baseUrl: config.BUILD_BACKEND_BASE_URL,
      bearerToken: config.BUILD_BACKEND_INTERNAL_TOKEN,
      requestTimeoutMs: config.BUILD_BACKEND_REQUEST_TIMEOUT_MS,
      previewRequestTimeoutMs: config.BUILD_BACKEND_PREVIEW_TIMEOUT_MS,
      artifactRequestTimeoutMs: config.BUILD_BACKEND_ARTIFACT_TIMEOUT_MS,
      expectedDaytonaSnapshot: config.DAYTONA_BUILD_SNAPSHOT,
      ...(config.ORCHESTRATION_ARTIFACT_TEMP_DIRECTORY
        ? {
            artifactTempDirectory: config.ORCHESTRATION_ARTIFACT_TEMP_DIRECTORY,
          }
        : {}),
    }),
  createDeployment: (config) =>
    new FlyCliDeploymentAdapter({
      accessToken: config.FLY_ACCESS_TOKEN,
      organizationSlug: config.FLY_ORG_SLUG,
      appNamePrefix: config.FLY_APP_NAME_PREFIX,
      primaryRegion: config.FLY_PRIMARY_REGION,
      executable: config.FLYCTL_BIN,
      healthPath: config.FLY_HEALTH_PATH,
      operationTimeoutMs: config.FLY_OPERATION_TIMEOUT_MS,
    }),
  createReadiness: (_config, index, dependencies) =>
    createOrchestrationReadinessProbe({
      index,
      ...dependencies,
    }),
  createHttpServer: (options) => createOrchestrationHttpServer(options),
};

export function createOrchestrationRuntime(
  config: OrchestrationConfig,
  factoryOverrides: Partial<OrchestrationRuntimeFactories> = {},
): OrchestrationRuntime {
  const factories = { ...defaultFactories, ...factoryOverrides };
  const store = factories.createStore(config);
  let server: FastifyInstance | undefined;
  try {
    const model = factories.createModel(config);
    const trace = factories.createTrace(config);
    const payment = factories.createPayment(config);
    const mail = factories.createMail(config);
    const research = factories.createResearch(config);
    const build = factories.createBuildBackend(config);
    const deployment = factories.createDeployment(config);
    const replyAddresses = new ReplyAddressCodec({
      domain: config.ORCHESTRATION_REPLY_DOMAIN,
      secret: Buffer.from(config.ORCHESTRATION_REPLY_SECRET_BASE64),
    });
    const proofSummaryLinks = new ProofSummaryLinkCodec({
      publicBaseUrl: config.ORCHESTRATION_PUBLIC_BASE_URL,
      secret: Buffer.from(config.ORCHESTRATION_REPLY_SECRET_BASE64),
    });
    const customerDashboardAccess = new CustomerDashboardAccessCodec({
      publicBaseUrl: config.ORCHESTRATION_PUBLIC_BASE_URL,
      secret: Buffer.from(config.ORCHESTRATION_REPLY_SECRET_BASE64),
    });
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(model),
      trace,
      { flushTimeoutMs: config.ORCHESTRATION_TRACE_FLUSH_TIMEOUT_MS },
    );
    const agent = new OrchestrationAgent({
      store,
      reasoner,
      payment,
      mail,
      research,
      build,
      deployment,
      replyAddresses,
      proofSummaryLinks,
      customerDashboardAccess,
      fromEmail: config.ORCHESTRATION_FROM_EMAIL,
      messageIdDomain: config.ORCHESTRATION_REPLY_DOMAIN,
      expectedStripeLivemode: config.STRIPE_EXPECTED_LIVEMODE,
      sandboxSnapshot: config.DAYTONA_BUILD_SNAPSHOT,
      provenPreviewTtlSeconds: config.ORCHESTRATION_PREVIEW_TTL_SECONDS,
      previewReviewPeriodMs: config.ORCHESTRATION_PREVIEW_REVIEW_PERIOD_MS,
      effectMaxAttempts: config.ORCHESTRATION_EFFECT_MAX_ATTEMPTS,
      effectRetryInitialDelayMs: config.ORCHESTRATION_EFFECT_RETRY_INITIAL_MS,
      effectRetryMaxDelayMs: config.ORCHESTRATION_EFFECT_RETRY_MAX_MS,
      buildDeadlineMs: config.ORCHESTRATION_BUILD_DEADLINE_MS,
      proofEventGracePeriodMs: config.ORCHESTRATION_PROOF_EVENT_GRACE_MS,
      mailDeliveryDeadlineMs: config.ORCHESTRATION_MAIL_DELIVERY_DEADLINE_MS,
    });
    const readiness = factories.createReadiness(config, store, {
      model,
      trace,
      payment,
      mail,
      buildBackend: build,
      deployment,
    });
    const inboundMailRecovery = new InboundMailRecovery({
      store,
      mail,
      controller: agent,
      replyAddresses,
      maxAttempts: config.ORCHESTRATION_EFFECT_MAX_ATTEMPTS,
      retryInitialDelayMs: config.ORCHESTRATION_EFFECT_RETRY_INITIAL_MS,
      retryMaxDelayMs: config.ORCHESTRATION_EFFECT_RETRY_MAX_MS,
    });
    server = factories.createHttpServer({
      controller: agent,
      payment,
      mail,
      inboundMailRecovery,
      securityAudit: store,
      projectEvidence: store,
      customerDashboardStore: store,
      customerDashboardAccess,
      buildObservability: build,
      proofSnapshots: store,
      proofSummaryLinks,
      replyAddresses,
      readiness,
      internalToken: config.ORCHESTRATION_INTERNAL_TOKEN,
      logger: config.NODE_ENV !== "test",
    });
    const worker = new ReconciliationWorker({
      index: store,
      controller: {
        async reconcileProject(projectId, signal) {
          await inboundMailRecovery.recoverProject(projectId, signal);
          return agent.reconcileProject(projectId, signal);
        },
      },
      intervalMilliseconds: config.ORCHESTRATION_RECONCILE_INTERVAL_MS,
      batchSize: config.ORCHESTRATION_RECONCILE_BATCH_SIZE,
      concurrency: config.ORCHESTRATION_RECONCILE_CONCURRENCY,
      projectDeadlineMilliseconds:
        config.ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS,
      onCycle: (result) => {
        if (result.failed > 0) {
          server?.log.warn(
            {
              attempted: result.attempted,
              failed: result.failed,
            },
            "Orchestration reconciliation cycle had project failures",
          );
        }
      },
      onCycleError: (errorName) => {
        server?.log.error(
          { errorName },
          "Orchestration reconciliation cycle failed",
        );
      },
    });

    let started = false;
    let stopPromise: Promise<void> | undefined;
    return {
      server,
      worker,
      async start() {
        if (started) {
          return;
        }
        try {
          await server!.listen({
            host: config.ORCHESTRATION_HOST,
            port: config.ORCHESTRATION_PORT,
          });
        } catch (error) {
          await drainRuntime(
            server!,
            worker,
            store,
            trace,
            config.ORCHESTRATION_SHUTDOWN_TIMEOUT_MS,
          );
          throw error;
        }
        started = true;
        worker.start();
        server!.log.info(
          {
            host: config.ORCHESTRATION_HOST,
            port: config.ORCHESTRATION_PORT,
          },
          "General orchestrator started",
        );
      },
      stop() {
        stopPromise ??= drainRuntime(
          server!,
          worker,
          store,
          trace,
          config.ORCHESTRATION_SHUTDOWN_TIMEOUT_MS,
        );
        return stopPromise;
      },
    };
  } catch (error) {
    void server?.close();
    store.close();
    throw error;
  }
}

async function drainRuntime(
  server: FastifyInstance,
  worker: ReconciliationWorker,
  store: RuntimeStore,
  trace: OrchestrationTracePort,
  timeoutMilliseconds: number,
): Promise<void> {
  const drain = Promise.allSettled([server.close(), worker.stop()])
    .then(() => trace.flush())
    .finally(() => {
      store.close();
    });
  await withTimeout(drain, timeoutMilliseconds);
}

async function withTimeout(
  promise: Promise<void>,
  timeoutMilliseconds: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Orchestration shutdown deadline exceeded"));
    }, timeoutMilliseconds);
    timer.unref();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
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

async function main(): Promise<void> {
  assertOrchestrationNodeVersion();
  if (existsSync(".env")) {
    loadEnvFile(".env");
  }
  const config = loadOrchestrationConfig();
  const runtime = createOrchestrationRuntime(config);
  config.ORCHESTRATION_ENCRYPTION_KEY_BASE64.fill(0);
  config.ORCHESTRATION_REPLY_SECRET_BASE64.fill(0);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    runtime.server.log.info({ signal }, "Stopping general orchestrator");
    void runtime.stop().catch((error: unknown) => {
      runtime.server.log.error(
        { errorName: errorName(error) },
        "General orchestrator shutdown failed",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await runtime.start();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(
    entry && pathToFileURL(resolve(entry)).href === import.meta.url,
  );
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    // Never print configuration errors: they may include secret-bearing input.
    process.stderr.write(
      `General orchestrator failed to start (${errorName(error)})\n`,
    );
    process.exitCode = 1;
  });
}
