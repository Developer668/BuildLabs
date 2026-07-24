import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OutboxEventSchema, type OutboxEvent } from "../src/domain/artifact.js";
import { assignmentDigest, contractDigest } from "../src/domain/contract.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import {
  OptimisticConcurrencyError,
  SqliteOrchestrationStore,
} from "../src/orchestration/adapters/sqlite/orchestration-store.js";
import {
  OrchestrationAgent,
  type OrchestrationAgentOptions,
} from "../src/orchestration/application/orchestration-agent.js";
import { CustomerDashboardAccessCodec } from "../src/orchestration/application/customer-dashboard-access.js";
import {
  MAX_PROOF_PII_SPANS,
  parseRecordedProofSnapshot,
} from "../src/orchestration/application/project-evidence.js";
import { ReplyAddressCodec } from "../src/orchestration/application/reply-address.js";
import { ProofSummaryLinkCodec } from "../src/orchestration/application/proof-summary-links.js";
import type {
  AnalyzeConversationInput,
  ChangeClassification,
  ClassifyChangeInput,
  ConversationAnalysis,
  DraftProposalInput,
  OrchestrationReasoner,
  ProposalPlan,
} from "../src/orchestration/application/fireworks-orchestration-reasoner.js";
import {
  ValidatedProvenArtifact,
  type BuildBackendPort,
  type BuildDispatchReceipt,
  type BuildRunSnapshot,
  type FrozenProvenPreview,
  type ProvenEventPollRequest,
  type ProvenPreviewRequest,
} from "../src/orchestration/ports/build-backend.js";
import type {
  FlyDeploymentPort,
  FlyDeploymentReceipt,
} from "../src/orchestration/ports/deployment.js";
import type {
  InboundMail,
  InboundMailNotification,
  MailPort,
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
} from "../src/orchestration/ports/payment.js";
import type {
  CaptureWebsiteRequest,
  WebsiteResearchCapture,
  WebsiteResearchPort,
} from "../src/orchestration/ports/website-research.js";
import { artifact } from "./fixtures.js";

const NOW = "2026-07-23T12:00:00.000Z";

