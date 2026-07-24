import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CustomerDashboardLoginConflictError,
  InboxConflictError,
  OptimisticConcurrencyError,
  OrchestrationIdempotencyConflictError,
  SqliteOrchestrationStore,
} from "../src/orchestration/adapters/sqlite/orchestration-store.js";
import {
  acceptanceContractDigest,
  BuildBatchSchema,
  ProjectAggregateSchema,
  proposalDigest,
} from "../src/orchestration/domain/project.js";
import type {
  AcceptanceContractContent,
  CreateProjectInput,
  ProposalVersionContent,
  ProjectEventInput,
} from "../src/orchestration/domain/project.js";
import { sha256 } from "../src/lib/canonical-json.js";

const NOW = "2026-07-23T19:00:00.000Z";
const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createInput(idempotencyKey = "intake-key-001"): CreateProjectInput {
  const content =
    "My name is Ava Chen. Email ava.secret@example.com. Build a bakery site.";
  const name = "Ava Chen";
  const email = "ava.secret@example.com";
  const nameStart = content.indexOf(name);
  const emailStart = content.indexOf(email);

  return {
    projectId: "project-encrypted-001",
    idempotencyKey,
    status: "intake_received",
    intake: {
      kind: "voice",
      intakeId: "intake-001",
      receivedAt: NOW,
      content,
      contentDigest: sha256(content),
      piiSpans: [
        {
          category: "name",
          startOffset: nameStart,
          endOffset: nameStart + name.length,
          valueDigest: sha256(name),
          confidence: 1,
          handling: "retain_in_profile",
        },
        {
          category: "email",
          startOffset: emailStart,
          endOffset: emailStart + email.length,
          valueDigest: sha256(email),
          confidence: 1,
          handling: "retain_in_profile",
        },
      ],
      source: {
        provider: "elevenlabs",
        conversationId: "conversation-001",
      },
    },
    customer: {
      profileId: "profile-001",
      displayName: name,
      email: {
        value: email,
        verified: true,
        verifiedAt: NOW,
      },
      organizationName: "Ava Secret Bakery",
      preferredChannel: "email",
      researchConsent: {
        granted: true,
        scope: "own_business_only",
        capturedAt: NOW,
        sourceIntakeId: "intake-001",
      },
    },
  };
}

function proposalFixture(projectId: string) {
  const intake = createInput().intake;
  const sourceId = "source-001";
  const minimizedContent = intake.content
    .replace("Ava Chen", "█".repeat("Ava Chen".length))
    .replace(
      "ava.secret@example.com",
      "█".repeat("ava.secret@example.com".length),
    );
  const contractContent: AcceptanceContractContent = {
    contractId: "contract-001",
    projectId,
    version: 1,
    approvedFacts: [],
    forbiddenClaims: ["No unsupported guarantees"],
    requirements: [
      {
        requirementId: "requirement-001",
        description: "Provide a responsive bakery landing page",
        priority: "hard",
        sourceIds: [sourceId],
        evidenceBasis: "customer_conversation",
        verificationBasis: "system_policy",
        verifiers: [
          {
            kind: "http",
            path: "/",
            expectedStatus: 200,
            bodyIncludes: ["Bakery"],
          },
        ],
      },
    ],
    verification: {
      origin: "system_policy",
      policyId: "buildlabs-proof-gate-v1",
      buildCommand: "npm run build",
      testCommands: ["npm test"],
      previewCommand: "npm start",
      previewPort: 3000,
    },
    createdAt: NOW,
  };
  const contract = {
    ...contractContent,
    digest: acceptanceContractDigest(contractContent),
  };
  const proposalContent: ProposalVersionContent = {
    proposalId: "proposal-001",
    version: 1,
    projectTitle: "Ava Secret Bakery",
    buildPrompt: "Build the approved responsive bakery landing page.",
    strategyLabels: ["editorial"],
    sources: [
      {
        sourceId,
        kind: "intake",
        intakeId: intake.intakeId,
        contentDigest: intake.contentDigest,
        minimizedContentDigest: sha256(minimizedContent),
        startOffset: 0,
        endOffset: minimizedContent.length,
        excerpt: minimizedContent,
        excerptDigest: sha256(minimizedContent),
      },
    ],
    plan: {
      summary: {
        text: "A responsive bakery landing page.",
        sourceIds: [sourceId],
      },
      deliverables: [
        {
          itemId: "deliverable-001",
          text: "Bakery landing page",
          sourceIds: [sourceId],
          evidenceBasis: "customer_conversation",
        },
      ],
      requirements: [
        {
          itemId: "requirement-001",
          text: "Responsive presentation",
          sourceIds: [sourceId],
          priority: "hard",
          evidenceBasis: "customer_conversation",
          verificationBasis: "system_policy",
        },
      ],
      approvedFacts: [],
      assets: [],
      exclusions: [],
      unknowns: [],
    },
    quote: { amountMinor: 125_00, currency: "usd" },
    contract,
    createdAt: NOW,
  };
  return {
    ...proposalContent,
    digest: proposalDigest(proposalContent),
  };
}

