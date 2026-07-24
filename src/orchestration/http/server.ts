import { randomBytes, timingSafeEqual } from "node:crypto";

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";

import { ProviderAdapterError } from "../adapters/providers/provider-error.js";
import {
  InvalidCustomerDashboardAccessError,
  type CustomerDashboardAccessCodec,
  type CustomerDashboardGrant,
} from "../application/customer-dashboard-access.js";
import {
  buildCustomerDashboardEventView,
  buildCustomerDashboardProjectView,
} from "../application/customer-dashboard-projection.js";
import type { ReplyAddressCodec } from "../application/reply-address.js";
import {
  parseRecordedProofSnapshot,
  type RecordedProofSummary,
} from "../application/project-evidence.js";
import {
  InvalidProofSummaryLinkError,
  type ProofSummaryLinkCodec,
} from "../application/proof-summary-links.js";
import {
  DurableEffectSchema,
  IdempotencyKeySchema,
  OrchestrationErrorSchema,
  OrchestrationIdSchema,
  OrchestrationSha256Schema,
  ProjectAggregateSchema,
  ProjectEventSchema,
} from "../domain/project.js";
import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import type {
  OrchestrationProjectStore,
  ProofSummarySnapshotStore,
  WebhookSecurityAuditProvider,
  WebhookSecurityAuditStore,
  WebhookSecurityFailureCode,
} from "../domain/store.js";
import type { MailPort } from "../ports/mail.js";
import type { BuildBackendPort } from "../ports/build-backend.js";
import type { PaymentPort } from "../ports/payment.js";
import { InvalidInboundContentError } from "./inbound-content.js";
import {
  InboundMailRecoveryDeferredError,
  InboundMailRecoveryError,
  type InboundMailRecovery,
} from "./inbound-mail-recovery.js";
import type {
  OrchestrationHttpController,
  OrchestrationHttpProjectResult,
} from "./controller.js";

const MAX_REQUEST_BODY_BYTES = 2 * 1_024 * 1_024;
const MAX_INTAKE_CONTENT_BYTES = 1_500_000;
const MAX_HEADER_BYTES = 8_192;
const PROOF_SUMMARY_PUBLIC_PATH = "/v1/orchestration/proof-summaries";
const CUSTOMER_DASHBOARD_PATH = "/v1/orchestration/customer-dashboard/projects";
const CUSTOMER_DASHBOARD_ACCESS_PATH =
  "/v1/orchestration/customer-dashboard/access";
const CUSTOMER_DASHBOARD_ACCESS_REQUEST_PATH =
  "/v1/orchestration/customer-dashboard/access/requests";
const CUSTOMER_DASHBOARD_COOKIE = "buildlapse_dashboard_session";
const CUSTOMER_DASHBOARD_CSRF_COOKIE = "buildlapse_dashboard_csrf";
const CUSTOMER_DASHBOARD_CSRF_HEADER = "x-buildlapse-csrf";

const ProviderSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/);
const IntakeBodySchema = z
  .object({
    projectId: z.uuid().optional(),
    channel: z.enum(["voice", "email", "text"]),
    intakeId: OrchestrationIdSchema,
    sourceId: OrchestrationIdSchema,
    receivedAt: z.iso.datetime(),
    content: z.string().min(1).max(1_500_000),
    emailVerified: z.boolean().default(false),
    trustedSenderEmail: z.email().max(320).optional(),
    researchConsent: z.boolean(),
    provider: ProviderSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Buffer.byteLength(input.content) > MAX_INTAKE_CONTENT_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "Intake content exceeds the byte limit",
      });
    }
    if (input.emailVerified && !input.trustedSenderEmail) {
      context.addIssue({
        code: "custom",
        path: ["trustedSenderEmail"],
        message: "A verified email must be supplied by the trusted caller",
      });
    }
    if (input.channel === "voice" && input.emailVerified) {
      context.addIssue({
        code: "custom",
        path: ["emailVerified"],
        message:
          "Voice intake cannot attest email ownership; use the passwordless verification callback",
      });
    }
  });
const EmailOwnershipVerificationBodySchema = z
  .object({
    method: z.literal("passwordless_email"),
    provider: ProviderSchema,
    providerEventId: OrchestrationIdSchema,
    email: z.email().max(320),
    verifiedAt: z.iso.datetime(),
  })
  .strict();
const ProjectParamsSchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();
const CustomerDashboardAccessBodySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(1_536)
      .regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const CustomerDashboardEventsQuerySchema = z
  .object({
    afterSequence: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    limit: z.coerce.number().int().min(1).max(250).default(100),
  })
  .strict();
const CustomerDashboardSteeringSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedProposalVersion: z.number().int().positive(),
    subject: z.string().min(1).max(998).default("Dashboard steering"),
    content: z.string().min(1).max(200_000),
  })
  .strict();
const ProofSummaryParamsSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const ProofSummarySnapshotParamsSchema = z
  .object({
    snapshotId: OrchestrationIdSchema,
  })
  .strict();
const ProofSummaryRevocationSchema = z
  .object({
    reason: z.enum([
      "operator_requested",
      "capability_compromised",
      "privacy_request",
      "security_policy",
    ]),
  })
  .strict();
