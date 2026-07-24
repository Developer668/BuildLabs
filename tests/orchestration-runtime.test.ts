import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createOrchestrationRuntime,
  type OrchestrationRuntimeFactories,
} from "../src/orchestration-index.js";
import { SqliteOrchestrationStore } from "../src/orchestration/adapters/sqlite/orchestration-store.js";
import type { ProjectLifecycleStatus } from "../src/orchestration/domain/project.js";
import {
  assertOrchestrationNodeVersion,
  loadOrchestrationConfig,
} from "../src/orchestration/runtime/config.js";
import { createOrchestrationReadinessProbe } from "../src/orchestration/runtime/readiness.js";
import { ReconciliationWorker } from "../src/orchestration/runtime/reconciliation-worker.js";
import { sha256 } from "../src/lib/canonical-json.js";
import { loadConfig } from "../src/config.js";

describe("orchestration runtime configuration", () => {
  it("decodes independent key material and validates bounded settings", () => {
    const config = loadOrchestrationConfig(validEnvironment());

    expect(config.ORCHESTRATION_ENCRYPTION_KEY_BASE64).toEqual(
      Buffer.alloc(32, 1),
    );
    expect(config.ORCHESTRATION_REPLY_SECRET_BASE64).toEqual(
      Buffer.alloc(32, 2),
    );
    expect(config.STRIPE_EXPECTED_LIVEMODE).toBe(false);
    expect(config.ORCHESTRATION_PORT).toBe(3100);
    expect(config.ORCHESTRATION_EFFECT_MAX_ATTEMPTS).toBe(5);
    expect(config.ORCHESTRATION_EFFECT_RETRY_INITIAL_MS).toBe(1_000);
    expect(config.ORCHESTRATION_EFFECT_RETRY_MAX_MS).toBe(60_000);
    expect(config.ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS).toBe(32 * 60_000);
    expect(config.BUILD_BACKEND_PREVIEW_TIMEOUT_MS).toBe(6 * 60_000);
    expect(config.BUILD_BACKEND_ARTIFACT_TIMEOUT_MS).toBe(10 * 60_000);
    expect(config.FLY_OPERATION_TIMEOUT_MS).toBe(20 * 60_000);
    expect(config.ORCHESTRATION_BUILD_DEADLINE_MS).toBe(2 * 60 * 60 * 1_000);
    expect(config.ORCHESTRATION_PROOF_EVENT_GRACE_MS).toBe(2 * 60 * 1_000);
    expect(config.ORCHESTRATION_MAIL_DELIVERY_DEADLINE_MS).toBe(
      6 * 60 * 60 * 1_000,
    );
    expect(config.FLY_ORG_SLUG).toBe("buildlapse-production");
    expect(config.FLY_PRIMARY_REGION).toBe("sjc");
  });

  it("rejects malformed key material, implicit Stripe mode, and unsafe preview timing", () => {
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_ENCRYPTION_KEY_BASE64: "not-base64",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS: "600000",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS: String(32 * 60_000),
        FLY_OPERATION_TIMEOUT_MS: String(30 * 60_000),
      }),
    ).toThrow();
    const withoutMode = validEnvironment();
    delete withoutMode.STRIPE_EXPECTED_LIVEMODE;
    expect(() => loadOrchestrationConfig(withoutMode)).toThrow();
    const withoutFlyOrganization = validEnvironment();
    delete withoutFlyOrganization.FLY_ORG_SLUG;
    expect(() => loadOrchestrationConfig(withoutFlyOrganization)).toThrow();
    const withoutFlyPrimaryRegion = validEnvironment();
    delete withoutFlyPrimaryRegion.FLY_PRIMARY_REGION;
    expect(() => loadOrchestrationConfig(withoutFlyPrimaryRegion)).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        FLY_PRIMARY_REGION: 'sjc"\n[http_service]',
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_PREVIEW_TTL_SECONDS: "3600",
        ORCHESTRATION_PREVIEW_REVIEW_PERIOD_MS: "3600000",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_EFFECT_RETRY_INITIAL_MS: "5000",
        ORCHESTRATION_EFFECT_RETRY_MAX_MS: "4999",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...validEnvironment(),
        ORCHESTRATION_EFFECT_MAX_ATTEMPTS: "21",
      }),
    ).toThrow();
  });

  it("requires independent secrets and durable production state", () => {
    const environment = validEnvironment();
    expect(() =>
      loadOrchestrationConfig({
        ...environment,
        ORCHESTRATION_REPLY_SECRET_BASE64:
          environment.ORCHESTRATION_ENCRYPTION_KEY_BASE64,
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...environment,
        BUILD_BACKEND_INTERNAL_TOKEN: environment.ORCHESTRATION_INTERNAL_TOKEN,
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...environment,
        NODE_ENV: "production",
        ORCHESTRATION_DATABASE_PATH: ":memory:",
      }),
    ).toThrow();
  });

  it("requires live Stripe and real customer-facing domains in production", () => {
    const production = {
      ...validEnvironment(),
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: "sk_live_real-key-material-for-production",
      STRIPE_EXPECTED_LIVEMODE: "true",
      ORCHESTRATION_REPLY_DOMAIN: "reply.buildlapse.com",
      ORCHESTRATION_FROM_EMAIL: "Buildlapse <projects@buildlapse.com>",
      ORCHESTRATION_PUBLIC_BASE_URL: "https://orchestrator.buildlapse.com",
      STRIPE_SUCCESS_URL: "https://buildlapse.com/payment/success",
      STRIPE_CANCEL_URL: "https://buildlapse.com/payment/cancel",
    };
    expect(() => loadOrchestrationConfig(production)).not.toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...production,
        STRIPE_SECRET_KEY: "sk_test_real-sandbox-key-material",
        STRIPE_EXPECTED_LIVEMODE: "false",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...production,
        ORCHESTRATION_REPLY_DOMAIN: "reply.example.com",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...production,
        STRIPE_SUCCESS_URL: "https://buildlapse.invalid/payment/success",
      }),
    ).toThrow();
    expect(() =>
      loadOrchestrationConfig({
        ...production,
        ORCHESTRATION_PUBLIC_BASE_URL: "https://127.0.0.1",
      }),
    ).toThrow();
  });

  it("requires durable build state and HTTPS provider endpoints", () => {
    const buildEnvironment = {
      NODE_ENV: "production",
      BUILDLAPSE_INTERNAL_TOKEN: "b".repeat(32),
      DAYTONA_API_KEY: "d".repeat(20),
      FIREWORKS_API_KEY: "f".repeat(20),
      BRAINTRUST_API_KEY: "b".repeat(20),
      CODERABBIT_AUTH_MODE: "preauthenticated",
      CODERABBIT_AUTH_HOME: "/secure/coderabbit-auth",
    };
    expect(() =>
      loadConfig({
        ...buildEnvironment,
        BUILDLAPSE_DATABASE_PATH: ":memory:",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...buildEnvironment,
        DAYTONA_API_URL: "http://app.daytona.io/api",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...buildEnvironment,
        FIREWORKS_BASE_URL: "https://credential@example.com/inference/v1",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...buildEnvironment,
        CODERABBIT_AUTH_MODE: "api-key",
      }),
    ).toThrow();
  });

  it("enforces the documented Node 24 minimum", () => {
    expect(() => assertOrchestrationNodeVersion("23.11.0")).toThrow(
      "Node.js 24",
    );
    expect(() => assertOrchestrationNodeVersion("24.0.0")).not.toThrow();
  });
});