describe("OrchestrationAgent proposal/payment/build lifecycle", () => {
  let store: SqliteOrchestrationStore;
  let payment: FakePayment;
  let mail: FakeMail;
  let build: FakeBuildBackend;
  let deployment: FakeDeployment;
  let reasoner: FakeReasoner;
  let agent: OrchestrationAgent;
  let dashboardAccess: CustomerDashboardAccessCodec;
  let baseAgentOptions: OrchestrationAgentOptions;
  let now: Date;
  let temporaryDirectories: string[];

  beforeEach(() => {
    now = new Date(NOW);
    temporaryDirectories = [];
    store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: Buffer.alloc(32, 9),
      now: () => now,
    });
    payment = new FakePayment();
    mail = new FakeMail();
    build = new FakeBuildBackend();
    deployment = new FakeDeployment();
    reasoner = new FakeReasoner();
    dashboardAccess = new CustomerDashboardAccessCodec({
      publicBaseUrl: "https://orchestrator.buildlapse.example",
      secret: Buffer.alloc(32, 12),
      now: () => now,
    });
    baseAgentOptions = {
      store,
      reasoner,
      payment,
      mail,
      research: new NoResearch(),
      build,
      deployment,
      replyAddresses: new ReplyAddressCodec({
        domain: "reply.buildlapse.example",
        secret: Buffer.alloc(32, 4),
      }),
      proofSummaryLinks: new ProofSummaryLinkCodec({
        publicBaseUrl: "https://orchestrator.buildlapse.example",
        secret: Buffer.alloc(32, 4),
      }),
      customerDashboardAccess: dashboardAccess,
      fromEmail: "Buildlapse <projects@buildlapse.example>",
      messageIdDomain: "reply.buildlapse.example",
      expectedStripeLivemode: false,
      now: () => now,
      previewReviewPeriodMs: 0,
    };
    agent = new OrchestrationAgent(baseAgentOptions);
  });

  afterEach(() => {
    store.close();
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loops through a revised proposal, exact paid version, confirmation, and free-slot fan-out", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-001",
      channel: "email",
      intakeId: "intake-agent-001",
      sourceId: "eleven-conversation-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    expect(initial.status).toBe("awaiting_payment");
    expect(initial.proposals).toHaveLength(1);
    expect(initial.checkoutSessions).toHaveLength(1);
    expect(mail.requests).toHaveLength(1);
    expect(mail.requests[0]?.text).toContain("Pay for this exact proposal");

    const inboundMessageId = "<revision-001@customer.example>";
    const priorReferences =
      "<proposal-001@buildlapse.example> <followup-001@buildlapse.example>";
    const revised = await agent.receiveCustomerMessage({
      projectId: initial.projectId,
      providerEventId: "resend-event-revision-001",
      eventDigest: sha256("signed-revision-event"),
      providerMessageId: `resend-message:${Buffer.from(
        inboundMessageId,
      ).toString("base64url")}`,
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: website",
      content: "Please make the estimate form the primary call to action.",
      threadId: `resend-thread:${Buffer.from(priorReferences).toString(
        "base64url",
      )}`,
    });

    expect(revised.activeProposalVersion).toBe(2);
    expect(revised.checkoutSessions[0]?.status).toBe("expired");
    expect(revised.checkoutSessions[1]?.status).toBe("open");
    expect(mail.requests).toHaveLength(2);
    expect(mail.requests[1]?.headers).toMatchObject({
      "In-Reply-To": inboundMessageId,
      References: `${priorReferences} ${inboundMessageId}`,
    });
    const encodedReferences = [
      "<proposal-001@buildlapse.example>",
      "<followup-001@buildlapse.example>",
      inboundMessageId,
    ].map(
      (messageId) =>
        `resend-message:${Buffer.from(messageId).toString("base64url")}`,
    );
    expect(revised.messages.at(-1)).toMatchObject({
      direction: "outbound",
      inReplyTo: revised.messages.at(-2)?.providerMessageId,
      references: encodedReferences,
    });

    const paidSession = revised.checkoutSessions[1]!;
    payment.markPaid(paidSession.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-paid-002",
        createdAt: NOW,
        livemode: false,
        session: payment.session(paidSession.sessionId),
      },
      sha256("signed-stripe-event-v2"),
    );

    expect(paid.status).toBe("building");
    expect(paid.paidProposalVersion).toBe(2);
    expect(paid.payments).toHaveLength(1);
    expect(paid.payments[0]).toMatchObject({
      verificationSource: "signed_webhook",
      providerStateVerified: true,
      signatureVerified: true,
    });
    expect(paid.buildBatches[0]?.runs).toHaveLength(2);
    expect(build.assignments).toHaveLength(2);
    expect(
      mail.requests.some((request) =>
        request.subject.includes("Payment received"),
      ),
    ).toBe(true);
    const dashboardMail = mail.requests.find((request) =>
      request.subject.includes("Build dashboard"),
    );
    expect(dashboardMail?.text).toContain(
      "/v1/orchestration/customer-dashboard/access#token=login.v1.",
    );
    const dashboardLink = dashboardMail?.text.match(/https:\/\/\S+/u)?.[0];
    expect(dashboardLink).toBeDefined();
    const loginToken = dashboardLoginToken(dashboardLink!);
    expect(dashboardAccess.parseLoginLink(loginToken)).toMatchObject({
      projectId: paid.projectId,
      purpose: "login",
      emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
    });
    const lifecycleEvents = store.listEvents(paid.projectId);
    expect(
      lifecycleEvents.findIndex(
        (event) => event.type === "email.dashboard_access_queued",
      ),
    ).toBeGreaterThan(
      lifecycleEvents.findIndex(
        (event) => event.type === "build.batch_dispatched",
      ),
    );
    for (const assignment of build.assignments) {
      expect(assignment.transcript.content).not.toContain("jordan@example.com");
      expect(assignment.contract.contractRevision).toBe(2);
    }
    for (const input of reasoner.draftInputs) {
      expect(JSON.stringify(input)).not.toContain("jordan@example.com");
      expect(JSON.stringify(input)).not.toContain("Jordan Lee");
    }
  });

  it("rejects voice-layer attempts to assert email ownership", async () => {
    await expect(
      agent.acceptIntake({
        idempotencyKey: "voice-intake-forged-ownership-001",
        channel: "voice",
        intakeId: "intake-forged-ownership-001",
        sourceId: "eleven-conversation-forged-ownership-001",
        receivedAt: NOW,
        content:
          "I am Jordan Lee. Email jordan@example.com. Build a service website for USD 2,500.",
        emailVerified: true,
        researchConsent: false,
      }),
    ).rejects.toThrow("Voice intake cannot attest email ownership");
    expect(mail.requests).toHaveLength(0);
  });

  it("captures dictated contact details without read-back and resumes only after passwordless email ownership proof", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-passwordless-001",
      channel: "voice",
      intakeId: "intake-passwordless-001",
      sourceId: "eleven-conversation-passwordless-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Phone 415-555-1212. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });

    expect(captured.status).toBe("needs_clarification");
    expect(captured.customer).toMatchObject({
      email: { value: "jordan@example.com", verified: false },
      phone: { value: "415-555-1212", verified: false },
    });
    expect(captured.openClarificationQuestions).toEqual([
      "Complete passwordless email verification to continue.",
    ]);
    expect(captured.proposals).toHaveLength(0);
    expect(captured.checkoutSessions).toHaveLength(0);
    expect(mail.requests).toHaveLength(1);
    expect(mail.requests[0]?.subject).toBe("Verify your email to continue");
    expect(mail.requests[0]?.text).not.toContain("jordan@example.com");
    const verificationLink =
      mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    expect(verificationLink).toBeDefined();
    expect(
      dashboardAccess.parseLoginLink(dashboardLoginToken(verificationLink!)),
    ).toMatchObject({
      projectId: captured.projectId,
      purpose: "login",
      emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
    });

    await expect(
      agent.verifyEmailOwnership({
        projectId: captured.projectId,
        method: "passwordless_email",
        provider: "buildlapse_auth",
        providerEventId: "magic-link-session-mismatch-001",
        eventDigest: sha256("mismatched-passwordless-event"),
        email: "someone-else@example.com",
        verifiedAt: NOW,
      }),
    ).rejects.toThrow(
      "Passwordless verification does not match the intake-evidenced email",
    );
    expect(store.getProject(captured.projectId)?.customer.email?.verified).toBe(
      false,
    );

    const verification = {
      projectId: captured.projectId,
      method: "passwordless_email" as const,
      provider: "buildlapse_auth",
      providerEventId: "magic-link-session-001",
      eventDigest: sha256("passwordless-event-001"),
      email: "JORDAN@example.com",
      verifiedAt: NOW,
    };
    const resumed = await agent.verifyEmailOwnership(verification);

    expect(resumed.status).toBe("awaiting_payment");
    expect(resumed.customer.email).toEqual({
      value: "jordan@example.com",
      verified: true,
      verifiedAt: NOW,
    });
    expect(resumed.openClarificationQuestions).toEqual([]);
    expect(resumed.proposals).toHaveLength(1);
    expect(resumed.checkoutSessions).toHaveLength(1);
    expect(mail.requests).toHaveLength(2);
    const verificationEvent = store
      .listEvents(captured.projectId)
      .find((event) => event.type === "customer.email_ownership_verified");
    expect(verificationEvent).toMatchObject({
      actor: "provider",
      payload: {
        provider: "buildlapse_auth",
        providerEventDigest: verification.eventDigest,
        correlationId: verification.providerEventId,
      },
    });
    expect(JSON.stringify(verificationEvent)).not.toContain(
      "jordan@example.com",
    );

    const replayed = await agent.verifyEmailOwnership(verification);
    expect(replayed.customer.email?.verified).toBe(true);
    expect(
      store
        .listEvents(captured.projectId)
        .filter((event) => event.type === "customer.email_ownership_verified"),
    ).toHaveLength(1);
    expect(mail.requests).toHaveLength(2);
  });

  it("consumes dashboard login atomically before deferred orchestration resumes", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-dashboard-exchange-001",
      channel: "voice",
      intakeId: "intake-dashboard-exchange-001",
      sourceId: "eleven-dashboard-exchange-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    const tokenDigest = sha256("dashboard-exchange-token-001");
    const verification = {
      projectId: captured.projectId,
      method: "passwordless_email" as const,
      provider: "buildlapse_dashboard",
      providerEventId: "dashboard-exchange-event-001",
      eventDigest: sha256("dashboard-exchange-event-001"),
      email: "jordan@example.com",
      verifiedAt: NOW,
      dashboardLogin: {
        tokenDigest,
        expiresAt: "2026-07-23T12:15:00.000Z",
      },
    };

    const verified = await agent.verifyEmailOwnership(verification);
    expect(verified.customer.email?.verified).toBe(true);
    expect(verified.proposals).toHaveLength(0);
    expect(
      store.hasConsumedCustomerDashboardLogin(tokenDigest, captured.projectId),
    ).toBe(true);
    await expect(agent.verifyEmailOwnership(verification)).rejects.toThrow(
      "already consumed",
    );

    const resumed = await agent.reconcileProject(captured.projectId);
    expect(resumed.status).toBe("awaiting_payment");
    expect(resumed.proposals).toHaveLength(1);
  });

  it("retries the same durable email-verification link without advancing the proposal", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      effectRetryInitialDelayMs: 1_000,
      effectRetryMaxDelayMs: 1_000,
    });
    mail.failOnSendCall = 1;
    const intake = {
      idempotencyKey: "voice-intake-verification-retry-001",
      channel: "voice" as const,
      intakeId: "intake-verification-retry-001",
      sourceId: "eleven-conversation-verification-retry-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    };

    await expect(agent.acceptIntake(intake)).rejects.toThrow(
      "injected mail failure",
    );
    const checkpoint = store
      .listProjectIdsForReconciliation(10)
      .projectIds.map((projectId) => store.getProject(projectId)!)
      .find((project) => project.intake.intakeId === intake.intakeId)!;
    expect(checkpoint.status).toBe("needs_clarification");
    expect(checkpoint.proposals).toHaveLength(0);
    expect(
      checkpoint.effects.find(
        (effect) => effect.type === "send_email_verification",
      ),
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      error: { retryable: true },
    });

    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.reconcileProject(checkpoint.projectId);
    expect(recovered.status).toBe("needs_clarification");
    expect(recovered.proposals).toHaveLength(0);
    expect(
      recovered.effects.find(
        (effect) => effect.type === "send_email_verification",
      ),
    ).toMatchObject({ status: "completed", attempts: 2 });
    expect(mail.requests).toHaveLength(1);
    const firstLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    expect(firstLink).toBeDefined();

    await agent.reconcileProject(checkpoint.projectId);
    expect(mail.requests).toHaveLength(1);
  });

  it("rotates an unsent passwordless capability that expired before retry", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      effectRetryInitialDelayMs: 1_000,
      effectRetryMaxDelayMs: 1_000,
    });
    mail.failOnSendCall = 1;
    await expect(
      agent.acceptIntake({
        idempotencyKey: "voice-intake-expired-retry-001",
        channel: "voice",
        intakeId: "intake-expired-retry-001",
        sourceId: "eleven-expired-retry-001",
        receivedAt: NOW,
        content:
          "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
        emailVerified: false,
        researchConsent: false,
      }),
    ).rejects.toThrow("injected mail failure");
    const projectId = store.listProjectIdsForReconciliation(10).projectIds[0]!;

    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    const recovered = await agent.reconcileProject(projectId);
    const verificationEffects = recovered.effects.filter(
      (effect) => effect.type === "send_email_verification",
    );

    expect(verificationEffects).toHaveLength(2);
    expect(verificationEffects[0]).toMatchObject({
      status: "failed",
      error: { code: "login_capability.expired_before_delivery" },
    });
    expect(verificationEffects[1]).toMatchObject({ status: "completed" });
    expect(verificationEffects[1]?.key).toContain(":generation:2");
    const replacementLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    expect(replacementLink).toBeDefined();
    expect(
      dashboardAccess.parseLoginLink(dashboardLoginToken(replacementLink!)),
    ).toMatchObject({ projectId });
  });

  it("reissues dashboard access only to the email bound by the signed capability", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-dashboard-reissue-001",
      channel: "voice",
      intakeId: "intake-dashboard-reissue-001",
      sourceId: "eleven-dashboard-reissue-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    const originalLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    const originalToken = dashboardLoginToken(originalLink!);
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    const request = {
      projectId: captured.projectId,
      emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
      capabilityDigest: sha256(originalToken),
    };

    await agent.requestCustomerDashboardAccess(request);
    expect(mail.requests).toHaveLength(2);
    expect(mail.requests[1]?.to).toBe("jordan@example.com");
    const replacementLink = mail.requests[1]?.text.match(/https:\/\/\S+/u)?.[0];
    expect(
      dashboardAccess.parseLoginLink(dashboardLoginToken(replacementLink!)),
    ).toMatchObject({
      projectId: captured.projectId,
      emailDigest: request.emailDigest,
    });

    await agent.requestCustomerDashboardAccess({
      ...request,
      capabilityDigest: sha256("immediate-repeat"),
    });
    expect(mail.requests).toHaveLength(2);
    await expect(
      agent.requestCustomerDashboardAccess({
        ...request,
        emailDigest: sha256("wrong-email"),
      }),
    ).rejects.toThrow("protected project identity");
    expect(mail.requests).toHaveLength(2);

    now = new Date(now.getTime() + 61_000);
    await agent.requestCustomerDashboardAccess(request);
    expect(mail.requests).toHaveLength(2);
    await agent.requestCustomerDashboardAccess({
      ...request,
      capabilityDigest: sha256("later-repeat"),
    });
    expect(mail.requests).toHaveLength(3);
    expect(
      store
        .getProject(captured.projectId)!
        .effects.filter((effect) => effect.type === "send_dashboard_login"),
    ).toHaveLength(2);
  });

  it("reloads and retries a dashboard-access intent after a CAS conflict", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-dashboard-cas-001",
      channel: "voice",
      intakeId: "intake-dashboard-cas-001",
      sourceId: "eleven-dashboard-cas-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    const originalLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    const originalToken = dashboardLoginToken(originalLink!);
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    const originalSave = store.saveProject.bind(store);
    let injected = false;
    const saveSpy = vi
      .spyOn(store, "saveProject")
      .mockImplementation((...arguments_) => {
        const [project, expectedRevision, event] = arguments_;
        if (!injected && event.type === "email.dashboard_login_queued") {
          injected = true;
          throw new OptimisticConcurrencyError(
            project.projectId,
            expectedRevision,
            expectedRevision + 1,
          );
        }
        return originalSave(...arguments_);
      });

    const reissued = await agent.requestCustomerDashboardAccess({
      projectId: captured.projectId,
      emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
      capabilityDigest: sha256(originalToken),
    });

    expect(injected).toBe(true);
    expect(
      reissued.effects.filter(
        (effect) => effect.type === "send_dashboard_login",
      ),
    ).toMatchObject([{ status: "completed" }]);
    expect(mail.requests).toHaveLength(2);
    saveSpy.mockRestore();
  });

  it("bounds dashboard-access replacements per signed capability and project", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-dashboard-cap-001",
      channel: "voice",
      intakeId: "intake-dashboard-cap-001",
      sourceId: "eleven-dashboard-cap-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    const emailDigest = dashboardAccess.emailDigest("jordan@example.com");

    for (let index = 0; index < 40; index += 1) {
      await agent.requestCustomerDashboardAccess({
        projectId: captured.projectId,
        emailDigest,
        capabilityDigest: sha256(`bounded-capability-${index}`),
      });
      now = new Date(now.getTime() + 61_000);
    }

    const reissueEffects = store
      .getProject(captured.projectId)!
      .effects.filter((effect) => effect.type === "send_dashboard_login");
    expect(reissueEffects).toHaveLength(32);
    expect(mail.requests).toHaveLength(33);

    await agent.requestCustomerDashboardAccess({
      projectId: captured.projectId,
      emailDigest,
      capabilityDigest: sha256("bounded-capability-0"),
    });
    expect(mail.requests).toHaveLength(33);
  });

  it("retries pending dashboard login delivery after a terminal-project restart", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-terminal-dashboard-001",
      channel: "voice",
      intakeId: "intake-terminal-dashboard-001",
      sourceId: "eleven-terminal-dashboard-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    const originalLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    const originalToken = dashboardLoginToken(originalLink!);
    const terminal = structuredClone(store.getProject(captured.projectId)!);
    terminal.status = "cancelled";
    store.saveProject(terminal, terminal.revision, {
      type: "project.cancelled",
      actor: "operator",
      payload: {
        previousStatus: captured.status,
        status: "cancelled",
      },
    });
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    mail.failOnSendCall = 2;

    await expect(
      agent.requestCustomerDashboardAccess({
        projectId: captured.projectId,
        emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
        capabilityDigest: sha256(originalToken),
      }),
    ).rejects.toThrow("injected mail failure");
    expect(store.listProjectIdsForReconciliation(10).projectIds).toContain(
      captured.projectId,
    );

    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 1_000);
    agent = new OrchestrationAgent(baseAgentOptions);
    const recovered = await agent.reconcileProject(captured.projectId);

    expect(recovered.status).toBe("cancelled");
    expect(
      recovered.effects.find(
        (effect) => effect.type === "send_dashboard_login",
      ),
    ).toMatchObject({ status: "completed", attempts: 2 });
    expect(mail.requests).toHaveLength(2);
    expect(store.listProjectIdsForReconciliation(10).projectIds).not.toContain(
      captured.projectId,
    );
  });

  it("honors a dashboard login's own retry schedule when another effect is due", async () => {
    const captured = await agent.acceptIntake({
      idempotencyKey: "voice-intake-dashboard-retry-order-001",
      channel: "voice",
      intakeId: "intake-dashboard-retry-order-001",
      sourceId: "eleven-dashboard-retry-order-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: false,
      researchConsent: false,
    });
    const originalLink = mail.requests[0]?.text.match(/https:\/\/\S+/u)?.[0];
    now = new Date(now.getTime() + 16 * 60 * 1_000);
    mail.failOnSendCall = 2;
    await expect(
      agent.requestCustomerDashboardAccess({
        projectId: captured.projectId,
        emailDigest: dashboardAccess.emailDigest("jordan@example.com"),
        capabilityDigest: sha256(dashboardLoginToken(originalLink!)),
      }),
    ).rejects.toThrow("injected mail failure");

    const withUnrelatedRetry = structuredClone(
      store.getProject(captured.projectId)!,
    );
    const unrelatedEffectKey = `mail:clarification:${captured.projectId}:scheduled`;
    withUnrelatedRetry.effects.push({
      key: unrelatedEffectKey,
      type: "send_clarification",
      status: "pending",
      attempts: 1,
      inputDigest: sha256("unrelated clarification retry"),
      error: {
        errorId: "unrelated-mail-retry-001",
        code: "mail.temporary_failure",
        category: "transient",
        message: "A separate message is ready to retry",
        retryable: true,
        effectKey: unrelatedEffectKey,
        occurredAt: now.toISOString(),
      },
      nextAttemptAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    store.saveProject(withUnrelatedRetry, withUnrelatedRetry.revision, {
      type: "effect.test_retry_scheduled",
      actor: "system",
      payload: {
        status: withUnrelatedRetry.status,
        effectKey: unrelatedEffectKey,
        effectType: "send_clarification",
      },
    });
    mail.failOnSendCall = null;

    await agent.reconcileProject(captured.projectId);
    expect(mail.requests).toHaveLength(1);

    now = new Date(now.getTime() + 1_000);
    const retried = await agent.reconcileProject(captured.projectId);
    expect(mail.requests).toHaveLength(2);
    expect(
      retried.effects.find((effect) => effect.type === "send_dashboard_login"),
    ).toMatchObject({ status: "completed", attempts: 2 });
    expect(
      retried.effects.find((effect) => effect.key === unrelatedEffectKey),
    ).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("rejects dashboard steering based on a stale project revision", async () => {
    const project = await agent.acceptIntake({
      idempotencyKey: "dashboard-stale-intake-001",
      channel: "email",
      intakeId: "dashboard-stale-intake-001",
      sourceId: "dashboard-stale-source-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    await expect(
      agent.receiveCustomerMessage({
        projectId: project.projectId,
        source: "dashboard",
        expectedProjectRevision: project.revision - 1,
        expectedProposalVersion: project.activeProposalVersion!,
        providerEventId: "dashboard-stale-event-001",
        eventDigest: sha256("dashboard-stale-event-001"),
        providerMessageId: "dashboard-stale-message-001",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Homepage direction",
        content: "Please make the primary action more prominent.",
      }),
    ).rejects.toThrow("Dashboard steering is stale");
    expect(store.getProject(project.projectId)?.revision).toBe(
      project.revision,
    );
  });

  it("recovers an exact paid Checkout through authoritative Stripe reconciliation when its webhook is lost", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-lost-payment-event-001",
      channel: "email",
      intakeId: "intake-agent-lost-payment-event-001",
      sourceId: "eleven-conversation-lost-payment-event-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = awaitingPayment.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);

    const recovered = await agent.reconcileProject(awaitingPayment.projectId);

    expect(recovered.status).toBe("building");
    expect(recovered.paidProposalVersion).toBe(1);
    expect(recovered.payments).toHaveLength(1);
    expect(recovered.payments[0]).toMatchObject({
      checkoutSessionId: checkout.sessionId,
      verificationSource: "provider_api",
      providerStateVerified: true,
      signatureVerified: false,
      proposalId: recovered.proposals[0]?.proposalId,
      amountReceivedMinor: 250_000,
      checkoutStatus: "complete",
      paymentStatus: "paid",
      paymentIntentStatus: "succeeded",
    });
    expect(
      recovered.effects.find((effect) => effect.type === "reconcile_payment"),
    ).toMatchObject({
      status: "completed",
      providerId: checkout.sessionId,
    });
    expect(recovered.buildBatches[0]?.runs).toHaveLength(2);
    expect(build.assignments).toHaveLength(2);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Payment received"),
      ),
    ).toHaveLength(1);

    const afterDelayedWebhook = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-delayed-after-reconciliation-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-delayed-stripe-event-after-reconciliation"),
    );
    expect(afterDelayedWebhook.payments).toHaveLength(1);
    expect(afterDelayedWebhook.buildBatches).toHaveLength(1);
    expect(build.assignments).toHaveLength(2);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Payment received"),
      ),
    ).toHaveLength(1);
  });

  it("records a late settlement for a superseded proposal without authorizing a build", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-late-superseded-payment-001",
      channel: "email",
      intakeId: "intake-agent-late-superseded-payment-001",
      sourceId: "eleven-conversation-late-superseded-payment-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const supersededCheckout = initial.checkoutSessions[0]!;

    const revised = await agent.receiveCustomerMessage({
      projectId: initial.projectId,
      providerEventId: "resend-event-late-superseded-payment-001",
      eventDigest: sha256("signed-late-superseded-payment-revision"),
      providerMessageId: "resend-message-late-superseded-payment-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: website",
      content: "Please make the estimate form the primary call to action.",
    });
    expect(revised.activeProposalVersion).toBe(2);
    expect(revised.checkoutSessions[0]?.status).toBe("expired");
    expect(revised.checkoutSessions[1]?.status).toBe("open");

    payment.markPaid(supersededCheckout.sessionId);
    const event: PaidCheckoutWebhook = {
      provider: "stripe",
      eventId: "stripe-event-late-superseded-payment-001",
      createdAt: NOW,
      livemode: false,
      session: payment.session(supersededCheckout.sessionId),
    };
    const eventDigest = sha256("signed-late-superseded-payment-event");
    const attention = await agent.confirmPayment(event, eventDigest);

    expect(attention.status).toBe("needs_operator_attention");
    expect(attention.activeProposalVersion).toBe(2);
    expect(attention.paidProposalVersion).toBeUndefined();
    expect(attention.payments).toHaveLength(1);
    expect(attention.payments[0]).toMatchObject({
      checkoutSessionId: supersededCheckout.sessionId,
      proposalVersion: 1,
      status: "paid",
      verificationSource: "signed_webhook",
    });
    expect(attention.checkoutSessions[0]?.status).toBe("complete");
    expect(attention.checkoutSessions[1]?.status).toBe("open");
    expect(attention.errors.at(-1)).toMatchObject({
      code: "payment.stale_proposal_settled",
      category: "permanent",
      retryable: false,
    });
    expect(attention.buildBatches).toHaveLength(0);
    expect(build.assignments).toHaveLength(0);

    const replayed = await agent.confirmPayment(event, eventDigest);
    expect(replayed.revision).toBe(attention.revision);
    expect(replayed.payments).toHaveLength(1);
    expect(build.assignments).toHaveLength(0);
  });

  it("fences payment and build dispatch while a signed inbound mail envelope is unresolved", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-inbound-payment-fence-001",
      channel: "email",
      intakeId: "intake-agent-inbound-payment-fence-001",
      sourceId: "eleven-conversation-inbound-payment-fence-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = awaitingPayment.checkoutSessions[0]!;
    const inboundEventId = "resend-event:pending-payment-steering-001";
    store.stageInboundMailEnvelope({
      provider: "resend",
      eventId: inboundEventId,
      eventDigest: sha256("signed pending payment steering"),
      projectId: awaitingPayment.projectId,
      emailId: "resend-email-pending-payment-001",
      identityDigest: sha256("pending payment steering identity"),
      receivedAt: NOW,
    });
    payment.markPaid(checkout.sessionId);

    await expect(
      agent.confirmPayment(
        {
          provider: "stripe",
          eventId: "stripe-event-pending-inbound-fence-001",
          createdAt: NOW,
          livemode: false,
          session: payment.session(checkout.sessionId),
        },
        sha256("signed payment while inbound steering is pending"),
      ),
    ).rejects.toThrow(
      "A signed inbound customer email must be recovered before advancing",
    );
    expect(store.getProject(awaitingPayment.projectId)?.payments).toHaveLength(
      0,
    );
    expect(build.assignments).toHaveLength(0);

    store.resolveInboundMailEnvelope(
      awaitingPayment.projectId,
      inboundEventId,
      "discard",
      NOW,
    );
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-pending-inbound-fence-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed payment while inbound steering is pending"),
    );
    expect(paid.status).toBe("building");
    expect(build.assignments).toHaveLength(2);
  });

  it("leaves an exact unpaid Checkout awaiting payment during reconciliation", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-unpaid-reconciliation-001",
      channel: "email",
      intakeId: "intake-agent-unpaid-reconciliation-001",
      sourceId: "eleven-conversation-unpaid-reconciliation-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    const unchanged = await agent.reconcileProject(awaitingPayment.projectId);

    expect(unchanged.status).toBe("awaiting_payment");
    expect(unchanged.revision).toBeGreaterThan(awaitingPayment.revision);
    expect(unchanged.payments).toHaveLength(0);
    expect(unchanged.buildBatches).toHaveLength(0);
    expect(build.assignments).toHaveLength(0);
    expect(mail.requests).toHaveLength(1);
    expect(
      unchanged.effects.find((effect) => effect.type === "reconcile_payment"),
    ).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("fails closed when the active proposal email permanently fails delivery", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-proposal-delivery-failure-001",
      channel: "email",
      intakeId: "intake-agent-proposal-delivery-failure-001",
      sourceId: "eleven-conversation-proposal-delivery-failure-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const proposalMessage = awaitingPayment.messages.find(
      (message) => message.purpose === "proposal",
    )!;
    mail.deliveryStates.set(proposalMessage.providerMessageId!, "failed");

    const attention = await agent.reconcileProject(awaitingPayment.projectId);

    expect(attention.status).toBe("needs_operator_attention");
    expect(
      attention.messages.find(
        (message) => message.messageId === proposalMessage.messageId,
      )?.deliveryStatus,
    ).toBe("failed");
    expect(attention.errors.at(-1)).toMatchObject({
      code: "mail.failed",
      category: "permanent",
      retryable: false,
    });
    expect(
      attention.effects.find(
        (effect) =>
          effect.key ===
          `mail:reconcile:${awaitingPayment.projectId}:${proposalMessage.providerMessageId}`,
      ),
    ).toMatchObject({ status: "failed" });
    expect(build.assignments).toHaveLength(0);
  });

  it("paces healthy pending Stripe and Resend provider checks without treating them as failures", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-provider-recheck-cadence-001",
      channel: "email",
      intakeId: "intake-agent-provider-recheck-cadence-001",
      sourceId: "eleven-conversation-provider-recheck-cadence-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    const firstCheck = await agent.reconcileProject(awaitingPayment.projectId);
    expect(mail.retrieveRequests).toHaveLength(1);
    expect(payment.retrieveRequests).toHaveLength(1);
    expect(
      firstCheck.effects
        .filter(
          (effect) =>
            effect.type === "reconcile_mail_delivery" ||
            effect.type === "reconcile_payment",
        )
        .every(
          (effect) =>
            effect.status === "pending" &&
            effect.nextCheckAt !== undefined &&
            effect.nextAttemptAt === undefined &&
            effect.error === undefined,
        ),
    ).toBe(true);

    await agent.reconcileProject(awaitingPayment.projectId);
    expect(mail.retrieveRequests).toHaveLength(1);
    expect(payment.retrieveRequests).toHaveLength(1);

    now = new Date(now.getTime() + 60_000);
    await agent.reconcileProject(awaitingPayment.projectId);
    expect(mail.retrieveRequests).toHaveLength(2);
    expect(payment.retrieveRequests).toHaveLength(2);
  });

  it("backs off a transient Stripe reconciliation failure and clears the failure after authoritative recovery", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-payment-retry-001",
      channel: "email",
      intakeId: "intake-agent-payment-retry-001",
      sourceId: "eleven-conversation-payment-retry-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    payment.failNextRetrieve = true;

    await expect(
      agent.reconcileProject(awaitingPayment.projectId),
    ).rejects.toThrow("injected Stripe retrieval failure");
    const failedAttempt = store.getProject(awaitingPayment.projectId)!;
    expect(
      failedAttempt.effects.find(
        (effect) => effect.type === "reconcile_payment",
      ),
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
      error: { code: "effect.provider_failure", retryable: true },
    });
    now = new Date(now.getTime() + 1_000);

    const recovered = await agent.reconcileProject(awaitingPayment.projectId);

    expect(recovered.status).toBe("awaiting_payment");
    expect(
      recovered.effects.find((effect) => effect.type === "reconcile_payment"),
    ).toMatchObject({ status: "pending", attempts: 1 });
    expect(
      recovered.effects.find((effect) => effect.type === "reconcile_payment")
        ?.error,
    ).toBeUndefined();
  });

  it("replaces an authoritatively expired unpaid Checkout and resends one current link idempotently", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-expired-checkout-001",
      channel: "email",
      intakeId: "intake-agent-expired-checkout-001",
      sourceId: "eleven-conversation-expired-checkout-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const expiredCheckout = awaitingPayment.checkoutSessions[0]!;
    payment.expireExternally(expiredCheckout.sessionId);

    const refreshed = await agent.reconcileProject(awaitingPayment.projectId);
    const replayed = await agent.reconcileProject(awaitingPayment.projectId);

    expect(refreshed.status).toBe("awaiting_payment");
    expect(refreshed.checkoutSessions).toHaveLength(2);
    expect(refreshed.checkoutSessions[0]?.status).toBe("expired");
    expect(refreshed.checkoutSessions[1]).toMatchObject({
      proposalVersion: 1,
      proposalDigest: refreshed.proposals[0]?.digest,
      amountMinor: 250_000,
      currency: "usd",
      status: "open",
    });
    expect(refreshed.checkoutSessions[1]?.sessionId).not.toBe(
      expiredCheckout.sessionId,
    );
    expect(mail.requests).toHaveLength(2);
    expect(mail.requests[1]?.text).toContain(
      refreshed.checkoutSessions[1]!.url,
    );
    expect(replayed.checkoutSessions).toHaveLength(2);
    expect(mail.requests).toHaveLength(2);
  });

  it("recovers a lost Checkout expiration response and creates exactly one replacement proposal Checkout", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-expire-response-loss-001",
      channel: "email",
      intakeId: "intake-agent-expire-response-loss-001",
      sourceId: "eleven-conversation-expire-response-loss-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const originalCheckout = awaitingPayment.checkoutSessions[0]!;
    payment.loseNextExpireResponse = true;

    await expect(
      agent.receiveCustomerMessage({
        projectId: awaitingPayment.projectId,
        providerEventId: "resend-event-expire-response-loss-001",
        eventDigest: sha256("signed-expire-response-loss-event"),
        providerMessageId: "resend-message-expire-response-loss-001",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Re: proposal",
        content: "Please make the estimate form the primary call to action.",
      }),
    ).rejects.toThrow("injected lost Checkout expiration response");

    const interrupted = store.getProject(awaitingPayment.projectId)!;
    expect(payment.session(originalCheckout.sessionId).status).toBe("expired");
    expect(interrupted.checkoutSessions[0]?.status).toBe("open");
    expect(
      interrupted.effects.find(
        (effect) =>
          effect.key === `checkout:expire:${awaitingPayment.projectId}:v1`,
      ),
    ).toMatchObject({
      type: "expire_checkout_session",
      status: "pending",
      attempts: 1,
    });
    expect(payment.expireRequests).toEqual([originalCheckout.sessionId]);
    expect(payment.createRequests).toHaveLength(1);

    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.reconcileProject(awaitingPayment.projectId);
    const replayed = await agent.reconcileProject(awaitingPayment.projectId);

    expect(recovered.status).toBe("awaiting_payment");
    expect(recovered.activeProposalVersion).toBe(2);
    expect(recovered.checkoutSessions).toHaveLength(2);
    expect(recovered.checkoutSessions[0]).toMatchObject({
      sessionId: originalCheckout.sessionId,
      proposalVersion: 1,
      status: "expired",
    });
    expect(recovered.checkoutSessions[1]).toMatchObject({
      proposalVersion: 2,
      status: "open",
    });
    expect(
      recovered.effects.find(
        (effect) =>
          effect.key === `checkout:expire:${awaitingPayment.projectId}:v1`,
      ),
    ).toMatchObject({
      type: "expire_checkout_session",
      status: "completed",
      attempts: 2,
      providerId: originalCheckout.sessionId,
    });
    expect(
      store
        .listEvents(recovered.projectId)
        .filter((event) => event.type === "checkout.expiration_recovered"),
    ).toHaveLength(1);
    expect(payment.expireRequests).toEqual([originalCheckout.sessionId]);
    expect(payment.createRequests).toHaveLength(2);
    expect(mail.requests).toHaveLength(2);
    expect(replayed.checkoutSessions).toHaveLength(2);
    expect(payment.expireRequests).toEqual([originalCheckout.sessionId]);
    expect(payment.createRequests).toHaveLength(2);
    expect(mail.requests).toHaveLength(2);
  });

  it("rejects a paid Checkout with mismatched immutable proposal evidence during reconciliation", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-payment-mismatch-001",
      channel: "email",
      intakeId: "intake-agent-payment-mismatch-001",
      sourceId: "eleven-conversation-payment-mismatch-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = awaitingPayment.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    payment.tamperSession(checkout.sessionId, {
      proposalDigest: sha256("different-proposal"),
    });

    await expect(
      agent.reconcileProject(awaitingPayment.projectId),
    ).rejects.toThrow(
      "Stripe Checkout reconciliation does not match the current customer proposal",
    );

    const failed = store.getProject(awaitingPayment.projectId)!;
    expect(failed.status).toBe("payment_verification_failed");
    expect(failed.payments).toHaveLength(0);
    expect(
      failed.effects.find((effect) => effect.type === "reconcile_payment"),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "effect.policy_failure",
        category: "policy",
        retryable: false,
      },
    });
    expect(build.assignments).toHaveLength(0);
  });

  it("resumes a reconciled payment after a crash without duplicating its receipt, confirmation, or build dispatch", async () => {
    const awaitingPayment = await agent.acceptIntake({
      idempotencyKey: "voice-intake-reconciled-payment-crash-001",
      channel: "email",
      intakeId: "intake-agent-reconciled-payment-crash-001",
      sourceId: "eleven-conversation-reconciled-payment-crash-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = awaitingPayment.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    mail.failOnSendCall = 2;

    await expect(
      agent.reconcileProject(awaitingPayment.projectId),
    ).rejects.toThrow("injected mail failure");

    const afterCrash = store.getProject(awaitingPayment.projectId)!;
    expect(afterCrash.status).toBe("paid");
    expect(afterCrash.payments).toHaveLength(1);
    expect(afterCrash.buildBatches).toHaveLength(0);

    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.reconcileProject(awaitingPayment.projectId);
    const replayed = await agent.reconcileProject(awaitingPayment.projectId);

    expect(recovered.status).toBe("building");
    expect(replayed.payments).toHaveLength(1);
    expect(replayed.buildBatches).toHaveLength(1);
    expect(build.assignments).toHaveLength(2);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Payment received"),
      ),
    ).toHaveLength(1);
  });

  it("selects only a proven current candidate, emails a frozen preview, then deploys and delivers it", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-proof-001",
      channel: "email",
      intakeId: "intake-agent-proof-001",
      sourceId: "eleven-conversation-proof-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    const proposalMessageId = mail.requests[0]?.headers?.["Message-ID"];
    expect(proposalMessageId).toMatch(
      /^<[a-f0-9]{64}@reply\.buildlapse\.example>$/,
    );
    expect(
      initial.messages.find((message) => message.purpose === "proposal")
        ?.rfcMessageId,
    ).toBe(
      `resend-message:${Buffer.from(proposalMessageId!).toString("base64url")}`,
    );
    payment.markPaid(checkout.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-proof-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-stripe-event-proof"),
    );
    expect(mail.requests[1]?.headers).toMatchObject({
      "In-Reply-To": proposalMessageId,
      References: proposalMessageId,
    });
    expect(mail.requests[1]?.headers?.["Message-ID"]).not.toBe(
      proposalMessageId,
    );

    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);

    expect(previewed.status).toBe("preview_ready");
    expect(previewed.provenCandidates).toHaveLength(2);
    expect(previewed.previews).toHaveLength(1);
    expect(previewed.previews[0]?.candidateId).toBe(
      build.highestRankedEvent().payload.candidateId,
    );
    expect(
      mail.requests.some((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toBe(true);
    expect(deployment.requests).toHaveLength(0);

    const stillAwaitingPreviewDelivery = await agent.reconcileProject(
      paid.projectId,
    );
    expect(stillAwaitingPreviewDelivery.status).toBe("preview_ready");
    expect(deployment.requests).toHaveLength(0);
    const previewMessage = stillAwaitingPreviewDelivery.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    mail.deliveryStates.set(previewMessage.providerMessageId!, "delivered");
    now = new Date(now.getTime() + 60_000);

    const finalMailAccepted = await agent.reconcileProject(paid.projectId);

    expect(finalMailAccepted.status).toBe("delivering");
    expect(finalMailAccepted.deployments).toHaveLength(1);
    expect(finalMailAccepted.deployments[0]?.candidateId).toBe(
      build.highestRankedEvent().payload.candidateId,
    );
    expect(deployment.requests).toHaveLength(1);
    expect(
      mail.requests.some((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toBe(true);
    const finalRequest = mail.requests.find((request) =>
      request.subject.includes("Production delivery"),
    )!;
    const proofUrl = finalRequest.text.match(
      /https:\/\/orchestrator\.buildlapse\.example\/v1\/orchestration\/proof-summaries\/[A-Za-z0-9_.-]+/,
    )?.[0];
    expect(proofUrl).toBeDefined();
    const proofGrant = new ProofSummaryLinkCodec({
      publicBaseUrl: "https://orchestrator.buildlapse.example",
      secret: Buffer.alloc(32, 4),
    }).parse(new URL(proofUrl!).pathname.split("/").at(-1)!);
    expect(proofGrant.snapshotId).toMatch(/^proof-summary:[a-f0-9]{32}$/u);
    expect(proofGrant.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    const storedProof = store.getProofSummarySnapshot(proofGrant.snapshotId);
    expect(storedProof).toMatchObject({
      snapshotId: proofGrant.snapshotId,
      snapshotDigest: proofGrant.snapshotDigest,
      projectId: paid.projectId,
      deploymentReceiptId: finalMailAccepted.deployments[0]!.receiptId,
      revisionHash: finalMailAccepted.deployments[0]!.revisionHash,
    });
    expect(parseRecordedProofSnapshot(storedProof!)).toMatchObject({
      project: { projectId: paid.projectId },
      contract: {
        version: finalMailAccepted.activeProposalVersion,
      },
      proofReceipt: {
        candidateId: finalMailAccepted.deployments[0]!.candidateId,
        revisionHash: finalMailAccepted.deployments[0]!.revisionHash,
      },
      deployment: {
        receiptId: finalMailAccepted.deployments[0]!.receiptId,
        productionUrl: finalMailAccepted.deployments[0]!.url,
      },
    });
    expect(build.acknowledged).toEqual(
      expect.arrayContaining(build.events.map((event) => event.eventId)),
    );
    const finalMessage = finalMailAccepted.messages.find(
      (message) => message.purpose === "final_delivery",
    )!;
    const delivered = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-final-delivered-001",
      eventDigest: sha256("signed-resend-delivered-event"),
      providerMessageId: finalMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    expect(delivered.status).toBe("completed");
    expect(
      delivered.messages.find(
        (message) => message.messageId === finalMessage.messageId,
      )?.deliveryStatus,
    ).toBe("delivered");
    const lateFailure = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-final-late-failure-001",
      eventDigest: sha256("signed-resend-late-failure-event"),
      providerMessageId: finalMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "bounced",
      permanent: true,
    });
    expect(lateFailure.status).toBe("completed");
    expect(
      lateFailure.messages.find(
        (message) => message.messageId === finalMessage.messageId,
      )?.deliveryStatus,
    ).toBe("delivered");

    const steered = await agent.receiveCustomerMessage({
      projectId: delivered.projectId,
      providerEventId: "resend-event-steering-001",
      eventDigest: sha256("signed-steering-event"),
      providerMessageId: "resend-message-steering-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: production delivery",
      content: "Please make the estimate form the primary call to action.",
    });

    expect(steered.status).toBe("building");
    expect(steered.activeProposalVersion).toBe(2);
    expect(steered.proposals[1]?.commercialBasisVersion).toBe(1);
    expect(steered.buildBatches).toHaveLength(2);
    expect(steered.buildBatches[1]?.paymentReceiptId).toBe(
      steered.payments[0]?.receiptId,
    );
    expect(build.assignments).toHaveLength(4);
    expect(
      build.assignments
        .slice(-2)
        .every((assignment) =>
          assignment.contract.requirements.some(
            (requirement) =>
              requirement.description ===
              "Please make the estimate form the primary call to action.",
          ),
        ),
    ).toBe(true);
    expect(
      mail.requests.some((request) =>
        request.subject.includes("Revision v2 queued"),
      ),
    ).toBe(true);
    expect(
      mail.requests.find((request) =>
        request.subject.includes("Revision v2 queued"),
      )?.text,
    ).toContain("Please make the estimate form the primary call to action.");
  });

  it("records deployment verification failure as a dedicated fail-closed state while retaining proven evidence", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      effectMaxAttempts: 1,
    });
    const paid = await beginPaidBuild("deployment-verification-failure");
    const paymentMessage = paid.messages.find(
      (message) => message.purpose === "payment_confirmation",
    )!;
    await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-payment-delivered-before-deploy-failure",
      eventDigest: sha256("signed-payment-delivered-before-deploy-failure"),
      providerMessageId: paymentMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);
    const previewMessage = previewed.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-preview-delivered-before-deploy-failure",
      eventDigest: sha256("signed-preview-delivered-before-deploy-failure"),
      providerMessageId: previewMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    deployment.failNextDeployment = true;

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "injected deployment verification failure",
    );

    const failed = store.getProject(paid.projectId)!;
    expect(failed.status).toBe("deployment_verification_failed");
    expect(failed.deployments).toHaveLength(0);
    expect(failed.provenCandidates).toHaveLength(2);
    expect(failed.previews).toHaveLength(1);
    expect(
      failed.effects.find(
        (effect) => effect.type === "deploy_proven_candidate",
      ),
    ).toMatchObject({
      status: "failed",
      error: { retryable: false },
    });
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);
    const replayed = await agent.reconcileProject(paid.projectId);
    expect(replayed.status).toBe("deployment_verification_failed");
    expect(deployment.requests).toHaveLength(1);
  });

  it("reuses the exact stored proof snapshot after a crash between insert and effect completion", async () => {
    store.close();
    const databaseDirectory = mkdtempSync(
      join(tmpdir(), "buildlapse-proof-recovery-"),
    );
    temporaryDirectories.push(databaseDirectory);
    const databasePath = join(databaseDirectory, "orchestration.sqlite");
    store = new SqliteOrchestrationStore({
      path: databasePath,
      encryptionKey: Buffer.alloc(32, 9),
      now: () => now,
    });
    baseAgentOptions = { ...baseAgentOptions, store };
    agent = new OrchestrationAgent(baseAgentOptions);
    const paid = await prepareDeliveredPreview("proof-snapshot-crash");
    const originalCreate = store.createProofSummarySnapshot.bind(store);
    let crashAfterInsert = true;
    const createSpy = vi
      .spyOn(store, "createProofSummarySnapshot")
      .mockImplementation((input) => {
        const result = originalCreate(input);
        if (crashAfterInsert) {
          crashAfterInsert = false;
          throw new Error("injected crash after proof snapshot insert");
        }
        return result;
      });

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "injected crash after proof snapshot insert",
    );
    const interrupted = store.getProject(paid.projectId)!;
    const pendingProof = interrupted.effects.find(
      (effect) => effect.type === "persist_proof_summary_snapshot",
    )!;
    expect(pendingProof).toMatchObject({
      status: "pending",
      error: { code: "effect.provider_failure", retryable: true },
    });
    expect(pendingProof.proofSnapshotId).toMatch(
      /^proof-summary:[a-f0-9]{32}$/u,
    );
    expect(pendingProof.proofSnapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      store.getProofSummarySnapshot(pendingProof.proofSnapshotId!),
    ).toMatchObject({
      snapshotId: pendingProof.proofSnapshotId,
      snapshotDigest: pendingProof.proofSnapshotDigest,
    });
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);

    expect(createSpy).toHaveBeenCalledTimes(1);
    store.close();
    store = new SqliteOrchestrationStore({
      path: databasePath,
      encryptionKey: Buffer.alloc(32, 9),
      now: () => now,
    });
    now = new Date(now.getTime() + 1_000);
    const reopenedCreateSpy = vi.spyOn(store, "createProofSummarySnapshot");
    baseAgentOptions = { ...baseAgentOptions, store };
    agent = new OrchestrationAgent(baseAgentOptions);
    const recovered = await agent.reconcileProject(paid.projectId);

    expect(recovered.status).toBe("delivering");
    expect(reopenedCreateSpy).not.toHaveBeenCalled();
    const finalRequests = mail.requests.filter((request) =>
      request.subject.includes("Production delivery"),
    );
    expect(finalRequests).toHaveLength(1);
    const proofUrl = finalRequests[0]!.text.match(
      /https:\/\/orchestrator\.buildlapse\.example\/v1\/orchestration\/proof-summaries\/[A-Za-z0-9_.-]+/,
    )?.[0];
    const recoveredGrant = new ProofSummaryLinkCodec({
      publicBaseUrl: "https://orchestrator.buildlapse.example",
      secret: Buffer.alloc(32, 4),
    }).parse(new URL(proofUrl!).pathname.split("/").at(-1)!);
    expect(recoveredGrant).toEqual({
      snapshotId: pendingProof.proofSnapshotId,
      snapshotDigest: pendingProof.proofSnapshotDigest,
    });
    expect(
      store
        .listEvents(paid.projectId)
        .filter((event) => event.type === "proof.summary_snapshot_recorded"),
    ).toHaveLength(1);
  });

  it("durably stops when the proof publication boundary rejects recorded evidence", async () => {
    const paid = await prepareDeliveredPreview("proof-publication-rejected");
    const changed = store.getProject(paid.projectId)!;
    const preview = changed.previews.at(-1)!;
    const winner = changed.provenCandidates.find(
      (candidate) =>
        candidate.batchId === preview.batchId &&
        candidate.event.payload.candidateId === preview.candidateId,
    )!;
    winner.event.traceId = "fw_1234567890abcdef";
    winner.event.payload.traceId = "fw_1234567890abcdef";
    winner.event.payload.ranking.traceId = "fw_1234567890abcdef";
    store.saveProject(changed, changed.revision, {
      type: "test.unsafe_proof_evidence_recorded",
      actor: "system",
      payload: { status: changed.status },
    });

    const attention = await agent.reconcileProject(paid.projectId);

    expect(attention.status).toBe("needs_operator_attention");
    expect(attention.deployments).toHaveLength(1);
    expect(
      attention.effects.find(
        (effect) => effect.type === "persist_proof_summary_snapshot",
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "proof.summary_publication_rejected",
        category: "policy",
        retryable: false,
      },
    });
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);
    const revision = attention.revision;
    const replayed = await agent.reconcileProject(paid.projectId);
    expect(replayed.status).toBe("needs_operator_attention");
    expect(replayed.revision).toBe(revision);
  });

  it("rejects overlapping full-transcript name spans before proof expansion", async () => {
    const paid = await prepareDeliveredPreview("proof-name-span-budget");
    const changed = store.getProject(paid.projectId)!;
    changed.intake.piiSpans = Array.from({ length: 500 }, () => ({
      category: "name" as const,
      startOffset: 0,
      endOffset: changed.intake.content.length,
      valueDigest: sha256(changed.intake.content),
      confidence: 1,
      handling: "tokenize" as const,
    }));
    store.saveProject(changed, changed.revision, {
      type: "test.overlapping_name_spans_recorded",
      actor: "system",
      payload: { status: changed.status, count: 500 },
    });
    const createSnapshot = vi.spyOn(store, "createProofSummarySnapshot");
    expect(changed.intake.piiSpans.length).toBeGreaterThan(MAX_PROOF_PII_SPANS);

    const attention = await agent.reconcileProject(paid.projectId);

    expect(attention.status).toBe("needs_operator_attention");
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(
      attention.effects.find(
        (effect) => effect.type === "persist_proof_summary_snapshot",
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "proof.summary_publication_rejected",
        retryable: false,
      },
    });
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);
  });

  it("dead-letters queued final delivery when its proof snapshot is revoked", async () => {
    const paid = await prepareDeliveredPreview("proof-revoked-before-send");
    const originalGet = store.getProofSummarySnapshot.bind(store);
    let revoked = false;
    vi.spyOn(store, "getProofSummarySnapshot").mockImplementation(
      (snapshotId) => {
        const current = store.getProject(paid.projectId);
        if (
          !revoked &&
          current?.effects.some(
            (effect) =>
              effect.type === "send_final_delivery" &&
              effect.status === "pending",
          )
        ) {
          store.revokeProofSummarySnapshot(
            snapshotId,
            "capability_compromised",
          );
          revoked = true;
        }
        return originalGet(snapshotId);
      },
    );

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "unavailable or revoked",
    );
    const attention = store.getProject(paid.projectId)!;
    expect(revoked).toBe(true);
    expect(attention.status).toBe("needs_operator_attention");
    expect(
      attention.effects.find((effect) => effect.type === "send_final_delivery"),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "effect.policy_failure",
        category: "policy",
        retryable: false,
      },
    });
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);

    const replayed = await agent.reconcileProject(paid.projectId);
    expect(replayed.status).toBe("needs_operator_attention");
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Production delivery"),
      ),
    ).toHaveLength(0);
  });

  it("rechecks the signed-inbound fence after long preview materialization before emailing the customer", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-preview-envelope-race-001",
      channel: "email",
      intakeId: "intake-agent-preview-envelope-race-001",
      sourceId: "eleven-conversation-preview-envelope-race-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-preview-envelope-race-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-preview-envelope-race-payment"),
    );
    build.proveAll();
    const inboundEventId = "resend-event:preview-materialization-race-001";
    build.onGetProvenPreview = () => {
      store.stageInboundMailEnvelope({
        provider: "resend",
        eventId: inboundEventId,
        eventDigest: sha256("signed preview materialization race"),
        projectId: paid.projectId,
        emailId: "resend-email-preview-race-001",
        identityDigest: sha256("preview materialization race identity"),
        receivedAt: NOW,
      });
    };

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "A signed inbound customer email must be recovered before advancing",
    );

    expect(build.previewRequests).toHaveLength(1);
    expect(store.getProject(paid.projectId)?.previews).toHaveLength(1);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(0);
    expect(deployment.requests).toHaveLength(0);

    store.resolveInboundMailEnvelope(
      paid.projectId,
      inboundEventId,
      "discard",
      NOW,
    );
    build.onGetProvenPreview = undefined;
    const previewed = await agent.reconcileProject(paid.projectId);
    expect(previewed.status).toBe("preview_ready");
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(1);
  });

  it("fails closed on a permanent final-email bounce and handles replay idempotently", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-bounce-001",
      channel: "email",
      intakeId: "intake-agent-bounce-001",
      sourceId: "eleven-conversation-bounce-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-bounce-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-stripe-event-bounce"),
    );
    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);
    const previewMessage = previewed.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    mail.deliveryStates.set(previewMessage.providerMessageId!, "delivered");
    const finalMailAccepted = await agent.reconcileProject(paid.projectId);
    const finalMessage = finalMailAccepted.messages.find(
      (message) => message.purpose === "final_delivery",
    )!;
    const bounce = {
      projectId: paid.projectId,
      providerEventId: "resend-event-final-bounced-001",
      eventDigest: sha256("signed-resend-bounced-event"),
      providerMessageId: finalMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "bounced" as const,
      permanent: true,
    };

    const attention = await agent.recordMailDelivery(bounce);
    expect(attention.status).toBe("needs_operator_attention");
    expect(
      attention.messages.find(
        (message) => message.messageId === finalMessage.messageId,
      )?.deliveryStatus,
    ).toBe("bounced");
    expect(attention.errors.at(-1)).toMatchObject({
      code: "mail.bounced",
      category: "permanent",
      retryable: false,
    });

    const replayed = await agent.recordMailDelivery(bounce);
    expect(replayed.revision).toBe(attention.revision);
    const outOfOrderDelivery = await agent.recordMailDelivery({
      ...bounce,
      providerEventId: "resend-event-late-delivered-001",
      eventDigest: sha256("signed-resend-late-delivered-event"),
      deliveryStatus: "delivered",
      permanent: false,
    });
    expect(outOfOrderDelivery.status).toBe("needs_operator_attention");
    expect(
      outOfOrderDelivery.messages.find(
        (message) => message.messageId === finalMessage.messageId,
      )?.deliveryStatus,
    ).toBe("bounced");
  });

  it("dead-letters a required customer email whose delivery cannot be verified before its deadline", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      mailDeliveryDeadlineMs: 1_000,
    });
    const paid = await beginPaidBuild("mail-delivery-deadline");
    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);
    const previewMessage = previewed.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;

    const pending = await agent.reconcileProject(paid.projectId);
    expect(
      pending.effects.find(
        (effect) =>
          effect.type === "reconcile_mail_delivery" &&
          effect.providerId === undefined,
      ),
    ).toMatchObject({ status: "pending" });
    now = new Date(now.getTime() + 1_001);

    const attention = await agent.reconcileProject(paid.projectId);

    expect(attention.status).toBe("needs_operator_attention");
    expect(deployment.requests).toHaveLength(0);
    expect(
      attention.effects.find(
        (effect) =>
          effect.key ===
          `mail:reconcile:${paid.projectId}:${previewMessage.providerMessageId}`,
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "mail.delivery_verification_timeout",
        category: "permanent",
        retryable: false,
      },
    });
    expect(
      store
        .listEvents(paid.projectId)
        .filter(
          (event) => event.type === "email.delivery_verification_timed_out",
        ),
    ).toHaveLength(1);
  });

  it("terminalizes a pending mail reconciliation effect when the delivery webhook wins the race", async () => {
    const paid = await beginPaidBuild("mail-delivery-webhook-race");
    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);
    const previewMessage = previewed.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    const waiting = await agent.reconcileProject(paid.projectId);
    const reconciliationKey = `mail:reconcile:${paid.projectId}:${previewMessage.providerMessageId}`;

    expect(
      waiting.effects.find((effect) => effect.key === reconciliationKey),
    ).toMatchObject({ status: "pending" });

    const delivered = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-preview-delivered-webhook-race",
      eventDigest: sha256("signed-preview-delivered-webhook-race"),
      providerMessageId: previewMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });

    expect(
      delivered.effects.find((effect) => effect.key === reconciliationKey),
    ).toMatchObject({
      status: "completed",
      providerId: previewMessage.providerMessageId,
    });
    expect(
      delivered.effects.filter(
        (effect) =>
          effect.key === reconciliationKey && effect.status === "pending",
      ),
    ).toHaveLength(0);

    const deployed = await agent.reconcileProject(paid.projectId);
    expect(deployed.status, JSON.stringify(deployed.errors.at(-1))).toBe(
      "delivering",
    );
    expect(deployment.requests).toHaveLength(1);
  });

  it("does not let delayed delivery for a superseded version complete the active version", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-delayed-v1-001",
      channel: "email",
      intakeId: "intake-agent-delayed-v1-001",
      sourceId: "eleven-conversation-delayed-v1-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-delayed-v1-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-stripe-event-delayed-v1"),
    );
    build.proveAll();
    const versionOnePreview = await agent.reconcileProject(paid.projectId);
    const versionOnePreviewMessage = versionOnePreview.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    mail.deliveryStates.set(
      versionOnePreviewMessage.providerMessageId!,
      "delivered",
    );
    const versionOneSent = await agent.reconcileProject(paid.projectId);
    const versionOneFinal = versionOneSent.messages.find(
      (message) => message.purpose === "final_delivery",
    )!;

    const versionTwoBuilding = await agent.receiveCustomerMessage({
      projectId: paid.projectId,
      providerEventId: "resend-event-delayed-v1-steering-001",
      eventDigest: sha256("signed-delayed-v1-steering-event"),
      providerMessageId: "resend-message-delayed-v1-steering-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: production delivery",
      content: "Please make the estimate form the primary call to action.",
    });
    expect(versionTwoBuilding.activeProposalVersion).toBe(2);
    build.proveAll();
    const versionTwoPreview = await agent.reconcileProject(paid.projectId);
    const versionTwoPreviewMessage = versionTwoPreview.messages
      .filter((message) => message.purpose === "proven_preview")
      .at(-1)!;
    mail.deliveryStates.set(
      versionTwoPreviewMessage.providerMessageId!,
      "delivered",
    );
    const versionTwoSent = await agent.reconcileProject(paid.projectId);
    const finalMessages = versionTwoSent.messages.filter(
      (message) => message.purpose === "final_delivery",
    );
    expect(finalMessages).toHaveLength(2);
    const versionTwoFinal = finalMessages.at(-1)!;

    const staleVersionOneFailure = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-delayed-v1-bounced-001",
      eventDigest: sha256("signed-delayed-v1-bounce-event"),
      providerMessageId: versionOneFinal.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "bounced",
      permanent: true,
    });
    expect(staleVersionOneFailure.status).toBe("delivering");

    const delayedVersionOne = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-delayed-v1-delivered-001",
      eventDigest: sha256("signed-delayed-v1-delivery-event"),
      providerMessageId: versionOneFinal.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    expect(delayedVersionOne.status).toBe("delivering");
    const completed = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-v2-delivered-001",
      eventDigest: sha256("signed-v2-delivery-event"),
      providerMessageId: versionTwoFinal.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    expect(completed.status).toBe("completed");
  });

  it("refreshes a stored frozen preview before email when too little review TTL remains", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-preview-refresh-001",
      channel: "email",
      intakeId: "intake-agent-preview-refresh-001",
      sourceId: "eleven-conversation-preview-refresh-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    let paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-preview-refresh-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-preview-refresh-payment"),
    );
    build.proveAll();
    const paymentMessage = paid.messages.find(
      (message) => message.purpose === "payment_confirmation",
    )!;
    paid = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-preview-refresh-payment-delivered-001",
      eventDigest: sha256("preview-refresh-payment-delivered"),
      providerMessageId: paymentMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    const dashboardMessage = paid.messages.find(
      (message) => message.purpose === "dashboard_access",
    )!;
    paid = await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: "resend-event-preview-refresh-dashboard-delivered-001",
      eventDigest: sha256("preview-refresh-dashboard-delivered"),
      providerMessageId: dashboardMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    mail.failOnSendCall = 4;

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "injected mail failure",
    );
    expect(build.previewRequests).toHaveLength(1);
    expect(store.getProject(paid.projectId)?.previews).toHaveLength(1);

    now = new Date("2026-07-24T11:30:00.000Z");
    build.previewExpiresAt = "2026-07-26T12:00:00.000Z";
    mail.failOnSendCall = null;
    const recovered = await agent.reconcileProject(paid.projectId);

    expect(build.previewRequests).toHaveLength(2);
    expect(recovered.previews).toHaveLength(1);
    expect(recovered.previews[0]?.expiresAt).toBe(build.previewExpiresAt);
    expect(
      mail.requests.find((request) =>
        request.subject.includes("Proven preview"),
      )?.text,
    ).toContain("/2");
  });

  it("recovers the inbox record when proven evidence was persisted before acknowledgement", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      effectRetryInitialDelayMs: 100,
      effectRetryMaxDelayMs: 100,
    });
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-proof-recovery-001",
      channel: "email",
      intakeId: "intake-agent-proof-recovery-001",
      sourceId: "eleven-conversation-proof-recovery-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const paid = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-proof-recovery-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-stripe-event-proof-recovery"),
    );

    build.proveAll();
    build.loseNextAcknowledgementResponse = true;
    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "simulated acknowledgement failure",
    );
    const afterResponseLoss = store.getProject(paid.projectId)!;
    expect(
      afterResponseLoss.effects.find(
        (effect) => effect.type === "acknowledge_proven_event",
      ),
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      error: { code: "effect.provider_failure", retryable: true },
    });
    now = new Date(now.getTime() + 101);

    const recovered = await agent.reconcileProject(paid.projectId);
    expect(
      recovered.effects.filter(
        (effect) => effect.type === "acknowledge_proven_event",
      ),
    ).toHaveLength(build.events.length);
    expect(
      recovered.effects
        .filter((effect) => effect.type === "acknowledge_proven_event")
        .every((effect) => effect.status === "completed"),
    ).toBe(true);
    for (const event of build.events) {
      expect(
        store.recordInbox("build-backend", event.eventId, digestJson(event)),
      ).toBe(false);
    }
  });

  it("resumes a partially dispatched paid batch without duplicating its first run", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-recovery-001",
      channel: "email",
      intakeId: "intake-agent-recovery-001",
      sourceId: "eleven-conversation-recovery-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const event: PaidCheckoutWebhook = {
      provider: "stripe",
      eventId: "stripe-event-recovery-001",
      createdAt: NOW,
      livemode: false,
      session: payment.session(checkout.sessionId),
    };
    build.failOnDispatchCall = 2;

    await expect(
      agent.confirmPayment(event, sha256("signed-recovery-event")),
    ).rejects.toThrow("injected dispatch failure");
    const partial = store.getProject(initial.projectId)!;
    expect(partial.buildBatches[0]?.runs).toHaveLength(1);
    expect(
      partial.messages.some(
        (message) => message.purpose === "dashboard_access",
      ),
    ).toBe(false);
    expect(
      partial.effects.some((effect) => effect.type === "send_dashboard_access"),
    ).toBe(false);

    build.failOnDispatchCall = null;
    const recovered = await agent.confirmPayment(
      event,
      sha256("signed-recovery-event"),
    );

    expect(recovered.status).toBe("building");
    expect(recovered.buildBatches[0]?.runs).toHaveLength(2);
    expect(build.assignments).toHaveLength(2);
    expect(
      recovered.messages.filter(
        (message) => message.purpose === "dashboard_access",
      ),
    ).toHaveLength(1);
  });

  it("emails missing intake questions and continues a no-proposal clarification reply into proposal v1", async () => {
    const unclear = await agent.acceptIntake({
      idempotencyKey: "voice-intake-clarify-001",
      channel: "email",
      intakeId: "intake-agent-clarify-001",
      sourceId: "eleven-conversation-clarify-001",
      receivedAt: NOW,
      content:
        "No name yet. Email jordan@example.com. I need a business website.",
      emailVerified: true,
      researchConsent: false,
    });

    expect(unclear.status).toBe("needs_clarification");
    expect(unclear.proposals).toHaveLength(0);
    expect(mail.requests.at(-1)?.subject).toContain("few details");

    const clarified = await agent.receiveCustomerMessage({
      projectId: unclear.projectId,
      providerEventId: "resend-event-clarify-001",
      eventDigest: sha256("signed-clarification-event"),
      providerMessageId: "resend-message-clarify-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: details",
      content:
        "My name is Jordan Lee. Build Mission Peak Electric a site. We agreed on USD 2,500.",
    });

    expect(clarified.status).toBe("awaiting_payment");
    expect(clarified.customer.displayName).toBe("Jordan Lee");
    expect(clarified.proposals).toHaveLength(1);
  });

  it("asks for an explicit ISO currency instead of treating a bare dollar sign as USD", async () => {
    const ambiguous = await agent.acceptIntake({
      idempotencyKey: "voice-intake-ambiguous-currency-001",
      channel: "email",
      intakeId: "intake-agent-ambiguous-currency-001",
      sourceId: "eleven-conversation-ambiguous-currency-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on $2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    expect(ambiguous.status).toBe("needs_clarification");
    expect(ambiguous.proposals).toHaveLength(0);
    expect(mail.requests.at(-1)?.text).toContain(
      "three-letter ISO currency code",
    );
  });

  it("asks for one-time commercial terms instead of creating Checkout for a monthly quote", async () => {
    const recurring = await agent.acceptIntake({
      idempotencyKey: "voice-intake-recurring-quote-001",
      channel: "email",
      intakeId: "intake-agent-recurring-quote-001",
      sourceId: "eleven-conversation-recurring-quote-001",
      receivedAt: NOW,
      content:
        "My name is Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500 monthly.",
      emailVerified: true,
      researchConsent: false,
    });

    expect(recurring.status).toBe("needs_clarification");
    expect(recurring.proposals).toHaveLength(0);
    expect(recurring.checkoutSessions).toHaveLength(0);
    expect(mail.requests.at(-1)?.text).toContain(
      "one-time, all-inclusive total",
    );
  });

  it("asks the customer to confirm provisional research instead of dead-lettering it as contract truth", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      research: new FakeResearch(),
    });
    const result = await agent.acceptIntake({
      idempotencyKey: "voice-intake-provisional-research-001",
      channel: "email",
      intakeId: "intake-agent-provisional-research-001",
      sourceId: "eleven-conversation-provisional-research-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site.\nPlease research our website https://missionpeak.example and use it for inspiration.\nWe agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: true,
    });

    expect(result.status).toBe("needs_clarification");
    expect(result.proposals).toHaveLength(0);
    expect(mail.requests.at(-1)?.text).toContain(
      "Research findings are provisional inspiration",
    );
  });

  it("resumes a proposal email after Checkout succeeded but mail failed", async () => {
    const intake = {
      idempotencyKey: "voice-intake-mail-recovery-001",
      channel: "email" as const,
      intakeId: "intake-agent-mail-recovery-001",
      sourceId: "eleven-conversation-mail-recovery-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    };
    mail.failOnSendCall = 1;

    await expect(agent.acceptIntake(intake)).rejects.toThrow(
      "injected mail failure",
    );
    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.acceptIntake(intake);

    expect(recovered.status).toBe("awaiting_payment");
    expect(recovered.checkoutSessions).toHaveLength(1);
    expect(
      recovered.effects.find((effect) =>
        effect.key.startsWith("mail:proposal:"),
      )?.status,
    ).toBe("completed");
  });

  it("persists deterministic intake before Fireworks and recovers inference without idempotency drift", async () => {
    const intake = {
      projectId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "voice-intake-inference-recovery-001",
      channel: "email" as const,
      intakeId: "intake-agent-inference-recovery-001",
      sourceId: "eleven-conversation-inference-recovery-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500. My SSN is 123-45-6789 and card is 4242 4242 4242 4242.",
      emailVerified: true,
      researchConsent: false,
    };
    reasoner.failNextAnalysis = true;

    await expect(agent.acceptIntake(intake)).rejects.toThrow(
      "injected analysis failure",
    );
    const checkpoint = store.getProject(intake.projectId)!;
    expect(checkpoint.status).toBe("intake_received");
    expect(checkpoint.proposals).toHaveLength(0);
    expect(checkpoint.intake.piiSpans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "government_identifier" }),
        expect.objectContaining({ category: "financial" }),
      ]),
    );

    const recovered = await agent.acceptIntake(intake);
    expect(recovered.status).toBe("awaiting_payment");
    expect(reasoner.analysisCalls).toBe(2);
    expect(reasoner.analyzeInputs[0]?.conversation).not.toContain(
      "123-45-6789",
    );
    expect(reasoner.analyzeInputs[0]?.conversation).not.toContain(
      "4242 4242 4242 4242",
    );
  });

  it("replays the exact persisted clarification after an outbound mail crash", async () => {
    const intake = {
      projectId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "voice-intake-clarification-mail-recovery-001",
      channel: "email" as const,
      intakeId: "intake-agent-clarification-mail-recovery-001",
      sourceId: "eleven-conversation-clarification-mail-recovery-001",
      receivedAt: NOW,
      content:
        "No name yet. Email jordan@example.com. I need a business website.",
      emailVerified: true,
      researchConsent: false,
    };
    mail.failOnSendCall = 1;

    await expect(agent.acceptIntake(intake)).rejects.toThrow(
      "injected mail failure",
    );
    const pending = store.getProject(intake.projectId)!;
    expect(pending.status).toBe("needs_clarification");
    expect(pending.openClarificationQuestions).not.toHaveLength(0);
    expect(
      pending.effects.find((effect) =>
        effect.key.startsWith("mail:clarification:"),
      )?.status,
    ).toBe("pending");

    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.reconcileProject(intake.projectId);
    expect(recovered.status).toBe("needs_clarification");
    expect(mail.requests).toHaveLength(1);
    expect(mail.requests[0]?.subject).toContain("few details");
    expect(
      recovered.effects.find((effect) =>
        effect.key.startsWith("mail:clarification:"),
      )?.status,
    ).toBe("completed");
  });

  it("recovers a paid revision after steering acknowledgement mail fails without sending a false payment receipt", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-steering-recovery-001",
      channel: "email",
      intakeId: "intake-agent-steering-recovery-001",
      sourceId: "eleven-conversation-steering-recovery-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const building = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-steering-recovery-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-steering-recovery-payment"),
    );
    mail.failOnSendCall = 4;

    await expect(
      agent.receiveCustomerMessage({
        projectId: building.projectId,
        providerEventId: "resend-event-steering-recovery-001",
        eventDigest: sha256("signed-steering-recovery-event"),
        providerMessageId: "resend-message-steering-recovery-001",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Re: paid plan",
        content: "Please make the estimate form the primary call to action.",
      }),
    ).rejects.toThrow("injected mail failure");
    const checkpoint = store.getProject(building.projectId)!;
    expect(checkpoint.status).toBe("paid");
    expect(checkpoint.activeProposalVersion).toBe(2);
    expect(checkpoint.buildBatches).toHaveLength(1);

    mail.failOnSendCall = null;
    now = new Date(now.getTime() + 1_000);
    const recovered = await agent.reconcileProject(building.projectId);
    expect(recovered.status).toBe("building");
    expect(recovered.buildBatches).toHaveLength(2);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Payment received"),
      ),
    ).toHaveLength(1);
    expect(
      mail.requests.some((request) =>
        request.subject.includes("Revision v2 queued"),
      ),
    ).toBe(true);
  });

  it("recovers a lost paid webhook against an in-flight pre-payment edit and processes the durable edit as paid steering", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-payment-edit-race-001",
      channel: "email",
      intakeId: "intake-agent-payment-edit-race-001",
      sourceId: "eleven-conversation-payment-edit-race-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);

    await expect(
      agent.receiveCustomerMessage({
        projectId: initial.projectId,
        providerEventId: "resend-event-payment-edit-race-001",
        eventDigest: sha256("signed-payment-edit-race-event"),
        providerMessageId: "resend-message-payment-edit-race-001",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Re: proposal",
        content: "Please make the estimate form the primary call to action.",
      }),
    ).rejects.toThrow(
      "Payment completed while a proposal revision was arriving",
    );
    expect(store.getProject(initial.projectId)?.status).toBe(
      "awaiting_customer_revision",
    );

    const resolved = await agent.reconcileProject(initial.projectId);
    expect(resolved.status).toBe("building");
    expect(resolved.paidProposalVersion).toBe(1);
    expect(resolved.payments[0]).toMatchObject({
      verificationSource: "provider_api",
      providerStateVerified: true,
      signatureVerified: false,
    });
    expect(resolved.activeProposalVersion).toBe(2);
    expect(resolved.proposals[1]?.commercialBasisVersion).toBe(1);
    expect(resolved.buildBatches).toHaveLength(1);
    expect(resolved.buildBatches[0]?.proposalVersion).toBe(2);
    expect(build.assignments).toHaveLength(2);
  });

  it("recovers a lost paid webhook before turning an in-flight commercial expansion into a replacement quote", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-payment-requote-race-001",
      channel: "email",
      intakeId: "intake-agent-payment-requote-race-001",
      sourceId: "eleven-conversation-payment-requote-race-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);

    await expect(
      agent.receiveCustomerMessage({
        projectId: initial.projectId,
        providerEventId: "resend-event-payment-requote-race-001",
        eventDigest: sha256("signed-payment-requote-race-event"),
        providerMessageId: "resend-message-payment-requote-race-001",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Re: proposal",
        content:
          "Please add a booking system. We agreed on a new price of USD 4,000",
      }),
    ).rejects.toThrow(
      "Payment completed while a proposal revision was arriving",
    );

    const requoted = await agent.reconcileProject(initial.projectId);

    expect(requoted.status).toBe("awaiting_payment");
    expect(requoted.paidProposalVersion).toBe(1);
    expect(requoted.payments).toHaveLength(1);
    expect(requoted.payments[0]?.verificationSource).toBe("provider_api");
    expect(requoted.activeProposalVersion).toBe(2);
    expect(requoted.proposals[1]?.quote).toEqual({
      amountMinor: 400_000,
      currency: "usd",
    });
    expect(requoted.checkoutSessions).toHaveLength(2);
    expect(requoted.checkoutSessions[0]?.status).toBe("complete");
    expect(requoted.checkoutSessions[1]?.status).toBe("open");
    expect(requoted.buildBatches).toHaveLength(0);
    expect(build.assignments).toHaveLength(0);
  });

  it("serializes queued customer revisions oldest-first without losing either message", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-ordered-revisions-001",
      channel: "email",
      intakeId: "intake-agent-ordered-revisions-001",
      sourceId: "eleven-conversation-ordered-revisions-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const building = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-ordered-revisions-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-ordered-revisions-payment"),
    );

    const pausedAnalysis = reasoner.pauseNextAnalysis();
    const firstRevision = agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-ordered-revision-a",
      eventDigest: sha256("signed-ordered-revision-a"),
      providerMessageId: "resend-message-ordered-revision-a",
      receivedAt: "2026-07-23T12:00:01.000Z",
      senderEmail: "jordan@example.com",
      subject: "Re: paid plan",
      content: "Update the headline wording.",
    });
    await pausedAnalysis.started;

    let secondSettled = false;
    const secondRevision = agent
      .receiveCustomerMessage({
        projectId: building.projectId,
        providerEventId: "resend-event-ordered-revision-b",
        eventDigest: sha256("signed-ordered-revision-b"),
        providerMessageId: "resend-message-ordered-revision-b",
        receivedAt: "2026-07-23T12:00:02.000Z",
        senderEmail: "jordan@example.com",
        subject: "Re: paid plan",
        content: "Make the site blue.",
      })
      .finally(() => {
        secondSettled = true;
      });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    pausedAnalysis.release();
    await firstRevision;
    const revised = await secondRevision;

    expect(
      reasoner.classifyInputs.map((input) => input.customerMessage),
    ).toEqual(
      expect.arrayContaining([
        "Update the headline wording.",
        "Make the site blue.",
      ]),
    );
    const inboundMessageIds = revised.messages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.messageId);
    const revisionEvents = store
      .listEvents(revised.projectId)
      .filter((event) => event.type === "proposal.paid_revision_created");
    expect(
      revisionEvents.map((event) => event.payload.consumedMessageIds),
    ).toEqual(inboundMessageIds.map((messageId) => [messageId]));
    expect(revised.proposals).toHaveLength(3);

    const replayed = await agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-ordered-revision-a-replay",
      eventDigest: sha256("signed-ordered-revision-a-replay"),
      providerMessageId: "resend-message-ordered-revision-a",
      receivedAt: "2026-07-23T12:00:01.000Z",
      senderEmail: "jordan@example.com",
      subject: "Re: paid plan",
      content: "Update the headline wording.",
    });
    expect(replayed.proposals).toHaveLength(3);
  });

  it("drains more than one bounded context window of durable customer revisions oldest-first", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-revision-backlog-001",
      channel: "email",
      intakeId: "intake-agent-revision-backlog-001",
      sourceId: "eleven-conversation-revision-backlog-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });

    for (let index = 1; index <= 51; index += 1) {
      reasoner.failNextAnalysis = true;
      await expect(
        agent.receiveCustomerMessage({
          projectId: initial.projectId,
          providerEventId: `resend-event-revision-backlog-${index}`,
          eventDigest: sha256(`signed-revision-backlog-${index}`),
          providerMessageId: `resend-message-revision-backlog-${index}`,
          receivedAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
          senderEmail: "jordan@example.com",
          subject: "Re: website",
          content: `Make accent color blue ${index}.`,
        }),
      ).rejects.toThrow("injected analysis failure");
    }

    const checkpoint = store.getProject(initial.projectId)!;
    const inboundMessageIds = checkpoint.messages
      .filter((message) => message.direction === "inbound")
      .map((message) => message.messageId);
    expect(inboundMessageIds).toHaveLength(51);

    const firstBatch = await agent.reconcileProject(initial.projectId);
    const firstRevisionEvent = store
      .listEvents(initial.projectId)
      .filter((event) => event.type === "proposal.created")
      .at(-1);
    expect(firstRevisionEvent?.payload.consumedMessageIds).toEqual(
      inboundMessageIds.slice(0, 50),
    );
    expect(firstBatch.activeProposalVersion).toBe(2);

    const drained = await agent.reconcileProject(initial.projectId);
    const consumedMessageIds = store
      .listEvents(initial.projectId)
      .filter((event) => event.type === "proposal.created")
      .flatMap((event) => event.payload.consumedMessageIds ?? []);
    expect(consumedMessageIds).toEqual(inboundMessageIds);
    expect(drained.activeProposalVersion).toBe(3);
    expect(drained.status).toBe("awaiting_payment");
  });

  it("records explicit message consumption when an authenticated reply changes no scope", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-no-scope-001",
      channel: "email",
      intakeId: "intake-agent-no-scope-001",
      sourceId: "eleven-conversation-no-scope-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const building = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-no-scope-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-no-scope-payment"),
    );

    const unchanged = await agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-no-scope-001",
      eventDigest: sha256("signed-no-scope-event"),
      providerMessageId: "resend-message-no-scope-001",
      receivedAt: "2026-07-23T12:00:01.000Z",
      senderEmail: "jordan@example.com",
      subject: "Re: paid plan",
      content: "Thanks, looks good.",
    });

    const inbound = unchanged.messages.find(
      (message) =>
        message.direction === "inbound" &&
        message.content === "Thanks, looks good.",
    )!;
    const noScopeEvent = store
      .listEvents(unchanged.projectId)
      .find((event) => event.type === "revision.no_scope_change");
    expect(noScopeEvent?.payload.consumedMessageIds).toEqual([
      inbound.messageId,
    ]);
    expect(unchanged.proposals).toHaveLength(1);
    expect(unchanged.status).toBe("building");
  });

  it("forces an ambiguous post-payment capability request to re-quote before Fireworks classification", async () => {
    const building = await beginPaidBuild("deterministic-paid-scope");

    const clarification = await agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-deterministic-paid-scope",
      eventDigest: sha256("signed-deterministic-paid-scope-event"),
      providerMessageId: "resend-message-deterministic-paid-scope",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: paid plan",
      content: "Can it take cards?",
    });

    expect(clarification.status).toBe("needs_clarification");
    expect(clarification.proposals).toHaveLength(1);
    expect(clarification.buildBatches).toHaveLength(1);
    expect(reasoner.classifyInputs).toHaveLength(0);
    expect(mail.requests.at(-1)?.text).toContain(
      "new agreed price and currency",
    );
  });

  it("retains an older paid build as evidence but withholds it while expanded scope needs clarification", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-unquoted-expansion-001",
      channel: "email",
      intakeId: "intake-agent-unquoted-expansion-001",
      sourceId: "eleven-conversation-unquoted-expansion-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const building = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-unquoted-expansion-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-unquoted-expansion-payment"),
    );

    const clarification = await agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-unquoted-expansion-001",
      eventDigest: sha256("signed-unquoted-expansion-event"),
      providerMessageId: "resend-message-unquoted-expansion-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: expand scope",
      content: "Add a full booking system.",
    });

    expect(clarification.status).toBe("needs_clarification");
    expect(clarification.proposals).toHaveLength(1);
    expect(clarification.buildBatches[0]?.status).toBe("building");
    expect(
      [...build.runs.values()].every(
        (snapshot) => !snapshot.run.cancelRequested,
      ),
    ).toBe(true);

    build.proveAll();
    const withheld = await agent.reconcileProject(clarification.projectId);
    expect(withheld.status).toBe("needs_clarification");
    expect(withheld.provenCandidates).toHaveLength(2);
    expect(withheld.previews).toHaveLength(0);
    expect(deployment.requests).toHaveLength(0);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(0);
  });

  it("withholds an older paid build while a replacement quote waits, then rebuilds the paid latest version", async () => {
    const initial = await agent.acceptIntake({
      idempotencyKey: "voice-intake-requote-001",
      channel: "email",
      intakeId: "intake-agent-requote-001",
      sourceId: "eleven-conversation-requote-001",
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = initial.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    const building = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-requote-paid-001",
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256("signed-requote-payment"),
    );

    const requoted = await agent.receiveCustomerMessage({
      projectId: building.projectId,
      providerEventId: "resend-event-requote-001",
      eventDigest: sha256("signed-requote-event"),
      providerMessageId: "resend-message-requote-001",
      receivedAt: NOW,
      senderEmail: "jordan@example.com",
      subject: "Re: expand scope",
      content:
        "Add a full booking system. We agreed on a new price of USD 4,000.",
    });

    expect(requoted.status).toBe("awaiting_payment");
    expect(requoted.activeProposalVersion).toBe(2);
    expect(requoted.proposals[1]?.commercialBasisVersion).toBeUndefined();
    expect(requoted.proposals[1]?.quote.amountMinor).toBe(400_000);
    expect(requoted.checkoutSessions.at(-1)?.amountMinor).toBe(400_000);
    expect(requoted.buildBatches[0]?.status).toBe("building");
    expect(
      [...build.runs.values()].every(
        (snapshot) => !snapshot.run.cancelRequested,
      ),
    ).toBe(true);

    build.proveAll();
    const withheld = await agent.reconcileProject(requoted.projectId);
    expect(withheld.status).toBe("awaiting_payment");
    expect(withheld.provenCandidates).toHaveLength(2);
    expect(withheld.previews).toHaveLength(0);
    expect(withheld.deployments).toHaveLength(0);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(0);

    const replacementCheckout = requoted.checkoutSessions.at(-1)!;
    payment.markPaid(replacementCheckout.sessionId);
    const replaced = await agent.confirmPayment(
      {
        provider: "stripe",
        eventId: "stripe-event-requote-paid-002",
        createdAt: NOW,
        livemode: false,
        session: payment.session(replacementCheckout.sessionId),
      },
      sha256("signed-requote-replacement-payment"),
    );
    expect(replaced.status).toBe("building");
    expect(replaced.paidProposalVersion).toBe(2);
    expect(replaced.buildBatches).toHaveLength(2);
    expect(replaced.buildBatches[0]?.status).toBe("cancelled");
    expect(replaced.buildBatches[1]?.proposalVersion).toBe(2);
    expect(replaced.activeBuildBatchId).toBe(replaced.buildBatches[1]?.batchId);

    build.proveAll();
    const latestPreview = await agent.reconcileProject(replaced.projectId);
    expect(latestPreview.status).toBe("preview_ready");
    expect(latestPreview.previews).toHaveLength(1);
    expect(latestPreview.previews[0]?.proposalVersion).toBe(2);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(1);
  });

  it("linearizes an inbound steering event with a customer-visible preview send", async () => {
    const paid = await beginPaidBuild("preview-steering-linearization");
    build.proveAll();
    const pausedSend = mail.pauseNextSend();
    const previewPromise = agent.reconcileProject(paid.projectId);
    await pausedSend.started;

    let steeringSettled = false;
    const steeringPromise = agent
      .receiveCustomerMessage({
        projectId: paid.projectId,
        providerEventId: "resend-preview-steering-linearization",
        eventDigest: sha256("signed-preview-steering-linearization"),
        providerMessageId: "resend-message-preview-steering-linearization",
        receivedAt: NOW,
        senderEmail: "jordan@example.com",
        subject: "Re: preview",
        content: "Please make the estimate form the primary call to action.",
      })
      .finally(() => {
        steeringSettled = true;
      });
    await Promise.resolve();
    await Promise.resolve();

    expect(steeringSettled).toBe(false);
    expect(store.getProject(paid.projectId)?.activeProposalVersion).toBe(1);

    pausedSend.release();
    const previewed = await previewPromise;
    const steered = await steeringPromise;

    expect(previewed.previews[0]?.proposalVersion).toBe(1);
    expect(steered.activeProposalVersion).toBe(2);
    expect(steered.status).toBe("building");
    expect(deployment.requests).toHaveLength(0);
    expect(
      steered.messages.filter(
        (message) => message.purpose === "proven_preview",
      ),
    ).toHaveLength(1);
  });

  it("cancels and durably retires builds that run past the batch deadline", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 1_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-running");
    for (const snapshot of build.runs.values()) {
      snapshot.run.status = "running";
      snapshot.run.stage = "generating";
    }
    now = new Date(now.getTime() + 1_001);

    const expired = await agent.reconcileProject(paid.projectId);

    expect(expired.status).toBe("no_proven_candidate");
    expect(expired.buildBatches[0]).toMatchObject({
      status: "failed",
      buildDeadlineAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
      proofEventDeadlineAt: now.toISOString(),
    });
    expect(
      expired.buildBatches[0]?.runs.every((run) => run.status === "cancelled"),
    ).toBe(true);
    expect(build.cancelRequests).toHaveLength(2);

    const replayed = await agent.reconcileProject(paid.projectId);
    expect(replayed).toEqual(expired);
    expect(build.cancelRequests).toHaveLength(2);
    expect(
      store
        .listEvents(paid.projectId)
        .filter((event) => event.type === "build.deadline_expired"),
    ).toHaveLength(1);
  });

  it("recovers an expired-run cancellation after the build backend loses its response", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 1_000,
      proofEventGracePeriodMs: 1_000,
      effectRetryInitialDelayMs: 100,
      effectRetryMaxDelayMs: 100,
    });
    const paid = await beginPaidBuild("deadline-cancel-response-loss");
    for (const snapshot of build.runs.values()) {
      snapshot.run.status = "running";
      snapshot.run.stage = "generating";
    }
    build.loseNextCancelResponse = true;
    now = new Date(now.getTime() + 1_001);

    await expect(agent.reconcileProject(paid.projectId)).rejects.toThrow(
      "simulated cancellation response loss",
    );
    const interrupted = store.getProject(paid.projectId)!;
    expect(
      interrupted.effects.find((effect) => effect.type === "cancel_build_run"),
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      error: { code: "effect.provider_failure", retryable: true },
    });
    now = new Date(now.getTime() + 101);

    const recovered = await agent.reconcileProject(paid.projectId);

    expect(recovered.status).toBe("no_proven_candidate");
    expect(
      recovered.effects.filter((effect) => effect.type === "cancel_build_run"),
    ).toHaveLength(2);
    expect(
      recovered.effects
        .filter((effect) => effect.type === "cancel_build_run")
        .every((effect) => effect.status === "completed"),
    ).toBe(true);
    expect(
      recovered.buildBatches[0]?.runs.every(
        (run) => run.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("retires stored nonterminal runs at the build deadline even when status polling is unavailable", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 1_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-status-unavailable");
    build.failBuildStatusReads = true;
    now = new Date(now.getTime() + 1_001);

    const retired = await agent.reconcileProject(paid.projectId);

    expect(retired.status).toBe("no_proven_candidate");
    expect(build.cancelRequests).toHaveLength(2);
    expect(
      retired.errors.find(
        (error) => error.code === "build.evidence_unavailable_at_deadline",
      ),
    ).toMatchObject({
      category: "transient",
      retryable: false,
    });
    expect(
      store
        .listEvents(paid.projectId)
        .filter(
          (event) => event.type === "build.evidence_unavailable_at_deadline",
        ),
    ).toHaveLength(1);
  });

  it("finishes the proof grace period from stored run evidence when outbox polling is unavailable", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 10_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-proof-poll-unavailable");
    for (const snapshot of build.runs.values()) {
      snapshot.run.status = "passed";
      snapshot.run.stage = "complete";
      snapshot.run.completedAt = NOW;
    }
    const grace = await agent.reconcileProject(paid.projectId);
    expect(grace.status).toBe("verifying");
    build.failProvenEventPolls = true;
    now = new Date(now.getTime() + 1_001);

    const exhausted = await agent.reconcileProject(paid.projectId);

    expect(exhausted.status).toBe("no_proven_candidate");
    expect(
      exhausted.errors.find(
        (error) => error.code === "build.evidence_unavailable_at_deadline",
      ),
    ).toBeDefined();
  });

  it("bounds the wait for a passed run whose proven event never arrives", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 10_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-missing-proof");
    for (const snapshot of build.runs.values()) {
      snapshot.run.status = "passed";
      snapshot.run.stage = "complete";
      snapshot.run.completedAt = NOW;
    }

    const grace = await agent.reconcileProject(paid.projectId);
    expect(grace.status).toBe("verifying");
    expect(grace.buildBatches[0]?.proofEventDeadlineAt).toBe(
      new Date(Date.parse(NOW) + 1_000).toISOString(),
    );
    now = new Date(now.getTime() + 999);
    expect((await agent.reconcileProject(paid.projectId)).status).toBe(
      "verifying",
    );
    now = new Date(now.getTime() + 2);

    const exhausted = await agent.reconcileProject(paid.projectId);
    expect(exhausted.status).toBe("no_proven_candidate");
    expect(build.cancelRequests).toHaveLength(0);
  });

  it("ranks an already-proven candidate and retires only the stalled peer at build expiry", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 1_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-partial-proof");
    build.proveAll();
    const stalledRun = [...build.runs.values()][1]!;
    stalledRun.run.status = "running";
    stalledRun.run.stage = "generating";
    build.events.splice(1);
    now = new Date(now.getTime() + 1_001);

    const previewed = await agent.reconcileProject(paid.projectId);

    expect(previewed.status).toBe("preview_ready");
    expect(previewed.previews).toHaveLength(1);
    expect(previewed.provenCandidates).toHaveLength(1);
    expect(build.cancelRequests).toEqual([stalledRun.run.id]);
    expect(previewed.buildBatches[0]?.runs[1]?.status).toBe("cancelled");

    await agent.reconcileProject(paid.projectId);
    expect(build.cancelRequests).toEqual([stalledRun.run.id]);
    expect(
      mail.requests.filter((request) =>
        request.subject.includes("Proven preview"),
      ),
    ).toHaveLength(1);
  });

  it("backfills and persists a deterministic deadline for a legacy active batch", async () => {
    agent = new OrchestrationAgent({
      ...baseAgentOptions,
      buildDeadlineMs: 10_000,
      proofEventGracePeriodMs: 1_000,
    });
    const paid = await beginPaidBuild("deadline-legacy");
    const legacy = structuredClone(paid);
    delete legacy.buildBatches[0]!.buildDeadlineAt;
    const savedLegacy = store.saveProject(legacy, paid.revision, {
      type: "test.legacy_batch_loaded",
      actor: "system",
      payload: { status: legacy.status },
    });

    const recovered = await agent.reconcileProject(savedLegacy.projectId);

    expect(recovered.buildBatches[0]?.buildDeadlineAt).toBe(
      new Date(
        Date.parse(recovered.buildBatches[0]!.createdAt) + 10_000,
      ).toISOString(),
    );
    expect(
      store
        .listEvents(paid.projectId)
        .filter((event) => event.type === "build.deadline_backfilled"),
    ).toHaveLength(1);
    await agent.reconcileProject(savedLegacy.projectId);
    expect(
      store
        .listEvents(paid.projectId)
        .filter((event) => event.type === "build.deadline_backfilled"),
    ).toHaveLength(1);
  });

  async function beginPaidBuild(id: string) {
    const awaiting = await agent.acceptIntake({
      idempotencyKey: `voice-intake-${id}`,
      channel: "email",
      intakeId: `intake-${id}`,
      sourceId: `eleven-${id}`,
      receivedAt: NOW,
      content:
        "I am Jordan Lee. Email jordan@example.com. Build Mission Peak Electric a site. We agreed on USD 2,500.",
      emailVerified: true,
      researchConsent: false,
    });
    const checkout = awaiting.checkoutSessions[0]!;
    payment.markPaid(checkout.sessionId);
    return agent.confirmPayment(
      {
        provider: "stripe",
        eventId: `stripe-paid-${id}`,
        createdAt: NOW,
        livemode: false,
        session: payment.session(checkout.sessionId),
      },
      sha256(`signed-stripe-${id}`),
    );
  }

  async function prepareDeliveredPreview(id: string) {
    const paid = await beginPaidBuild(id);
    build.proveAll();
    const previewed = await agent.reconcileProject(paid.projectId);
    const previewMessage = previewed.messages.find(
      (message) => message.purpose === "proven_preview",
    )!;
    await agent.recordMailDelivery({
      projectId: paid.projectId,
      providerEventId: `resend-preview-delivered-${id}`,
      eventDigest: sha256(`signed-preview-delivered-${id}`),
      providerMessageId: previewMessage.providerMessageId!,
      occurredAt: NOW,
      deliveryStatus: "delivered",
      permanent: false,
    });
    return paid;
  }
});

