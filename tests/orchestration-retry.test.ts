import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderAdapterError } from "../src/orchestration/adapters/providers/provider-error.js";
import { SqliteOrchestrationStore } from "../src/orchestration/adapters/sqlite/orchestration-store.js";
import {
  OrchestrationAgent,
  type OrchestrationAgentOptions,
} from "../src/orchestration/application/orchestration-agent.js";
import { CustomerDashboardAccessCodec } from "../src/orchestration/application/customer-dashboard-access.js";
import type {
  AnalyzeConversationInput,
  ChangeClassification,
  ClassifyChangeInput,
  ConversationAnalysis,
  DraftProposalInput,
  OrchestrationReasoner,
  ProposalPlan,
} from "../src/orchestration/application/fireworks-orchestration-reasoner.js";
import { ReplyAddressCodec } from "../src/orchestration/application/reply-address.js";
import { ProofSummaryLinkCodec } from "../src/orchestration/application/proof-summary-links.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type { BuildBackendPort } from "../src/orchestration/ports/build-backend.js";
import type { FlyDeploymentPort } from "../src/orchestration/ports/deployment.js";
import type {
  InboundMail,
  MailPort,
  MailWebhookNotification,
  OutboundMailProviderState,
  RawResendWebhook,
  SendMailRequest,
  SentMail,
} from "../src/orchestration/ports/mail.js";
import type {
  CheckoutSession,
  CreateCheckoutSessionRequest,
  PaidCheckoutWebhook,
  PaymentPort,
  RawStripeWebhook,
  VerifiedSettlement,
  VerifySettlementRequest,
} from "../src/orchestration/ports/payment.js";
import type {
  CaptureWebsiteRequest,
  WebsiteResearchCapture,
  WebsiteResearchPort,
} from "../src/orchestration/ports/website-research.js";

const START = "2026-07-24T12:00:00.000Z";
const CONTENT =
  "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.";
const PROJECT_IDS = {
  "retry-exhaustion": "11111111-1111-4111-8111-111111111111",
  "permanent-failure": "22222222-2222-4222-8222-222222222222",
  "retry-success": "33333333-3333-4333-8333-333333333333",
  "attention-reply": "44444444-4444-4444-8444-444444444444",
  "effect-attribution": "55555555-5555-4555-8555-555555555555",
  "aborted-provider-attempt": "66666666-6666-4666-8666-666666666666",
} as const;