describe("reconciliation project index and worker", () => {
  it("lists only eligible opaque IDs with a stable exclusive cursor", () => {
    const store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: Buffer.alloc(32, 9),
    });
    const first = createIndexedProject(store, "deployment_verification_failed");
    createIndexedProject(store, "cancelled");
    const pendingRevision = createIndexedProject(store, "revision_pending");
    const second = createIndexedProject(
      store,
      "deployment_verification_failed",
    );
    const expected = [first, pendingRevision, second].sort();

    const pageOne = store.listProjectIdsForReconciliation(1);
    expect(pageOne).toEqual({
      projectIds: [expected[0]],
      nextAfterProjectId: expected[0],
    });
    expect(
      store.listProjectIdsForReconciliation(1, pageOne.nextAfterProjectId),
    ).toEqual({
      projectIds: [expected[1]],
      nextAfterProjectId: expected[1],
    });
    expect(store.listProjectIdsForReconciliation(10)).toEqual({
      projectIds: expected,
    });
    expect(() => store.listProjectIdsForReconciliation(0)).toThrow();
    store.close();
  });

  it("routes Checkout, proposal-mail, payment-confirmation, and partial-dispatch recovery states", async () => {
    const store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: Buffer.alloc(32, 8),
    });
    const expected = [
      createIndexedProject(store, "proposal_drafting"),
      createIndexedProject(store, "awaiting_payment"),
      createIndexedProject(store, "paid"),
    ].sort();
    const reconciled: string[] = [];
    const worker = new ReconciliationWorker({
      index: store,
      controller: {
        reconcileProject: (projectId) => {
          reconciled.push(projectId);
          return Promise.resolve();
        },
      },
      intervalMilliseconds: 1_000,
      batchSize: 10,
      concurrency: 2,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      attempted: 3,
      succeeded: 3,
      failed: 0,
    });
    expect(reconciled.sort()).toEqual(expected);
    store.close();
  });

  it("bounds concurrency, isolates project failures, and wraps its cursor", async () => {
    let active = 0;
    let maximumActive = 0;
    const reconciled: string[] = [];
    const index = {
      listProjectIdsForReconciliation: vi
        .fn()
        .mockReturnValueOnce({
          projectIds: ["project-a", "project-b", "project-c"],
          nextAfterProjectId: "project-c",
        })
        .mockReturnValueOnce({ projectIds: [] }),
    };
    const worker = new ReconciliationWorker({
      index,
      controller: {
        reconcileProject: async (projectId) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          reconciled.push(projectId);
          if (projectId === "project-b") {
            throw new Error("expected fixture failure");
          }
        },
      },
      intervalMilliseconds: 1_000,
      batchSize: 3,
      concurrency: 2,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      wrapped: false,
    });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(reconciled).toHaveLength(3);
    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      wrapped: true,
    });
    expect(index.listProjectIdsForReconciliation).toHaveBeenLastCalledWith(
      3,
      "project-c",
    );
  });
});