class FakeReasoner implements OrchestrationReasoner {
  readonly analyzeInputs: AnalyzeConversationInput[] = [];
  readonly draftInputs: DraftProposalInput[] = [];
  readonly classifyInputs: ClassifyChangeInput[] = [];
  analysisCalls = 0;
  failNextAnalysis = false;
  #nextAnalysisPause:
    | {
        started: () => void;
        released: Promise<void>;
      }
    | undefined;

  pauseNextAnalysis(): {
    started: Promise<void>;
    release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextAnalysisPause = {
      started: markStarted,
      released,
    };
    return { started, release };
  }

  analyzeConversation(
    input: AnalyzeConversationInput,
  ): Promise<ConversationAnalysis> {
    this.analysisCalls += 1;
    this.analyzeInputs.push(structuredClone(input));
    if (this.failNextAnalysis) {
      this.failNextAnalysis = false;
      return Promise.reject(new Error("injected analysis failure"));
    }
    const pause = this.#nextAnalysisPause;
    this.#nextAnalysisPause = undefined;
    if (pause) {
      pause.started();
      return pause.released.then(() => this.#conversationAnalysis(input));
    }
    return Promise.resolve(this.#conversationAnalysis(input));
  }

  #conversationAnalysis(input: AnalyzeConversationInput): ConversationAnalysis {
    if (
      input.conversation.includes("No name yet") &&
      !input.conversation.includes("My name is Jordan Lee")
    ) {
      return {
        customer: { email: "jordan@example.com" },
        piiSpans: [],
        quote: null,
        researchTargets: [],
        clarificationQuestions: ["Please provide the name and agreed price."],
      };
    }
    const nameStart = input.conversation.indexOf("Jordan Lee");
    const expandedQuote = input.conversation.includes("USD 4,000");
    const recurringQuote = input.conversation.includes("USD 2,500 monthly");
    const ambiguousDollarQuote =
      input.conversation.includes("$2,500") &&
      !input.conversation.includes("USD 2,500");
    const researchConsentEvidence =
      "Please research our website https://missionpeak.example and use it for inspiration.";
    return {
      customer: { name: "Jordan Lee", email: "jordan@example.com" },
      piiSpans:
        nameStart >= 0
          ? [
              {
                type: "person_name",
                startOffset: nameStart,
                endOffset: nameStart + "Jordan Lee".length,
                confidence: 1,
              },
            ]
          : [],
      quote: {
        amountMinor: expandedQuote ? 400_000 : 250_000,
        currency: "usd",
        evidenceExcerpt: expandedQuote
          ? "We agreed on a new price of USD 4,000"
          : recurringQuote
            ? "We agreed on USD 2,500 monthly."
            : ambiguousDollarQuote
              ? "We agreed on $2,500"
              : "We agreed on USD 2,500",
      },
      researchTargets: input.conversation.includes(researchConsentEvidence)
        ? [
            {
              url: "https://missionpeak.example",
              purpose: "Use the caller-owned site as provisional inspiration.",
              consentEvidenceExcerpt: researchConsentEvidence,
            },
          ]
        : [],
      clarificationQuestions: [],
    };
  }

  draftProposal(input: DraftProposalInput): Promise<ProposalPlan> {
    this.draftInputs.push(structuredClone(input));
    const baseRequirement = {
      id: "homepage",
      description: "Build Mission Peak Electric a site.",
      priority: "hard" as const,
      citation: {
        kind: "conversation" as const,
        excerpt: "Build Mission Peak Electric a site.",
      },
      verifiers: [
        {
          kind: "http" as const,
          path: "/",
          expectedStatus: 200,
          bodyIncludes: ["Mission Peak Electric"],
        },
      ],
    };
    const requirements = (
      input.priorPlan?.contractDraft.requirements ?? [baseRequirement]
    ).map((requirement) => structuredClone(requirement));
    const approvedFacts = [
      {
        id: "business-name",
        statement: "Build Mission Peak Electric a site.",
        citation: {
          kind: "conversation" as const,
          excerpt: "Build Mission Peak Electric a site.",
        },
      },
      ...(input.research.length > 0
        ? [
            {
              id: "research-hours",
              statement: "Open 24/7.",
              citation: {
                kind: "research" as const,
                url: input.research[0]!.url,
                excerpt: "Open 24/7.",
              },
            },
          ]
        : []),
    ];
    const boundedChanges = (input.customerChange?.split("\n\n") ?? []).filter(
      (change) =>
        /\b(?:alignment|blue|button|call\s+to\s+action|color|copy|cta|font|headline|layout|order|spacing|style|text|typography|wording)\b/iu.test(
          change,
        ),
    );
    for (const boundedChange of boundedChanges) {
      const changeId = `change-${sha256(boundedChange).slice(0, 16)}`;
      if (!requirements.some((requirement) => requirement.id === changeId)) {
        requirements.push({
          id: changeId,
          description: boundedChange,
          priority: "hard",
          citation: {
            kind: "conversation",
            excerpt: boundedChange,
          },
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: [boundedChange],
            },
          ],
        });
      }
    }
    return Promise.resolve({
      title: "Mission Peak Electric website",
      summary: input.customerChange
        ? "A revised service website with a prominent estimate flow."
        : "A service website with an estimate flow.",
      scopeItems: [
        {
          id: "website",
          text: "Build Mission Peak Electric a site.",
          citation: {
            kind: "conversation",
            excerpt: "Build Mission Peak Electric a site.",
          },
        },
      ],
      buildPrompt:
        "Build an accessible Mission Peak Electric service website with an estimate form.",
      strategyLabels: ["conversion-first", "trust-first"],
      assets: [],
      clarificationQuestions: [],
      contractDraft: {
        approvedFacts,
        forbiddenClaims: ["24/7 emergency service"],
        requirements,
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

  classifyChange(input: ClassifyChangeInput): Promise<ChangeClassification> {
    this.classifyInputs.push(structuredClone(input));
    if (input.customerMessage.includes("Thanks, looks good.")) {
      return Promise.resolve({
        kind: "no_scope_change",
        explanation: "The customer approved the current paid scope.",
        supersededScopeItems: [],
        supersededRequirementIds: [],
        supersededFactIds: [],
      });
    }
    if (input.customerMessage.includes("booking system")) {
      return Promise.resolve({
        kind: "requires_requote",
        explanation: "A booking system materially expands paid scope.",
        supersededScopeItems: [],
        supersededRequirementIds: [],
        supersededFactIds: [],
      });
    }
    return Promise.resolve({
      kind: "within_paid_scope",
      explanation: "Presentation change within the paid scope.",
      supersededScopeItems: [],
      supersededRequirementIds: [],
      supersededFactIds: [],
    });
  }
}

function dashboardLoginToken(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}

class FakePayment implements PaymentPort {
  private readonly sessions = new Map<string, CheckoutSession>();
  readonly createRequests: CreateCheckoutSessionRequest[] = [];
  readonly expireRequests: string[] = [];
  readonly retrieveRequests: string[] = [];
  loseNextExpireResponse = false;
  failNextRetrieve = false;

  health(): Promise<void> {
    return Promise.resolve();
  }

  createCheckoutSession(
    request: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    this.createRequests.push(structuredClone(request));
    const sessionId = `cs_test_${this.sessions.size + 1}`;
    const session: CheckoutSession = {
      provider: "stripe",
      sessionId,
      livemode: false,
      url: `https://checkout.stripe.test/${sessionId}`,
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
      createdAt: NOW,
      expiresAt: "2026-07-24T12:00:00.000Z",
    };
    this.sessions.set(sessionId, session);
    return Promise.resolve(structuredClone(session));
  }

  expireCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    this.expireRequests.push(sessionId);
    const session = this.require(sessionId);
    if (session.paymentStatus === "paid") {
      return Promise.reject(new Error("cannot expire a paid Checkout Session"));
    }
    session.status = "expired";
    if (this.loseNextExpireResponse) {
      this.loseNextExpireResponse = false;
      return Promise.reject(
        new Error("injected lost Checkout expiration response"),
      );
    }
    return Promise.resolve(structuredClone(session));
  }

  parseWebhook(_webhook: RawStripeWebhook): PaidCheckoutWebhook | null {
    throw new Error("not used");
  }

  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    this.retrieveRequests.push(sessionId);
    if (this.failNextRetrieve) {
      this.failNextRetrieve = false;
      return Promise.reject(new Error("injected Stripe retrieval failure"));
    }
    return Promise.resolve(structuredClone(this.require(sessionId)));
  }

  verifySettlement(
    request: Parameters<PaymentPort["verifySettlement"]>[0],
  ): ReturnType<PaymentPort["verifySettlement"]> {
    const session = this.require(request.checkoutSessionId);
    if (
      session.paymentIntentId !== request.paymentIntentId ||
      session.paymentStatus !== "paid"
    ) {
      return Promise.reject(new Error("fake settlement mismatch"));
    }
    return Promise.resolve({
      provider: "stripe",
      checkoutSessionId: request.checkoutSessionId,
      paymentIntentId: request.paymentIntentId,
      projectId: request.projectId,
      proposalId: request.proposalId,
      proposalVersion: request.proposalVersion,
      proposalDigest: request.proposalDigest,
      amountMinor: request.amountMinor,
      amountReceivedMinor: request.amountMinor,
      currency: request.currency,
      customerEmail: request.customerEmail,
      customerId: null,
      livemode: request.livemode,
      checkoutStatus: "complete",
      paymentStatus: "paid",
      paymentIntentStatus: "succeeded",
      paymentIntentCreatedAt: NOW,
    });
  }

  markPaid(sessionId: string): void {
    const session = this.require(sessionId);
    session.status = "complete";
    session.paymentStatus = "paid";
    session.paymentIntentId = `pi_${sessionId}`;
  }

  expireExternally(sessionId: string): void {
    const session = this.require(sessionId);
    session.status = "expired";
    session.paymentStatus = "unpaid";
    session.paymentIntentId = null;
  }

  tamperSession(sessionId: string, patch: Partial<CheckoutSession>): void {
    Object.assign(this.require(sessionId), patch);
  }

  session(sessionId: string): CheckoutSession {
    return structuredClone(this.require(sessionId));
  }

  private require(sessionId: string): CheckoutSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("missing fake session");
    }
    return session;
  }
}