describe("SqliteOrchestrationStore", () => {
  let store: SqliteOrchestrationStore;

  beforeEach(() => {
    store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: KEY,
      now: () => new Date(NOW),
    });
  });

  afterEach(() => {
    store.close();
  });

  it("round-trips the full aggregate and an immutable redacted event ledger", () => {
    const first = store.createProject(createInput());
    expect(first.created).toBe(true);
    expect(store.getProject(first.project.projectId)).toEqual(first.project);

    const changed = structuredClone(first.project);
    changed.status = "needs_clarification";
    const saved = store.saveProject(changed, 0, {
      type: "project.clarification_needed",
      actor: "system",
      payload: {
        previousStatus: "intake_received",
        status: "needs_clarification",
        correlationId: "clarification-001",
      },
    });

    expect(saved.revision).toBe(1);
    expect(store.getProject(saved.projectId)).toEqual(saved);
    expect(store.listEvents(saved.projectId)).toMatchObject([
      {
        aggregateRevision: 0,
        type: "project.created",
        payload: { status: "intake_received" },
      },
      {
        aggregateRevision: 1,
        type: "project.clarification_needed",
        payload: {
          previousStatus: "intake_received",
          status: "needs_clarification",
          correlationId: "clarification-001",
        },
      },
    ]);
  });

  it("does not persist sensitive aggregate plaintext in a file-backed database", () => {
    store.close();
    const directory = mkdtempSync(join(tmpdir(), "buildlabs-orchestration-"));
    const path = join(directory, "orchestration.sqlite");
    try {
      store = new SqliteOrchestrationStore({
        path,
        encryptionKey: KEY,
        now: () => new Date(NOW),
      });
      store.createProject(createInput("file-key-001"));
      store.close();

      const databaseBytes = readFileSync(path);
      for (const secret of [
        "Ava Chen",
        "ava.secret@example.com",
        "Ava Secret Bakery",
        "Build a bakery site",
      ]) {
        expect(databaseBytes.includes(Buffer.from(secret, "utf8"))).toBe(false);
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays identical intake idempotently and rejects key reuse", () => {
    const first = store.createProject(createInput());
    const replay = store.createProject(createInput());
    expect(replay).toEqual({ project: first.project, created: false });

    const changed = createInput();
    changed.customer.organizationName = "A different business";
    expect(() => store.createProject(changed)).toThrow(
      OrchestrationIdempotencyConflictError,
    );
  });

  it("uses aggregate revision as an optimistic compare-and-set token", () => {
    const created = store.createProject(createInput()).project;
    const firstWriter = structuredClone(created);
    const staleWriter = structuredClone(created);
    firstWriter.status = "researching";
    staleWriter.status = "needs_clarification";

    store.saveProject(firstWriter, 0, {
      type: "project.research_started",
      actor: "system",
      payload: {
        previousStatus: "intake_received",
        status: "researching",
      },
    });

    expect(() =>
      store.saveProject(staleWriter, 0, {
        type: "project.clarification_needed",
        actor: "system",
        payload: {
          previousStatus: "intake_received",
          status: "needs_clarification",
        },
      }),
    ).toThrow(OptimisticConcurrencyError);
    expect(store.getProject(created.projectId)).toMatchObject({
      revision: 1,
      status: "researching",
    });
    expect(store.listEvents(created.projectId)).toHaveLength(2);
  });

  it("deduplicates authenticated webhook inbox replays by provider and event id", () => {
    const firstDigest = sha256("signed raw stripe body");
    expect(store.recordInbox("stripe", "evt_paid_001", firstDigest)).toBe(true);
    expect(store.recordInbox("stripe", "evt_paid_001", firstDigest)).toBe(
      false,
    );
    expect(() =>
      store.recordInbox("stripe", "evt_paid_001", sha256("different body")),
    ).toThrow(InboxConflictError);

    expect(
      store.recordInbox("resend", "evt_paid_001", sha256("resend body")),
    ).toBe(true);
  });

  it("retains bounded immutable invalid-webhook fingerprints and summarizes overflow", () => {
    store.close();
    store = new SqliteOrchestrationStore({
      path: ":memory:",
      encryptionKey: KEY,
      now: () => new Date(NOW),
      securityAuditReceiptLimit: 1,
    });
    const first = {
      provider: "stripe" as const,
      bodyDigest: sha256("invalid Stripe body one"),
      headerDigest: sha256("invalid Stripe signature one"),
      failureCode: "webhook_verification_failed" as const,
    };

    expect(store.recordWebhookSecurityFailure(first)).toEqual({
      outcome: "recorded",
    });
    expect(store.recordWebhookSecurityFailure(first)).toEqual({
      outcome: "duplicate",
    });
    expect(
      store.recordWebhookSecurityFailure({
        provider: "resend",
        bodyDigest: sha256("invalid Resend body two"),
        headerDigest: sha256("invalid Resend headers two"),
        failureCode: "invalid_signature_headers",
      }),
    ).toEqual({ outcome: "overflow_summarized" });

    expect(store.summarizeWebhookSecurityFailures()).toEqual({
      receiptLimit: 1,
      retainedReceiptCount: 1,
      overflowObservationCount: 1,
      groups: [
        {
          provider: "resend",
          failureCode: "invalid_signature_headers",
          retainedReceiptCount: 0,
          overflowObservationCount: 1,
          firstObservedAt: NOW,
          lastObservedAt: NOW,
        },
        {
          provider: "stripe",
          failureCode: "webhook_verification_failed",
          retainedReceiptCount: 1,
          overflowObservationCount: 0,
          firstObservedAt: NOW,
          lastObservedAt: NOW,
        },
      ],
    });
  });

  it("prevents mutation or deletion of retained webhook security receipts", () => {
    store.close();
    const directory = mkdtempSync(join(tmpdir(), "buildlabs-security-audit-"));
    const path = join(directory, "orchestration.sqlite");
    let database: DatabaseSync | undefined;
    try {
      store = new SqliteOrchestrationStore({
        path,
        encryptionKey: KEY,
        now: () => new Date(NOW),
      });
      store.recordWebhookSecurityFailure({
        provider: "stripe",
        bodyDigest: sha256("invalid webhook body"),
        headerDigest: sha256("invalid webhook signature"),
        failureCode: "webhook_verification_failed",
      });
      store.close();

      database = new DatabaseSync(path);
      expect(() =>
        database!
          .prepare(
            `UPDATE orchestration_webhook_security_audit
             SET failure_code = 'invalid_signature_headers'`,
          )
          .run(),
      ).toThrow(/immutable/u);
      expect(() =>
        database!
          .prepare("DELETE FROM orchestration_webhook_security_audit")
          .run(),
      ).toThrow(/immutable/u);
    } finally {
      database?.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("commits a verified inbox receipt and its aggregate transition atomically", () => {
    const created = store.createProject(createInput()).project;
    const changed = structuredClone(created);
    changed.status = "researching";
    const digest = sha256("signed provider body");
    const event = {
      type: "project.research_started",
      actor: "provider",
      payload: {
        previousStatus: "intake_received",
        status: "researching",
        provider: "resend",
        providerEventDigest: digest,
      },
    } as const;
    const inbox = {
      provider: "resend",
      eventId: "email-event-atomic-001",
      digest,
    };

    const saved = store.saveProject(changed, created.revision, event, inbox);
    expect(saved).toMatchObject({ revision: 1, status: "researching" });

    const replayMutation = structuredClone(saved);
    replayMutation.status = "needs_clarification";
    const replayed = store.saveProject(
      replayMutation,
      saved.revision,
      {
        type: "project.clarification_needed",
        actor: "provider",
        payload: {
          previousStatus: "researching",
          status: "needs_clarification",
          provider: "resend",
          providerEventDigest: digest,
        },
      },
      inbox,
    );
    expect(replayed).toEqual(saved);
    expect(store.listEvents(created.projectId)).toHaveLength(2);

    expect(() =>
      store.saveProject(
        replayMutation,
        saved.revision,
        {
          type: "project.clarification_needed",
          actor: "provider",
          payload: {
            previousStatus: "researching",
            status: "needs_clarification",
            provider: "resend",
            providerEventDigest: sha256("different signed body"),
          },
        },
        {
          ...inbox,
          digest: sha256("different signed body"),
        },
      ),
    ).toThrow(InboxConflictError);
    expect(store.getProject(created.projectId)).toEqual(saved);
  });

  it("rolls back an inbox receipt when its aggregate compare-and-set fails", () => {
    const created = store.createProject(createInput()).project;
    const firstWriter = structuredClone(created);
    firstWriter.status = "researching";
    store.saveProject(firstWriter, created.revision, {
      type: "project.research_started",
      actor: "system",
      payload: {
        previousStatus: "intake_received",
        status: "researching",
      },
    });

    const staleWriter = structuredClone(created);
    staleWriter.status = "needs_clarification";
    const digest = sha256("signed stale event");
    expect(() =>
      store.saveProject(
        staleWriter,
        created.revision,
        {
          type: "project.clarification_needed",
          actor: "provider",
          payload: {
            previousStatus: "intake_received",
            status: "needs_clarification",
            provider: "resend",
            providerEventDigest: digest,
          },
        },
        {
          provider: "resend",
          eventId: "email-event-stale-001",
          digest,
        },
      ),
    ).toThrow(OptimisticConcurrencyError);
    expect(store.recordInbox("resend", "email-event-stale-001", digest)).toBe(
      true,
    );
  });

  it("atomically consumes a one-time dashboard login with email verification", () => {
    const created = store.createProject(createInput()).project;
    const eventDigest = sha256("passwordless dashboard exchange");
    const inbox = {
      provider: "passwordless_email_buildlabs_dashboard",
      eventId: "dashboard-login-event-001",
      digest: eventDigest,
    };
    const login = {
      tokenDigest: sha256("one-time-dashboard-token"),
      projectId: created.projectId,
      expiresAt: "2026-07-23T19:15:00.000Z",
    };
    const saved = store.saveProject(
      structuredClone(created),
      created.revision,
      {
        type: "customer.email_ownership_verified",
        actor: "provider",
        payload: {
          status: created.status,
          provider: "buildlabs_dashboard",
          providerEventDigest: eventDigest,
          correlationId: inbox.eventId,
        },
      },
      inbox,
      login,
    );

    expect(saved.revision).toBe(1);
    expect(
      store.hasConsumedCustomerDashboardLogin(
        login.tokenDigest,
        created.projectId,
      ),
    ).toBe(true);
    expect(() =>
      store.saveProject(
        structuredClone(saved),
        saved.revision,
        {
          type: "customer.email_ownership_verified",
          actor: "provider",
          payload: {
            status: saved.status,
            provider: "buildlabs_dashboard",
            providerEventDigest: eventDigest,
            correlationId: inbox.eventId,
          },
        },
        inbox,
        login,
      ),
    ).toThrow(CustomerDashboardLoginConflictError);
    expect(store.getProject(created.projectId)).toEqual(saved);
    const duplicateInboxLogin = {
      ...login,
      tokenDigest: sha256("different-token-for-duplicate-inbox"),
    };
    expect(() =>
      store.saveProject(
        structuredClone(saved),
        saved.revision,
        {
          type: "customer.email_ownership_verified",
          actor: "provider",
          payload: {
            status: saved.status,
            provider: "buildlabs_dashboard",
            providerEventDigest: eventDigest,
            correlationId: inbox.eventId,
          },
        },
        inbox,
        duplicateInboxLogin,
      ),
    ).toThrow(CustomerDashboardLoginConflictError);
    expect(
      store.hasConsumedCustomerDashboardLogin(
        duplicateInboxLogin.tokenDigest,
        created.projectId,
      ),
    ).toBe(false);

    const conflictingDigest = sha256("second passwordless exchange");
    const secondInbox = {
      provider: "passwordless_email_buildlabs_dashboard",
      eventId: "dashboard-login-event-002",
      digest: conflictingDigest,
    };
    expect(() =>
      store.saveProject(
        structuredClone(saved),
        saved.revision,
        {
          type: "customer.email_ownership_verified",
          actor: "provider",
          payload: {
            status: saved.status,
            provider: "buildlabs_dashboard",
            providerEventDigest: conflictingDigest,
            correlationId: secondInbox.eventId,
          },
        },
        secondInbox,
        login,
      ),
    ).toThrow(CustomerDashboardLoginConflictError);
    expect(store.getProject(created.projectId)).toEqual(saved);
    expect(
      store.recordInbox(
        secondInbox.provider,
        secondInbox.eventId,
        secondInbox.digest,
      ),
    ).toBe(true);
  });

  it("rejects the same dashboard login across independent store connections", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "buildlabs-dashboard-login-race-"),
    );
    const path = join(directory, "orchestration.sqlite");
    const primary = new SqliteOrchestrationStore({
      path,
      encryptionKey: KEY,
      now: () => new Date(NOW),
    });
    const replica = new SqliteOrchestrationStore({
      path,
      encryptionKey: KEY,
      now: () => new Date(NOW),
    });
    try {
      const created = primary.createProject(createInput()).project;
      const replicaView = replica.getProject(created.projectId)!;
      const eventDigest = sha256("cross-connection dashboard exchange");
      const inbox = {
        provider: "passwordless_email_buildlabs_dashboard",
        eventId: "dashboard-login-cross-connection-001",
        digest: eventDigest,
      };
      const login = {
        tokenDigest: sha256("cross-connection one-time token"),
        projectId: created.projectId,
        expiresAt: "2026-07-23T19:15:00.000Z",
      };
      primary.saveProject(
        structuredClone(created),
        created.revision,
        {
          type: "customer.email_ownership_verified",
          actor: "provider",
          payload: {
            status: created.status,
            provider: "buildlabs_dashboard",
            providerEventDigest: eventDigest,
            correlationId: inbox.eventId,
          },
        },
        inbox,
        login,
      );

      expect(() =>
        replica.saveProject(
          structuredClone(replicaView),
          replicaView.revision,
          {
            type: "customer.email_ownership_verified",
            actor: "provider",
            payload: {
              status: replicaView.status,
              provider: "buildlabs_dashboard",
              providerEventDigest: eventDigest,
              correlationId: inbox.eventId,
            },
          },
          inbox,
          login,
        ),
      ).toThrow(CustomerDashboardLoginConflictError);
    } finally {
      replica.close();
      primary.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists, leases, retries, and completes minimal inbound Resend envelopes", () => {
    const created = store.createProject(createInput()).project;
    const envelope = {
      provider: "resend" as const,
      eventId: "resend-event:durable-inbound-001",
      eventDigest: sha256("signed raw Resend body"),
      projectId: created.projectId,
      emailId: "resend-email-opaque-001",
      identityDigest: sha256("normalized signed notification identity"),
      receivedAt: NOW,
    };

    expect(store.stageInboundMailEnvelope(envelope)).toMatchObject({
      ...envelope,
      status: "pending",
      attempts: 0,
    });
    expect(store.stageInboundMailEnvelope(envelope)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(
      store.claimPendingInboundMailEnvelopes(
        created.projectId,
        NOW,
        "2026-07-23T19:00:30.000Z",
        10,
      ),
    ).toMatchObject([{ status: "pending", attempts: 1 }]);
    expect(store.hasUnresolvedInboundMailEnvelope(created.projectId)).toBe(
      true,
    );

    store.recordInboundMailEnvelopeFailure({
      provider: "resend",
      eventId: envelope.eventId,
      eventDigest: envelope.eventDigest,
      errorCode: "inbound_mail.provider_failure",
      retryable: true,
      nextAttemptAt: "2026-07-23T19:00:01.000Z",
      failedAt: NOW,
    });
    expect(
      store.claimPendingInboundMailEnvelopes(
        created.projectId,
        "2026-07-23T19:00:00.999Z",
        "2026-07-23T19:00:30.999Z",
        10,
      ),
    ).toEqual([]);
    expect(
      store.claimPendingInboundMailEnvelopes(
        created.projectId,
        "2026-07-23T19:00:01.000Z",
        "2026-07-23T19:00:31.000Z",
        10,
      ),
    ).toMatchObject([{ attempts: 2 }]);

    store.recordInbox("resend", envelope.eventId, envelope.eventDigest);
    expect(
      store.hasVerifiedInboxEvent(
        "resend",
        envelope.eventId,
        envelope.eventDigest,
      ),
    ).toBe(true);
    store.completeInboundMailEnvelope(
      "resend",
      envelope.eventId,
      envelope.eventDigest,
      "2026-07-23T19:00:02.000Z",
    );
    expect(store.listInboundMailEnvelopes(created.projectId)).toMatchObject([
      {
        status: "processed",
        attempts: 2,
        processedAt: "2026-07-23T19:00:02.000Z",
      },
    ]);
    expect(store.hasUnresolvedInboundMailEnvelope(created.projectId)).toBe(
      false,
    );
  });

  it("keeps excluded lifecycle projects pollable while signed inbound mail is unresolved", () => {
    const created = store.createProject(createInput()).project;
    const cancelled = structuredClone(created);
    cancelled.status = "cancelled";
    store.saveProject(cancelled, created.revision, {
      type: "project.cancelled",
      actor: "operator",
      payload: {
        previousStatus: created.status,
        status: "cancelled",
      },
    });
    expect(store.listProjectIdsForReconciliation(10).projectIds).not.toContain(
      created.projectId,
    );

    store.stageInboundMailEnvelope({
      provider: "resend",
      eventId: "resend-event:cancelled-project-reply",
      eventDigest: sha256("signed cancelled project reply"),
      projectId: created.projectId,
      emailId: "resend-email-cancelled-001",
      identityDigest: sha256("cancelled identity"),
      receivedAt: NOW,
    });

    expect(store.listProjectIdsForReconciliation(10).projectIds).toContain(
      created.projectId,
    );
    store.resolveInboundMailEnvelope(
      created.projectId,
      "resend-event:cancelled-project-reply",
      "discard",
      NOW,
    );
    expect(store.listProjectIdsForReconciliation(10).projectIds).not.toContain(
      created.projectId,
    );
    expect(store.listInboundMailEnvelopes(created.projectId)).toMatchObject([
      {
        status: "rejected",
        lastErrorCode: "inbound_mail.operator_discarded",
      },
    ]);
  });

  it("keeps terminal projects pollable while dashboard login delivery is pending", () => {
    const created = store.createProject(createInput()).project;
    const pending = structuredClone(created);
    const effectKey = `mail:dashboard-login:${created.projectId}:request:${sha256(
      "expired signed capability",
    )}`;
    pending.status = "cancelled";
    pending.effects.push({
      key: effectKey,
      type: "send_dashboard_login",
      status: "pending",
      attempts: 0,
      inputDigest: sha256("dashboard login delivery"),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const queued = store.saveProject(pending, created.revision, {
      type: "email.dashboard_login_queued",
      actor: "system",
      payload: {
        status: "cancelled",
        effectKey,
        effectType: "send_dashboard_login",
        providerEventDigest: sha256("expired signed capability"),
        count: 1,
      },
    });

    expect(store.listProjectIdsForReconciliation(10).projectIds).toContain(
      created.projectId,
    );

    const delivered = structuredClone(queued);
    const effect = delivered.effects.find(
      (candidate) => candidate.key === effectKey,
    )!;
    effect.status = "completed";
    effect.attempts = 1;
    effect.providerId = "resend-message-dashboard-001";
    effect.receiptDigest = sha256("resend dashboard receipt");
    effect.completedAt = NOW;
    effect.updatedAt = NOW;
    store.saveProject(delivered, queued.revision, {
      type: "email.dashboard_login_sent",
      actor: "provider",
      payload: {
        status: "cancelled",
        effectKey,
        effectType: "send_dashboard_login",
        messageId: "resend-message-dashboard-001",
        count: 1,
      },
    });

    expect(store.listProjectIdsForReconciliation(10).projectIds).not.toContain(
      created.projectId,
    );
  });

  it("backfills pending dashboard login reconciliation when schema v6 is applied", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "buildlabs-dashboard-login-migration-"),
    );
    const path = join(directory, "orchestration.sqlite");
    const legacy = new SqliteOrchestrationStore({
      path,
      encryptionKey: KEY,
      now: () => new Date(NOW),
    });
    let migrated: SqliteOrchestrationStore | undefined;
    try {
      const created = legacy.createProject(createInput()).project;
      const pending = structuredClone(created);
      const effectKey = `mail:dashboard-login:${created.projectId}:request:${sha256(
        "pre-v6 signed capability",
      )}`;
      pending.status = "cancelled";
      pending.effects.push({
        key: effectKey,
        type: "send_dashboard_login",
        status: "pending",
        attempts: 1,
        inputDigest: sha256("pre-v6 dashboard login delivery"),
        createdAt: NOW,
        updatedAt: NOW,
      });
      legacy.saveProject(pending, created.revision, {
        type: "email.dashboard_login_queued",
        actor: "system",
        payload: {
          status: "cancelled",
          effectKey,
          effectType: "send_dashboard_login",
          providerEventDigest: sha256("pre-v6 signed capability"),
          count: 1,
        },
      });
      legacy.close();

      const database = new DatabaseSync(path);
      database.exec(`
        DELETE FROM orchestration_schema_migrations WHERE version = 6;
        DROP INDEX orchestration_projects_dashboard_login_reconcile_idx;
        ALTER TABLE orchestration_projects
          DROP COLUMN has_pending_dashboard_login;
      `);
      database.close();

      migrated = new SqliteOrchestrationStore({
        path,
        encryptionKey: KEY,
        now: () => new Date(NOW),
      });
      expect(migrated.listProjectIdsForReconciliation(10).projectIds).toContain(
        created.projectId,
      );
    } finally {
      migrated?.close();
      legacy.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects arbitrary event payload fields that could contain raw PII", () => {
    const created = store.createProject(createInput()).project;
    const changed = structuredClone(created);
    changed.status = "needs_clarification";
    const unsafeEvent = {
      type: "message.received",
      actor: "customer",
      payload: {
        messageId: "message-001",
        rawMessage: "Email me at ava.secret@example.com",
      },
    } as unknown as ProjectEventInput;

    expect(() => store.saveProject(changed, 0, unsafeEvent)).toThrow();
    expect(store.getProject(created.projectId)).toMatchObject({
      revision: 0,
      status: "intake_received",
    });
  });

  it("binds proven candidates to the separately compiled build contract hash", () => {
    const project = store.createProject(createInput()).project;
    const proposal = proposalFixture(project.projectId);
    const buildContractHash = "a".repeat(64);
    const runId = "00000000-0000-4000-8000-000000000001";
    const artifactId = "00000000-0000-4000-8000-000000000002";
    const revisionHash = "b".repeat(64);
    const paymentReceiptId = "payment-receipt-001";
    const batch = {
      batchId: "batch-001",
      projectId: project.projectId,
      proposalVersion: proposal.version,
      proposalDigest: proposal.digest,
      paymentReceiptId,
      paymentProposalVersion: proposal.version,
      contractVersion: proposal.contract.version,
      contractDigest: proposal.contract.digest,
      buildContractHash,
      requestedCandidateCount: 1,
      runs: [
        {
          runId,
          candidateId: "candidate-001",
          assignmentId: "assignment-001",
          status: "passed" as const,
        },
      ],
      status: "completed" as const,
      createdAt: NOW,
      completedAt: NOW,
    };
    expect(BuildBatchSchema.safeParse(batch).success).toBe(true);
    const missingBuildHash = { ...batch } as Record<string, unknown>;
    Reflect.deleteProperty(missingBuildHash, "buildContractHash");
    expect(BuildBatchSchema.safeParse(missingBuildHash).success).toBe(false);

    const withCandidate = structuredClone(project);
    withCandidate.proposals = [proposal];
    withCandidate.activeProposalVersion = 1;
    withCandidate.checkoutSessions = [
      {
        sessionId: "checkout-session-001",
        provider: "stripe",
        projectId: project.projectId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        amountMinor: proposal.quote.amountMinor,
        currency: proposal.quote.currency,
        url: "https://checkout.stripe.test/session-001",
        status: "complete",
        expiresAt: "2026-07-24T12:00:00.000Z",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    withCandidate.payments = [
      {
        receiptId: paymentReceiptId,
        provider: "stripe",
        providerEventId: "stripe-event-001",
        checkoutSessionId: "checkout-session-001",
        paymentIntentId: "payment-intent-001",
        projectId: project.projectId,
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        amountMinor: proposal.quote.amountMinor,
        amountReceivedMinor: proposal.quote.amountMinor,
        currency: proposal.quote.currency,
        customerEmailDigest: sha256("ava.secret@example.com"),
        customerId: null,
        checkoutStatus: "complete",
        paymentStatus: "paid",
        paymentIntentStatus: "succeeded",
        paymentIntentCreatedAt: NOW,
        status: "paid",
        verificationSource: "signed_webhook",
        providerStateVerified: true,
        signatureVerified: true,
        signedEventDigest: sha256("signed-stripe-event-001"),
        providerEvidenceDigest: sha256("signed-stripe-event-001"),
        paidAt: NOW,
        verifiedAt: NOW,
        livemode: false,
      },
    ];
    withCandidate.paidProposalVersion = proposal.version;
    withCandidate.buildBatches = [batch];
    withCandidate.activeBuildBatchId = batch.batchId;
    withCandidate.provenCandidates = [
      {
        batchId: batch.batchId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        event: {
          eventId: randomUUID(),
          type: "candidate.proven",
          runId,
          revisionHash,
          traceId: "trace-001",
          payload: {
            runId,
            projectId: project.projectId,
            candidateId: "candidate-001",
            contractHash: buildContractHash,
            revisionHash,
            sandboxId: "sandbox-001",
            previewPort: 3000,
            artifact: {
              artifactId,
              runId,
              revisionHash,
              format: "tar.gz",
              uri: `/v1/build-runs/${runId}/artifacts/${artifactId}`,
              sha256: "c".repeat(64),
              sizeBytes: 1_024,
              dockerfilePath: "Dockerfile",
              daytonaSnapshot: "snapshot-001",
              createdAt: NOW,
            },
            traceId: "trace-001",
            ranking: {
              provider: "braintrust",
              policyVersion: "braintrust-preference-v1",
              preferenceSatisfaction: 0.9,
              scoreTuple: [0.9],
              traceId: "trace-001",
            },
          },
          createdAt: NOW,
        },
        receivedAt: NOW,
      },
    ];
    expect(ProjectAggregateSchema.safeParse(withCandidate).success).toBe(true);

    withCandidate.provenCandidates[0]!.event.payload.contractHash = "d".repeat(
      64,
    );
    expect(ProjectAggregateSchema.safeParse(withCandidate).success).toBe(false);
  });
});