describe("orchestration readiness and composition", () => {
  it("checks every real provider boundary and the database index", async () => {
    const index = {
      listProjectIdsForReconciliation: vi
        .fn()
        .mockReturnValue({ projectIds: [] }),
    };
    const health = {
      model: vi.fn().mockResolvedValue(undefined),
      trace: vi.fn().mockResolvedValue(undefined),
      payment: vi.fn().mockResolvedValue(undefined),
      mail: vi.fn().mockResolvedValue(undefined),
      buildBackend: vi.fn().mockResolvedValue(undefined),
      deployment: vi.fn().mockResolvedValue(undefined),
    };
    const probe = createOrchestrationReadinessProbe({
      index,
      model: { health: health.model },
      trace: { health: health.trace },
      payment: { health: health.payment },
      mail: { health: health.mail },
      buildBackend: { health: health.buildBackend },
      deployment: { health: health.deployment },
      cacheMilliseconds: 0,
    });

    await expect(probe()).resolves.toEqual({
      database: true,
      fireworks: true,
      braintrust: true,
      stripe: true,
      resend: true,
      buildBackend: true,
      fly: true,
    });
    for (const providerHealth of Object.values(health)) {
      expect(providerHealth).toHaveBeenCalledWith(expect.any(AbortSignal));
    }
  });

  it("fails only the provider whose authenticated probe fails", async () => {
    const healthy = { health: vi.fn().mockResolvedValue(undefined) };
    const probe = createOrchestrationReadinessProbe({
      index: {
        listProjectIdsForReconciliation: vi
          .fn()
          .mockReturnValue({ projectIds: [] }),
      },
      model: healthy,
      trace: healthy,
      payment: {
        health: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      },
      mail: healthy,
      buildBackend: healthy,
      deployment: healthy,
      cacheMilliseconds: 0,
    });

    await expect(probe()).resolves.toEqual({
      database: true,
      fireworks: true,
      braintrust: true,
      stripe: false,
      resend: true,
      buildBackend: true,
      fly: true,
    });
  });

  it("composes the standalone server through injectable provider factories", async () => {
    const config = loadOrchestrationConfig({
      ...validEnvironment(),
      NODE_ENV: "test",
      ORCHESTRATION_DATABASE_PATH: ":memory:",
    });
    const calls: string[] = [];
    const traceFlush = vi.fn().mockResolvedValue(undefined);
    const mark = <T>(name: string, value: T): T => {
      calls.push(name);
      return value;
    };
    const runtime = createOrchestrationRuntime(config, {
      createModel: () =>
        mark("model", {
          complete: vi.fn(),
          evaluateContract: vi.fn(),
          health: vi.fn(),
        }),
      createTrace: () =>
        mark("trace", {
          health: vi.fn(),
          run: vi.fn(),
          flush: traceFlush,
        } as ReturnType<OrchestrationRuntimeFactories["createTrace"]>),
      createPayment: () =>
        mark(
          "payment",
          {} as ReturnType<OrchestrationRuntimeFactories["createPayment"]>,
        ),
      createMail: () =>
        mark(
          "mail",
          {} as ReturnType<OrchestrationRuntimeFactories["createMail"]>,
        ),
      createResearch: () =>
        mark(
          "research",
          {} as ReturnType<OrchestrationRuntimeFactories["createResearch"]>,
        ),
      createBuildBackend: () =>
        mark(
          "build",
          {} as ReturnType<OrchestrationRuntimeFactories["createBuildBackend"]>,
        ),
      createDeployment: () =>
        mark(
          "deployment",
          {} as ReturnType<OrchestrationRuntimeFactories["createDeployment"]>,
        ),
      createReadiness: () => {
        calls.push("readiness");
        return () =>
          Promise.resolve({
            database: true,
            fireworks: true,
            braintrust: true,
            stripe: true,
            resend: true,
            buildBackend: true,
            fly: true,
          });
      },
    });

    expect(calls).toEqual([
      "model",
      "trace",
      "payment",
      "mail",
      "research",
      "build",
      "deployment",
      "readiness",
    ]);
    const ready = await runtime.server.inject({
      method: "GET",
      url: "/ready",
      headers: {
        authorization: `Bearer ${config.ORCHESTRATION_INTERNAL_TOKEN}`,
      },
    });
    expect(ready.statusCode).toBe(200);
    await runtime.stop();
    expect(traceFlush).toHaveBeenCalledOnce();
  });
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ORCHESTRATION_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ORCHESTRATION_INTERNAL_TOKEN:
      "orchestration-internal-token-with-32-characters",
    ORCHESTRATION_REPLY_DOMAIN: "reply.buildlapse.example",
    ORCHESTRATION_REPLY_SECRET_BASE64: Buffer.alloc(32, 2).toString("base64"),
    ORCHESTRATION_FROM_EMAIL: "Buildlapse <projects@buildlapse.example>",
    ORCHESTRATION_PUBLIC_BASE_URL: "https://orchestrator.buildlapse.example",
    FIREWORKS_API_KEY: "fireworks-key-with-enough-characters",
    BRAINTRUST_API_KEY: "braintrust-key-with-enough-characters",
    BRAINTRUST_API_URL: "https://api.braintrust.dev",
    BRAINTRUST_APP_URL: "https://www.braintrust.dev",
    BRAINTRUST_PROJECT_NAME: "Buildlapse",
    STRIPE_SECRET_KEY: "sk_test_fixture_with_enough_characters",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture_with_enough_characters",
    STRIPE_SUCCESS_URL: "https://buildlapse.example/payment/success",
    STRIPE_CANCEL_URL: "https://buildlapse.example/payment/cancel",
    STRIPE_EXPECTED_LIVEMODE: "false",
    RESEND_API_KEY: "resend-key-with-enough-characters",
    RESEND_WEBHOOK_SECRET: "resend-webhook-secret-enough-characters",
    BUILD_BACKEND_INTERNAL_TOKEN:
      "build-backend-internal-token-with-enough-characters",
    FLY_ACCESS_TOKEN: "fly-access-token-with-enough-characters",
    FLY_ORG_SLUG: "buildlapse-production",
    FLY_PRIMARY_REGION: "sjc",
  };
}

function createIndexedProject(
  store: SqliteOrchestrationStore,
  status: ProjectLifecycleStatus,
): string {
  const projectId = randomUUID();
  const content = "Build an evidence-grounded site.";
  const created = store.createProject({
    projectId,
    idempotencyKey: `intake:${projectId}`,
    status: "intake_received",
    intake: {
      kind: "text",
      intakeId: `intake:${projectId}`,
      receivedAt: "2026-07-24T07:00:00.000Z",
      content,
      contentDigest: sha256(content),
      piiSpans: [],
      source: {
        provider: "internal",
        providerMessageId: `message:${projectId}`,
        signatureVerified: true,
      },
    },
    customer: {
      profileId: `profile:${projectId}`,
      preferredChannel: "text",
      researchConsent: {
        granted: false,
        scope: "own_business_only",
      },
    },
  }).project;
  const changed = structuredClone(created);
  changed.status = status;
  store.saveProject(changed, created.revision, {
    type: "test.status_changed",
    actor: "system",
    payload: { previousStatus: created.status, status },
  });
  return projectId;
}