class FakeMail implements MailPort {
  readonly requests: SendMailRequest[] = [];
  readonly retrieveRequests: string[] = [];
  readonly deliveryStates = new Map<
    string,
    OutboundMailProviderState["status"]
  >();
  failOnSendCall: number | null = null;
  #sendCalls = 0;
  #nextSendPause:
    | {
        started: () => void;
        released: Promise<void>;
      }
    | undefined;

  pauseNextSend(): {
    started: Promise<void>;
    release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#nextSendPause = {
      started: markStarted,
      released,
    };
    return { started, release };
  }

  health(): Promise<void> {
    return Promise.resolve();
  }

  async send(request: SendMailRequest): Promise<SentMail> {
    this.#sendCalls += 1;
    if (this.#sendCalls === this.failOnSendCall) {
      return Promise.reject(new Error("injected mail failure"));
    }
    this.requests.push(request);
    const sent = {
      provider: "resend",
      messageId: `mail-${this.requests.length}`,
    } as const;
    this.deliveryStates.set(sent.messageId, "pending");
    const pause = this.#nextSendPause;
    this.#nextSendPause = undefined;
    if (pause) {
      pause.started();
      await pause.released;
    }
    return sent;
  }

  retrieveOutboundDelivery(
    messageId: string,
  ): Promise<OutboundMailProviderState> {
    this.retrieveRequests.push(messageId);
    const status = this.deliveryStates.get(messageId);
    if (!status) {
      return Promise.reject(new Error("missing fake outbound email"));
    }
    return Promise.resolve({
      provider: "resend",
      messageId,
      status,
      verifiedAt: NOW,
      permanent: status === "bounced" || status === "failed",
    });
  }

  parseWebhook(_webhook: RawResendWebhook): InboundMailNotification | null {
    throw new Error("not used");
  }

  retrieveInboundEmail(_emailId: string): Promise<InboundMail> {
    throw new Error("not used");
  }
}