const OperatorEvidenceQuerySchema = z
  .object({
    afterSequence: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const RecoveryParamsSchema = z
  .object({
    projectId: z.uuid(),
    eventId: OrchestrationIdSchema,
  })
  .strict();
const RecoveryResolutionSchema = z
  .object({
    resolution: z.enum(["retry", "discard"]),
  })
  .strict();
const PublicProjectResultSchema = z.object({
  projectId: OrchestrationIdSchema,
  status: z.string().min(1).max(64),
  revision: z.number().int().nonnegative().optional(),
  clarificationQuestions: z
    .array(z.string().min(1).max(1_000))
    .max(20)
    .optional(),
});
const WebhookSecurityFailureSummarySchema = z
  .object({
    receiptLimit: z.number().int().positive().max(100_000),
    retainedReceiptCount: z.number().int().nonnegative().max(100_000),
    overflowObservationCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    groups: z
      .array(
        z
          .object({
            provider: z.enum(["resend", "stripe"]),
            failureCode: z.enum([
              "invalid_signature_headers",
              "webhook_verification_failed",
            ]),
            retainedReceiptCount: z.number().int().nonnegative().max(100_000),
            overflowObservationCount: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER),
            firstObservedAt: z.iso.datetime(),
            lastObservedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
const InboundMailRecoveryStatusSchema = z
  .object({
    eventId: OrchestrationIdSchema,
    status: z.enum(["pending", "processed", "rejected", "failed"]),
    attempts: z.number().int().nonnegative(),
    receivedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    nextAttemptAt: z.iso.datetime().optional(),
    lastErrorCode: z.string().min(1).max(256).optional(),
  })
  .strict();
const DeadLetterSummarySchema = z
  .object({
    effectKey: IdempotencyKeySchema,
    effectType: DurableEffectSchema.shape.type,
    attempts: z.number().int().nonnegative(),
    errorCode: z.string().min(1).max(128),
    category: z.enum(["transient", "permanent", "policy", "security"]),
    occurredAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const OperatorProjectEvidenceSchema = z
  .object({
    traceCorrelation: OrchestrationSha256Schema,
    project: ProjectAggregateSchema,
    events: z
      .object({
        items: z.array(ProjectEventSchema).max(500),
        nextAfterSequence: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict(),
    operations: z
      .object({
        effects: z.array(DurableEffectSchema).max(10_000),
        errors: z.array(OrchestrationErrorSchema).max(10_000),
        deadLetters: z.array(DeadLetterSummarySchema).max(10_000),
        inboundMail: z.array(InboundMailRecoveryStatusSchema),
      })
      .strict(),
  })
  .strict();

export interface OrchestrationHttpServerOptions {
  controller: OrchestrationHttpController;
  payment: Pick<PaymentPort, "parseWebhook">;
  mail: Pick<MailPort, "parseWebhook">;
  inboundMailRecovery: Pick<
    InboundMailRecovery,
    "acceptSignedNotification" | "recoverProject" | "resolve" | "status"
  >;
  securityAudit: Pick<
    WebhookSecurityAuditStore,
    "recordWebhookSecurityFailure" | "summarizeWebhookSecurityFailures"
  >;
  projectEvidence: Pick<OrchestrationProjectStore, "getProject" | "listEvents">;
  customerDashboardStore: Pick<
    OrchestrationProjectStore,
    "getProject" | "listEvents"
  >;
  customerDashboardAccess: Pick<
    CustomerDashboardAccessCodec,
    | "createSession"
    | "emailDigest"
    | "parseLoginLink"
    | "parseLoginLinkForReissue"
    | "parseSession"
    | "verifyCsrfToken"
  >;
  buildObservability: Pick<BuildBackendPort, "getCustomerBuildObservation">;
  proofSnapshots: Pick<
    ProofSummarySnapshotStore,
    "getProofSummarySnapshot" | "revokeProofSummarySnapshot"
  >;
  proofSummaryLinks: Pick<ProofSummaryLinkCodec, "parse">;
  replyAddresses: ReplyAddressCodec;
  readiness: () => Promise<OrchestrationReadinessResult>;
  /**
   * Shared only with trusted internal callers (voice intake and cron). Provider
   * webhook routes do not accept this token and authenticate solely by the
   * provider signature over the exact raw request bytes.
   */
  internalToken: string;
  logger?: boolean;
  proofSummaryRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
    maxEntries?: number;
    now?: () => number;
  };
}

export interface OrchestrationReadinessResult {
  database: boolean;
  fireworks: boolean;
  braintrust: boolean;
  stripe: boolean;
  resend: boolean;
  buildBackend: boolean;
  fly: boolean;
}

/**
 * Creates, but does not listen with, the orchestration HTTP boundary.
 *
 * JSON is deliberately parsed as a Buffer for every route. Stripe and Resend
 * signatures are verified against those untouched bytes; internal JSON is
 * decoded only after authentication and then checked with strict schemas.
 */
export function createOrchestrationHttpServer(
  options: OrchestrationHttpServerOptions,
): FastifyInstance {
  const internalToken = validateInternalToken(options.internalToken);
  const server = Fastify({
    logger: options.logger ?? false,
    bodyLimit: MAX_REQUEST_BODY_BYTES,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 8_192 },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const proofSummaryRateLimiter = new CapabilityRateLimiter(
    options.proofSummaryRateLimit,
  );

  server.removeContentTypeParser("application/json");
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  server.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("Cache-Control")) {
      void reply.header("Cache-Control", "no-store");
    }
    void reply.header("X-Content-Type-Options", "nosniff");
  });

  const requireInternal = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!validBearerToken(request, internalToken)) {
      await reply.code(401).send({
        error: "unauthorized",
        message: "A valid internal bearer token is required",
      });
    }
  };

  server.get("/health", { preHandler: requireInternal }, () => ({
    status: "ok",
    component: "general-orchestrator",
  }));

  server.get(
    "/ready",
    { preHandler: requireInternal },
    async (_request, reply) => {
      let checks: OrchestrationReadinessResult;
      try {
        checks = await options.readiness();
      } catch {
        checks = unhealthyReadiness();
      }
      const ready = Object.values(checks).every((healthy) => healthy);
      return reply.code(ready ? 200 : 503).send({
        status: ready ? "ready" : "not_ready",
        components: {
          database: checks.database ? "healthy" : "unhealthy",
          fireworks: checks.fireworks ? "healthy" : "unhealthy",
          braintrust: checks.braintrust ? "healthy" : "unhealthy",
          stripe: checks.stripe ? "healthy" : "unhealthy",
          resend: checks.resend ? "healthy" : "unhealthy",
          buildBackend: checks.buildBackend ? "healthy" : "unhealthy",
          fly: checks.fly ? "healthy" : "unhealthy",
        },
      });
    },
  );

  server.post(
    "/v1/orchestration/projects/:projectId/recovery/inbound-mail/:eventId",
    { preHandler: requireInternal },
    (request, reply) => {
      const { projectId, eventId } = RecoveryParamsSchema.parse(request.params);
      const { resolution } = RecoveryResolutionSchema.parse(
        parseInternalJson(request.body),
      );
      options.inboundMailRecovery.resolve(projectId, eventId, resolution);
      return reply.code(202).send({
        accepted: true,
        projectId,
        eventId,
        resolution,
      });
    },
  );

  server.post(
    "/v1/orchestration/intakes",
    { preHandler: requireInternal },
    async (request, reply) => {
      const idempotencyKey = IdempotencyKeySchema.parse(
        requiredHeader(request, "idempotency-key"),
      );
      const body = IntakeBodySchema.parse(parseInternalJson(request.body));
      const result = await options.controller.acceptIntake({
        idempotencyKey,
        ...(body.projectId ? { projectId: body.projectId } : {}),
        channel: body.channel,
        intakeId: body.intakeId,
        sourceId: body.sourceId,
        receivedAt: body.receivedAt,
        content: body.content,
        emailVerified: body.emailVerified,
        ...(body.trustedSenderEmail
          ? { trustedSenderEmail: body.trustedSenderEmail }
          : {}),
        researchConsent: body.researchConsent,
        ...(body.provider ? { provider: body.provider } : {}),
      });
      return reply.code(202).send({
        accepted: true,
        project: publicProjectResult(result),
      });
    },
  );

  server.post(
    "/v1/orchestration/projects/:projectId/email-verifications",
    { preHandler: requireInternal },
    async (request, reply) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const body = EmailOwnershipVerificationBodySchema.parse(
        parseInternalJson(request.body),
      );
      const result = await options.controller.verifyEmailOwnership({
        projectId,
        ...body,
        eventDigest: sha256(canonicalJson({ projectId, ...body })),
      });
      return reply.code(202).send({
        accepted: true,
        project: publicProjectResult(result),
      });
    },
  );

  server.get(CUSTOMER_DASHBOARD_ACCESS_PATH, (request, reply) => {
    if (request.raw.url?.includes("?")) {
      return sendCustomerDashboardAccessNotFound(reply);
    }
    const nonce = randomBytes(18).toString("base64url");
    applyCustomerDashboardHeaders(reply, nonce);
    return reply
      .type("text/html; charset=utf-8")
      .send(renderCustomerDashboardAccessExchange(nonce));
  });

  server.post(CUSTOMER_DASHBOARD_ACCESS_PATH, async (request, reply) => {
    applyCustomerDashboardHeaders(reply);
    if (request.raw.url?.includes("?")) {
      return sendCustomerDashboardAccessNotFound(reply);
    }
    let token: string;
    let loginGrant: CustomerDashboardGrant;
    try {
      token = CustomerDashboardAccessBodySchema.parse(
        parseInternalJson(request.body),
      ).token;
      loginGrant = options.customerDashboardAccess.parseLoginLink(token);
    } catch {
      return sendCustomerDashboardAccessNotFound(reply);
    }
    const tokenDigest = sha256(token);
    const project = options.customerDashboardStore.getProject(
      loginGrant.projectId,
    );
    const storedEmail = project?.customer.email;
    if (
      !project ||
      !storedEmail ||
      options.customerDashboardAccess.emailDigest(storedEmail.value) !==
        loginGrant.emailDigest
    ) {
      return sendCustomerDashboardAccessNotFound(reply);
    }

    const providerEventId = stableProviderId("dashboard-login", token);
    const eventDigest = sha256(
      canonicalJson({
        projectId: project.projectId,
        emailDigest: loginGrant.emailDigest,
        nonce: loginGrant.nonce,
        expiresAt: loginGrant.expiresAt,
      }),
    );
    try {
      await options.controller.verifyEmailOwnership({
        projectId: project.projectId,
        method: "passwordless_email",
        provider: "buildlapse_dashboard",
        providerEventId,
        eventDigest,
        email: storedEmail.value,
        verifiedAt: new Date().toISOString(),
        dashboardLogin: {
          tokenDigest,
          expiresAt: new Date(loginGrant.expiresAt * 1_000).toISOString(),
        },
      });
    } catch {
      return sendCustomerDashboardAccessNotFound(reply);
    }
    const verifiedProject = options.customerDashboardStore.getProject(
      project.projectId,
    );
    if (
      !verifiedProject?.customer.email?.verified ||
      options.customerDashboardAccess.emailDigest(
        verifiedProject.customer.email.value,
      ) !== loginGrant.emailDigest
    ) {
      return sendCustomerDashboardAccessNotFound(reply);
    }
    const session = options.customerDashboardAccess.createSession(loginGrant);
    const maxAge = Math.max(
      0,
      session.grant.expiresAt - Math.floor(Date.now() / 1_000),
    );
    void Promise.resolve()
      .then(() => options.controller.reconcileProject(project.projectId))
      .catch(() => {
        server.log.warn(
          { projectCorrelation: sha256(project.projectId) },
          "Dashboard login reconciliation will be retried by the durable worker",
        );
      });
    return reply
      .header("Set-Cookie", [
        serializeCustomerDashboardCookie(session.token, maxAge),
        serializeCustomerDashboardCsrfCookie(session.csrfToken, maxAge),
      ])
      .code(200)
      .send({
        redirectTo: `/dashboard/projects/${encodeURIComponent(project.projectId)}`,
      });
  });

  server.post(
    CUSTOMER_DASHBOARD_ACCESS_REQUEST_PATH,
    async (request, reply) => {
      applyCustomerDashboardHeaders(reply);
      try {
        if (request.raw.url?.includes("?")) {
          throw new InvalidCustomerDashboardAccessError();
        }
        const token = CustomerDashboardAccessBodySchema.parse(
          parseInternalJson(request.body),
        ).token;
        const grant =
          options.customerDashboardAccess.parseLoginLinkForReissue(token);
        const project = options.customerDashboardStore.getProject(
          grant.projectId,
        );
        const storedEmail = project?.customer.email;
        if (
          project &&
          storedEmail &&
          options.customerDashboardAccess.emailDigest(storedEmail.value) ===
            grant.emailDigest
        ) {
          await options.controller.requestCustomerDashboardAccess({
            projectId: project.projectId,
            emailDigest: grant.emailDigest,
            capabilityDigest: sha256(token),
          });
        }
      } catch {
        // Reissue is intentionally non-enumerating for malformed, stale,
        // mismatched, throttled, and provider-failed requests.
      }
      return reply.code(202).send({ status: "accepted" });
    },
  );

  server.get(
    `${CUSTOMER_DASHBOARD_PATH}/:projectId`,
    async (request, reply) => {
      applyCustomerDashboardHeaders(reply);
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const project = requireCustomerDashboardProject(
        options,
        request,
        projectId,
      );
      const activeBatch = project.activeBuildBatchId
        ? project.buildBatches.find(
            (batch) => batch.batchId === project.activeBuildBatchId,
          )
        : undefined;
      const observations = await Promise.all(
        (activeBatch?.runs ?? []).map(async (run) => {
          try {
            const observation =
              await options.buildObservability.getCustomerBuildObservation({
                runId: run.runId,
                limit: 100,
              });
            return { runId: run.runId, observation };
          } catch {
            return { runId: run.runId };
          }
        }),
      );
      return buildCustomerDashboardProjectView(project, observations);
    },
  );

  server.get(
    `${CUSTOMER_DASHBOARD_PATH}/:projectId/events`,
    (request, reply) => {
      applyCustomerDashboardHeaders(reply);
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireCustomerDashboardProject(options, request, projectId);
      const { afterSequence, limit } = CustomerDashboardEventsQuerySchema.parse(
        request.query,
      );
      const eventWindow = options.customerDashboardStore.listEvents(
        projectId,
        afterSequence,
        limit + 1,
      );
      const hasMore = eventWindow.length > limit;
      const items = eventWindow
        .slice(0, limit)
        .map(buildCustomerDashboardEventView);
      return {
        items,
        nextAfterSequence: items.at(-1)?.sequence ?? afterSequence,
        hasMore,
      };
    },
  );

  server.post(
    `${CUSTOMER_DASHBOARD_PATH}/:projectId/steering`,
    async (request, reply) => {
      applyCustomerDashboardHeaders(reply);
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const project = requireCustomerDashboardProject(
        options,
        request,
        projectId,
      );
      requireCustomerDashboardCsrf(options, request);
      const customerEmail = project.customer.email;
      if (!customerEmail?.verified) {
        throw new OrchestrationHttpError(
          401,
          "customer_dashboard_unauthorized",
          "A valid customer dashboard session is required",
        );
      }
      const body = CustomerDashboardSteeringSchema.parse(
        parseInternalJson(request.body),
      );
      const idempotencyKey = IdempotencyKeySchema.parse(
        requiredHeader(request, "idempotency-key"),
      );
      const messageDigest = sha256(body.content);
      const providerMessageId = `dashboard-message:${sha256(idempotencyKey).slice(0, 24)}`;
      const providerEventId = `dashboard-event:${sha256(`${projectId}:${idempotencyKey}`).slice(0, 24)}`;
      const result = await options.controller.receiveCustomerMessage({
        projectId,
        source: "dashboard",
        expectedProjectRevision: body.expectedRevision,
        expectedProposalVersion: body.expectedProposalVersion,
        providerEventId,
        eventDigest: sha256(
          canonicalJson({
            projectId,
            providerMessageId,
            messageDigest,
          }),
        ),
        providerMessageId,
        receivedAt: new Date().toISOString(),
        senderEmail: customerEmail.value,
        subject: body.subject,
        content: body.content,
      });
      return reply.code(202).send({
        received: true,
        project: publicProjectResult(result),
      });
    },
  );

  server.post(
    "/v1/orchestration/proof-summary-snapshots/:snapshotId/revoke",
    { preHandler: requireInternal },
    (request, reply) => {
      const { snapshotId } = ProofSummarySnapshotParamsSchema.parse(
        request.params,
      );
      const { reason } = ProofSummaryRevocationSchema.parse(
        parseInternalJson(request.body),
      );
      if (!options.proofSnapshots.getProofSummarySnapshot(snapshotId)) {
        throw new OrchestrationHttpError(
          404,
          "proof_summary_snapshot_not_found",
          "The requested proof-summary snapshot was not found",
        );
      }
      const result = options.proofSnapshots.revokeProofSummarySnapshot(
        snapshotId,
        reason,
      );
      return reply.code(200).send({
        snapshotId,
        revoked: result.revoked,
        revokedAt: result.revokedAt,
        reason,
      });
    },
  );

  server.get(
    "/v1/orchestration/security/webhooks",
    { preHandler: requireInternal },
    () =>
      WebhookSecurityFailureSummarySchema.parse(
        options.securityAudit.summarizeWebhookSecurityFailures(),
      ),
  );

  server.post("/v1/orchestration/webhooks/stripe", async (request, reply) => {
    const rawBody = requireRawBody(request.body);
    let signature: string;
    try {
      signature = requiredHeader(request, "stripe-signature");
    } catch (error) {
      recordWebhookSecurityFailure(
        options.securityAudit,
        request,
        "stripe",
        rawBody,
        ["stripe-signature"],
        "invalid_signature_headers",
      );
      throw error;
    }
    let event: ReturnType<PaymentPort["parseWebhook"]>;
    try {
      event = options.payment.parseWebhook({ rawBody, signature });
    } catch (error) {
      if (isInvalidProviderWebhook(error, "stripe")) {
        recordWebhookSecurityFailure(
          options.securityAudit,
          request,
          "stripe",
          rawBody,
          ["stripe-signature"],
          "webhook_verification_failed",
        );
      }
      throw error;
    }
    if (!event) {
      return reply.code(204).send();
    }

    await options.controller.confirmPayment(event, sha256(rawBody));
    return reply.code(204).send();
  });

  server.post("/v1/orchestration/webhooks/resend", async (request, reply) => {
    const rawBody = requireRawBody(request.body);
    let svixId: string;
    let svixTimestamp: string;
    let svixSignature: string;
    try {
      svixId = requiredHeader(request, "svix-id");
      svixTimestamp = requiredHeader(request, "svix-timestamp");
      svixSignature = requiredHeader(request, "svix-signature");
    } catch (error) {
      recordWebhookSecurityFailure(
        options.securityAudit,
        request,
        "resend",
        rawBody,
        ["svix-id", "svix-timestamp", "svix-signature"],
        "invalid_signature_headers",
      );
      throw error;
    }
    let notification: ReturnType<MailPort["parseWebhook"]>;
    try {
      notification = options.mail.parseWebhook({
        rawBody,
        svixId,
        svixTimestamp,
        svixSignature,
      });
    } catch (error) {
      if (isInvalidProviderWebhook(error, "resend")) {
        recordWebhookSecurityFailure(
          options.securityAudit,
          request,
          "resend",
          rawBody,
          ["svix-id", "svix-timestamp", "svix-signature"],
          "webhook_verification_failed",
        );
      }
      throw error;
    }
    if (!notification) {
      return reply.code(204).send();
    }
    const providerEventId = stableProviderId("resend-event", svixId);
    const eventDigest = sha256(rawBody);
    if ("deliveryStatus" in notification) {
      await options.controller.recordMailDelivery({
        projectId: notification.projectId,
        providerEventId,
        eventDigest,
        providerMessageId: notification.emailId,
        occurredAt: notification.occurredAt,
        deliveryStatus: notification.deliveryStatus,
        permanent: notification.permanent,
      });
      return reply.code(204).send();
    }

    await options.inboundMailRecovery.acceptSignedNotification(
      notification,
      providerEventId,
      eventDigest,
    );
    return reply.code(204).send();
  });

  server.get(
    "/v1/orchestration/projects/:projectId/recovery",
    { preHandler: requireInternal },
    (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      return {
        projectId,
        inboundMail: options.inboundMailRecovery.status(projectId),
      };
    },
  );

  server.get(
    "/v1/orchestration/projects/:projectId/evidence",
    { preHandler: requireInternal },
    (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const { afterSequence, limit } = OperatorEvidenceQuerySchema.parse(
        request.query,
      );
      const project = options.projectEvidence.getProject(projectId);
      if (!project) {
        throw new OrchestrationHttpError(
          404,
          "project_not_found",
          "The requested orchestration project was not found",
        );
      }
      const deadLetters = project.effects
        .filter((effect) => effect.status === "failed" && effect.error)
        .map((effect) => ({
          effectKey: effect.key,
          effectType: effect.type,
          attempts: effect.attempts,
          errorCode: effect.error!.code,
          category: effect.error!.category,
          occurredAt: effect.error!.occurredAt,
          updatedAt: effect.updatedAt,
        }));
      const eventWindow = options.projectEvidence.listEvents(
        projectId,
        afterSequence,
        limit + 1,
      );
      const hasNext = eventWindow.length > limit;
      const events = eventWindow.slice(0, limit);
      return OperatorProjectEvidenceSchema.parse({
        traceCorrelation: sha256(project.projectId),
        project,
        events: {
          items: events,
          ...(hasNext ? { nextAfterSequence: events.at(-1)!.sequence } : {}),
        },
        operations: {
          effects: project.effects,
          errors: project.errors,
          deadLetters,
          inboundMail: options.inboundMailRecovery.status(projectId),
        },
      });
    },
  );

  server.get(`${PROOF_SUMMARY_PUBLIC_PATH}/:token`, (request, reply) => {
    applyProofSummaryHeaders(reply);
    if (request.raw.url?.includes("?")) {
      return sendProofSummaryNotFound(reply);
    }
    let token: string;
    let grant: ReturnType<ProofSummaryLinkCodec["parse"]>;
    try {
      token = ProofSummaryParamsSchema.parse(request.params).token;
      grant = options.proofSummaryLinks.parse(token);
    } catch (error) {
      if (
        error instanceof InvalidProofSummaryLinkError ||
        error instanceof ZodError
      ) {
        return sendProofSummaryNotFound(reply);
      }
      return sendProofSummaryNotFound(reply);
    }
    const rate = proofSummaryRateLimiter.consume(sha256(token));
    if (!rate.allowed) {
      return reply
        .header("Retry-After", String(rate.retryAfterSeconds))
        .code(429)
        .send({
          error: "proof_summary_rate_limited",
          message: "The proof summary request limit was exceeded",
        });
    }
    try {
      const snapshot = options.proofSnapshots.getProofSummarySnapshot(
        grant.snapshotId,
      );
      if (
        !snapshot ||
        snapshot.snapshotDigest !== grant.snapshotDigest ||
        snapshot.revokedAt
      ) {
        return sendProofSummaryNotFound(reply);
      }
      const summary = parseRecordedProofSnapshot(snapshot);
      return reply
        .type("text/html; charset=utf-8")
        .send(renderProofSummary(summary));
    } catch {
      return sendProofSummaryNotFound(reply);
    }
  });

  server.post(
    "/v1/orchestration/projects/:projectId/reconcile",
    { preHandler: requireInternal },
    async (request, reply) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      await options.inboundMailRecovery.recoverProject(projectId);
      const result = await options.controller.reconcileProject(projectId);
      return reply.code(200).send({
        reconciled: true,
        project: publicProjectResult(result),
      });
    },
  );

  server.setNotFoundHandler((request, reply) => {
    if (isCustomerDashboardAccessPath(request)) {
      applyCustomerDashboardHeaders(reply);
      return sendCustomerDashboardAccessNotFound(reply);
    }
    if (isProofSummaryPublicPath(request)) {
      applyProofSummaryHeaders(reply);
      return sendProofSummaryNotFound(reply);
    }
    return reply.code(404).send({
      error: "not_found",
      message: "The requested route was not found",
    });
  });

  server.setErrorHandler((error, request, reply) => {
    if (isCustomerDashboardAccessRequestPath(request)) {
      applyCustomerDashboardHeaders(reply);
      void reply.code(202).send({ status: "accepted" });
      return;
    }
    if (isCustomerDashboardAccessPath(request)) {
      applyCustomerDashboardHeaders(reply);
      void sendCustomerDashboardAccessNotFound(reply);
      return;
    }
    if (isProofSummaryPublicPath(request)) {
      applyProofSummaryHeaders(reply);
      void sendProofSummaryNotFound(reply);
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send({
        error: "invalid_request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof OrchestrationHttpError) {
      void reply.code(error.statusCode).send({
        error: error.code,
        message: error.publicMessage,
      });
      return;
    }
    if (error instanceof InboundMailRecoveryError) {
      void reply.code(error.statusCode).send({
        error: error.code,
        message: error.publicMessage,
      });
      return;
    }
    if (error instanceof InboundMailRecoveryDeferredError) {
      void reply.code(503).send({
        error: "inbound_mail_recovery_pending",
        message: "Signed inbound email recovery is still pending",
      });
      return;
    }
    if (error instanceof InvalidInboundContentError) {
      void reply.code(422).send({
        error: "invalid_inbound_content",
        message: "The inbound email has no usable customer-authored content",
      });
      return;
    }
    if (error instanceof ProviderAdapterError) {
      const invalidRequest =
        error.code === "INVALID_WEBHOOK" || error.code === "INVALID_INPUT";
      void reply.code(invalidRequest ? 400 : 502).send({
        error: invalidRequest ? "invalid_webhook" : "provider_failure",
        message: invalidRequest
          ? "The provider webhook could not be verified"
          : "The provider response could not be verified",
      });
      return;
    }
    if (isFastifyBodyTooLargeError(error)) {
      void reply.code(413).send({
        error: "payload_too_large",
        message: "The request payload exceeds the allowed size",
      });
      return;
    }
    if (isFastifyUnsupportedMediaTypeError(error)) {
      void reply.code(415).send({
        error: "unsupported_media_type",
        message: "The request must use application/json",
      });
      return;
    }
    if (isExpectedConflict(error)) {
      void reply.code(409).send({
        error: "orchestration_conflict",
        message: "The orchestration transition was rejected",
      });
      return;
    }

    server.log.error(
      { errorName: errorName(error) },
      "Unhandled orchestration HTTP request failure",
    );
    void reply.code(500).send({
      error: "internal_error",
      message: "The orchestrator could not complete the request",
    });
  });

  return server;
}

const PROOF_SUMMARY_NOT_FOUND = {
  error: "proof_summary_not_found",
  message: "The requested proof summary was not found",
} as const;

function applyProofSummaryHeaders(reply: FastifyReply): void {
  void reply
    .header("Cache-Control", "private, no-store")
    .header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY")
    .header("X-Robots-Tag", "noindex, nofollow")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendProofSummaryNotFound(reply: FastifyReply): FastifyReply {
  applyProofSummaryHeaders(reply);
  return reply.code(404).send(PROOF_SUMMARY_NOT_FOUND);
}

function isProofSummaryPublicPath(request: FastifyRequest): boolean {
  const path = (request.raw.url ?? "").split("?", 1)[0] ?? "";
  return (
    path === PROOF_SUMMARY_PUBLIC_PATH ||
    path.startsWith(`${PROOF_SUMMARY_PUBLIC_PATH}/`)
  );
}

const CUSTOMER_DASHBOARD_ACCESS_NOT_FOUND = {
  error: "customer_dashboard_access_not_found",
  message: "The customer dashboard access link was not found",
} as const;

function applyCustomerDashboardHeaders(
  reply: FastifyReply,
  scriptNonce?: string,
): void {
  if (
    scriptNonce !== undefined &&
    !/^[A-Za-z0-9_-]{16,128}$/.test(scriptNonce)
  ) {
    throw new TypeError("Customer dashboard script nonce is invalid");
  }
  const contentSecurityPolicy =
    scriptNonce === undefined
      ? "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      : `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  void reply
    .header("Cache-Control", "private, no-store")
    .header("Content-Security-Policy", contentSecurityPolicy)
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY")
    .header("X-Robots-Tag", "noindex, nofollow")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function renderCustomerDashboardAccessExchange(scriptNonce: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>Buildlapse</title>",
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#181817;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#555}</style>",
    "</head><body><main>",
    "<h1>Opening your project</h1>",
    '<p id="status" role="status">Securing your dashboard session...</p>',
    "</main>",
    `<script nonce="${scriptNonce}">`,
    "(()=>{const status=document.getElementById('status');const fail=()=>{status.textContent='This access link is invalid or expired.';};try{const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);if(!token||token.length>1536){fail();return;}const requestFresh=()=>fetch(location.pathname+'/requests',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(()=>{status.textContent='If this link is eligible, a fresh sign-in email is on its way.';},fail);fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async(response)=>{if(!response.ok){await requestFresh();return;}const body=await response.json();if(typeof body.redirectTo!=='string'||!body.redirectTo.startsWith('/dashboard/projects/')){throw new Error('invalid_redirect');}location.replace(body.redirectTo);}).catch(fail);}catch{fail();}})();",
    "</script></body></html>",
  ].join("");
}

function sendCustomerDashboardAccessNotFound(
  reply: FastifyReply,
): FastifyReply {
  applyCustomerDashboardHeaders(reply);
  return reply.code(404).send(CUSTOMER_DASHBOARD_ACCESS_NOT_FOUND);
}

function isCustomerDashboardAccessPath(request: FastifyRequest): boolean {
  const path = (request.raw.url ?? "").split("?", 1)[0] ?? "";
  return (
    path === CUSTOMER_DASHBOARD_ACCESS_PATH ||
    path.startsWith(`${CUSTOMER_DASHBOARD_ACCESS_PATH}/`)
  );
}

function isCustomerDashboardAccessRequestPath(
  request: FastifyRequest,
): boolean {
  const path = (request.raw.url ?? "").split("?", 1)[0] ?? "";
  return path === CUSTOMER_DASHBOARD_ACCESS_REQUEST_PATH;
}

function requireCustomerDashboardProject(
  options: OrchestrationHttpServerOptions,
  request: FastifyRequest,
  projectId: string,
): NonNullable<ReturnType<OrchestrationProjectStore["getProject"]>> {
  let grant: CustomerDashboardGrant;
  try {
    grant = options.customerDashboardAccess.parseSession(
      customerDashboardSessionToken(request),
    );
  } catch {
    throw new OrchestrationHttpError(
      401,
      "customer_dashboard_unauthorized",
      "A valid customer dashboard session is required",
    );
  }
  const project = options.customerDashboardStore.getProject(projectId);
  const email = project?.customer.email;
  if (
    grant.projectId !== projectId ||
    !project ||
    !email?.verified ||
    options.customerDashboardAccess.emailDigest(email.value) !==
      grant.emailDigest
  ) {
    throw new OrchestrationHttpError(
      401,
      "customer_dashboard_unauthorized",
      "A valid customer dashboard session is required",
    );
  }
  return project;
}

function requireCustomerDashboardCsrf(
  options: OrchestrationHttpServerOptions,
  request: FastifyRequest,
): void {
  const sessionToken = customerDashboardSessionToken(request);
  const header = request.headers[CUSTOMER_DASHBOARD_CSRF_HEADER];
  const cookie = customerDashboardCookie(
    request,
    CUSTOMER_DASHBOARD_CSRF_COOKIE,
  );
  if (
    typeof header !== "string" ||
    Buffer.byteLength(header) > MAX_HEADER_BYTES ||
    cookie === undefined ||
    !constantTimeTextEqual(header, cookie) ||
    !options.customerDashboardAccess.verifyCsrfToken(sessionToken, header)
  ) {
    throw new OrchestrationHttpError(
      403,
      "customer_dashboard_csrf_rejected",
      "The customer dashboard request could not be verified",
    );
  }
}

function customerDashboardSessionToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  let bearer: string | undefined;
  if (authorization !== undefined) {
    if (
      Buffer.byteLength(authorization) > MAX_HEADER_BYTES ||
      !authorization.startsWith("Bearer ")
    ) {
      throw new InvalidCustomerDashboardAccessError();
    }
    bearer = authorization.slice("Bearer ".length);
  }
  const cookie = customerDashboardCookie(request, CUSTOMER_DASHBOARD_COOKIE);
  if (
    (bearer === undefined && cookie === undefined) ||
    (bearer !== undefined && cookie !== undefined && bearer !== cookie)
  ) {
    throw new InvalidCustomerDashboardAccessError();
  }
  return (bearer ?? cookie)!;
}

function customerDashboardCookie(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(cookieHeader) > MAX_HEADER_BYTES) {
    throw new InvalidCustomerDashboardAccessError();
  }
  const matchingCookies = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (matchingCookies.length > 1) {
    throw new InvalidCustomerDashboardAccessError();
  }
  return matchingCookies[0];
}

function serializeCustomerDashboardCookie(
  token: string,
  maxAgeSeconds: number,
): string {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(token) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0
  ) {
    throw new InvalidCustomerDashboardAccessError();
  }
  return [
    `${CUSTOMER_DASHBOARD_COOKIE}=${token}`,
    "Path=/v1/orchestration/customer-dashboard",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function serializeCustomerDashboardCsrfCookie(
  token: string,
  maxAgeSeconds: number,
): string {
  if (
    !/^csrf\.v1\.[A-Za-z0-9_-]{43}$/.test(token) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0
  ) {
    throw new InvalidCustomerDashboardAccessError();
  }
  return [
    `${CUSTOMER_DASHBOARD_CSRF_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

interface CapabilityRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

class CapabilityRateLimiter {
  readonly #entries = new Map<
    string,
    { count: number; windowExpiresAt: number }
  >();
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(
    options?: OrchestrationHttpServerOptions["proofSummaryRateLimit"],
  ) {
    this.#maxRequests = boundedPositiveInteger(
      options?.maxRequests ?? 60,
      10_000,
      "proofSummaryRateLimit.maxRequests",
    );
    this.#windowMs = boundedPositiveInteger(
      options?.windowMs ?? 60_000,
      24 * 60 * 60 * 1_000,
      "proofSummaryRateLimit.windowMs",
    );
    this.#maxEntries = boundedPositiveInteger(
      options?.maxEntries ?? 10_000,
      100_000,
      "proofSummaryRateLimit.maxEntries",
    );
    this.#now = options?.now ?? Date.now;
  }

  consume(capabilityDigest: string): CapabilityRateLimitResult {
    const now = this.#now();
    let entry = this.#entries.get(capabilityDigest);
    if (entry && entry.windowExpiresAt <= now) {
      this.#entries.delete(capabilityDigest);
      entry = undefined;
    }
    if (!entry) {
      this.#prune(now);
      while (this.#entries.size >= this.#maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (!oldest) {
          break;
        }
        this.#entries.delete(oldest);
      }
      entry = { count: 0, windowExpiresAt: now + this.#windowMs };
      this.#entries.set(capabilityDigest, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.#maxRequests,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((entry.windowExpiresAt - now) / 1_000),
      ),
    };
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.windowExpiresAt <= now) {
        this.#entries.delete(key);
      }
    }
  }
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function unhealthyReadiness(): OrchestrationReadinessResult {
  return {
    database: false,
    fireworks: false,
    braintrust: false,
    stripe: false,
    resend: false,
    buildBackend: false,
    fly: false,
  };
}

function renderProofSummary(summary: RecordedProofSummary): string {
  const requirements = summary.contract.hardRequirements
    .map(
      (requirement) =>
        `<li><strong>${escapeHtml(requirement.description)}</strong><ul>${requirement.verifiers
          .map(
            (verifier) =>
              `<li><code>${escapeHtml(JSON.stringify(verifier))}</code></li>`,
          )
          .join("")}</ul></li>`,
    )
    .join("");
  const testCommands = summary.contract.configuredChecks.testCommands
    .map((command) => `<li><code>${escapeHtml(command)}</code></li>`)
    .join("");
  const productionUrl = escapeHtml(summary.deployment.productionUrl);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>Recorded proof summary — ${escapeHtml(summary.project.title)}</title>`,
    "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:72rem;margin:3rem auto;padding:0 1.25rem;color:#172033}code{overflow-wrap:anywhere}dt{font-weight:700;margin-top:1rem}dd{margin-left:0}section{margin:2rem 0}</style>",
    "</head><body>",
    "<main>",
    `<h1>Recorded proof summary</h1><p>${escapeHtml(summary.project.title)} · contract v${summary.contract.version}</p>`,
    `<p>${escapeHtml(summary.evidenceBoundary)}</p>`,
    "<section><h2>Configured contract checks</h2>",
    `<p>Policy: <code>${escapeHtml(summary.contract.verificationPolicy)}</code></p>`,
    `<p>Build command: <code>${escapeHtml(summary.contract.configuredChecks.buildCommand)}</code></p>`,
    `<p>Preview command: <code>${escapeHtml(summary.contract.configuredChecks.previewCommand)}</code></p>`,
    `<p>Test commands:</p><ul>${testCommands}</ul>`,
    `<h3>Hard requirements</h3><ul>${requirements}</ul></section>`,
    "<section><h2>Recorded candidate.proven receipt</h2><dl>",
    `<dt>Event</dt><dd><code>${escapeHtml(summary.proofReceipt.eventId)}</code></dd>`,
    `<dt>Recorded</dt><dd>${escapeHtml(summary.proofReceipt.recordedAt)}</dd>`,
    `<dt>Run / candidate</dt><dd><code>${escapeHtml(summary.proofReceipt.runId)}</code> / <code>${escapeHtml(summary.proofReceipt.candidateId)}</code></dd>`,
    `<dt>Revision</dt><dd><code>${escapeHtml(summary.proofReceipt.revisionHash)}</code></dd>`,
    `<dt>Artifact</dt><dd><code>${escapeHtml(summary.proofReceipt.artifactDigest)}</code></dd>`,
    `<dt>Braintrust trace</dt><dd><code>${escapeHtml(summary.proofReceipt.traceId)}</code></dd>`,
    "</dl></section>",
    "<section><h2>Verified deployment receipt</h2><dl>",
    `<dt>Production URL</dt><dd><a href="${productionUrl}" rel="noopener noreferrer">${productionUrl}</a></dd>`,
    `<dt>Fly release</dt><dd><code>${escapeHtml(summary.deployment.releaseId)}</code> (version ${summary.deployment.releaseVersion})</dd>`,
    `<dt>Image digest</dt><dd><code>${escapeHtml(summary.deployment.imageDigest)}</code></dd>`,
    `<dt>Health verified</dt><dd>${escapeHtml(summary.deployment.healthVerifiedAt)}</dd>`,
    "</dl></section>",
    "</main></body></html>",
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validateInternalToken(token: string): string {
  if (
    token.length < 32 ||
    token.length > 4_096 ||
    token.trim() !== token ||
    /\s/.test(token) ||
    hasControlCharacters(token)
  ) {
    throw new TypeError(
      "The orchestration internal token must be 32-4096 non-whitespace characters",
    );
  }
  return token;
}

function validBearerToken(
  request: FastifyRequest,
  expectedToken: string,
): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_HEADER_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new OrchestrationHttpError(
      400,
      "invalid_header",
      `A valid ${name} header is required`,
    );
  }
  return value;
}

function requireRawBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) {
    throw new OrchestrationHttpError(
      415,
      "raw_body_required",
      "Provider webhooks require an application/json raw body",
    );
  }
  return body;
}

function parseInternalJson(body: unknown): unknown {
  const rawBody = requireRawBody(body);
  try {
    return JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    throw new OrchestrationHttpError(
      400,
      "invalid_json",
      "The request body must be valid JSON",
    );
  }
}

function publicProjectResult(
  result: OrchestrationHttpProjectResult,
): z.infer<typeof PublicProjectResultSchema> {
  const parsed = PublicProjectResultSchema.safeParse({
    projectId: result.projectId,
    status: result.status,
    ...(result.revision === undefined ? {} : { revision: result.revision }),
    ...(result.status === "needs_clarification" &&
    result.openClarificationQuestions?.length
      ? { clarificationQuestions: result.openClarificationQuestions }
      : {}),
  });
  if (!parsed.success) {
    throw new Error("The orchestration controller returned an invalid result");
  }
  return parsed.data;
}

function stableProviderId(prefix: string, value: string): string {
  return `${prefix}:${sha256(value).slice(0, 32)}`;
}

function recordWebhookSecurityFailure(
  audit: OrchestrationHttpServerOptions["securityAudit"],
  request: FastifyRequest,
  provider: WebhookSecurityAuditProvider,
  rawBody: Buffer,
  headerNames: readonly string[],
  failureCode: WebhookSecurityFailureCode,
): void {
  audit.recordWebhookSecurityFailure({
    provider,
    bodyDigest: sha256(rawBody),
    headerDigest: digestWebhookHeaders(request, headerNames),
    failureCode,
  });
}

function digestWebhookHeaders(
  request: FastifyRequest,
  headerNames: readonly string[],
): string {
  const fingerprints = headerNames.map((name) => {
    const value = request.headers[name];
    if (typeof value === "string") {
      return {
        name,
        present: true,
        valueDigests: [sha256(value)],
      };
    }
    if (Array.isArray(value)) {
      return {
        name,
        present: true,
        valueDigests: value.map((item) => sha256(item)),
      };
    }
    return {
      name,
      present: false,
      valueDigests: [],
    };
  });
  return sha256(canonicalJson(fingerprints));
}

function isInvalidProviderWebhook(
  error: unknown,
  provider: WebhookSecurityAuditProvider,
): boolean {
  return (
    error instanceof ProviderAdapterError &&
    error.provider === provider &&
    error.code === "INVALID_WEBHOOK"
  );
}

class OrchestrationHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(statusCode: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "OrchestrationHttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

function isFastifyBodyTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  );
}

function isFastifyUnsupportedMediaTypeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
  );
}

function isExpectedConflict(error: unknown): boolean {
  const name = errorName(error);
  return new Set([
    "CustomerDashboardLoginConflictError",
    "InboxConflictError",
    "InboundMailEnvelopeConflictError",
    "OptimisticConcurrencyError",
    "OrchestrationIdempotencyConflictError",
    "OrchestrationPolicyError",
    "PendingInboundMailError",
    "ProofSummarySnapshotRevocationConflictError",
    "ProjectAlreadyExistsError",
  ]).has(name);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }
  return false;
}