describe("durable orchestration effect retry policy", () => {
  let store: SqliteOrchestrationStore;
  let now: Date;

  beforeEach(() => {
    now = new Date(START);
    store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: Buffer.alloc(32, 7),
      now: () => now,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("persists exponential retry attempts, makes no early provider call, and dead-letters after exhaustion", async () => {
    const payment = new FailingCheckoutPayment("PROVIDER_FAILURE");
    const agent = createAgent(store, payment, () => now, {
      effectMaxAttempts: 3,
      effectRetryInitialDelayMs: 1_000,
      effectRetryMaxDelayMs: 10_000,
    });

    await expect(
      agent.acceptIntake(intake("retry-exhaustion")),
    ).rejects.toThrow("PROVIDER_FAILURE");
    const projectId = PROJECT_IDS["retry-exhaustion"];
    let project = store.getProject(projectId)!;
    let effect = project.effects.find(
      (candidate) => candidate.type === "create_checkout_session",
    )!;
    expect(effect).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: "2026-07-24T12:00:01.000Z",
      error: {
        category: "transient",
        retryable: true,
      },
    });
    expect(payment.createCalls).toBe(1);

    await expect(agent.reconcileProject(projectId)).resolves.toMatchObject({
      status: "proposal_drafting",
    });
    expect(payment.createCalls).toBe(1);

    now = new Date("2026-07-24T12:00:01.000Z");
    await expect(agent.reconcileProject(projectId)).rejects.toThrow(
      "PROVIDER_FAILURE",
    );
    project = store.getProject(projectId)!;
    effect = project.effects.find(
      (candidate) => candidate.type === "create_checkout_session",
    )!;
    expect(effect).toMatchObject({
      status: "pending",
      attempts: 2,
      nextAttemptAt: "2026-07-24T12:00:03.000Z",
    });
    expect(payment.createCalls).toBe(2);

    now = new Date("2026-07-24T12:00:02.999Z");
    await agent.reconcileProject(projectId);
    expect(payment.createCalls).toBe(2);

    now = new Date("2026-07-24T12:00:03.000Z");
    await expect(agent.reconcileProject(projectId)).rejects.toThrow(
      "PROVIDER_FAILURE",
    );
    project = store.getProject(projectId)!;
    effect = project.effects.find(
      (candidate) => candidate.type === "create_checkout_session",
    )!;
    expect(project.status).toBe("needs_operator_attention");
    expect(effect).toMatchObject({
      status: "failed",
      attempts: 3,
      error: {
        category: "transient",
        retryable: false,
      },
    });
    expect(effect.nextAttemptAt).toBeUndefined();
    expect(payment.createCalls).toBe(3);

    await agent.reconcileProject(projectId);
    expect(payment.createCalls).toBe(3);
    expect(
      store
        .listEvents(projectId)
        .filter((event) => event.type === "effect.retry_started"),
    ).toHaveLength(2);
    expect(
      store
        .listEvents(projectId)
        .filter((event) => event.type === "effect.dead_lettered"),
    ).toHaveLength(1);
  });

  it("fails a permanent provider/policy error closed without retrying", async () => {
    const payment = new FailingCheckoutPayment("POLICY_BLOCKED");
    const agent = createAgent(store, payment, () => now);

    await expect(
      agent.acceptIntake(intake("permanent-failure")),
    ).rejects.toThrow("POLICY_BLOCKED");

    const project = store.getProject(PROJECT_IDS["permanent-failure"])!;
    const effect = project.effects.find(
      (candidate) => candidate.type === "create_checkout_session",
    )!;
    expect(project.status).toBe("needs_operator_attention");
    expect(effect).toMatchObject({
      status: "failed",
      attempts: 1,
      error: {
        category: "policy",
        retryable: false,
      },
    });
    expect(effect.nextAttemptAt).toBeUndefined();

    now = new Date("2026-07-25T12:00:00.000Z");
    await agent.reconcileProject(project.projectId);
    expect(payment.createCalls).toBe(1);
  });

  it("reuses the stable provider idempotency key when a due retry succeeds", async () => {
    const payment = new FailingCheckoutPayment("PROVIDER_FAILURE", 1);
    const mail = new RecordingMail();
    const agent = createAgent(store, payment, () => now, {}, mail);

    await expect(agent.acceptIntake(intake("retry-success"))).rejects.toThrow(
      "PROVIDER_FAILURE",
    );
    expect(payment.idempotencyKeys).toHaveLength(1);

    now = new Date("2026-07-24T12:00:01.000Z");
    const recovered = await agent.reconcileProject(
      PROJECT_IDS["retry-success"],
    );

    expect(recovered.status).toBe("awaiting_payment");
    expect(payment.idempotencyKeys).toHaveLength(2);
    expect(new Set(payment.idempotencyKeys).size).toBe(1);
    const recoveredEffect = recovered.effects.find(
      (candidate) => candidate.type === "create_checkout_session",
    )!;
    expect(recoveredEffect).toMatchObject({
      status: "completed",
      attempts: 2,
    });
    expect(recoveredEffect.nextAttemptAt).toBeUndefined();
    expect(recoveredEffect.error).toBeUndefined();
    expect(mail.requests).toHaveLength(1);
  });

  it("charges an aborted provider attempt to the exact durable effect instead of retrying it immediately forever", async () => {
    const payment = new FailingCheckoutPayment("PROVIDER_FAILURE");
    const agent = createAgent(store, payment, () => now, {
      effectMaxAttempts: 3,
      effectRetryInitialDelayMs: 1_000,
      effectRetryMaxDelayMs: 1_000,
    });
    await expect(
      agent.acceptIntake(intake("aborted-provider-attempt")),
    ).rejects.toThrow("PROVIDER_FAILURE");
    now = new Date("2026-07-24T12:00:01.000Z");

    await expect(
      agent.reconcileProject(
        PROJECT_IDS["aborted-provider-attempt"],
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("PROVIDER_FAILURE");

    const effect = store
      .getProject(PROJECT_IDS["aborted-provider-attempt"])!
      .effects.find(
        (candidate) => candidate.type === "create_checkout_session",
      )!;
    expect(effect).toMatchObject({
      status: "pending",
      attempts: 2,
      nextAttemptAt: "2026-07-24T12:00:02.000Z",
      error: { code: "effect.provider_failure", retryable: true },
    });
    await agent.reconcileProject(PROJECT_IDS["aborted-provider-attempt"]);
    expect(payment.createCalls).toBe(2);
  });

  it("durably records a customer reply without letting it bypass operator attention", async () => {
    const payment = new FailingCheckoutPayment("POLICY_BLOCKED");
    const agent = createAgent(store, payment, () => now);

    await expect(agent.acceptIntake(intake("attention-reply"))).rejects.toThrow(
      "POLICY_BLOCKED",
    );

    const blocked = await agent.receiveCustomerMessage({
      projectId: PROJECT_IDS["attention-reply"],
      providerEventId: "resend-event-attention-reply-001",
      eventDigest:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      providerMessageId: "resend-message-attention-reply-001",
      receivedAt: START,
      senderEmail: "jordan@example.com",
      subject: "Re: proposal",
      content: "Please use blue for the primary call to action.",
    });

    expect(blocked.status).toBe("needs_operator_attention");
    expect(
      blocked.messages.some(
        (message) =>
          message.direction === "inbound" &&
          message.providerMessageId === "resend-message-attention-reply-001",
      ),
    ).toBe(true);
    expect(payment.createCalls).toBe(1);
  });

  it("never charges an unrelated pending effect for a different provider failure", async () => {
    const payment = new FailingCheckoutPayment("PROVIDER_FAILURE", 0);
    const agent = createAgent(store, payment, () => now);
    const awaitingPayment = await agent.acceptIntake(
      intake("effect-attribution"),
    );
    const withUnrelatedEffect = structuredClone(awaitingPayment);
    const unrelatedKey = `deploy:fly:unrelated-${awaitingPayment.projectId}`;
    withUnrelatedEffect.effects.push({
      key: unrelatedKey,
      type: "deploy_proven_candidate",
      status: "pending",
      attempts: 1,
      inputDigest: sha256("unrelated-deploy"),
      createdAt: START,
      updatedAt: START,
    });
    store.saveProject(withUnrelatedEffect, awaitingPayment.revision, {
      type: "test.unrelated_effect_queued",
      actor: "system",
      payload: {
        status: awaitingPayment.status,
        effectKey: unrelatedKey,
        effectType: "deploy_proven_candidate",
      },
    });

    await expect(
      agent.reconcileProject(awaitingPayment.projectId),
    ).rejects.toThrow("not used");

    const recovered = store.getProject(awaitingPayment.projectId)!;
    const unrelated = recovered.effects.find(
      (effect) => effect.key === unrelatedKey,
    )!;
    expect(unrelated).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(unrelated.nextAttemptAt).toBeUndefined();
    expect(
      recovered.errors.some((error) => error.effectKey === unrelatedKey),
    ).toBe(false);
  });
});

function intake(suffix: string) {
  const projectId = PROJECT_IDS[suffix as keyof typeof PROJECT_IDS];
  if (!projectId) {
    throw new Error("missing retry-test project id");
  }
  return {
    projectId,
    idempotencyKey: `intake-idempotency-${suffix}`,
    channel: "email" as const,
    intakeId: `intake-${suffix}`,
    sourceId: `conversation-${suffix}`,
    receivedAt: START,
    content: CONTENT,
    emailVerified: true,
    researchConsent: false,
  };
}

function createAgent(
  store: SqliteOrchestrationStore,
  payment: PaymentPort,
  now: () => Date,
  retry: Pick<
    OrchestrationAgentOptions,
    "effectMaxAttempts" | "effectRetryInitialDelayMs" | "effectRetryMaxDelayMs"
  > = {},
  mail: MailPort = new RecordingMail(),
): OrchestrationAgent {
  return new OrchestrationAgent({
    store,
    reasoner: new DeterministicReasoner(),
    payment,
    mail,
    research: new NoResearch(),
    build: unusedBuildBackend(),
    deployment: unusedDeployment(),
    replyAddresses: new ReplyAddressCodec({
      domain: "reply.buildlapse.example",
      secret: Buffer.alloc(32, 4),
    }),
    proofSummaryLinks: new ProofSummaryLinkCodec({
      publicBaseUrl: "https://orchestrator.buildlapse.example",
      secret: Buffer.alloc(32, 4),
    }),
    customerDashboardAccess: new CustomerDashboardAccessCodec({
      publicBaseUrl: "https://orchestrator.buildlapse.example",
      secret: Buffer.alloc(32, 12),
      now,
    }),
    fromEmail: "Buildlapse <projects@buildlapse.example>",
    messageIdDomain: "reply.buildlapse.example",
    expectedStripeLivemode: false,
    now,
    previewReviewPeriodMs: 0,
    ...retry,
  });
}

class FailingCheckoutPayment implements PaymentPort {
  createCalls = 0;
  readonly idempotencyKeys: string[] = [];

  constructor(
    private readonly failureCode: "POLICY_BLOCKED" | "PROVIDER_FAILURE",
    private readonly failuresBeforeSuccess = Number.POSITIVE_INFINITY,
  ) {}

  health(): Promise<void> {
    return Promise.resolve();
  }

  createCheckoutSession(
    request: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    this.createCalls += 1;
    this.idempotencyKeys.push(request.idempotencyKey);
    if (this.createCalls <= this.failuresBeforeSuccess) {
      return Promise.reject(
        new ProviderAdapterError(
          "stripe",
          "create_checkout_session",
          this.failureCode,
        ),
      );
    }
    return Promise.resolve({
      provider: "stripe",
      sessionId: "cs_test_retry",
      livemode: false,
      url: "https://checkout.stripe.test/cs_test_retry",
      status: "open",
      paymentStatus: "unpaid",
      paymentIntentId: null,
      amountMinor: request.amountMinor,
      currency: request.currency,
      customerEmail: request.customerEmail,
      customerId: null,
      projectId: request.projectId,
      proposalId: request.proposalId,
      proposalVersion: request.proposalVersion,
      proposalDigest: request.proposalDigest,
      createdAt: START,
      expiresAt: "2026-07-25T12:00:00.000Z",
    });
  }

  expireCheckoutSession(_sessionId: string): Promise<CheckoutSession> {
    throw new Error("not used");
  }

  parseWebhook(_webhook: RawStripeWebhook): PaidCheckoutWebhook | null {
    throw new Error("not used");
  }

  retrieveCheckoutSession(_sessionId: string): Promise<CheckoutSession> {
    throw new Error("not used");
  }

  verifySettlement(
    _request: VerifySettlementRequest,
  ): Promise<VerifiedSettlement> {
    throw new Error("not used");
  }
}

class RecordingMail implements MailPort {
  readonly requests: SendMailRequest[] = [];

  health(): Promise<void> {
    return Promise.resolve();
  }

  send(request: SendMailRequest): Promise<SentMail> {
    this.requests.push(request);
    return Promise.resolve({
      provider: "resend",
      messageId: `mail-${String(this.requests.length)}`,
    });
  }

  retrieveOutboundDelivery(
    messageId: string,
  ): Promise<OutboundMailProviderState> {
    return Promise.resolve({
      provider: "resend",
      messageId,
      status: "delivered",
      verifiedAt: START,
      permanent: false,
    });
  }

  parseWebhook(_webhook: RawResendWebhook): MailWebhookNotification | null {
    throw new Error("not used");
  }

  retrieveInboundEmail(_emailId: string): Promise<InboundMail> {
    throw new Error("not used");
  }
}

class NoResearch implements WebsiteResearchPort {
  capture(_request: CaptureWebsiteRequest): Promise<WebsiteResearchCapture> {
    throw new Error("not used");
  }
}

class DeterministicReasoner implements OrchestrationReasoner {
  analyzeConversation(
    input: AnalyzeConversationInput,
  ): Promise<ConversationAnalysis> {
    const nameStart = input.conversation.indexOf("Jordan Lee");
    return Promise.resolve({
      customer: { name: "Jordan Lee", email: "jordan@example.com" },
      piiSpans: [
        {
          type: "person_name",
          startOffset: nameStart,
          endOffset: nameStart + "Jordan Lee".length,
          confidence: 1,
        },
      ],
      quote: {
        amountMinor: 250_000,
        currency: "usd",
        evidenceExcerpt: "We agreed on USD 2,500",
      },
      researchTargets: [],
      clarificationQuestions: [],
    });
  }

  draftProposal(_input: DraftProposalInput): Promise<ProposalPlan> {
    const citedStatement = "Build Mission Peak Electric a site.";
    return Promise.resolve({
      title: "Mission Peak Electric website",
      summary: "A service website with an estimate flow.",
      scopeItems: [
        {
          id: "website",
          text: citedStatement,
          citation: { kind: "conversation", excerpt: citedStatement },
        },
      ],
      buildPrompt:
        "Build an accessible Mission Peak Electric service website with an estimate form.",
      strategyLabels: ["conversion-first"],
      assets: [],
      clarificationQuestions: [],
      contractDraft: {
        approvedFacts: [
          {
            id: "business-name",
            statement: citedStatement,
            citation: { kind: "conversation", excerpt: citedStatement },
          },
        ],
        forbiddenClaims: ["24/7 emergency service"],
        requirements: [
          {
            id: "homepage",
            description: citedStatement,
            priority: "hard",
            citation: { kind: "conversation", excerpt: citedStatement },
            verifiers: [
              {
                kind: "http",
                path: "/",
                expectedStatus: 200,
                bodyIncludes: ["Mission Peak Electric"],
              },
            ],
          },
        ],
        verification: {
          origin: "system_policy",
          policyId: "buildlapse-proof-gate-v1",
          buildCommand: "npm run build",
          testCommands: ["npm test"],
          previewCommand: "npm run start",
          previewPort: 3000,
        },
      },
    });
  }

  classifyChange(_input: ClassifyChangeInput): Promise<ChangeClassification> {
    throw new Error("not used");
  }
}

function unusedBuildBackend(): BuildBackendPort {
  const unused = (): never => {
    throw new Error("not used");
  };
  return {
    health: () => Promise.resolve(),
    dispatchBuild: unused,
    cancelBuild: unused,
    getBuildRun: unused,
    getCustomerBuildObservation: unused,
    pollProvenEvents: unused,
    acknowledgeProvenEvent: unused,
    getProvenPreview: unused,
    downloadProvenArtifact: unused,
  };
}

function unusedDeployment(): FlyDeploymentPort {
  return {
    health: () => Promise.resolve(),
    deployProvenArtifact: () => {
      throw new Error("not used");
    },
  };
}