class NoResearch implements WebsiteResearchPort {
  capture(_request: CaptureWebsiteRequest): Promise<WebsiteResearchCapture> {
    throw new Error("not expected");
  }
}

class FakeResearch implements WebsiteResearchPort {
  capture(request: CaptureWebsiteRequest): Promise<WebsiteResearchCapture> {
    const url = new URL(request.url).toString();
    const textExcerpt = "Open 24/7.";
    return Promise.resolve({
      url,
      requestedUrl: url,
      finalUrl: url,
      redirectChain: [url],
      capturedAt: NOW,
      retrievedAt: NOW,
      textExcerpt,
      sha256: sha256(textExcerpt),
    });
  }
}

class FakeBuildBackend implements BuildBackendPort {
  readonly assignments: Parameters<BuildBackendPort["dispatchBuild"]>[0][] = [];
  readonly runs = new Map<string, BuildRunSnapshot>();
  readonly events: OutboxEvent[] = [];
  readonly acknowledged: string[] = [];
  readonly cancelRequests: string[] = [];
  readonly previewRequests: ProvenPreviewRequest[] = [];
  previewExpiresAt = "2026-07-24T12:00:00.000Z";
  onGetProvenPreview: (() => void) | undefined;
  loseNextAcknowledgementResponse = false;
  loseNextCancelResponse = false;
  failBuildStatusReads = false;
  failProvenEventPolls = false;
  failOnDispatchCall: number | null = null;
  #dispatchCalls = 0;

  health(): Promise<void> {
    return Promise.resolve();
  }

  dispatchBuild(
    assignment: Parameters<BuildBackendPort["dispatchBuild"]>[0],
  ): Promise<BuildDispatchReceipt> {
    this.#dispatchCalls += 1;
    if (this.#dispatchCalls === this.failOnDispatchCall) {
      return Promise.reject(new Error("injected dispatch failure"));
    }
    this.assignments.push(assignment);
    const receipt: BuildDispatchReceipt = {
      created: true,
      run: {
        id: randomUUID(),
        assignmentId: assignment.assignmentId,
        assignmentHash: assignmentDigest(assignment),
        projectId: assignment.projectId,
        candidateId: assignment.candidateId,
        contractHash: contractDigest(assignment.contract),
        status: "queued",
        stage: "queued",
        cancelRequested: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    this.runs.set(receipt.run.id, {
      run: structuredClone(receipt.run),
      artifact: null,
    });
    return Promise.resolve(receipt);
  }

  getBuildRun(runId: string): Promise<BuildRunSnapshot> {
    if (this.failBuildStatusReads) {
      return Promise.reject(new Error("injected build status read failure"));
    }
    const snapshot = this.runs.get(runId);
    if (!snapshot) {
      throw new Error("missing fake run");
    }
    return Promise.resolve(structuredClone(snapshot));
  }

  getCustomerBuildObservation(): never {
    throw new Error("not used");
  }

  cancelBuild(runId: string): Promise<BuildRunSnapshot["run"]> {
    const snapshot = this.runs.get(runId);
    if (!snapshot) {
      throw new Error("missing fake run");
    }
    this.cancelRequests.push(runId);
    snapshot.run.cancelRequested = true;
    if (
      !["passed", "rejected", "failed", "cancelled"].includes(
        snapshot.run.status,
      )
    ) {
      snapshot.run.status = "cancelled";
      snapshot.run.stage = "complete";
      snapshot.run.completedAt = NOW;
    }
    if (this.loseNextCancelResponse) {
      this.loseNextCancelResponse = false;
      return Promise.reject(new Error("simulated cancellation response loss"));
    }
    return Promise.resolve(structuredClone(snapshot.run));
  }

  pollProvenEvents(_request?: ProvenEventPollRequest): Promise<OutboxEvent[]> {
    if (this.failProvenEventPolls) {
      return Promise.reject(new Error("injected proven event poll failure"));
    }
    return Promise.resolve(
      this.events
        .filter((event) => !this.acknowledged.includes(event.eventId))
        .map((event) => structuredClone(event)),
    );
  }

  acknowledgeProvenEvent(eventId: string): Promise<void> {
    if (!this.events.some((event) => event.eventId === eventId)) {
      throw new Error("missing fake event");
    }
    if (!this.acknowledged.includes(eventId)) {
      this.acknowledged.push(eventId);
    }
    if (this.loseNextAcknowledgementResponse) {
      this.loseNextAcknowledgementResponse = false;
      return Promise.reject(new Error("simulated acknowledgement failure"));
    }
    return Promise.resolve();
  }

  getProvenPreview(
    request: ProvenPreviewRequest,
  ): Promise<FrozenProvenPreview> {
    this.previewRequests.push(structuredClone(request));
    this.onGetProvenPreview?.();
    const { event } = request;
    return Promise.resolve({
      kind: "frozen_proven_preview",
      eventId: event.eventId,
      runId: event.runId,
      artifactId: event.payload.artifact.artifactId,
      revisionHash: event.revisionHash,
      artifactSha256: event.payload.artifact.sha256,
      snapshotId: event.payload.artifact.daytonaSnapshot,
      url: `https://preview.example/${event.eventId}/${this.previewRequests.length}`,
      expiresAt: this.previewExpiresAt,
    });
  }

  downloadProvenArtifact(
    event: Parameters<BuildBackendPort["downloadProvenArtifact"]>[0],
  ): Promise<ValidatedProvenArtifact> {
    return Promise.resolve(new FakeValidatedArtifact(event));
  }

  proveAll(): void {
    for (const [index, assignment] of this.assignments.entries()) {
      const snapshot = [...this.runs.values()].find(
        (candidate) => candidate.run.assignmentId === assignment.assignmentId,
      );
      if (!snapshot) {
        throw new Error("missing assignment run");
      }
      if (
        snapshot.run.status === "passed" &&
        this.events.some((event) => event.runId === snapshot.run.id)
      ) {
        continue;
      }
      const revisionHash = sha256(`${snapshot.run.id}:revision`);
      const provenArtifact = artifact(snapshot.run.id, revisionHash);
      snapshot.run.status = "passed";
      snapshot.run.stage = "complete";
      snapshot.run.revisionHash = revisionHash;
      snapshot.run.sandboxId = `sandbox-${index + 1}`;
      snapshot.run.previewPort = 3000;
      snapshot.run.completedAt = NOW;
      snapshot.artifact = provenArtifact;
      const traceId = `trace-${index + 1}`;
      this.events.push(
        OutboxEventSchema.parse({
          eventId: randomUUID(),
          type: "candidate.proven",
          runId: snapshot.run.id,
          revisionHash,
          traceId,
          payload: {
            runId: snapshot.run.id,
            projectId: assignment.projectId,
            candidateId: assignment.candidateId,
            contractHash: snapshot.run.contractHash,
            revisionHash,
            sandboxId: snapshot.run.sandboxId,
            previewPort: snapshot.run.previewPort,
            artifact: provenArtifact,
            traceId,
            ranking: {
              provider: "braintrust",
              policyVersion: "braintrust-preference-v1",
              preferenceSatisfaction: index === 0 ? 0.7 : 0.9,
              scoreTuple: [index === 0 ? 0.7 : 0.9],
              traceId,
            },
          },
          createdAt: NOW,
        }),
      );
    }
  }

  highestRankedEvent(): OutboxEvent {
    const event = [...this.events].sort(
      (left, right) =>
        right.payload.ranking.scoreTuple[0] -
        left.payload.ranking.scoreTuple[0],
    )[0];
    if (!event) {
      throw new Error("no fake proven event");
    }
    return event;
  }
}

class FakeValidatedArtifact extends ValidatedProvenArtifact {
  readonly eventId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly contractHash: string;
  readonly revisionHash: string;
  readonly artifactId: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
  readonly workspaceSha256 = "e".repeat(64);
  readonly directory = "/tmp/buildlapse-fake-proven";
  #cleaned = false;

  constructor(event: OutboxEvent) {
    super();
    this.eventId = event.eventId;
    this.runId = event.runId;
    this.projectId = event.payload.projectId;
    this.candidateId = event.payload.candidateId;
    this.contractHash = event.payload.contractHash;
    this.revisionHash = event.revisionHash;
    this.artifactId = event.payload.artifact.artifactId;
    this.sourceSha256 = event.payload.artifact.sha256;
    this.sourceSizeBytes = event.payload.artifact.sizeBytes;
  }

  assertUsable(): void {
    if (this.#cleaned) {
      throw new Error("fake artifact already cleaned");
    }
  }

  cleanup(): Promise<void> {
    this.#cleaned = true;
    return Promise.resolve();
  }
}

class FakeDeployment implements FlyDeploymentPort {
  readonly requests: Parameters<
    FlyDeploymentPort["deployProvenArtifact"]
  >[0][] = [];
  failNextDeployment = false;

  health(): Promise<void> {
    return Promise.resolve();
  }

  deployProvenArtifact(
    request: Parameters<FlyDeploymentPort["deployProvenArtifact"]>[0],
  ): Promise<FlyDeploymentReceipt> {
    this.requests.push(request);
    if (this.failNextDeployment) {
      this.failNextDeployment = false;
      return Promise.reject(
        new Error("injected deployment verification failure"),
      );
    }
    return Promise.resolve({
      provider: "fly",
      appName: "buildlapse-project",
      releaseKey: sha256(request.event.eventId),
      projectId: request.event.payload.projectId,
      candidateId: request.event.payload.candidateId,
      contractHash: request.event.payload.contractHash,
      revisionHash: request.event.revisionHash,
      sourceArtifactSha256: request.event.payload.artifact.sha256,
      workspaceSha256: request.artifact.workspaceSha256,
      flyReleaseId: "fly-release-001",
      flyReleaseVersion: 1,
      imageDigest: `sha256:${"f".repeat(64)}`,
      machineIds: ["machine-001"],
      machineInstanceIds: ["instance-001"],
      verifiedLabels: {
        releaseKey: sha256(request.event.eventId),
        artifactSha256: request.event.payload.artifact.sha256,
      },
      deploymentAttempted: true,
      recoveredFromProvider: false,
      productionUrl: "https://buildlapse-project.fly.dev/",
      deployedAt: NOW,
      releaseVerifiedAt: NOW,
      healthVerifiedAt: NOW,
      healthAttempts: 1,
    });
  }
}
