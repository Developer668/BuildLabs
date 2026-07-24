import { AsyncLocalStorage } from "node:async_hooks";

import type { OutboxEvent } from "../../domain/artifact.js";
import { isTerminalStatus } from "../../domain/run.js";
import { canonicalJson, digestJson, sha256 } from "../../lib/canonical-json.js";
import type {
  BuildBackendPort,
  FrozenProvenPreview,
} from "../ports/build-backend.js";
import type {
  FlyDeploymentPort,
  FlyDeploymentReceipt,
} from "../ports/deployment.js";
import type {
  MailPort,
  OutboundMailDeliveryStatus,
  SendMailRequest,
} from "../ports/mail.js";
import type {
  CheckoutSession as ProviderCheckoutSession,
  PaidCheckoutWebhook,
  PaymentPort,
  VerifiedSettlement,
} from "../ports/payment.js";
import type {
  WebsiteResearchCapture,
  WebsiteResearchPort,
} from "../ports/website-research.js";
import {
  CheckoutSessionSchema,
  CustomerProfileSchema,
  IntakeSchema,
  ProjectMessageSchema,
  type BuildBatch,
  type DurableEffect,
  type Intake,
  type ProjectAggregate,
  type ProjectEventInput,
  type ProjectMessage,
  type ProposalVersion,
  type ProvenCandidate,
} from "../domain/project.js";
import type {
  CustomerDashboardLoginConsumption,
  OrchestrationProjectStore,
  ProofSummarySnapshot,
  ProofSummarySnapshotInput,
  VerifiedInboxEvent,
} from "../domain/store.js";
import { compileBuildAssignments } from "./build-assignment-compiler.js";
import {
  clarificationEmail,
  customerDashboardLoginEmail,
  dashboardAccessEmail,
  emailVerificationEmail,
  paymentConfirmationEmail,
  productionDeliveryEmail,
  proposalEmail,
  provenPreviewEmail,
  steeringAcceptedEmail,
  type CustomerEmailDraft,
} from "./customer-email-templates.js";
import type { CustomerDashboardAccessCodec } from "./customer-dashboard-access.js";
import type {
  ChangeClassification,
  ConversationAnalysis,
  OrchestrationReasoner,
  ProposalPlan,
} from "./fireworks-orchestration-reasoner.js";
import { identifyAndMinimizePii, type PiiFinding } from "./pii.js";
import {
  assertPaidRevisionUsesExactCommercialScope,
  customerChangeRequiresRequote,
  UnpaidScopeExpansionError,
} from "./paid-scope-policy.js";
import {
  buildProposalVersion,
  UnconfirmedResearchEvidenceError,
  UnsupportedAssetEvidenceError,
  UnverifiedQuoteEvidenceError,
  type ConversationEvidenceSegment,
} from "./proposal-builder.js";
import {
  assertExplicitResearchAuthorization,
  UnverifiedResearchAuthorizationError,
} from "./research-authorization.js";
import {
  boundProtectedPublicationValues,
  createRecordedProofSnapshot,
  MAX_PROOF_PERSON_NAME_SPAN_CHARS,
  MAX_PROOF_PERSON_NAME_SPANS,
  MAX_PROOF_PERSON_NAME_TOKENS,
  MAX_PROOF_PII_SPANS,
  MAX_PROOF_PROTECTED_VALUE_CHARS,
  parseRecordedProofSnapshot,
  type ProtectedPublicationValue,
  type RecordedProofBinding,
} from "./project-evidence.js";
import type { ProofSummaryLinkCodec } from "./proof-summary-links.js";
import type { ReplyAddressCodec } from "./reply-address.js";
import { selectProvenWinner } from "./winner-selection.js";

const MAX_MODEL_CONTEXT_CHARS = 200_000;
const MAX_CONTEXT_MESSAGES = 50;
const PREVIEW_EXPIRY_SAFETY_MARGIN_MS = 60 * 60 * 1_000;
const PROVIDER_RECHECK_INTERVAL_MS = 60_000;
const EMAIL_VERIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_DASHBOARD_LOGIN_TTL_SECONDS = 15 * 60;
const DASHBOARD_LOGIN_REISSUE_MIN_INTERVAL_MS = 60 * 1_000;
const MAX_DASHBOARD_LOGIN_REISSUE_REQUESTS = 32;
const MAX_LOGIN_CAPABILITY_GENERATIONS = 3;
const DASHBOARD_ACCESS_CAS_ATTEMPTS = 3;
const EMAIL_OWNERSHIP_CLARIFICATION =
  "Complete passwordless email verification to continue.";
const effectAttemptContext = new AsyncLocalStorage<{
  attemptedEffectKeys: string[];
}>();

export interface OrchestrationAgentOptions {
  store: OrchestrationProjectStore;
  reasoner: OrchestrationReasoner;
  payment: PaymentPort;
  mail: MailPort;
  research: WebsiteResearchPort;
  build: BuildBackendPort;
  deployment: FlyDeploymentPort;
  replyAddresses: ReplyAddressCodec;
  proofSummaryLinks: Pick<ProofSummaryLinkCodec, "create">;
  customerDashboardAccess: Pick<
    CustomerDashboardAccessCodec,
    "createLoginLink"
  >;
  fromEmail: string;
  messageIdDomain: string;
  expectedStripeLivemode: boolean;
  now?: () => Date;
  sandboxSnapshot?: string;
  provenPreviewTtlSeconds?: number;
  previewReviewPeriodMs?: number;
  effectMaxAttempts?: number;
  effectRetryInitialDelayMs?: number;
  effectRetryMaxDelayMs?: number;
  buildDeadlineMs?: number;
  proofEventGracePeriodMs?: number;
  mailDeliveryDeadlineMs?: number;
  dashboardLoginTtlSeconds?: number;
}

export interface AcceptIntakeRequest {
  idempotencyKey: string;
  projectId?: string;
  channel: "voice" | "email" | "text";
  intakeId: string;
  sourceId: string;
  receivedAt: string;
  content: string;
  emailVerified: boolean;
  trustedSenderEmail?: string;
  researchConsent: boolean;
  provider?: string;
  /**
   * Return as soon as the intake is durably recorded, leaving reasoning and the
   * first customer mail to the reconciliation worker. Callers on a request
   * deadline — the voice post-call bridge in particular — cannot wait for a
   * model turn, and `intake_received` is a reconcilable checkpoint, so the work
   * still completes exactly once.
   */
  deferAnalysis?: boolean;
}

export interface VerifyEmailOwnershipRequest {
  projectId: string;
  method: "passwordless_email";
  provider: string;
  providerEventId: string;
  eventDigest: string;
  email: string;
  verifiedAt: string;
  dashboardLogin?: Omit<CustomerDashboardLoginConsumption, "projectId">;
}

export interface RequestCustomerDashboardAccessRequest {
  projectId: string;
  emailDigest: string;
  capabilityDigest: string;
}

export interface ReceiveCustomerMessageRequest {
  projectId: string;
  source?: "dashboard" | "email";
  expectedProjectRevision?: number;
  expectedProposalVersion?: number;
  providerEventId: string;
  eventDigest: string;
  providerMessageId: string;
  receivedAt: string;
  senderEmail: string;
  subject: string;
  content: string;
  threadId?: string;
}

export interface RecordMailDeliveryRequest {
  projectId: string;
  providerEventId: string;
  eventDigest: string;
  providerMessageId: string;
  occurredAt: string;
  deliveryStatus: OutboundMailDeliveryStatus;
  permanent: boolean;
}

interface VerifiedStripePayment {
  checkout: ProviderCheckoutSession;
  settlement: VerifiedSettlement;
}

interface StripePaymentEvidence {
  providerEventId: string;
  providerEvidenceDigest: string;
  inboxEventDigest?: string;
  signedEventDigest?: string;
  reconciliationEffectKey?: string;
  verificationSource: "provider_api" | "signed_webhook";
  signatureVerified: boolean;
  paidAt: string;
}

export class OrchestrationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationPolicyError";
  }
}

export class PendingInboundMailError extends Error {
  constructor() {
    super(
      "A signed inbound customer email must be recovered before advancing this project",
    );
    this.name = "PendingInboundMailError";
  }
}

export class OrchestrationAgent {
  readonly #store: OrchestrationProjectStore;
  readonly #reasoner: OrchestrationReasoner;
  readonly #payment: PaymentPort;
  readonly #mail: MailPort;
  readonly #research: WebsiteResearchPort;
  readonly #build: BuildBackendPort;
  readonly #deployment: FlyDeploymentPort;
  readonly #replyAddresses: ReplyAddressCodec;
  readonly #proofSummaryLinks: Pick<ProofSummaryLinkCodec, "create">;
  readonly #customerDashboardAccess: Pick<
    CustomerDashboardAccessCodec,
    "createLoginLink"
  >;
  readonly #fromEmail: string;
  readonly #messageIdDomain: string;
  readonly #expectedStripeLivemode: boolean;
  readonly #now: () => Date;
  readonly #sandboxSnapshot: string | undefined;
  readonly #provenPreviewTtlSeconds: number;
  readonly #previewReviewPeriodMs: number;
  readonly #effectMaxAttempts: number;
  readonly #effectRetryInitialDelayMs: number;
  readonly #effectRetryMaxDelayMs: number;
  readonly #buildDeadlineMs: number;
  readonly #proofEventGracePeriodMs: number;
  readonly #mailDeliveryDeadlineMs: number;
  readonly #dashboardLoginTtlSeconds: number;
  readonly #projectSerial = new ProjectSerialExecutor();

  constructor(options: OrchestrationAgentOptions) {
    this.#store = options.store;
    this.#reasoner = options.reasoner;
    this.#payment = options.payment;
    this.#mail = options.mail;
    this.#research = options.research;
    this.#build = options.build;
    this.#deployment = options.deployment;
    this.#replyAddresses = options.replyAddresses;
    this.#proofSummaryLinks = options.proofSummaryLinks;
    this.#customerDashboardAccess = options.customerDashboardAccess;
    this.#fromEmail = options.fromEmail;
    this.#messageIdDomain = validateMessageIdDomain(options.messageIdDomain);
    this.#expectedStripeLivemode = options.expectedStripeLivemode;
    this.#now = options.now ?? (() => new Date());
    this.#sandboxSnapshot = options.sandboxSnapshot;
    this.#provenPreviewTtlSeconds =
      options.provenPreviewTtlSeconds ?? 48 * 60 * 60;
    this.#previewReviewPeriodMs =
      options.previewReviewPeriodMs ?? 24 * 60 * 60 * 1_000;
    this.#effectMaxAttempts = boundedRetryInteger(
      options.effectMaxAttempts ?? 5,
      1,
      20,
      "effectMaxAttempts",
    );
    this.#effectRetryInitialDelayMs = boundedRetryInteger(
      options.effectRetryInitialDelayMs ?? 1_000,
      100,
      5 * 60_000,
      "effectRetryInitialDelayMs",
    );
    this.#effectRetryMaxDelayMs = boundedRetryInteger(
      options.effectRetryMaxDelayMs ?? 60_000,
      this.#effectRetryInitialDelayMs,
      24 * 60 * 60 * 1_000,
      "effectRetryMaxDelayMs",
    );
    this.#buildDeadlineMs = boundedRetryInteger(
      options.buildDeadlineMs ?? 2 * 60 * 60 * 1_000,
      1_000,
      24 * 60 * 60 * 1_000,
      "buildDeadlineMs",
    );
    this.#proofEventGracePeriodMs = boundedRetryInteger(
      options.proofEventGracePeriodMs ?? 2 * 60 * 1_000,
      1_000,
      30 * 60 * 1_000,
      "proofEventGracePeriodMs",
    );
    this.#mailDeliveryDeadlineMs = boundedRetryInteger(
      options.mailDeliveryDeadlineMs ?? 6 * 60 * 60 * 1_000,
      1_000,
      7 * 24 * 60 * 60 * 1_000,
      "mailDeliveryDeadlineMs",
    );
    this.#dashboardLoginTtlSeconds = boundedRetryInteger(
      options.dashboardLoginTtlSeconds ?? DEFAULT_DASHBOARD_LOGIN_TTL_SECONDS,
      60,
      7 * 24 * 60 * 60,
      "dashboardLoginTtlSeconds",
    );
    if (
      !Number.isInteger(this.#provenPreviewTtlSeconds) ||
      this.#provenPreviewTtlSeconds < 60 ||
      this.#provenPreviewTtlSeconds > 7 * 24 * 60 * 60
    ) {
      throw new RangeError(
        "provenPreviewTtlSeconds must be between 60 seconds and 7 days",
      );
    }
    if (
      !Number.isSafeInteger(this.#previewReviewPeriodMs) ||
      this.#previewReviewPeriodMs < 0
    ) {
      throw new RangeError(
        "previewReviewPeriodMs must be a non-negative safe integer",
      );
    }
    if (
      this.#provenPreviewTtlSeconds * 1_000 <
      this.#previewReviewPeriodMs + 60 * 60 * 1_000
    ) {
      throw new RangeError(
        "proven preview TTL must exceed the review period by at least one hour",
      );
    }
  }

  async acceptIntake(
    input: AcceptIntakeRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    if (input.channel === "voice" && input.emailVerified) {
      throw new OrchestrationPolicyError(
        "Voice intake cannot attest email ownership",
      );
    }
    if (input.content.length > MAX_MODEL_CONTEXT_CHARS) {
      throw new OrchestrationPolicyError(
        "Intake exceeds the bounded orchestration model context",
      );
    }
    // Persist only deterministic intake facts before asking Fireworks to
    // reason. This makes the idempotency digest independent of model output
    // and leaves a recoverable `intake_received` checkpoint if inference
    // fails or the process stops.
    const deterministicPii = identifyAndMinimizePii(input.content, []);
    const intake = buildIntake(input, deterministicPii.findings);
    const detectedEmails = [
      ...new Set(
        deterministicPii.findings
          .filter((finding) => finding.type === "email")
          .map((finding) => finding.value.trim()),
      ),
    ];
    const detectedPhones = [
      ...new Set(
        deterministicPii.findings
          .filter((finding) => finding.type === "phone")
          .map((finding) => finding.value.trim()),
      ),
    ];
    const deterministicEmail = (
      input.trustedSenderEmail ??
      (detectedEmails.length === 1 ? detectedEmails[0] : undefined)
    )?.trim();
    const customer = CustomerProfileSchema.parse({
      profileId: `profile:${sha256(input.intakeId).slice(0, 24)}`,
      ...(deterministicEmail
        ? {
            email: {
              value: deterministicEmail,
              verified: input.emailVerified,
              ...(input.emailVerified ? { verifiedAt: input.receivedAt } : {}),
            },
          }
        : {}),
      ...(detectedPhones.length === 1
        ? {
            phone: {
              value: detectedPhones[0],
              verified: false,
            },
          }
        : {}),
      preferredChannel: input.channel,
      researchConsent: {
        granted: input.researchConsent,
        scope: "own_business_only",
        ...(input.researchConsent
          ? {
              capturedAt: input.receivedAt,
              sourceIntakeId: input.intakeId,
            }
          : {}),
      },
    });
    const created = this.#store.createProject({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      idempotencyKey: input.idempotencyKey,
      status: "intake_received",
      intake,
      customer,
    });
    if (!created.created) {
      return input.deferAnalysis
        ? created.project
        : this.reconcileProject(created.project.projectId, signal);
    }
    if (input.deferAnalysis) {
      return created.project;
    }
    return this.#runWithEffectFailure(
      created.project.projectId,
      () => this.#analyzeStoredIntake(created.project, signal),
      signal,
    );
  }

  async verifyEmailOwnership(
    input: VerifyEmailOwnershipRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    return this.#projectSerial.run(input.projectId, async () => {
      if (
        input.method !== "passwordless_email" ||
        !/^[a-z][a-z0-9_-]{0,63}$/u.test(input.provider)
      ) {
        throw new OrchestrationPolicyError(
          "Email ownership requires a recognized passwordless provider attestation",
        );
      }
      const project = this.#requireProject(input.projectId);
      const storedEmail = project.customer.email;
      if (
        !storedEmail ||
        normalizeEmail(storedEmail.value) !== normalizeEmail(input.email)
      ) {
        throw new OrchestrationPolicyError(
          "Passwordless verification does not match the intake-evidenced email",
        );
      }
      const verifiedAt = Date.parse(input.verifiedAt);
      if (
        !Number.isFinite(verifiedAt) ||
        verifiedAt <
          Date.parse(project.intake.receivedAt) -
            EMAIL_VERIFICATION_CLOCK_SKEW_MS ||
        verifiedAt > this.#now().getTime() + EMAIL_VERIFICATION_CLOCK_SKEW_MS
      ) {
        throw new OrchestrationPolicyError(
          "Passwordless verification timestamp is outside the accepted window",
        );
      }

      const inbox: VerifiedInboxEvent = {
        provider: `passwordless_email_${input.provider}`,
        eventId: input.providerEventId,
        digest: input.eventDigest,
      };
      if (
        this.#store.hasVerifiedInboxEvent(
          inbox.provider,
          inbox.eventId,
          inbox.digest,
        )
      ) {
        if (input.dashboardLogin) {
          throw new OrchestrationPolicyError(
            "Passwordless dashboard login capability was already consumed",
          );
        }
        if (!storedEmail.verified) {
          throw new OrchestrationPolicyError(
            "Passwordless verification receipt is inconsistent with project identity",
          );
        }
        return this.#reconcileProject(project.projectId, signal);
      }

      const changed = structuredClone(project);
      changed.customer.email = {
        value: storedEmail.value,
        verified: true,
        verifiedAt: input.verifiedAt,
      };
      changed.openClarificationQuestions =
        changed.openClarificationQuestions.filter(
          (question) => !isEmailOwnershipClarification(question),
        );
      const saved = this.#save(
        changed,
        {
          type: "customer.email_ownership_verified",
          actor: "provider",
          payload: {
            status: changed.status,
            provider: input.provider,
            providerEventDigest: input.eventDigest,
            correlationId: input.providerEventId,
          },
        },
        inbox,
        input.dashboardLogin
          ? {
              ...input.dashboardLogin,
              projectId: input.projectId,
            }
          : undefined,
      );
      if (input.dashboardLogin) {
        return saved;
      }
      return this.#reconcileProject(saved.projectId, signal);
    });
  }

  async requestCustomerDashboardAccess(
    input: RequestCustomerDashboardAccessRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    return this.#projectSerial.run(input.projectId, async () => {
      if (
        !/^[a-f0-9]{64}$/u.test(input.emailDigest) ||
        !/^[a-f0-9]{64}$/u.test(input.capabilityDigest)
      ) {
        throw new OrchestrationPolicyError(
          "Dashboard access reissue evidence is invalid",
        );
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.#runWithEffectFailure(
            input.projectId,
            async () => {
              const project = this.#requireProject(input.projectId);
              const email = project.customer.email;
              if (
                !email ||
                sha256(normalizeEmail(email.value)) !== input.emailDigest
              ) {
                throw new OrchestrationPolicyError(
                  "Dashboard access reissue does not match the protected project identity",
                );
              }
              return this.#sendDashboardLogin(project, input.capabilityDigest);
            },
            signal,
          );
        } catch (error) {
          if (
            attempt >= DASHBOARD_ACCESS_CAS_ATTEMPTS ||
            !isOptimisticConcurrencyFailure(error)
          ) {
            throw error;
          }
        }
      }
    });
  }

  async receiveCustomerMessage(
    input: ReceiveCustomerMessageRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    return this.#projectSerial.run(input.projectId, () =>
      this.#receiveCustomerMessage(input, signal),
    );
  }

  async #receiveCustomerMessage(
    input: ReceiveCustomerMessageRequest,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const source = input.source ?? "email";
    if (input.content.length > MAX_MODEL_CONTEXT_CHARS) {
      throw new OrchestrationPolicyError(
        "Customer message exceeds the bounded orchestration model context",
      );
    }
    const project = this.#requireProject(input.projectId);
    const expectedEmail = project.customer.email;
    if (
      !expectedEmail?.verified ||
      normalizeEmail(expectedEmail.value) !== normalizeEmail(input.senderEmail)
    ) {
      throw new OrchestrationPolicyError(
        "Inbound sender does not match the verified project customer",
      );
    }
    if (["cancelled", "failed"].includes(project.status)) {
      throw new OrchestrationPolicyError(
        "This project is not accepting customer revisions",
      );
    }
    const recoveryBlocked = [
      "needs_operator_attention",
      "payment_verification_failed",
      "deployment_verification_failed",
    ].includes(project.status);

    const messageId = `message:${sha256(input.providerMessageId).slice(0, 24)}`;
    const existingMessage = project.messages.find(
      (candidate) => candidate.messageId === messageId,
    );
    if (
      source === "dashboard" &&
      !existingMessage &&
      (input.expectedProjectRevision !== project.revision ||
        input.expectedProposalVersion !== project.activeProposalVersion)
    ) {
      throw new OrchestrationPolicyError(
        "Dashboard steering is stale for the current project revision",
      );
    }
    const priorStableStatus = stableProjectStatus(project);
    let saved = project;
    if (!existingMessage) {
      const message = ProjectMessageSchema.parse({
        messageId,
        direction: "inbound",
        channel: source,
        purpose: "customer_revision",
        provider: source === "dashboard" ? "buildlabs_dashboard" : "resend",
        providerMessageId: input.providerMessageId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        references: [],
        subject: input.subject,
        content: input.content,
        contentDigest: sha256(input.content),
        senderAuthenticated: true,
        deliveryStatus: "received",
        createdAt: input.receivedAt,
      });
      const changed = structuredClone(project);
      changed.messages.push(message);
      if (!recoveryBlocked) {
        changed.openClarificationQuestions = [];
        changed.status =
          project.payments.length > 0
            ? "revision_pending"
            : "awaiting_customer_revision";
      }
      saved = this.#save(
        changed,
        {
          type: "message.customer_revision_received",
          actor: "customer",
          payload: {
            previousStatus: project.status,
            status: changed.status,
            messageId: message.messageId,
            messageDigest: message.contentDigest,
          },
        },
        source === "email"
          ? {
              provider: "resend",
              eventId: input.providerEventId,
              digest: input.eventDigest,
            }
          : undefined,
      );
    } else {
      if (
        existingMessage.contentDigest !== sha256(input.content) ||
        existingMessage.channel !== source ||
        existingMessage.provider !==
          (source === "dashboard" ? "buildlabs_dashboard" : "resend")
      ) {
        throw new OrchestrationPolicyError(
          "Provider message identity was reused with different content",
        );
      }
      if (source === "email") {
        this.#store.recordInbox(
          "resend",
          input.providerEventId,
          input.eventDigest,
        );
      }
      const alreadyApplied =
        this.#consumedInboundMessageIds(project).has(messageId);
      if (alreadyApplied) {
        return project;
      }
      if (
        !recoveryBlocked &&
        (!["awaiting_customer_revision", "revision_pending"].includes(
          project.status,
        ) ||
          project.openClarificationQuestions.length > 0)
      ) {
        const changed = structuredClone(project);
        changed.openClarificationQuestions = [];
        changed.status =
          project.payments.length > 0
            ? "revision_pending"
            : "awaiting_customer_revision";
        saved = this.#save(changed, {
          type: "message.customer_revision_resumed",
          actor: "system",
          payload: {
            previousStatus: project.status,
            status: changed.status,
            messageId,
            messageDigest: existingMessage.contentDigest,
          },
        });
      }
    }

    if (!saved.messages.some((message) => message.messageId === messageId)) {
      throw new OrchestrationPolicyError(
        "Persisted customer revision could not be recovered",
      );
    }
    if (recoveryBlocked) {
      return saved;
    }
    return this.#runWithEffectFailure(
      saved.projectId,
      () =>
        this.#processSavedCustomerMessages(saved, priorStableStatus, signal),
      signal,
    );
  }

  async recordMailDelivery(
    input: RecordMailDeliveryRequest,
  ): Promise<ProjectAggregate> {
    return this.#projectSerial.run(input.projectId, () =>
      this.#recordMailDelivery(input),
    );
  }

  async #recordMailDelivery(
    input: RecordMailDeliveryRequest,
  ): Promise<ProjectAggregate> {
    // Keep this provider-facing controller method on the same asynchronous
    // boundary as the other webhook handlers even though the store is local.
    await Promise.resolve();
    const project = this.#requireProject(input.projectId);
    const matchingMessages = project.messages.filter(
      (message) =>
        message.direction === "outbound" &&
        message.provider === "resend" &&
        message.providerMessageId === input.providerMessageId,
    );
    if (matchingMessages.length !== 1) {
      throw new OrchestrationPolicyError(
        "Resend delivery event does not identify exactly one outbound message",
      );
    }
    const matched = matchingMessages[0]!;
    const permanentFailure =
      input.permanent &&
      (input.deliveryStatus === "bounced" || input.deliveryStatus === "failed");
    const deliveryFailure =
      input.deliveryStatus === "bounced" || input.deliveryStatus === "failed";
    const alreadyFailed =
      matched.deliveryStatus === "bounced" ||
      matched.deliveryStatus === "failed";
    const alreadyDelivered = matched.deliveryStatus === "delivered";
    const activeMailEffect = activeRequiredMailEffect(project, matched);
    const activeFinalDelivery =
      matched.purpose === "final_delivery" &&
      activeMailEffect?.type === "send_final_delivery";
    const activeRequiredMail = activeMailEffect !== undefined;
    const terminalDeliveryFailure = deliveryFailure && permanentFailure;
    const nextDeliveryStatus =
      alreadyFailed || alreadyDelivered
        ? matched.deliveryStatus
        : terminalDeliveryFailure || input.deliveryStatus === "delivered"
          ? input.deliveryStatus
          : matched.deliveryStatus;
    const nextProjectStatus =
      permanentFailure && activeRequiredMail && !alreadyDelivered
        ? "needs_operator_attention"
        : input.deliveryStatus === "delivered" &&
            !alreadyFailed &&
            activeFinalDelivery
          ? buildProgressStatus(project, "completed")
          : project.status;

    const errorId = deliveryFailure
      ? `mail-delivery:${sha256(input.providerEventId).slice(0, 24)}`
      : undefined;
    const recordsNewFailure =
      errorId !== undefined &&
      !project.errors.some((error) => error.errorId === errorId);
    const reconciliationKey = `mail:reconcile:${project.projectId}:${input.providerMessageId}`;
    const reconciliationEffect = project.effects.find(
      (effect) =>
        effect.key === reconciliationKey &&
        effect.type === "reconcile_mail_delivery",
    );
    const terminalizesReconciliation =
      reconciliationEffect?.status === "pending" &&
      (input.deliveryStatus === "delivered" || permanentFailure);
    if (
      nextDeliveryStatus === matched.deliveryStatus &&
      nextProjectStatus === project.status &&
      !recordsNewFailure &&
      !terminalizesReconciliation
    ) {
      this.#store.recordInbox(
        "resend",
        input.providerEventId,
        input.eventDigest,
      );
      return project;
    }

    const changed = structuredClone(project);
    const message = changed.messages.find(
      (candidate) => candidate.messageId === matched.messageId,
    )!;
    if (nextDeliveryStatus !== matched.deliveryStatus) {
      message.deliveryStatus = nextDeliveryStatus;
      message.deliveryUpdatedAt = input.occurredAt;
    }
    changed.status = nextProjectStatus;
    if (deliveryFailure && errorId) {
      if (recordsNewFailure) {
        changed.errors.push({
          errorId,
          code: `mail.${input.deliveryStatus}`,
          category: permanentFailure ? "permanent" : "transient",
          message: permanentFailure
            ? "Resend reported a permanent outbound delivery failure"
            : "Resend reported an outbound delivery failure requiring review",
          retryable: !permanentFailure,
          occurredAt: input.occurredAt,
        });
      }
    }
    if (terminalizesReconciliation && input.deliveryStatus === "delivered") {
      completeEffect(
        changed,
        reconciliationKey,
        input.providerMessageId,
        {
          provider: "resend",
          messageId: input.providerMessageId,
          status: input.deliveryStatus,
          verifiedAt: input.occurredAt,
          permanent: input.permanent,
          providerEventDigest: input.eventDigest,
        },
        input.occurredAt,
      );
    } else if (terminalizesReconciliation && permanentFailure) {
      const effect = requireEffect(changed, reconciliationKey);
      const reconciliationError = {
        errorId: effectErrorId(
          effect.key,
          effect.attempts,
          `mail.${input.deliveryStatus}`,
        ),
        code: `mail.${input.deliveryStatus}`,
        category: "permanent" as const,
        message: "Resend reported a permanent outbound delivery failure",
        retryable: false,
        effectKey: effect.key,
        occurredAt: input.occurredAt,
      };
      effect.status = "failed";
      effect.error = reconciliationError;
      effect.updatedAt = input.occurredAt;
      delete effect.nextAttemptAt;
      delete effect.nextCheckAt;
      if (
        !changed.errors.some(
          (candidate) => candidate.errorId === reconciliationError.errorId,
        )
      ) {
        changed.errors.push(reconciliationError);
      }
    }
    return this.#save(
      changed,
      {
        type: "email.delivery_status_updated",
        actor: "provider",
        payload: {
          previousStatus: project.status,
          status: changed.status,
          messageId: message.messageId,
          provider: "resend",
          providerEventDigest: input.eventDigest,
          ...(deliveryFailure
            ? { errorCode: `mail.${input.deliveryStatus}` }
            : {}),
          ...(terminalizesReconciliation
            ? {
                effectKey: reconciliationKey,
                effectType: "reconcile_mail_delivery",
              }
            : {}),
        },
      },
      {
        provider: "resend",
        eventId: input.providerEventId,
        digest: input.eventDigest,
      },
    );
  }

  async confirmPayment(
    event: PaidCheckoutWebhook,
    eventDigest: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const projectId = event.session.projectId;
    if (!projectId) {
      throw new OrchestrationPolicyError(
        "Stripe event is missing its project binding",
      );
    }
    return this.#projectSerial.run(projectId, () =>
      this.#confirmPayment(event, eventDigest, signal),
    );
  }

  async #confirmPayment(
    event: PaidCheckoutWebhook,
    eventDigest: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const projectId = event.session.projectId!;
    const project = this.#requireProject(projectId);
    this.#assertNoUnresolvedInboundMail(projectId);
    return this.#runWithEffectFailure(
      projectId,
      async () => {
        const existingPayment = project.payments.find(
          (payment) =>
            payment.checkoutSessionId === event.session.sessionId ||
            (event.session.paymentIntentId !== null &&
              payment.paymentIntentId === event.session.paymentIntentId),
        );
        if (existingPayment) {
          const paidProposal = project.proposals.find(
            (candidate) =>
              candidate.version === existingPayment.proposalVersion &&
              candidate.digest === existingPayment.proposalDigest,
          );
          if (!paidProposal) {
            throw new OrchestrationPolicyError(
              "Stored payment has no exact proposal",
            );
          }
          await this.#verifyStripeSettlement(
            project,
            paidProposal,
            event.session.sessionId,
            event,
          );
          this.#store.recordInbox("stripe", event.eventId, eventDigest);
          if (project.activeProposalVersion !== paidProposal.version) {
            return project;
          }
          return this.#continueAfterPayment(project, paidProposal, signal);
        }
        const storedCheckout = project.checkoutSessions.find(
          (session) => session.sessionId === event.session.sessionId,
        );
        if (!storedCheckout) {
          throw new OrchestrationPolicyError(
            "Stripe payment references an unknown Checkout Session",
          );
        }
        const proposal = project.proposals.find(
          (candidate) =>
            candidate.version === storedCheckout.proposalVersion &&
            candidate.digest === storedCheckout.proposalDigest,
        );
        if (!proposal) {
          throw new OrchestrationPolicyError(
            "Stored Checkout Session has no exact proposal",
          );
        }
        const currentProposal = activeProposal(project);
        const settlesCurrentProposal =
          currentProposal.version === proposal.version &&
          currentProposal.digest === proposal.digest;
        if (
          settlesCurrentProposal &&
          !["awaiting_payment", "awaiting_customer_revision"].includes(
            project.status,
          )
        ) {
          throw new OrchestrationPolicyError(
            "A new payment can only settle the current proposal while payment or a pre-payment edit is pending",
          );
        }
        const verified = await this.#verifyStripeSettlement(
          project,
          proposal,
          event.session.sessionId,
          event,
        );
        const providerEvidenceDigest = verifiedStripeEvidenceDigest(verified);
        const saved = this.#persistVerifiedPayment(
          project,
          proposal,
          verified,
          {
            providerEventId: event.eventId,
            providerEvidenceDigest,
            inboxEventDigest: eventDigest,
            signedEventDigest: eventDigest,
            verificationSource: "signed_webhook",
            signatureVerified: true,
            paidAt: event.createdAt,
          },
          settlesCurrentProposal,
        );
        if (!settlesCurrentProposal) {
          return saved;
        }
        return this.#continueAfterPayment(saved, proposal, signal);
      },
      signal,
    );
  }

  #persistVerifiedPayment(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    verified: VerifiedStripePayment,
    evidence: StripePaymentEvidence,
    authorizeCurrentProposal = true,
  ): ProjectAggregate {
    const changed = structuredClone(project);
    const checkout = changed.checkoutSessions.find(
      (session) => session.sessionId === verified.checkout.sessionId,
    );
    if (!checkout || !verified.checkout.paymentIntentId) {
      throw new OrchestrationPolicyError(
        "Verified Stripe settlement lacks its stored Checkout identity",
      );
    }
    checkout.status = "complete";
    checkout.updatedAt = this.#timestamp();
    changed.payments.push({
      receiptId: `payment:${sha256(evidence.providerEventId).slice(0, 24)}`,
      provider: "stripe",
      providerEventId: evidence.providerEventId,
      providerEvidenceDigest: evidence.providerEvidenceDigest,
      checkoutSessionId: verified.checkout.sessionId,
      paymentIntentId: verified.checkout.paymentIntentId,
      projectId: changed.projectId,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      proposalDigest: proposal.digest,
      amountMinor: proposal.quote.amountMinor,
      amountReceivedMinor: verified.settlement.amountReceivedMinor,
      currency: proposal.quote.currency,
      customerEmailDigest: sha256(
        normalizeEmail(verified.settlement.customerEmail),
      ),
      customerId: verified.settlement.customerId,
      checkoutStatus: verified.settlement.checkoutStatus,
      paymentStatus: verified.settlement.paymentStatus,
      paymentIntentStatus: verified.settlement.paymentIntentStatus,
      paymentIntentCreatedAt: verified.settlement.paymentIntentCreatedAt,
      status: "paid",
      verificationSource: evidence.verificationSource,
      providerStateVerified: true,
      signatureVerified: evidence.signatureVerified,
      ...(evidence.signedEventDigest
        ? { signedEventDigest: evidence.signedEventDigest }
        : {}),
      paidAt: evidence.paidAt,
      verifiedAt: this.#timestamp(),
      livemode: verified.checkout.livemode,
    });
    if (evidence.reconciliationEffectKey) {
      completeEffect(
        changed,
        evidence.reconciliationEffectKey,
        verified.checkout.sessionId,
        verified,
        this.#timestamp(),
      );
    }
    if (authorizeCurrentProposal) {
      changed.paidProposalVersion = proposal.version;
      changed.status = "paid";
    } else {
      const stalePaymentError = {
        errorId: `payment-stale:${sha256(verified.checkout.sessionId).slice(0, 24)}`,
        code: "payment.stale_proposal_settled",
        category: "permanent" as const,
        message:
          "Stripe settled a superseded proposal; building is fenced pending commercial resolution",
        retryable: false,
        occurredAt: this.#timestamp(),
      };
      if (
        !changed.errors.some(
          (candidate) => candidate.errorId === stalePaymentError.errorId,
        )
      ) {
        changed.errors.push(stalePaymentError);
      }
      changed.status = "needs_operator_attention";
    }
    return this.#save(
      changed,
      {
        type: authorizeCurrentProposal
          ? "payment.verified"
          : "payment.stale_proposal_settled",
        actor: "provider",
        payload: {
          previousStatus: project.status,
          status: changed.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          paymentReceiptId: changed.payments.at(-1)!.receiptId,
          provider: "stripe",
          providerEventDigest: evidence.providerEvidenceDigest,
          ...(!authorizeCurrentProposal
            ? { errorCode: "payment.stale_proposal_settled" }
            : {}),
        },
      },
      evidence.signatureVerified
        ? {
            provider: "stripe",
            eventId: evidence.providerEventId,
            digest: evidence.inboxEventDigest!,
          }
        : undefined,
    );
  }

  async #continueAfterPayment(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    this.#assertNoUnresolvedInboundMail(project.projectId);
    let saved = project;
    const confirmationKey = `mail:payment:${project.projectId}:v${proposal.version}`;
    if (!completedEffect(saved, confirmationKey)) {
      saved = await this.#sendPaymentConfirmation(saved, proposal, signal);
    }
    const supersededBatch = saved.buildBatches.find(
      (batch) =>
        batch.batchId === saved.activeBuildBatchId &&
        batch.proposalVersion !== proposal.version,
    );
    if (supersededBatch) {
      saved = await this.#supersedeActiveBuild(saved, signal);
    }
    const pendingMessages = this.#unappliedInboundMessages(saved);
    if (pendingMessages.length > 0) {
      if (saved.status !== "revision_pending") {
        const changed = structuredClone(saved);
        changed.status = "revision_pending";
        saved = this.#save(changed, {
          type: "message.customer_revision_payment_won",
          actor: "system",
          payload: {
            previousStatus: saved.status,
            status: "revision_pending",
            messageId: pendingMessages[0]!.messageId,
            messageDigest: pendingMessages[0]!.contentDigest,
            proposalVersion: proposal.version,
            proposalDigest: proposal.digest,
          },
        });
      }
      const processed = await this.#processSavedCustomerMessages(
        saved,
        "paid",
        signal,
      );
      if (
        processed.status === "paid" &&
        processed.activeProposalVersion === proposal.version
      ) {
        return this.#dispatchBuildBatch(processed, proposal, signal);
      }
      return processed;
    }
    return this.#dispatchBuildBatch(saved, proposal, signal);
  }

  async #verifyStripeSettlement(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    checkoutSessionId: string,
    event?: PaidCheckoutWebhook,
    knownAuthoritative?: ProviderCheckoutSession,
  ): Promise<VerifiedStripePayment> {
    const authoritative =
      knownAuthoritative ??
      (await this.#payment.retrieveCheckoutSession(checkoutSessionId));
    validatePaidCheckout(
      authoritative,
      project,
      proposal,
      this.#expectedStripeLivemode,
      checkoutSessionId,
      event,
    );
    if (!authoritative.paymentIntentId) {
      throw new OrchestrationPolicyError(
        "Paid Checkout Session has no PaymentIntent",
      );
    }
    const settlement = await this.#payment.verifySettlement({
      checkoutSessionId: authoritative.sessionId,
      paymentIntentId: authoritative.paymentIntentId,
      projectId: project.projectId,
      proposalId: proposal.proposalId,
      proposalVersion: proposal.version,
      proposalDigest: proposal.digest,
      amountMinor: proposal.quote.amountMinor,
      currency: proposal.quote.currency,
      customerEmail: project.customer.email!.value,
      livemode: this.#expectedStripeLivemode,
    });
    if (
      settlement.checkoutSessionId !== authoritative.sessionId ||
      settlement.paymentIntentId !== authoritative.paymentIntentId ||
      settlement.projectId !== project.projectId ||
      settlement.proposalId !== proposal.proposalId ||
      settlement.proposalVersion !== proposal.version ||
      settlement.proposalDigest !== proposal.digest ||
      settlement.amountMinor !== proposal.quote.amountMinor ||
      settlement.amountReceivedMinor !== proposal.quote.amountMinor ||
      settlement.currency !== proposal.quote.currency ||
      normalizeEmail(settlement.customerEmail) !==
        normalizeEmail(project.customer.email!.value) ||
      settlement.livemode !== this.#expectedStripeLivemode
    ) {
      throw new OrchestrationPolicyError(
        "Verified Stripe settlement does not match the exact customer proposal",
      );
    }
    return { checkout: authoritative, settlement };
  }

  async #reconcileAwaitingPayment(
    initial: ProjectAggregate,
    proposal: ProposalVersion,
    signal?: AbortSignal,
    refreshUnpaidCheckout = true,
  ): Promise<ProjectAggregate | null> {
    const proposalCheckouts = initial.checkoutSessions.filter(
      (session) =>
        session.proposalVersion === proposal.version &&
        session.proposalDigest === proposal.digest,
    );
    const storedCheckout = proposalCheckouts.at(-1);
    if (!storedCheckout) {
      return null;
    }
    const reconciliationKey = paymentReconciliationEffectKey(
      initial.projectId,
      proposal.version,
      storedCheckout.sessionId,
    );
    let project = initial;
    if (!project.effects.some((effect) => effect.key === reconciliationKey)) {
      const queued = structuredClone(project);
      addPendingEffect(
        queued,
        reconciliationKey,
        "reconcile_payment",
        {
          checkoutSessionId: storedCheckout.sessionId,
          proposalDigest: proposal.digest,
          amountMinor: proposal.quote.amountMinor,
          currency: proposal.quote.currency,
        },
        this.#timestamp(),
      );
      project = this.#save(queued, {
        type: "payment.reconciliation_queued",
        actor: "system",
        payload: {
          status: project.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: reconciliationKey,
          effectType: "reconcile_payment",
          correlationId: storedCheckout.sessionId,
        },
      });
    }
    const providerCheck = this.#beginProviderCheck(project, reconciliationKey);
    if (providerCheck.deferred) {
      return providerCheck.project;
    }
    project = providerCheck.project;
    markEffectAttempt(reconciliationKey);
    const authoritative = await this.#payment.retrieveCheckoutSession(
      storedCheckout.sessionId,
    );
    validateReconciledCheckoutBinding(
      authoritative,
      storedCheckout.sessionId,
      project,
      proposal,
      this.#expectedStripeLivemode,
    );
    if (authoritative.paymentStatus !== "paid") {
      let saved = project;
      const replacementAttempt = proposalCheckouts.length + 1;
      const replacementKey = checkoutEffectKey(
        project.projectId,
        proposal.version,
        replacementAttempt,
      );
      const shouldQueueReplacement =
        authoritative.status === "expired" &&
        !project.effects.some((effect) => effect.key === replacementKey);
      const reconciliationEffect = requireEffect(project, reconciliationKey);
      const recoveredProviderRead =
        reconciliationEffect.attempts > 1 ||
        reconciliationEffect.error !== undefined ||
        reconciliationEffect.nextAttemptAt !== undefined;
      const expirationKey = `checkout:expire:${project.projectId}:v${proposal.version}`;
      const recoversExpirationMutation =
        authoritative.status === "expired" &&
        project.effects.some(
          (effect) =>
            effect.key === expirationKey &&
            effect.type === "expire_checkout_session" &&
            effect.status === "pending",
        );
      if (
        storedCheckout.status !== authoritative.status ||
        shouldQueueReplacement ||
        recoveredProviderRead ||
        authoritative.status === "expired" ||
        recoversExpirationMutation
      ) {
        const changed = structuredClone(project);
        const stored = changed.checkoutSessions.find(
          (session) => session.sessionId === authoritative.sessionId,
        )!;
        stored.status = authoritative.status;
        stored.updatedAt = this.#timestamp();
        if (authoritative.status === "expired") {
          completeEffect(
            changed,
            reconciliationKey,
            authoritative.sessionId,
            authoritative,
            this.#timestamp(),
          );
          if (recoversExpirationMutation) {
            completeEffect(
              changed,
              expirationKey,
              authoritative.sessionId,
              authoritative,
              this.#timestamp(),
            );
          }
        } else {
          const effect = requireEffect(changed, reconciliationKey);
          effect.attempts = 1;
          effect.updatedAt = this.#timestamp();
          delete effect.error;
          delete effect.nextAttemptAt;
          delete effect.nextCheckAt;
        }
        if (shouldQueueReplacement) {
          addPendingEffect(
            changed,
            replacementKey,
            "create_checkout_session",
            {
              proposalDigest: proposal.digest,
              amountMinor: proposal.quote.amountMinor,
              currency: proposal.quote.currency,
            },
            this.#timestamp(),
          );
        }
        saved = this.#save(changed, {
          type: recoversExpirationMutation
            ? "checkout.expiration_recovered"
            : "checkout.state_reconciled",
          actor: "provider",
          payload: {
            status: project.status,
            proposalVersion: proposal.version,
            proposalDigest: proposal.digest,
            correlationId: authoritative.sessionId,
            ...(recoversExpirationMutation
              ? {
                  effectKey: expirationKey,
                  effectType: "expire_checkout_session" as const,
                }
              : shouldQueueReplacement
                ? {
                    effectKey: replacementKey,
                    effectType: "create_checkout_session" as const,
                    attempt: replacementAttempt,
                  }
                : {}),
          },
        });
      }
      if (authoritative.status !== "expired") {
        saved = this.#scheduleProviderRecheck(
          saved,
          reconciliationKey,
          "payment.reconciliation_pending",
        );
      }
      if (!refreshUnpaidCheckout) {
        return saved;
      }
      if (authoritative.status === "complete") {
        return saved;
      }
      return this.#createCheckoutAndSend(saved, proposal, signal);
    }
    const verified = await this.#verifyStripeSettlement(
      project,
      proposal,
      storedCheckout.sessionId,
      undefined,
      authoritative,
    );
    const providerEvidenceDigest = verifiedStripeEvidenceDigest(verified);
    const providerEventId = `stripe-reconciliation:${sha256(
      `${verified.checkout.sessionId}\0${verified.settlement.paymentIntentId}`,
    ).slice(0, 24)}`;
    const saved = this.#persistVerifiedPayment(project, proposal, verified, {
      providerEventId,
      providerEvidenceDigest,
      reconciliationEffectKey: reconciliationKey,
      verificationSource: "provider_api",
      signatureVerified: false,
      paidAt: this.#timestamp(),
    });
    return this.#continueAfterPayment(saved, proposal, signal);
  }

  async reconcileProject(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    return this.#projectSerial.run(projectId, () =>
      this.#reconcileProject(projectId, signal),
    );
  }

  async #reconcileProject(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = this.#requireProject(projectId);
    this.#assertNoUnresolvedInboundMail(projectId);
    const pendingDashboardLogin = latestDashboardLoginMailEffect(project);
    if (pendingDashboardLogin?.status === "pending") {
      const loginRetry = this.#prepareEffectRetry(
        project,
        pendingDashboardLogin.key,
      );
      if (loginRetry.deferred) {
        return loginRetry.project;
      }
      project = loginRetry.project;
      const readyDashboardLogin = latestDashboardLoginMailEffect(project);
      if (readyDashboardLogin?.status === "pending") {
        return this.#runWithEffectFailure(
          projectId,
          () => this.#deliverDashboardLogin(project, readyDashboardLogin.key),
          signal,
        );
      }
    }
    if (
      [
        "completed",
        "cancelled",
        "failed",
        "needs_operator_attention",
        "payment_verification_failed",
        "deployment_verification_failed",
      ].includes(project.status)
    ) {
      return project;
    }
    const retry = this.#prepareEffectRetry(project);
    if (retry.deferred) {
      return project;
    }
    project = retry.project;
    return this.#runWithEffectFailure(
      projectId,
      () => this.#reconcileProjectOnce(project, signal),
      signal,
    );
  }

  async #reconcileProjectOnce(
    initial: ProjectAggregate,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    if (
      [
        "completed",
        "cancelled",
        "failed",
        "needs_operator_attention",
        "payment_verification_failed",
        "deployment_verification_failed",
      ].includes(initial.status)
    ) {
      return initial;
    }
    let project = await this.#reconcileRequiredMailDelivery(initial, signal);
    if (
      [
        "completed",
        "cancelled",
        "failed",
        "needs_operator_attention",
        "payment_verification_failed",
        "deployment_verification_failed",
      ].includes(project.status)
    ) {
      return project;
    }
    if (project.status === "intake_received") {
      return this.#analyzeStoredIntake(project, signal);
    }
    if (project.status === "needs_clarification") {
      if (project.openClarificationQuestions.length > 0) {
        project = await this.#sendClarification(
          project,
          project.openClarificationQuestions,
        );
      } else if (project.proposals.length === 0) {
        return this.#analyzeStoredIntake(project, signal);
      }
      return this.#reconcileActiveBuildBatch(project, signal);
    }
    if (
      ["awaiting_customer_revision", "revision_pending"].includes(
        project.status,
      )
    ) {
      const proposal =
        project.proposals.length > 0 ? activeProposal(project) : undefined;
      if (
        proposal &&
        proposal.commercialBasisVersion === undefined &&
        !project.payments.some(
          (payment) =>
            payment.proposalVersion === proposal.version &&
            payment.proposalDigest === proposal.digest,
        )
      ) {
        const paymentResult = await this.#reconcileAwaitingPayment(
          project,
          proposal,
          signal,
          false,
        );
        if (
          paymentResult &&
          paymentResult.payments.length > project.payments.length
        ) {
          return this.#reconcileActiveBuildBatch(paymentResult, signal);
        }
        project = paymentResult ?? project;
      }
      if (this.#unappliedInboundMessages(project).length > 0) {
        project = await this.#processSavedCustomerMessages(
          project,
          stableProjectStatus(project),
          signal,
        );
      }
      return this.#reconcileActiveBuildBatch(project, signal);
    }
    if (project.status === "proposal_drafting") {
      project = await this.#createCheckoutAndSend(
        project,
        activeProposal(project),
        signal,
      );
      return this.#reconcileActiveBuildBatch(project, signal);
    }
    if (project.status === "awaiting_payment") {
      const proposal = activeProposal(project);
      const reconciled = await this.#reconcileAwaitingPayment(
        project,
        proposal,
        signal,
      );
      project = reconciled ?? project;
      if (
        project.status === "awaiting_payment" &&
        this.#unappliedInboundMessages(project).length > 0
      ) {
        project = await this.#processSavedCustomerMessages(
          project,
          "awaiting_payment",
          signal,
        );
        return this.#reconcileActiveBuildBatch(project, signal);
      }
      if (project.status === "awaiting_payment") {
        project = await this.#createCheckoutAndSend(project, proposal, signal);
      }
      return this.#reconcileActiveBuildBatch(project, signal);
    }
    if (project.status === "paid") {
      const proposal = activeProposal(project);
      if (proposal.commercialBasisVersion !== undefined) {
        const priorBatch = project.buildBatches.find(
          (batch) =>
            batch.batchId === project.activeBuildBatchId &&
            batch.proposalVersion !== proposal.version,
        );
        if (priorBatch) {
          project = await this.#supersedeActiveBuild(project, signal);
        }
        project = await this.#sendSteeringAcknowledgement(project, proposal);
        return this.#dispatchBuildBatch(project, proposal, signal);
      }
      return this.#continueAfterPayment(project, proposal, signal);
    }
    return this.#reconcileActiveBuildBatch(project, signal);
  }

  #prepareEffectRetry(
    project: ProjectAggregate,
    effectKey?: string,
  ): {
    project: ProjectAggregate;
    deferred: boolean;
  } {
    const effect =
      effectKey === undefined
        ? earliestScheduledRetryEffect(project)
        : project.effects.find(
            (candidate) =>
              candidate.key === effectKey &&
              candidate.status === "pending" &&
              candidate.nextAttemptAt !== undefined,
          );
    if (!effect) {
      return { project, deferred: false };
    }
    const now = this.#now();
    if (Date.parse(effect.nextAttemptAt!) > now.getTime()) {
      return { project, deferred: true };
    }
    if (effect.attempts >= this.#effectMaxAttempts) {
      const exhausted = this.#failEffect(
        project,
        effect.key,
        safeEffectError(effect, "retry_exhausted", now.toISOString()),
        "effect.retry_exhausted",
      );
      return { project: exhausted, deferred: true };
    }
    const changed = structuredClone(project);
    const retrying = requireEffect(changed, effect.key);
    retrying.attempts += 1;
    retrying.updatedAt = now.toISOString();
    delete retrying.nextAttemptAt;
    delete retrying.nextCheckAt;
    const saved = this.#save(changed, {
      type: "effect.retry_started",
      actor: "system",
      payload: {
        status: changed.status,
        effectKey: retrying.key,
        effectType: retrying.type,
        attempt: retrying.attempts,
      },
    });
    return { project: saved, deferred: false };
  }

  #beginProviderCheck(
    project: ProjectAggregate,
    effectKey: string,
  ): { project: ProjectAggregate; deferred: boolean } {
    const effect = requireEffect(project, effectKey);
    if (!effect.nextCheckAt) {
      return { project, deferred: false };
    }
    if (Date.parse(effect.nextCheckAt) > this.#now().getTime()) {
      return { project, deferred: true };
    }
    const changed = structuredClone(project);
    const checking = requireEffect(changed, effectKey);
    delete checking.nextCheckAt;
    checking.updatedAt = this.#timestamp();
    return {
      project: this.#save(changed, {
        type: "effect.provider_check_started",
        actor: "system",
        payload: {
          status: changed.status,
          effectKey: checking.key,
          effectType: checking.type,
          attempt: checking.attempts,
        },
      }),
      deferred: false,
    };
  }

  #scheduleProviderRecheck(
    project: ProjectAggregate,
    effectKey: string,
    eventType:
      "email.delivery_pending_verified" | "payment.reconciliation_pending",
  ): ProjectAggregate {
    const changed = structuredClone(project);
    const effect = requireEffect(changed, effectKey);
    if (effect.status !== "pending") {
      return project;
    }
    effect.attempts = 1;
    effect.nextCheckAt = new Date(
      this.#now().getTime() + PROVIDER_RECHECK_INTERVAL_MS,
    ).toISOString();
    effect.updatedAt = this.#timestamp();
    delete effect.error;
    delete effect.nextAttemptAt;
    return this.#save(changed, {
      type: eventType,
      actor: "provider",
      payload: {
        status: changed.status,
        effectKey: effect.key,
        effectType: effect.type,
      },
    });
  }

  async #runWithEffectFailure<T>(
    projectId: string,
    action: () => Promise<T>,
    _signal?: AbortSignal,
  ): Promise<T> {
    const context = { attemptedEffectKeys: [] as string[] };
    try {
      return await effectAttemptContext.run(context, action);
    } catch (error) {
      if (error instanceof PendingInboundMailError) {
        throw error;
      }
      try {
        const effectKey = context.attemptedEffectKeys.at(-1);
        if (effectKey) {
          this.#recordPendingEffectFailure(projectId, effectKey, error);
        }
      } catch {
        // Preserve the provider/application error at this boundary. A
        // concurrent winner may already have advanced the same effect.
      }
      throw error;
    }
  }

  #recordPendingEffectFailure(
    projectId: string,
    effectKey: string,
    error: unknown,
  ): void {
    const project = this.#requireProject(projectId);
    const effect = project.effects.find(
      (candidate) =>
        candidate.key === effectKey &&
        candidate.status === "pending" &&
        candidate.nextAttemptAt === undefined,
    );
    if (!effect) {
      return;
    }
    const now = this.#timestamp();
    const classified = classifyEffectError(error, effect, now);
    if (!classified.retryable || effect.attempts >= this.#effectMaxAttempts) {
      this.#failEffect(project, effect.key, classified, "effect.dead_lettered");
      return;
    }
    const changed = structuredClone(project);
    const scheduled = requireEffect(changed, effect.key);
    const delay = Math.min(
      this.#effectRetryInitialDelayMs * 2 ** (scheduled.attempts - 1),
      this.#effectRetryMaxDelayMs,
    );
    scheduled.error = classified;
    scheduled.nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
    scheduled.updatedAt = now;
    delete scheduled.nextCheckAt;
    changed.errors.push(classified);
    this.#save(changed, {
      type: "effect.retry_scheduled",
      actor: "system",
      payload: {
        status: changed.status,
        effectKey: scheduled.key,
        effectType: scheduled.type,
        attempt: scheduled.attempts,
        errorCode: classified.code,
      },
    });
  }

  #failEffect(
    project: ProjectAggregate,
    effectKey: string,
    error: ProjectAggregate["errors"][number],
    eventType: "effect.dead_lettered" | "effect.retry_exhausted",
  ): ProjectAggregate {
    const changed = structuredClone(project);
    const effect = requireEffect(changed, effectKey);
    effect.status = "failed";
    effect.error = { ...error, retryable: false };
    effect.updatedAt = error.occurredAt;
    delete effect.nextAttemptAt;
    delete effect.nextCheckAt;
    changed.errors.push(effect.error);
    const previousStatus = changed.status;
    changed.status =
      effect.type === "reconcile_payment"
        ? "payment_verification_failed"
        : effect.type === "deploy_proven_candidate" ||
            effect.type === "verify_deployment"
          ? "deployment_verification_failed"
          : "needs_operator_attention";
    return this.#save(changed, {
      type: eventType,
      actor: "system",
      payload: {
        previousStatus,
        status: changed.status,
        effectKey: effect.key,
        effectType: effect.type,
        attempt: effect.attempts,
        errorCode: effect.error.code,
      },
    });
  }

  async #reconcileActiveBuildBatch(
    initial: ProjectAggregate,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = initial;
    if (!project.activeBuildBatchId) {
      return project;
    }
    let batch = activeBuildBatch(project);
    const proposal = proposalForBatch(project, batch);
    if (!batch.buildDeadlineAt) {
      const changed = structuredClone(project);
      const storedBatch = activeBuildBatch(changed);
      storedBatch.buildDeadlineAt = new Date(
        Date.parse(storedBatch.createdAt) + this.#buildDeadlineMs,
      ).toISOString();
      project = this.#save(changed, {
        type: "build.deadline_backfilled",
        actor: "system",
        payload: {
          status: changed.status,
          buildBatchId: batch.batchId,
          proposalVersion: batch.proposalVersion,
          proposalDigest: batch.proposalDigest,
        },
      });
      batch = activeBuildBatch(project);
    }
    if (batch.status === "failed" || batch.status === "cancelled") {
      return project;
    }
    if (
      batch.runs.length === batch.requestedCandidateCount &&
      !["pending", "dispatched"].includes(batch.status)
    ) {
      project = await this.#sendDashboardAccess(project, proposal);
      batch = activeBuildBatch(project);
    }
    const buildDeadlineAt = batch.buildDeadlineAt;
    if (!buildDeadlineAt) {
      throw new OrchestrationPolicyError("Build batch deadline is missing");
    }
    const buildDeadlineElapsed =
      this.#now().getTime() >= Date.parse(buildDeadlineAt);
    if (
      !buildDeadlineElapsed &&
      (batch.runs.length < batch.requestedCandidateCount ||
        ["pending", "dispatched"].includes(batch.status))
    ) {
      project = await this.#dispatchBuildBatch(project, proposal, signal);
      batch = activeBuildBatch(project);
    }
    const existingPreview = project.previews.find(
      (preview) => preview.batchId === batch.batchId,
    );
    if (existingPreview) {
      if (!this.#isLatestDeliverableBatch(project, batch)) {
        return this.#acknowledgeBatchEvents(project, batch, signal);
      }
      project = await this.#materializeAndSendPreview(
        project,
        batch,
        proposal,
        existingPreview.candidateId,
        signal,
      );
      const winner = requireProvenCandidate(
        project,
        batch.batchId,
        existingPreview.candidateId,
      );
      const mailEffect = project.effects.find(
        (effect) =>
          effect.key ===
          previewMailEffectKey(
            project.projectId,
            proposal.version,
            winner.event.revisionHash,
          ),
      );
      if (!mailEffect?.completedAt) {
        return project;
      }
      const previewMessage = mailEffect.providerId
        ? project.messages.find(
            (message) =>
              message.direction === "outbound" &&
              message.purpose === "proven_preview" &&
              message.providerMessageId === mailEffect.providerId,
          )
        : undefined;
      if (
        previewMessage?.deliveryStatus !== "delivered" ||
        !previewMessage.deliveryUpdatedAt
      ) {
        return project;
      }
      const reviewElapsed =
        this.#now().getTime() - Date.parse(previewMessage.deliveryUpdatedAt) >=
        this.#previewReviewPeriodMs;
      if (!reviewElapsed) {
        return project;
      }
      return this.#deployAndDeliver(
        project,
        batch,
        proposal,
        existingPreview.candidateId,
        signal,
      );
    }

    const proofEventDeadlineElapsed =
      batch.proofEventDeadlineAt !== undefined &&
      this.#now().getTime() >= Date.parse(batch.proofEventDeadlineAt);
    try {
      project = await this.#refreshBuildRuns(project, batch, signal);
      batch = activeBuildBatch(project);
      project = await this.#ingestProvenEvents(project, batch, signal);
      batch = activeBuildBatch(project);
    } catch (error) {
      if (
        (!buildDeadlineElapsed && !proofEventDeadlineElapsed) ||
        !isTransientProviderFailure(error)
      ) {
        throw error;
      }
      project = this.#recordUnavailableBuildEvidenceAtDeadline(project, batch);
      batch = activeBuildBatch(project);
      if (
        buildDeadlineElapsed &&
        batch.runs.some((run) => !isTerminalStatus(run.status))
      ) {
        project = await this.#retireExpiredBuildBatch(project, batch, signal);
        batch = activeBuildBatch(project);
      }
      return this.#finalizeBuildBatch(project, batch, proposal, signal);
    }

    const unresolvedAtBuildDeadline =
      this.#now().getTime() >= Date.parse(buildDeadlineAt) &&
      (batch.proofEventDeadlineAt === undefined ||
        batch.runs.length < batch.requestedCandidateCount ||
        batch.runs.some((run) => !isTerminalStatus(run.status)));
    if (unresolvedAtBuildDeadline) {
      project = await this.#retireExpiredBuildBatch(project, batch, signal);
      batch = activeBuildBatch(project);
      return this.#finalizeBuildBatch(project, batch, proposal, signal);
    }

    const terminal =
      batch.runs.length === batch.requestedCandidateCount &&
      batch.runs.every((run) => isTerminalStatus(run.status));
    const passedRunIds = new Set(
      batch.runs
        .filter((run) => run.status === "passed")
        .map((run) => run.runId),
    );
    const candidates = project.provenCandidates.filter(
      (candidate) => candidate.batchId === batch.batchId,
    );
    const provenRunIds = new Set(
      candidates.map((candidate) => candidate.event.runId),
    );
    const waitingForProofEvent = [...passedRunIds].some(
      (runId) => !provenRunIds.has(runId),
    );

    if (!terminal) {
      return project;
    }
    if (waitingForProofEvent) {
      if (!batch.proofEventDeadlineAt) {
        const changed = structuredClone(project);
        const nextStatus = buildProgressStatus(project, "verifying");
        changed.status = nextStatus;
        const storedBatch = activeBuildBatch(changed);
        storedBatch.status = "verifying";
        storedBatch.proofEventDeadlineAt = new Date(
          this.#now().getTime() + this.#proofEventGracePeriodMs,
        ).toISOString();
        project = this.#save(changed, {
          type: "build.proof_event_grace_started",
          actor: "system",
          payload: {
            previousStatus: project.status,
            status: nextStatus,
            buildBatchId: batch.batchId,
            proposalVersion: batch.proposalVersion,
            proposalDigest: batch.proposalDigest,
            count: [...passedRunIds].filter((runId) => !provenRunIds.has(runId))
              .length,
          },
        });
        return project;
      }
      if (this.#now().getTime() < Date.parse(batch.proofEventDeadlineAt)) {
        return project;
      }
    }

    return this.#finalizeBuildBatch(project, batch, proposal, signal);
  }

  #recordUnavailableBuildEvidenceAtDeadline(
    project: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
  ): ProjectAggregate {
    const errorId = `build-evidence:${sha256(batch.batchId).slice(0, 24)}`;
    if (project.errors.some((error) => error.errorId === errorId)) {
      return project;
    }
    const changed = structuredClone(project);
    changed.errors.push({
      errorId,
      code: "build.evidence_unavailable_at_deadline",
      category: "transient",
      message:
        "Build backend status or proof evidence was unavailable at the persisted lifecycle deadline",
      retryable: false,
      occurredAt: this.#timestamp(),
    });
    return this.#save(changed, {
      type: "build.evidence_unavailable_at_deadline",
      actor: "system",
      payload: {
        status: changed.status,
        buildBatchId: batch.batchId,
        proposalVersion: batch.proposalVersion,
        proposalDigest: batch.proposalDigest,
        errorCode: "build.evidence_unavailable_at_deadline",
      },
    });
  }

  async #retireExpiredBuildBatch(
    project: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const nonterminal = batch.runs.filter(
      (run) => !isTerminalStatus(run.status),
    );
    let saved = project;
    const cancellationTargets = batch.runs.filter(
      (run) =>
        !isTerminalStatus(run.status) ||
        saved.effects.some(
          (effect) =>
            effect.key ===
              buildCancellationEffectKey(batch.batchId, run.runId) &&
            effect.status === "pending",
        ),
    );
    for (const run of cancellationTargets) {
      saved = await this.#cancelBuildRun(
        saved,
        batch,
        run,
        "deadline_expired",
        signal,
      );
    }
    if (batch.proofEventDeadlineAt !== undefined && nonterminal.length === 0) {
      return saved;
    }
    const changed = structuredClone(saved);
    const storedBatch = activeBuildBatch(changed);
    for (const run of storedBatch.runs) {
      if (!isTerminalStatus(run.status)) {
        run.status = "cancelled";
      }
    }
    storedBatch.status = "verifying";
    storedBatch.proofEventDeadlineAt = this.#timestamp();
    changed.status = buildProgressStatus(saved, "verifying");
    return this.#save(changed, {
      type: "build.deadline_expired",
      actor: "system",
      payload: {
        previousStatus: saved.status,
        status: changed.status,
        buildBatchId: batch.batchId,
        proposalVersion: batch.proposalVersion,
        proposalDigest: batch.proposalDigest,
        count: nonterminal.length,
      },
    });
  }

  async #cancelBuildRun(
    initial: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    run: ProjectAggregate["buildBatches"][number]["runs"][number],
    reason: "deadline_expired" | "superseded",
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const key = buildCancellationEffectKey(batch.batchId, run.runId);
    const existing = initial.effects.find((effect) => effect.key === key);
    if (existing?.status === "completed") {
      return initial;
    }
    let project = initial;
    if (!existing) {
      const queued = structuredClone(project);
      addPendingEffect(
        queued,
        key,
        "cancel_build_run",
        {
          batchId: batch.batchId,
          runId: run.runId,
          assignmentId: run.assignmentId,
          candidateId: run.candidateId,
          contractHash: batch.buildContractHash,
        },
        this.#timestamp(),
      );
      project = this.#save(queued, {
        type: "build.run_cancellation_queued",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: batch.proposalVersion,
          proposalDigest: batch.proposalDigest,
          effectKey: key,
          effectType: "cancel_build_run",
          runId: run.runId,
          reason,
        },
      });
    }

    markEffectAttempt(key);
    const cancelled = await this.#build.cancelBuild(run.runId, signal);
    if (
      cancelled.id !== run.runId ||
      cancelled.assignmentId !== run.assignmentId ||
      cancelled.projectId !== project.projectId ||
      cancelled.candidateId !== run.candidateId ||
      cancelled.contractHash !== batch.buildContractHash ||
      (!cancelled.cancelRequested && !isTerminalStatus(cancelled.status))
    ) {
      throw new OrchestrationPolicyError(
        "Build backend did not confirm the exact run cancellation",
      );
    }

    const confirmed = structuredClone(project);
    const storedBatch = confirmed.buildBatches.find(
      (candidate) => candidate.batchId === batch.batchId,
    );
    const storedRun = storedBatch?.runs.find(
      (candidate) => candidate.runId === run.runId,
    );
    if (!storedBatch || !storedRun) {
      throw new OrchestrationPolicyError(
        "Cancelled build run is missing from its persisted batch",
      );
    }
    storedRun.status = isTerminalStatus(cancelled.status)
      ? cancelled.status
      : "cancelled";
    completeEffect(confirmed, key, cancelled.id, cancelled, this.#timestamp());
    return this.#save(confirmed, {
      type: "build.run_cancellation_confirmed",
      actor: "provider",
      payload: {
        status: confirmed.status,
        buildBatchId: batch.batchId,
        proposalVersion: batch.proposalVersion,
        proposalDigest: batch.proposalDigest,
        effectKey: key,
        effectType: "cancel_build_run",
        runId: run.runId,
        reason,
      },
    });
  }

  async #finalizeBuildBatch(
    project: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    proposal: ProposalVersion,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const candidates = project.provenCandidates.filter(
      (candidate) => candidate.batchId === batch.batchId,
    );
    if (candidates.length === 0) {
      if (batch.status === "failed") {
        return project;
      }
      const changed = structuredClone(project);
      const nextStatus = buildProgressStatus(project, "no_proven_candidate");
      changed.status = nextStatus;
      const storedBatch = activeBuildBatch(changed);
      storedBatch.status = "failed";
      storedBatch.completedAt = this.#timestamp();
      return this.#save(changed, {
        type: "build.no_proven_candidate",
        actor: "system",
        payload: {
          previousStatus: project.status,
          status: nextStatus,
          buildBatchId: batch.batchId,
          proposalVersion: batch.proposalVersion,
          proposalDigest: batch.proposalDigest,
        },
      });
    }
    if (!this.#isLatestDeliverableBatch(project, batch)) {
      return this.#acknowledgeBatchEvents(project, batch, signal);
    }

    const winner = selectProvenWinner(
      candidates.map((candidate) => candidate.event.payload),
      {
        projectId: project.projectId,
        contractHash: batch.buildContractHash,
      },
    );
    return this.#materializeAndSendPreview(
      project,
      batch,
      proposal,
      winner.candidateId,
      signal,
    );
  }

  async #reconcileRequiredMailDelivery(
    initial: ProjectAggregate,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const pendingMessage = [...initial.messages]
      .reverse()
      .find(
        (message) =>
          message.direction === "outbound" &&
          (message.deliveryStatus === "pending" ||
            message.deliveryStatus === "sent") &&
          message.providerMessageId !== undefined &&
          activeRequiredMailEffect(initial, message) !== undefined,
      );
    if (!pendingMessage?.providerMessageId) {
      return initial;
    }

    const key = `mail:reconcile:${initial.projectId}:${pendingMessage.providerMessageId}`;
    const queued = structuredClone(initial);
    const existing = queued.effects.some((effect) => effect.key === key);
    addPendingEffect(
      queued,
      key,
      "reconcile_mail_delivery",
      { providerMessageId: pendingMessage.providerMessageId },
      this.#timestamp(),
    );
    const project = existing
      ? initial
      : this.#save(queued, {
          type: "email.delivery_reconciliation_queued",
          actor: "system",
          payload: {
            status: initial.status,
            effectKey: key,
            effectType: "reconcile_mail_delivery",
            messageId: pendingMessage.messageId,
          },
        });

    const now = this.#timestamp();
    if (
      Date.parse(now) >=
      Date.parse(pendingMessage.createdAt) + this.#mailDeliveryDeadlineMs
    ) {
      const timedOut = structuredClone(project);
      const effect = requireEffect(timedOut, key);
      if (effect.status !== "pending") {
        return project;
      }
      const error = {
        errorId: effectErrorId(
          effect.key,
          effect.attempts,
          "mail.delivery_verification_timeout",
        ),
        code: "mail.delivery_verification_timeout",
        category: "permanent" as const,
        message:
          "Required customer email delivery could not be verified before its deadline",
        retryable: false,
        effectKey: effect.key,
        occurredAt: now,
      };
      effect.status = "failed";
      effect.error = error;
      effect.updatedAt = now;
      delete effect.nextAttemptAt;
      delete effect.nextCheckAt;
      if (
        !timedOut.errors.some(
          (candidate) => candidate.errorId === error.errorId,
        )
      ) {
        timedOut.errors.push(error);
      }
      const previousStatus = timedOut.status;
      timedOut.status = "needs_operator_attention";
      return this.#save(timedOut, {
        type: "email.delivery_verification_timed_out",
        actor: "system",
        payload: {
          previousStatus,
          status: timedOut.status,
          effectKey: key,
          effectType: "reconcile_mail_delivery",
          messageId: pendingMessage.messageId,
          errorCode: error.code,
        },
      });
    }

    const providerCheck = this.#beginProviderCheck(project, key);
    if (providerCheck.deferred) {
      return providerCheck.project;
    }
    const checkingProject = providerCheck.project;
    markEffectAttempt(key);
    const providerState = await this.#mail.retrieveOutboundDelivery(
      pendingMessage.providerMessageId,
      signal,
    );
    if (
      providerState.provider !== "resend" ||
      providerState.messageId !== pendingMessage.providerMessageId
    ) {
      throw new OrchestrationPolicyError(
        "Resend delivery reconciliation returned the wrong message identity",
      );
    }
    if (providerState.status === "pending") {
      return this.#scheduleProviderRecheck(
        checkingProject,
        key,
        "email.delivery_pending_verified",
      );
    }

    const eventDigest = digestJson({
      source: "resend_provider_api",
      messageId: providerState.messageId,
      status: providerState.status,
      verifiedAt: providerState.verifiedAt,
      permanent: providerState.permanent,
    });
    return this.#recordMailDelivery({
      projectId: checkingProject.projectId,
      providerEventId: `resend-reconciliation:${sha256(eventDigest).slice(0, 24)}`,
      eventDigest,
      providerMessageId: providerState.messageId,
      occurredAt: providerState.verifiedAt,
      deliveryStatus: providerState.status,
      permanent: providerState.permanent,
    });
  }

  async #refreshBuildRuns(
    project: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const snapshots = await Promise.all(
      batch.runs.map((run) => this.#build.getBuildRun(run.runId, signal)),
    );
    const changed = structuredClone(project);
    const storedBatch = activeBuildBatch(changed);
    let changedRun = false;
    for (const [index, snapshot] of snapshots.entries()) {
      const expected = batch.runs[index]!;
      if (
        snapshot.run.id !== expected.runId ||
        snapshot.run.assignmentId !== expected.assignmentId ||
        snapshot.run.candidateId !== expected.candidateId ||
        snapshot.run.projectId !== project.projectId ||
        snapshot.run.contractHash !== batch.buildContractHash
      ) {
        throw new OrchestrationPolicyError(
          "Build backend returned a run outside the active project/contract identity",
        );
      }
      const stored = storedBatch.runs[index]!;
      if (stored.status !== snapshot.run.status) {
        stored.status = snapshot.run.status;
        changedRun = true;
      }
    }
    const allTerminal =
      storedBatch.runs.length === storedBatch.requestedCandidateCount &&
      storedBatch.runs.every((run) => isTerminalStatus(run.status));
    const nextBatchStatus = allTerminal ? "verifying" : "building";
    if (storedBatch.status !== nextBatchStatus) {
      storedBatch.status = nextBatchStatus;
      changedRun = true;
    }
    const nextProjectStatus = buildProgressStatus(
      project,
      allTerminal ? "verifying" : "building",
    );
    if (changed.status !== nextProjectStatus) {
      changed.status = nextProjectStatus;
      changedRun = true;
    }
    if (!changedRun) {
      return project;
    }
    return this.#save(changed, {
      type: "build.status_reconciled",
      actor: "provider",
      payload: {
        previousStatus: project.status,
        status: nextProjectStatus,
        buildBatchId: batch.batchId,
        proposalVersion: batch.proposalVersion,
        proposalDigest: batch.proposalDigest,
        count: storedBatch.runs.filter((run) => isTerminalStatus(run.status))
          .length,
      },
    });
  }

  async #ingestProvenEvents(
    initial: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = initial;
    const runIds = new Set(batch.runs.map((run) => run.runId));
    if (runIds.size === 0) {
      return project;
    }
    const events = await this.#build.pollProvenEvents(
      {
        limit: 100,
        projectId: initial.projectId,
        runIds: [...runIds],
      },
      signal,
    );
    for (const event of events) {
      if (!runIds.has(event.runId)) {
        continue;
      }
      validateProvenEvent(event, project, batch);
      const existing = project.provenCandidates.find(
        (candidate) => candidate.event.eventId === event.eventId,
      );
      if (existing) {
        if (digestJson(existing.event) !== digestJson(event)) {
          throw new OrchestrationPolicyError(
            "Build backend reused a proven event identity with different evidence",
          );
        }
        this.#store.recordInbox(
          "build-backend",
          event.eventId,
          digestJson(event),
        );
        continue;
      }
      const changed = structuredClone(project);
      changed.provenCandidates.push({
        batchId: batch.batchId,
        proposalVersion: batch.proposalVersion,
        proposalDigest: batch.proposalDigest,
        event,
        receivedAt: this.#timestamp(),
      });
      const eventDigest = digestJson(event);
      project = this.#save(
        changed,
        {
          type: "build.candidate_proven_received",
          actor: "provider",
          payload: {
            status: project.status,
            buildBatchId: batch.batchId,
            proposalVersion: batch.proposalVersion,
            proposalDigest: batch.proposalDigest,
            runId: event.runId,
            candidateId: event.payload.candidateId,
            provider: "build-backend",
            providerEventDigest: eventDigest,
          },
        },
        {
          provider: "build-backend",
          eventId: event.eventId,
          digest: eventDigest,
        },
      );
    }
    return project;
  }

  async #materializeAndSendPreview(
    initial: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    proposal: ProposalVersion,
    winnerCandidateId: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = initial;
    this.#assertNoUnresolvedInboundMail(project.projectId);
    if (!this.#isLatestDeliverableBatch(project, batch)) {
      return this.#acknowledgeBatchEvents(project, batch, signal);
    }
    const winner = requireProvenCandidate(
      project,
      batch.batchId,
      winnerCandidateId,
    );
    const event = winner.event;
    const mailKey = previewMailEffectKey(
      project.projectId,
      proposal.version,
      event.revisionHash,
    );
    const previewAlreadySent = completedEffect(project, mailKey);
    let receipt = project.previews.find(
      (preview) =>
        preview.batchId === batch.batchId &&
        preview.candidateId === winnerCandidateId,
    );
    const minimumExpiryMs =
      this.#now().getTime() +
      this.#previewReviewPeriodMs +
      PREVIEW_EXPIRY_SAFETY_MARGIN_MS;
    const needsFreshPreview =
      !receipt ||
      (!previewAlreadySent && Date.parse(receipt.expiresAt) < minimumExpiryMs);
    const materializeKey = receipt
      ? `preview:refresh:${event.eventId}:${sha256(receipt.expiresAt).slice(0, 24)}`
      : `preview:materialize:${event.eventId}`;
    if (needsFreshPreview) {
      const changed = structuredClone(project);
      addPendingEffect(
        changed,
        materializeKey,
        receipt ? "refresh_proven_preview" : "materialize_proven_preview",
        {
          eventId: event.eventId,
          artifactDigest: event.payload.artifact.sha256,
          ttlSeconds: this.#provenPreviewTtlSeconds,
          ...(receipt ? { previousExpiresAt: receipt.expiresAt } : {}),
        },
        this.#timestamp(),
      );
      project = this.#save(changed, {
        type: receipt
          ? "preview.refresh_queued"
          : "preview.materialization_queued",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: materializeKey,
          effectType: receipt
            ? "refresh_proven_preview"
            : "materialize_proven_preview",
        },
      });
      markEffectAttempt(materializeKey);
      const preview = await this.#build.getProvenPreview(
        {
          event,
          ttlSeconds: this.#provenPreviewTtlSeconds,
          idempotencyKey: materializeKey,
        },
        signal,
      );
      validateFrozenPreview(preview, event, this.#now(), minimumExpiryMs);
      const withPreview = structuredClone(project);
      const refreshedReceipt = {
        receiptId: `preview:${sha256(event.eventId).slice(0, 24)}`,
        provider: "daytona",
        projectId: withPreview.projectId,
        batchId: batch.batchId,
        runId: event.runId,
        candidateId: event.payload.candidateId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        revisionHash: event.revisionHash,
        artifactDigest: event.payload.artifact.sha256,
        snapshotId: event.payload.artifact.daytonaSnapshot,
        url: preview.url,
        expiresAt: preview.expiresAt,
        immutable: true,
        httpsHealthy: true,
        createdAt: this.#timestamp(),
        verifiedAt: this.#timestamp(),
      } as const;
      const existingReceiptIndex = withPreview.previews.findIndex(
        (candidate) => candidate.receiptId === refreshedReceipt.receiptId,
      );
      if (existingReceiptIndex === -1) {
        withPreview.previews.push(refreshedReceipt);
      } else {
        withPreview.previews[existingReceiptIndex] = refreshedReceipt;
      }
      receipt = refreshedReceipt;
      const nextStatus = buildProgressStatus(project, "preview_ready");
      withPreview.status = nextStatus;
      const storedBatch = activeBuildBatch(withPreview);
      storedBatch.status = "completed";
      storedBatch.completedAt = this.#timestamp();
      completeEffect(
        withPreview,
        materializeKey,
        preview.eventId,
        preview,
        this.#timestamp(),
      );
      project = this.#save(withPreview, {
        type:
          existingReceiptIndex === -1
            ? "preview.proven_materialized"
            : "preview.proven_refreshed",
        actor: "provider",
        payload: {
          previousStatus: project.status,
          status: nextStatus,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: materializeKey,
          effectType:
            existingReceiptIndex === -1
              ? "materialize_proven_preview"
              : "refresh_proven_preview",
          previewReceiptId: receipt.receiptId,
          candidateId: event.payload.candidateId,
        },
      });
    }

    if (!receipt) {
      throw new OrchestrationPolicyError(
        "Frozen preview materialization did not produce a receipt",
      );
    }
    this.#assertNoUnresolvedInboundMail(project.projectId);
    if (!completedEffect(project, mailKey)) {
      const queued = structuredClone(project);
      addPendingEffect(
        queued,
        mailKey,
        "send_proven_preview",
        { previewReceiptId: receipt.receiptId },
        this.#timestamp(),
      );
      project = this.#save(queued, {
        type: "email.proven_preview_queued",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: mailKey,
          effectType: "send_proven_preview",
          previewReceiptId: receipt.receiptId,
        },
      });
      const draft = provenPreviewEmail({
        customerName: project.customer.displayName ?? "there",
        projectTitle: proposal.projectTitle,
        contractVersion: proposal.contract.version,
        previewUrl: receipt.url,
        proofSummary: proofSummary(proposal),
        replyTo: this.#replyAddresses.create(project.projectId),
      });
      const latest = this.#requireProject(project.projectId);
      if (!this.#isLatestDeliverableBatch(latest, batch)) {
        return this.#supersedePendingEffect(latest, mailKey);
      }
      this.#assertNoUnresolvedInboundMail(latest.projectId);
      project = latest;
      markEffectAttempt(mailKey);
      const sent = await this.#mail.send(
        this.#mailRequest(project, proposal.version, mailKey, draft),
      );
      const withMessage = structuredClone(project);
      withMessage.messages.push(
        outboundMessage(
          project,
          draft,
          sent.messageId,
          mailKey,
          "proven_preview",
          this.#messageIdDomain,
          this.#timestamp(),
        ),
      );
      completeEffect(
        withMessage,
        mailKey,
        sent.messageId,
        sent,
        this.#timestamp(),
      );
      project = this.#save(withMessage, {
        type: "email.proven_preview_sent",
        actor: "provider",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: mailKey,
          effectType: "send_proven_preview",
          previewReceiptId: receipt.receiptId,
          messageId: withMessage.messages.at(-1)!.messageId,
        },
      });
    }
    return this.#acknowledgeBatchEvents(project, batch, signal);
  }

  async #deployAndDeliver(
    initial: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    proposal: ProposalVersion,
    winnerCandidateId: string,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = initial;
    this.#assertNoUnresolvedInboundMail(project.projectId);
    if (!this.#isLatestDeliverableBatch(project, batch)) {
      return project;
    }
    const winner = requireProvenCandidate(
      project,
      batch.batchId,
      winnerCandidateId,
    );
    const event = winner.event;
    let deployment = project.deployments.find(
      (candidate) =>
        candidate.batchId === batch.batchId &&
        candidate.candidateId === winnerCandidateId,
    );
    const deployKey = `deploy:fly:${event.eventId}`;
    if (!deployment) {
      const queued = structuredClone(project);
      const deployingStatus = buildProgressStatus(project, "deploying");
      queued.status = deployingStatus;
      addPendingEffect(
        queued,
        deployKey,
        "deploy_proven_candidate",
        {
          eventId: event.eventId,
          artifactDigest: event.payload.artifact.sha256,
        },
        this.#timestamp(),
      );
      project = this.#save(queued, {
        type: "deployment.queued",
        actor: "system",
        payload: {
          previousStatus: project.status,
          status: deployingStatus,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: deployKey,
          effectType: "deploy_proven_candidate",
          candidateId: winnerCandidateId,
        },
      });
      markEffectAttempt(deployKey);
      const artifact = await this.#build.downloadProvenArtifact(event, signal);
      let deployed: FlyDeploymentReceipt;
      try {
        const latest = this.#requireProject(project.projectId);
        if (!this.#isLatestDeliverableBatch(latest, batch)) {
          return this.#supersedePendingEffect(latest, deployKey);
        }
        this.#assertNoUnresolvedInboundMail(latest.projectId);
        project = latest;
        deployed = await this.#deployment.deployProvenArtifact(
          { event, artifact },
          signal,
        );
      } finally {
        await artifact.cleanup();
      }
      validateDeployment(deployed, event);
      const withDeployment = structuredClone(project);
      deployment = {
        receiptId: `deployment:${sha256(deployKey).slice(0, 24)}`,
        provider: "fly",
        projectId: withDeployment.projectId,
        batchId: batch.batchId,
        runId: event.runId,
        candidateId: event.payload.candidateId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        revisionHash: event.revisionHash,
        artifactDigest: event.payload.artifact.sha256,
        releaseId: deployed.flyReleaseId,
        releaseKey: deployed.releaseKey,
        releaseVersion: deployed.flyReleaseVersion,
        imageDigest: deployed.imageDigest,
        workspaceDigest: deployed.workspaceSha256,
        machineIds: [...deployed.machineIds],
        machineInstanceIds: [...deployed.machineInstanceIds],
        deploymentAttempted: deployed.deploymentAttempted,
        recoveredFromProvider: deployed.recoveredFromProvider,
        url: deployed.productionUrl,
        httpsHealthy: true,
        deployedAt: deployed.deployedAt,
        releaseVerifiedAt: deployed.releaseVerifiedAt,
        verifiedAt: deployed.healthVerifiedAt,
      };
      withDeployment.deployments.push(deployment);
      const deliveringStatus = buildProgressStatus(project, "delivering");
      withDeployment.status = deliveringStatus;
      completeEffect(
        withDeployment,
        deployKey,
        deployed.releaseKey,
        deployed,
        this.#timestamp(),
      );
      project = this.#save(withDeployment, {
        type: "deployment.verified",
        actor: "provider",
        payload: {
          previousStatus: project.status,
          status: deliveringStatus,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: deployKey,
          effectType: "deploy_proven_candidate",
          deploymentReceiptId: deployment.receiptId,
          candidateId: winnerCandidateId,
        },
      });
    }

    this.#assertNoUnresolvedInboundMail(project.projectId);
    const latest = this.#requireProject(project.projectId);
    if (!this.#isLatestDeliverableBatch(latest, batch)) {
      return latest;
    }
    this.#assertNoUnresolvedInboundMail(latest.projectId);
    project = latest;
    const proofBinding: RecordedProofBinding = {
      projectId: project.projectId,
      deploymentReceiptId: deployment.receiptId,
      revisionHash: deployment.revisionHash,
    };
    const proofKey = `proof:summary:${project.projectId}:v${proposal.version}:${event.revisionHash}`;
    let proofEffect = project.effects.find((effect) => effect.key === proofKey);
    if (!proofEffect) {
      let candidate: ProofSummarySnapshotInput;
      try {
        candidate = safeProofSnapshotInput(project, proofBinding);
      } catch {
        const rejected = structuredClone(project);
        const previousStatus = rejected.status;
        const occurredAt = this.#timestamp();
        const error = {
          errorId: `proof-error:${sha256(proofKey).slice(0, 24)}`,
          code: "proof.summary_publication_rejected",
          category: "policy" as const,
          message:
            "The proof summary failed the bounded customer publication policy",
          retryable: false,
          effectKey: proofKey,
          occurredAt,
        };
        rejected.status = "needs_operator_attention";
        rejected.errors.push(error);
        rejected.effects.push({
          key: proofKey,
          type: "persist_proof_summary_snapshot",
          status: "failed",
          attempts: 1,
          inputDigest: sha256(canonicalJson(proofBinding)),
          error,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        return this.#save(rejected, {
          type: "proof.summary_publication_rejected",
          actor: "system",
          payload: {
            previousStatus,
            status: rejected.status,
            buildBatchId: batch.batchId,
            proposalVersion: proposal.version,
            proposalDigest: proposal.digest,
            effectKey: proofKey,
            effectType: "persist_proof_summary_snapshot",
            deploymentReceiptId: deployment.receiptId,
            errorCode: error.code,
          },
        });
      }
      const queued = structuredClone(project);
      addPendingEffect(
        queued,
        proofKey,
        "persist_proof_summary_snapshot",
        {
          snapshotId: candidate.snapshotId,
          snapshotDigest: candidate.snapshotDigest,
          deploymentReceiptId: deployment.receiptId,
        },
        this.#timestamp(),
        candidate,
      );
      project = this.#save(queued, {
        type: "proof.summary_snapshot_queued",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: proofKey,
          effectType: "persist_proof_summary_snapshot",
          deploymentReceiptId: deployment.receiptId,
          proofSnapshotId: candidate.snapshotId,
          proofSnapshotDigest: candidate.snapshotDigest,
        },
      });
      proofEffect = requireEffect(project, proofKey);
    }
    const proofCoordinates = requireProofSnapshotCoordinates(
      proofEffect,
      proofBinding,
    );
    let proofSnapshot: ProofSummarySnapshot | undefined;
    if (proofEffect.status === "pending") {
      markEffectAttempt(proofKey);
      proofSnapshot = this.#store.getProofSummarySnapshot(
        proofCoordinates.snapshotId,
      );
      if (!proofSnapshot) {
        const candidate = safeProofSnapshotInput(project, proofBinding);
        if (
          candidate.snapshotId !== proofCoordinates.snapshotId ||
          candidate.snapshotDigest !== proofCoordinates.snapshotDigest
        ) {
          throw new OrchestrationPolicyError(
            "The durable proof-summary effect does not match the exact recorded evidence",
          );
        }
        proofSnapshot =
          this.#store.createProofSummarySnapshot(candidate).snapshot;
      }
      requireExactProofSnapshot(proofSnapshot, proofCoordinates, proofBinding);
      const recorded = structuredClone(project);
      completeEffect(
        recorded,
        proofKey,
        proofCoordinates.snapshotId,
        {
          snapshotId: proofCoordinates.snapshotId,
          snapshotDigest: proofCoordinates.snapshotDigest,
        },
        this.#timestamp(),
      );
      project = this.#save(recorded, {
        type: "proof.summary_snapshot_recorded",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: proofKey,
          effectType: "persist_proof_summary_snapshot",
          deploymentReceiptId: deployment.receiptId,
          proofSnapshotId: proofCoordinates.snapshotId,
          proofSnapshotDigest: proofCoordinates.snapshotDigest,
        },
      });
    } else if (proofEffect.status !== "completed") {
      throw new OrchestrationPolicyError(
        "The proof-summary snapshot effect is not deliverable",
      );
    }
    const mailKey = `mail:delivery:${project.projectId}:v${proposal.version}:${event.revisionHash}`;
    const legacyDeliveryEffect = project.effects.find(
      (effect) =>
        effect.key === mailKey &&
        effect.type === "send_final_delivery" &&
        effect.status === "pending" &&
        (!effect.proofSnapshotId || !effect.proofSnapshotDigest),
    );
    if (legacyDeliveryEffect) {
      const blocked = structuredClone(project);
      const effect = requireEffect(blocked, mailKey);
      const occurredAt = this.#timestamp();
      const error = {
        errorId: `proof-error:${sha256(`${mailKey}:legacy`).slice(0, 24)}`,
        code: "proof.legacy_delivery_unbound",
        category: "policy" as const,
        message:
          "A legacy final-delivery effect lacks an immutable proof snapshot binding",
        retryable: false,
        effectKey: mailKey,
        occurredAt,
      };
      effect.status = "failed";
      effect.error = error;
      effect.updatedAt = occurredAt;
      delete effect.nextAttemptAt;
      delete effect.nextCheckAt;
      const previousStatus = blocked.status;
      blocked.status = "needs_operator_attention";
      blocked.errors.push(error);
      return this.#save(blocked, {
        type: "proof.legacy_delivery_blocked",
        actor: "system",
        payload: {
          previousStatus,
          status: blocked.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: mailKey,
          effectType: "send_final_delivery",
          deploymentReceiptId: deployment.receiptId,
          errorCode: error.code,
        },
      });
    }
    if (!completedEffect(project, mailKey)) {
      const queued = structuredClone(project);
      addPendingEffect(
        queued,
        mailKey,
        "send_final_delivery",
        {
          deploymentReceiptId: deployment.receiptId,
          snapshotId: proofCoordinates.snapshotId,
          snapshotDigest: proofCoordinates.snapshotDigest,
        },
        this.#timestamp(),
        proofCoordinates,
      );
      project = this.#save(queued, {
        type: "email.final_delivery_queued",
        actor: "system",
        payload: {
          status: project.status,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: mailKey,
          effectType: "send_final_delivery",
          deploymentReceiptId: deployment.receiptId,
          proofSnapshotId: proofCoordinates.snapshotId,
          proofSnapshotDigest: proofCoordinates.snapshotDigest,
        },
      });
      const deliveryEffect = requireEffect(project, mailKey);
      markEffectAttempt(mailKey);
      const deliveryCoordinates = requireProofSnapshotCoordinates(
        deliveryEffect,
        proofBinding,
      );
      const draft = productionDeliveryEmail({
        customerName: project.customer.displayName ?? "there",
        projectTitle: proposal.projectTitle,
        contractVersion: proposal.contract.version,
        productionUrl: deployment.url,
        proofSummary: proofSummary(proposal),
        proofSummaryUrl: this.#proofSummaryLinks.create({
          snapshotId: deliveryCoordinates.snapshotId,
          snapshotDigest: deliveryCoordinates.snapshotDigest,
        }),
        replyTo: this.#replyAddresses.create(project.projectId),
      });
      const latestBeforeSend = this.#requireProject(project.projectId);
      if (!this.#isLatestDeliverableBatch(latestBeforeSend, batch)) {
        return this.#supersedePendingEffect(latestBeforeSend, mailKey);
      }
      this.#assertNoUnresolvedInboundMail(latestBeforeSend.projectId);
      project = latestBeforeSend;
      const deliverySnapshot = this.#store.getProofSummarySnapshot(
        deliveryCoordinates.snapshotId,
      );
      requireExactProofSnapshot(
        deliverySnapshot,
        deliveryCoordinates,
        proofBinding,
      );
      const completedProofEffect = requireEffect(project, proofKey);
      if (
        completedProofEffect.status !== "completed" ||
        completedProofEffect.providerId !== deliveryCoordinates.snapshotId
      ) {
        throw new OrchestrationPolicyError(
          "The proof-summary persistence receipt does not match final delivery",
        );
      }
      const sent = await this.#mail.send(
        this.#mailRequest(project, proposal.version, mailKey, draft),
      );
      const sentProject = structuredClone(project);
      sentProject.messages.push(
        outboundMessage(
          project,
          draft,
          sent.messageId,
          mailKey,
          "final_delivery",
          this.#messageIdDomain,
          this.#timestamp(),
        ),
      );
      completeEffect(
        sentProject,
        mailKey,
        sent.messageId,
        sent,
        this.#timestamp(),
      );
      const deliveringStatus = buildProgressStatus(project, "delivering");
      sentProject.status = deliveringStatus;
      project = this.#save(sentProject, {
        type: "email.final_delivery_sent",
        actor: "provider",
        payload: {
          previousStatus: project.status,
          status: deliveringStatus,
          buildBatchId: batch.batchId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: mailKey,
          effectType: "send_final_delivery",
          deploymentReceiptId: deployment.receiptId,
          proofSnapshotId: deliveryCoordinates.snapshotId,
          proofSnapshotDigest: deliveryCoordinates.snapshotDigest,
          messageId: sentProject.messages.at(-1)!.messageId,
        },
      });
    }
    return project;
  }

  #isLatestDeliverableBatch(
    project: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
  ): boolean {
    const latestProposal = project.proposals.find(
      (proposal) => proposal.version === project.activeProposalVersion,
    );
    return (
      latestProposal?.version === batch.proposalVersion &&
      latestProposal.digest === batch.proposalDigest &&
      project.openClarificationQuestions.length === 0 &&
      this.#unappliedInboundMessages(project).length === 0
    );
  }

  #supersedePendingEffect(
    project: ProjectAggregate,
    effectKey: string,
  ): ProjectAggregate {
    const current = project.effects.find((effect) => effect.key === effectKey);
    if (!current || current.status !== "pending") {
      return project;
    }
    const changed = structuredClone(project);
    const effect = requireEffect(changed, effectKey);
    const occurredAt = this.#timestamp();
    const error = {
      errorId: effectErrorId(effect.key, effect.attempts, "effect.superseded"),
      code: "effect.superseded",
      category: "policy" as const,
      message:
        "A newer authenticated customer requirement superseded this provider action",
      retryable: false,
      effectKey: effect.key,
      occurredAt,
    };
    effect.status = "failed";
    effect.error = error;
    effect.updatedAt = occurredAt;
    delete effect.nextAttemptAt;
    delete effect.nextCheckAt;
    if (
      !changed.errors.some((candidate) => candidate.errorId === error.errorId)
    ) {
      changed.errors.push(error);
    }
    return this.#save(changed, {
      type: "effect.superseded",
      actor: "system",
      payload: {
        status: changed.status,
        effectKey: effect.key,
        effectType: effect.type,
        errorCode: error.code,
      },
    });
  }

  async #acknowledgeBatchEvents(
    initial: ProjectAggregate,
    batch: ProjectAggregate["buildBatches"][number],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let project = initial;
    for (const candidate of project.provenCandidates.filter(
      (item) => item.batchId === batch.batchId,
    )) {
      const key = `build:ack:${candidate.event.eventId}`;
      const existing = project.effects.find((effect) => effect.key === key);
      if (existing?.status === "completed") {
        continue;
      }
      if (!existing) {
        const queued = structuredClone(project);
        addPendingEffect(
          queued,
          key,
          "acknowledge_proven_event",
          {
            eventId: candidate.event.eventId,
            runId: candidate.event.runId,
            revisionHash: candidate.event.revisionHash,
          },
          this.#timestamp(),
        );
        project = this.#save(queued, {
          type: "build.proven_event_acknowledgement_queued",
          actor: "system",
          payload: {
            status: project.status,
            buildBatchId: batch.batchId,
            proposalVersion: batch.proposalVersion,
            proposalDigest: batch.proposalDigest,
            effectKey: key,
            effectType: "acknowledge_proven_event",
            candidateId: candidate.event.payload.candidateId,
            runId: candidate.event.runId,
          },
        });
      }
      markEffectAttempt(key);
      await this.#build.acknowledgeProvenEvent(candidate.event.eventId, signal);
      const acknowledged = structuredClone(project);
      completeEffect(
        acknowledged,
        key,
        candidate.event.eventId,
        {
          provider: "build-backend",
          eventId: candidate.event.eventId,
          acknowledged: true,
        },
        this.#timestamp(),
      );
      project = this.#save(acknowledged, {
        type: "build.proven_event_acknowledged",
        actor: "provider",
        payload: {
          status: acknowledged.status,
          buildBatchId: batch.batchId,
          proposalVersion: batch.proposalVersion,
          proposalDigest: batch.proposalDigest,
          effectKey: key,
          effectType: "acknowledge_proven_event",
          candidateId: candidate.event.payload.candidateId,
          runId: candidate.event.runId,
        },
      });
    }
    return project;
  }

  #consumedInboundMessageIds(project: ProjectAggregate): Set<string> {
    return new Set(
      this.#store
        .listEvents(project.projectId)
        .filter((event) =>
          [
            "proposal.created",
            "proposal.paid_revision_created",
            "revision.no_scope_change",
          ].includes(event.type),
        )
        .flatMap((event) => event.payload.consumedMessageIds ?? []),
    );
  }

  #unappliedInboundMessages(project: ProjectAggregate): ProjectMessage[] {
    const consumedMessageIds = this.#consumedInboundMessageIds(project);
    return project.messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          message.direction === "inbound" &&
          message.senderAuthenticated &&
          !consumedMessageIds.has(message.messageId),
      )
      .sort(
        (left, right) =>
          Date.parse(left.message.createdAt) -
            Date.parse(right.message.createdAt) || left.index - right.index,
      )
      .map(({ message }) => message);
  }

  async #processSavedCustomerMessages(
    project: ProjectAggregate,
    priorStableStatus: ProjectAggregate["status"],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const expectedEmail = project.customer.email;
    const unappliedMessages = this.#unappliedInboundMessages(project);
    if (!expectedEmail?.verified || unappliedMessages.length === 0) {
      throw new OrchestrationPolicyError(
        "A verified customer and unapplied inbound messages are required to process steering",
      );
    }
    const pendingMessages = boundedPendingMessageBatch(
      project,
      unappliedMessages,
    );
    const consumedMessageIds = pendingMessages.map(
      (message) => message.messageId,
    );
    let saved = project;
    const conversation = canonicalConversation(saved, consumedMessageIds);
    const reasonerConversation = maskHighlySensitivePii(conversation.content);
    const analysis = await this.#reasoner.analyzeConversation(
      {
        channel: "email",
        conversation: reasonerConversation,
        researchConsent: saved.customer.researchConsent.granted,
        trustedSenderEmail: expectedEmail.value,
        traceContext: {
          projectId: saved.projectId,
          ...(saved.activeProposalVersion === undefined
            ? {}
            : { proposalVersion: saved.activeProposalVersion }),
        },
      },
      signal,
    );
    validateExtractedIdentity(
      reasonerConversation,
      analysis,
      expectedEmail.value,
    );
    const minimized = identifyAndMinimizePii(
      conversation.content,
      analysis.piiSpans,
    );
    const segments = minimizeSegments(
      conversation.segments,
      minimized.minimized,
    );
    const changeSegments = pendingMessages.map((message) =>
      segments.find(
        (segment) =>
          segment.kind === "customer_message" &&
          segment.messageId === message.messageId,
      ),
    );
    if (
      changeSegments.some(
        (segment) =>
          segment?.kind !== "customer_message" ||
          segment.minimizedContent.length === 0,
      )
    ) {
      throw new OrchestrationPolicyError(
        "The complete ordered customer-revision envelope does not fit the bounded model context",
      );
    }
    const minimizedChange = changeSegments
      .map((segment) => segment!.minimizedContent)
      .join("\n\n");
    const firstMessage = pendingMessages[0]!;
    if (!saved.customer.displayName && analysis.customer.name) {
      const identified = structuredClone(saved);
      identified.customer.displayName = analysis.customer.name;
      saved = this.#save(identified, {
        type: "customer.identity_completed",
        actor: "system",
        payload: {
          status: saved.status,
          messageId: firstMessage.messageId,
          messageDigest: firstMessage.contentDigest,
        },
      });
    }
    const questions = blockingQuestions(saved, analysis);
    if (questions.length > 0) {
      return this.#sendClarification(saved, questions);
    }

    const currentProposal =
      saved.proposals.length > 0 ? activeProposal(saved) : undefined;
    const paidBasisVersion = currentProposal
      ? (currentProposal.commercialBasisVersion ?? currentProposal.version)
      : undefined;
    const activePlanIsPaid =
      paidBasisVersion !== undefined &&
      saved.payments.some(
        (payment) =>
          payment.proposalVersion === paidBasisVersion &&
          payment.status === "paid",
      );
    if (!activePlanIsPaid) {
      if (saved.proposals.length > 0) {
        saved = await this.#expireCurrentCheckout(saved, signal);
      }
      return this.#createProposalAndSend(
        saved,
        analysis,
        minimized.minimized,
        segments,
        minimizedChange,
        consumedMessageIds,
        signal,
      );
    }

    const paidBasis = saved.proposals.find(
      (proposal) => proposal.version === paidBasisVersion,
    );
    if (!paidBasis) {
      throw new OrchestrationPolicyError(
        "The paid commercial basis is missing from immutable proposal history",
      );
    }
    if (
      customerChangeRequiresRequote(
        {
          deliverables: paidBasis.plan.deliverables,
          requirements: paidBasis.contract.requirements,
        },
        minimizedChange,
      )
    ) {
      if (
        !analysis.quote ||
        !minimizedChange.includes(analysis.quote.evidenceExcerpt)
      ) {
        return this.#sendClarification(saved, [
          "Please confirm the new agreed price and currency for this expanded scope.",
        ]);
      }
      return this.#createProposalAndSend(
        saved,
        analysis,
        minimized.minimized,
        segments,
        minimizedChange,
        consumedMessageIds,
        signal,
      );
    }

    const classification = await this.#reasoner.classifyChange(
      {
        paidPlan: proposalToPlan(currentProposal!),
        customerMessage: minimizedChange,
        traceContext: {
          projectId: saved.projectId,
          proposalVersion: currentProposal!.version,
        },
      },
      signal,
    );
    if (classification.kind === "no_scope_change") {
      const unchanged = structuredClone(saved);
      unchanged.status = priorStableStatus;
      return this.#save(unchanged, {
        type: "revision.no_scope_change",
        actor: "system",
        payload: {
          previousStatus: saved.status,
          status: priorStableStatus,
          messageId: firstMessage.messageId,
          messageDigest: firstMessage.contentDigest,
          consumedMessageIds,
        },
      });
    }

    if (classification.kind === "requires_requote") {
      if (
        !analysis.quote ||
        !minimizedChange.includes(analysis.quote.evidenceExcerpt)
      ) {
        return this.#sendClarification(saved, [
          "Please confirm the new agreed price and currency for this expanded scope.",
        ]);
      }
      return this.#createProposalAndSend(
        saved,
        analysis,
        minimized.minimized,
        segments,
        minimizedChange,
        consumedMessageIds,
        signal,
      );
    }
    return this.#createPaidRevisionAndDispatch(
      saved,
      analysis,
      minimized.minimized,
      segments,
      minimizedChange,
      classification,
      paidBasisVersion,
      consumedMessageIds,
      signal,
    );
  }

  async #analyzeStoredIntake(
    project: ProjectAggregate,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    if (project.proposals.length > 0) {
      throw new OrchestrationPolicyError(
        "Stored intake analysis cannot replace an existing proposal",
      );
    }
    const conversation = canonicalConversation(project);
    const reasonerConversation = maskHighlySensitivePii(conversation.content);
    const analysis = await this.#reasoner.analyzeConversation(
      {
        channel: project.intake.kind,
        conversation: reasonerConversation,
        researchConsent: project.customer.researchConsent.granted,
        ...(project.customer.email?.verified
          ? { trustedSenderEmail: project.customer.email.value }
          : {}),
        traceContext: { projectId: project.projectId },
      },
      signal,
    );
    validateExtractedIdentity(
      reasonerConversation,
      analysis,
      project.customer.email?.verified
        ? project.customer.email.value
        : undefined,
    );
    const minimized = identifyAndMinimizePii(
      conversation.content,
      analysis.piiSpans,
    );
    const segments = minimizeSegments(
      conversation.segments,
      minimized.minimized,
    );
    const changed = structuredClone(project);
    const intakePii = minimized.findings
      .filter((finding) => finding.endOffset <= changed.intake.content.length)
      .map(toDomainPii);
    let shouldSave =
      digestJson(intakePii) !== digestJson(changed.intake.piiSpans);
    changed.intake.piiSpans = intakePii;

    if (analysis.customer.name) {
      if (
        changed.customer.displayName &&
        changed.customer.displayName !== analysis.customer.name
      ) {
        throw new OrchestrationPolicyError(
          "Stored customer identity conflicts with the evidenced intake name",
        );
      }
      if (!changed.customer.displayName) {
        changed.customer.displayName = analysis.customer.name;
        shouldSave = true;
      }
    }
    if (analysis.customer.email) {
      if (
        changed.customer.email &&
        normalizeEmail(changed.customer.email.value) !==
          normalizeEmail(analysis.customer.email)
      ) {
        throw new OrchestrationPolicyError(
          "Stored customer identity conflicts with the evidenced intake email",
        );
      }
      if (!changed.customer.email) {
        changed.customer.email = {
          value: analysis.customer.email,
          verified: false,
        };
        shouldSave = true;
      }
    }
    if (analysis.customer.phone) {
      if (
        changed.customer.phone &&
        changed.customer.phone.value !== analysis.customer.phone
      ) {
        throw new OrchestrationPolicyError(
          "Stored customer identity conflicts with the evidenced intake phone",
        );
      }
      if (!changed.customer.phone) {
        changed.customer.phone = {
          value: analysis.customer.phone,
          verified: false,
        };
        shouldSave = true;
      }
    }
    changed.openClarificationQuestions = [];
    const saved = shouldSave
      ? this.#save(changed, {
          type: "intake.analysis_completed",
          actor: "system",
          payload: {
            status: changed.status,
            count: intakePii.length,
          },
        })
      : project;
    const questions = blockingQuestions(saved, analysis);
    if (questions.length > 0) {
      return this.#sendClarification(saved, questions);
    }
    return this.#createProposalAndSend(
      saved,
      analysis,
      minimized.minimized,
      segments,
      undefined,
      [],
      signal,
    );
  }

  #requireProject(projectId: string): ProjectAggregate {
    const project = this.#store.getProject(projectId);
    if (!project) {
      throw new OrchestrationPolicyError("Orchestration project not found");
    }
    return project;
  }

  #assertNoUnresolvedInboundMail(projectId: string): void {
    if (this.#store.hasUnresolvedInboundMailEnvelope(projectId)) {
      throw new PendingInboundMailError();
    }
  }

  async #sendDashboardLogin(
    project: ProjectAggregate,
    requestDigest: string,
  ): Promise<ProjectAggregate> {
    const email = project.customer.email;
    if (!email) {
      throw new OrchestrationPolicyError(
        "Dashboard access reissue requires a captured customer email",
      );
    }
    const requestPrefix = dashboardLoginMailEffectPrefix(
      project.projectId,
      requestDigest,
    );
    if (
      latestCapabilityMailEffect(project, "send_dashboard_login", requestPrefix)
    ) {
      return project;
    }
    const reissueEffects = dashboardLoginMailEffects(project);
    if (
      new Set(
        reissueEffects.map((effect) => capabilityEffectBaseKey(effect.key)),
      ).size >= MAX_DASHBOARD_LOGIN_REISSUE_REQUESTS
    ) {
      return project;
    }
    const latest = latestDashboardLoginMailEffect(project);
    if (latest?.status === "pending") {
      return project;
    }
    if (
      latest &&
      this.#now().getTime() - Date.parse(latest.createdAt) <
        DASHBOARD_LOGIN_REISSUE_MIN_INTERVAL_MS
    ) {
      return project;
    }

    const key = dashboardLoginMailEffectKey(project.projectId, requestDigest);
    const generation = 1;
    const createdAt = this.#timestamp();
    const expiresAt = new Date(
      Date.parse(createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
    ).toISOString();
    const changed = structuredClone(project);
    addPendingEffect(
      changed,
      key,
      "send_dashboard_login",
      {
        projectId: project.projectId,
        emailDigest: sha256(normalizeEmail(email.value)),
        requestDigest,
        generation,
        expiresAt,
      },
      createdAt,
    );
    const saved = this.#save(changed, {
      type: "email.dashboard_login_queued",
      actor: "system",
      payload: {
        status: changed.status,
        effectKey: key,
        effectType: "send_dashboard_login",
        providerEventDigest: requestDigest,
        count: generation,
      },
    });
    return this.#deliverDashboardLogin(saved, key);
  }

  async #deliverDashboardLogin(
    project: ProjectAggregate,
    key: string,
  ): Promise<ProjectAggregate> {
    const effect = requireEffect(project, key);
    if (effect.status !== "pending") {
      return project;
    }
    if (
      capabilityEffectExpired(
        effect,
        this.#now(),
        this.#dashboardLoginTtlSeconds,
      )
    ) {
      const rotated = this.#rotateCapabilityMailEffect(
        project,
        effect,
        capabilityMailEffectKey(
          capabilityEffectBaseKey(effect.key),
          capabilityEffectGeneration(effect.key) + 1,
        ),
        "send_dashboard_login",
      );
      const replacement = latestCapabilityMailEffect(
        rotated,
        "send_dashboard_login",
        capabilityEffectBaseKey(effect.key),
      );
      return replacement?.status === "pending"
        ? this.#deliverDashboardLogin(rotated, replacement.key)
        : rotated;
    }
    const email = project.customer.email;
    if (!email) {
      throw new OrchestrationPolicyError(
        "Dashboard access reissue requires a captured customer email",
      );
    }
    const expiresAt = new Date(
      Date.parse(effect.createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
    ).toISOString();
    const dashboardUrl = this.#customerDashboardAccess.createLoginLink({
      projectId: project.projectId,
      email: email.value,
      expiresAt,
      nonce: `dashboard-reissue:${sha256(key).slice(0, 32)}`,
    });
    const draft = customerDashboardLoginEmail({
      ...(project.customer.displayName
        ? { customerName: project.customer.displayName }
        : {}),
      dashboardUrl,
      emailVerified: email.verified,
      replyTo: this.#replyAddresses.create(project.projectId),
    });
    markEffectAttempt(key);
    const sent = await this.#mail.send(
      this.#mailRequest(
        project,
        project.activeProposalVersion ?? 1,
        key,
        draft,
      ),
    );
    const withMessage = structuredClone(project);
    withMessage.messages.push(
      outboundMessage(
        project,
        draft,
        sent.messageId,
        key,
        "dashboard_access",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    return this.#save(withMessage, {
      type: "email.dashboard_login_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        effectKey: key,
        effectType: "send_dashboard_login",
        messageId: withMessage.messages.at(-1)!.messageId,
        count: capabilityEffectGeneration(key),
      },
    });
  }

  #rotateCapabilityMailEffect(
    project: ProjectAggregate,
    expiredEffect: DurableEffect,
    replacementKey: string,
    type:
      | "send_email_verification"
      | "send_dashboard_login"
      | "send_dashboard_access",
  ): ProjectAggregate {
    const generation = capabilityEffectGeneration(replacementKey);
    if (generation > MAX_LOGIN_CAPABILITY_GENERATIONS) {
      const occurredAt = this.#timestamp();
      return this.#failEffect(
        project,
        expiredEffect.key,
        {
          errorId: `login-capability-exhausted:${sha256(expiredEffect.key).slice(0, 24)}`,
          code: "login_capability.rotation_exhausted",
          category: "permanent",
          message:
            "Passwordless capability delivery exhausted its bounded generations",
          retryable: false,
          effectKey: expiredEffect.key,
          occurredAt,
        },
        "effect.retry_exhausted",
      );
    }
    const changed = structuredClone(project);
    const expired = requireEffect(changed, expiredEffect.key);
    const occurredAt = this.#timestamp();
    expired.status = "failed";
    expired.error = {
      errorId: `login-capability-expired:${sha256(expired.key).slice(0, 24)}`,
      code: "login_capability.expired_before_delivery",
      category: "permanent",
      message:
        "The passwordless capability expired before provider delivery completed",
      retryable: false,
      effectKey: expired.key,
      occurredAt,
    };
    expired.updatedAt = occurredAt;
    delete expired.nextAttemptAt;
    delete expired.nextCheckAt;
    const expiresAt = new Date(
      Date.parse(occurredAt) + this.#dashboardLoginTtlSeconds * 1_000,
    ).toISOString();
    addPendingEffect(
      changed,
      replacementKey,
      type,
      {
        projectId: project.projectId,
        predecessorEffectDigest: expired.inputDigest,
        generation,
        expiresAt,
      },
      occurredAt,
    );
    return this.#save(changed, {
      type: "email.login_capability_rotated",
      actor: "system",
      payload: {
        status: changed.status,
        effectKey: replacementKey,
        effectType: type,
        errorCode: expired.error.code,
        count: generation,
      },
    });
  }

  async #sendEmailVerification(
    project: ProjectAggregate,
    questions: string[],
  ): Promise<ProjectAggregate> {
    const email = project.customer.email;
    if (!email || email.verified) {
      throw new OrchestrationPolicyError(
        "Email verification delivery requires one captured unverified address",
      );
    }
    const prefix = emailVerificationMailEffectPrefix(project.projectId);
    let latest = latestCapabilityMailEffect(
      project,
      "send_email_verification",
      prefix,
    );
    if (latest?.status === "completed" || latest?.status === "failed") {
      return project;
    }
    let saved = project;
    if (
      latest &&
      capabilityEffectExpired(
        latest,
        this.#now(),
        this.#dashboardLoginTtlSeconds,
      )
    ) {
      saved = this.#rotateCapabilityMailEffect(
        saved,
        latest,
        emailVerificationMailEffectKey(
          saved.projectId,
          capabilityEffectGeneration(latest.key) + 1,
        ),
        "send_email_verification",
      );
      latest = latestCapabilityMailEffect(
        saved,
        "send_email_verification",
        prefix,
      );
      if (latest?.status !== "pending") {
        return saved;
      }
    }
    const generation = latest ? capabilityEffectGeneration(latest.key) : 1;
    const key =
      latest?.key ??
      emailVerificationMailEffectKey(project.projectId, generation);
    if (!latest) {
      const changed = structuredClone(saved);
      const createdAt = this.#timestamp();
      const expiresAt = new Date(
        Date.parse(createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
      ).toISOString();
      changed.status = "needs_clarification";
      changed.openClarificationQuestions = questions;
      addPendingEffect(
        changed,
        key,
        "send_email_verification",
        {
          projectId: changed.projectId,
          intakeDigest: changed.intake.contentDigest,
          emailDigest: sha256(normalizeEmail(email.value)),
          generation,
          expiresAt,
        },
        createdAt,
      );
      saved = this.#save(changed, {
        type: "email.verification_queued",
        actor: "system",
        payload: {
          previousStatus: project.status,
          status: "needs_clarification",
          effectKey: key,
          effectType: "send_email_verification",
        },
      });
    }
    if (completedEffect(saved, key)) {
      return saved;
    }

    const effect = requireEffect(saved, key);
    const expiresAt = new Date(
      Date.parse(effect.createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
    ).toISOString();
    markEffectAttempt(key);
    const verificationUrl = this.#customerDashboardAccess.createLoginLink({
      projectId: saved.projectId,
      email: email.value,
      expiresAt,
      nonce: `email-verification:${sha256(key).slice(0, 32)}`,
    });
    const draft = emailVerificationEmail({
      ...(saved.customer.displayName
        ? { customerName: saved.customer.displayName }
        : {}),
      verificationUrl,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    const sent = await this.#mail.send(this.#mailRequest(saved, 1, key, draft));
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "email_verification",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    return this.#save(withMessage, {
      type: "email.verification_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        effectKey: key,
        effectType: "send_email_verification",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
  }

  async #sendClarification(
    project: ProjectAggregate,
    rawQuestions: string[],
  ): Promise<ProjectAggregate> {
    const questions = [
      ...new Set(rawQuestions.map((question) => question.trim())),
    ]
      .filter(Boolean)
      .slice(0, 20);
    const changed = structuredClone(project);
    changed.status = "needs_clarification";
    changed.openClarificationQuestions = questions;
    if (
      !changed.customer.email?.verified &&
      changed.customer.email &&
      questions.some(isEmailOwnershipClarification)
    ) {
      return this.#sendEmailVerification(project, questions);
    }
    if (!changed.customer.email?.verified || questions.length === 0) {
      if (
        changed.status === project.status &&
        digestJson(changed.openClarificationQuestions) ===
          digestJson(project.openClarificationQuestions)
      ) {
        return project;
      }
      return this.#save(changed, {
        type: "project.clarification_needed",
        actor: "system",
        payload: {
          previousStatus: project.status,
          status: "needs_clarification",
          count: questions.length,
        },
      });
    }
    const key = `mail:clarification:${project.projectId}:${digestJson(questions).slice(0, 24)}`;
    if (completedEffect(project, key)) {
      return project;
    }
    addPendingEffect(
      changed,
      key,
      "send_clarification",
      { questionDigest: digestJson(questions) },
      this.#timestamp(),
    );
    let saved = this.#save(changed, {
      type: "email.clarification_queued",
      actor: "system",
      payload: {
        previousStatus: project.status,
        status: "needs_clarification",
        effectKey: key,
        effectType: "send_clarification",
        count: questions.length,
      },
    });
    const draft = clarificationEmail({
      ...(saved.customer.displayName
        ? { customerName: saved.customer.displayName }
        : {}),
      questions,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    markEffectAttempt(key);
    const sent = await this.#mail.send(
      this.#mailRequest(saved, saved.activeProposalVersion ?? 1, key, draft),
    );
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "clarification",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    saved = this.#save(withMessage, {
      type: "email.clarification_sent",
      actor: "provider",
      payload: {
        status: "needs_clarification",
        effectKey: key,
        effectType: "send_clarification",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
    return saved;
  }

  async #supersedeActiveBuild(
    project: ProjectAggregate,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const batch = project.buildBatches.find(
      (candidate) => candidate.batchId === project.activeBuildBatchId,
    );
    if (!batch || ["completed", "failed", "cancelled"].includes(batch.status)) {
      return project;
    }
    let saved = project;
    for (const run of batch.runs.filter(
      (candidate) =>
        !isTerminalStatus(candidate.status) ||
        project.effects.some(
          (effect) =>
            effect.key ===
              buildCancellationEffectKey(batch.batchId, candidate.runId) &&
            effect.status === "pending",
        ),
    )) {
      saved = await this.#cancelBuildRun(
        saved,
        batch,
        run,
        "superseded",
        signal,
      );
    }
    const changed = structuredClone(saved);
    const stored = activeBuildBatch(changed);
    stored.status = "cancelled";
    stored.completedAt = this.#timestamp();
    return this.#save(changed, {
      type: "build.batch_superseded",
      actor: "customer",
      payload: {
        previousStatus: saved.status,
        status: changed.status,
        buildBatchId: stored.batchId,
        proposalVersion: stored.proposalVersion,
        proposalDigest: stored.proposalDigest,
      },
    });
  }

  async #createPaidRevisionAndDispatch(
    project: ProjectAggregate,
    analysis: ConversationAnalysis,
    minimizedConversation: string,
    conversationSegments: ConversationEvidenceSegment[],
    customerChange: string,
    classification: ChangeClassification,
    paidBasisVersion: number,
    consumedMessageIds: string[],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const prior = activeProposal(project);
    const paidBasis = project.proposals.find(
      (candidate) => candidate.version === paidBasisVersion,
    );
    if (
      !paidBasis ||
      !analysis.quote ||
      analysis.quote.amountMinor !== paidBasis.quote.amountMinor ||
      analysis.quote.currency !== paidBasis.quote.currency
    ) {
      throw new OrchestrationPolicyError(
        "An in-scope revision must retain the exact paid quote",
      );
    }
    let research: WebsiteResearchCapture[];
    try {
      research = await this.#gatherResearch(
        project,
        analysis,
        minimizedConversation,
        signal,
      );
    } catch (error) {
      if (error instanceof UnverifiedResearchAuthorizationError) {
        return this.#sendClarification(project, [error.message]);
      }
      throw error;
    }
    const plannerAnalysis = analysisForPlanning(analysis);
    const plan = await this.#reasoner.draftProposal(
      {
        minimizedConversation,
        analysis: plannerAnalysis,
        research: research.map((capture) => ({
          url: capture.url,
          capturedAt: capture.capturedAt,
          text: capture.textExcerpt,
          sha256: capture.sha256,
        })),
        priorPlan: proposalToPlan(prior),
        customerChange,
        traceContext: {
          projectId: project.projectId,
          proposalVersion: prior.version + 1,
        },
      },
      signal,
    );
    if (plan.clarificationQuestions.length > 0) {
      return this.#sendClarification(project, plan.clarificationQuestions);
    }
    try {
      assertPaidRevisionUsesExactCommercialScope(
        {
          deliverables: paidBasis.plan.deliverables,
          requirements: prior.contract.requirements,
        },
        {
          scopeItems: plan.scopeItems,
          requirements: plan.contractDraft.requirements,
        },
        customerChange,
      );
      assertCumulativePaidRevision(prior, plan, classification, customerChange);
    } catch (error) {
      if (error instanceof UnpaidScopeExpansionError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      throw error;
    }
    const version = prior.version + 1;
    let proposal: ProposalVersion;
    try {
      proposal = buildProposalVersion({
        projectId: project.projectId,
        version,
        parentVersion: prior.version,
        priorProposal: prior,
        commercialBasisVersion: paidBasisVersion,
        changeRationale: `Authenticated in-scope steering decision ${digestJson(classification)}.`,
        createdAt: this.#timestamp(),
        intake: project.intake,
        minimizedConversation,
        conversationSegments,
        analysis: plannerAnalysis,
        plan,
        research,
        disallowedPiiValues: [
          project.customer.displayName ?? "",
          project.customer.email?.value ?? "",
          project.customer.phone?.value ?? "",
        ],
      });
    } catch (error) {
      if (error instanceof UnsupportedAssetEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      if (error instanceof UnverifiedQuoteEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      if (error instanceof UnconfirmedResearchEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      throw error;
    }
    const changed = structuredClone(project);
    changed.proposals.push(proposal);
    changed.activeProposalVersion = proposal.version;
    changed.status = "paid";
    let saved = this.#save(changed, {
      type: "proposal.paid_revision_created",
      actor: "system",
      payload: {
        previousStatus: project.status,
        status: "paid",
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        ...(consumedMessageIds.length > 0 ? { consumedMessageIds } : {}),
      },
    });
    saved = await this.#supersedeActiveBuild(saved, signal);
    saved = await this.#sendSteeringAcknowledgement(saved, proposal);
    return this.#dispatchBuildBatch(saved, proposal, signal);
  }

  async #sendSteeringAcknowledgement(
    project: ProjectAggregate,
    proposal: ProposalVersion,
  ): Promise<ProjectAggregate> {
    const key = `mail:steering:${project.projectId}:v${proposal.version}`;
    if (completedEffect(project, key)) {
      return project;
    }
    const changed = structuredClone(project);
    addPendingEffect(
      changed,
      key,
      "send_steering_acknowledgement",
      { proposalDigest: proposal.digest },
      this.#timestamp(),
    );
    let saved = this.#save(changed, {
      type: "email.steering_queued",
      actor: "system",
      payload: {
        status: project.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_steering_acknowledgement",
      },
    });
    const draft = steeringAcceptedEmail({
      customerName: saved.customer.displayName ?? "there",
      projectTitle: proposal.projectTitle,
      contractVersion: proposal.contract.version,
      summary: proposal.plan.summary.text,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    markEffectAttempt(key);
    const sent = await this.#mail.send(
      this.#mailRequest(saved, proposal.version, key, draft),
    );
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "steering",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    saved = this.#save(withMessage, {
      type: "email.steering_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_steering_acknowledgement",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
    return saved;
  }

  async #createProposalAndSend(
    project: ProjectAggregate,
    analysis: ConversationAnalysis,
    minimizedConversation: string,
    conversationSegments: ConversationEvidenceSegment[],
    customerChange: string | undefined,
    consumedMessageIds: string[],
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    if (
      !analysis.quote ||
      analysis.clarificationQuestions.length > 0 ||
      !project.customer.email?.verified
    ) {
      return this.#sendClarification(
        project,
        blockingQuestions(project, analysis),
      );
    }

    let research: WebsiteResearchCapture[];
    try {
      research = await this.#gatherResearch(
        project,
        analysis,
        minimizedConversation,
        signal,
      );
    } catch (error) {
      if (error instanceof UnverifiedResearchAuthorizationError) {
        return this.#sendClarification(project, [error.message]);
      }
      throw error;
    }
    const prior = project.proposals.at(-1);
    const plannerAnalysis = analysisForPlanning(analysis);
    const plan = await this.#reasoner.draftProposal(
      {
        minimizedConversation,
        analysis: plannerAnalysis,
        research: research.map((capture) => ({
          url: capture.url,
          capturedAt: capture.capturedAt,
          text: capture.textExcerpt,
          sha256: capture.sha256,
        })),
        ...(prior ? { priorPlan: proposalToPlan(prior) } : {}),
        ...(customerChange ? { customerChange } : {}),
        traceContext: {
          projectId: project.projectId,
          proposalVersion: (prior?.version ?? 0) + 1,
        },
      },
      signal,
    );
    if (plan.clarificationQuestions.length > 0) {
      return this.#sendClarification(project, plan.clarificationQuestions);
    }

    const version = (prior?.version ?? 0) + 1;
    let proposal: ProposalVersion;
    try {
      proposal = buildProposalVersion({
        projectId: project.projectId,
        version,
        ...(prior ? { parentVersion: prior.version } : {}),
        ...(prior ? { priorProposal: prior } : {}),
        ...(customerChange
          ? { changeRationale: "Customer requested a pre-payment revision." }
          : {}),
        createdAt: this.#timestamp(),
        intake: project.intake,
        minimizedConversation,
        conversationSegments,
        analysis: plannerAnalysis,
        plan,
        research,
        disallowedPiiValues: [
          project.customer.displayName ?? "",
          project.customer.email.value,
          project.customer.phone?.value ?? "",
        ],
      });
    } catch (error) {
      if (error instanceof UnsupportedAssetEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      if (error instanceof UnverifiedQuoteEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      if (error instanceof UnconfirmedResearchEvidenceError) {
        return this.#sendClarification(project, [error.clarificationQuestion]);
      }
      throw error;
    }
    const changed = structuredClone(project);
    changed.proposals.push(proposal);
    changed.activeProposalVersion = proposal.version;
    changed.status = "proposal_drafting";
    addPendingEffect(
      changed,
      checkoutEffectKey(changed.projectId, proposal.version),
      "create_checkout_session",
      {
        proposalDigest: proposal.digest,
        amountMinor: proposal.quote.amountMinor,
        currency: proposal.quote.currency,
      },
      this.#timestamp(),
    );
    const saved = this.#save(changed, {
      type: "proposal.created",
      actor: "system",
      payload: {
        previousStatus: project.status,
        status: "proposal_drafting",
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: checkoutEffectKey(project.projectId, proposal.version),
        effectType: "create_checkout_session",
        ...(consumedMessageIds.length > 0 ? { consumedMessageIds } : {}),
      },
    });

    return this.#createCheckoutAndSend(saved, proposal, signal);
  }

  async #createCheckoutAndSend(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    let saved = project;
    let proposalCheckouts = saved.checkoutSessions.filter(
      (session) =>
        session.proposalVersion === proposal.version &&
        session.proposalDigest === proposal.digest,
    );
    let storedCheckout = proposalCheckouts.at(-1);
    if (!storedCheckout || storedCheckout.status !== "open") {
      const checkoutAttempt = proposalCheckouts.length + 1;
      const createKey = checkoutEffectKey(
        saved.projectId,
        proposal.version,
        checkoutAttempt,
      );
      if (!saved.effects.some((effect) => effect.key === createKey)) {
        const withIntent = structuredClone(saved);
        addPendingEffect(
          withIntent,
          createKey,
          "create_checkout_session",
          {
            proposalDigest: proposal.digest,
            amountMinor: proposal.quote.amountMinor,
            currency: proposal.quote.currency,
          },
          this.#timestamp(),
        );
        saved = this.#save(withIntent, {
          type: "checkout.creation_queued",
          actor: "system",
          payload: {
            status: saved.status,
            proposalVersion: proposal.version,
            proposalDigest: proposal.digest,
            effectKey: createKey,
            effectType: "create_checkout_session",
            attempt: checkoutAttempt,
          },
        });
      }
      markEffectAttempt(createKey);
      const checkout = await this.#payment.createCheckoutSession({
        projectId: saved.projectId,
        proposalId: proposal.proposalId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        amountMinor: proposal.quote.amountMinor,
        currency: proposal.quote.currency,
        customerEmail: saved.customer.email!.value,
        idempotencyKey: createKey,
      });
      validateCreatedCheckout(
        checkout,
        saved,
        proposal,
        this.#expectedStripeLivemode,
      );
      if (
        saved.checkoutSessions.some(
          (session) => session.sessionId === checkout.sessionId,
        )
      ) {
        throw new OrchestrationPolicyError(
          "Stripe returned a prior Checkout Session for a replacement attempt",
        );
      }
      const withCheckout = structuredClone(saved);
      withCheckout.checkoutSessions.push(
        CheckoutSessionSchema.parse({
          sessionId: checkout.sessionId,
          provider: "stripe",
          projectId: withCheckout.projectId,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          amountMinor: proposal.quote.amountMinor,
          currency: proposal.quote.currency,
          url: checkout.url,
          status: "open",
          expiresAt: checkout.expiresAt,
          createdAt: checkout.createdAt,
          updatedAt: this.#timestamp(),
        }),
      );
      completeEffect(
        withCheckout,
        createKey,
        checkout.sessionId,
        checkout,
        this.#timestamp(),
      );
      withCheckout.status = "awaiting_payment";
      saved = this.#save(withCheckout, {
        type: "checkout.created",
        actor: "provider",
        payload: {
          previousStatus: saved.status,
          status: "awaiting_payment",
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: createKey,
          effectType: "create_checkout_session",
          correlationId: checkout.sessionId,
          attempt: checkoutAttempt,
        },
      });
      storedCheckout = saved.checkoutSessions.find(
        (session) => session.sessionId === checkout.sessionId,
      );
      proposalCheckouts = saved.checkoutSessions.filter(
        (session) =>
          session.proposalVersion === proposal.version &&
          session.proposalDigest === proposal.digest,
      );
    }
    if (
      !storedCheckout ||
      storedCheckout.proposalDigest !== proposal.digest ||
      storedCheckout.status !== "open"
    ) {
      throw new OrchestrationPolicyError(
        "Current proposal lacks an open exact Checkout Session",
      );
    }
    const checkoutAttempt =
      proposalCheckouts.findIndex(
        (session) => session.sessionId === storedCheckout.sessionId,
      ) + 1;
    const mailKey = proposalMailEffectKey(
      saved.projectId,
      proposal.version,
      checkoutAttempt,
    );
    if (completedEffect(saved, mailKey)) {
      return saved;
    }
    return this.#sendProposal(
      saved,
      proposal,
      storedCheckout.url,
      storedCheckout.sessionId,
      mailKey,
      signal,
    );
  }

  async #gatherResearch(
    project: ProjectAggregate,
    analysis: ConversationAnalysis,
    conversation: string,
    signal?: AbortSignal,
  ): Promise<WebsiteResearchCapture[]> {
    if (
      !project.customer.researchConsent.granted ||
      analysis.researchTargets.length === 0
    ) {
      return [];
    }
    const captures: WebsiteResearchCapture[] = [];
    for (const target of analysis.researchTargets) {
      assertExplicitResearchAuthorization(conversation, target);
      captures.push(
        await this.#research.capture(
          {
            url: target.url,
            authorization: {
              callerProvided: true,
              researchConsent: true,
              evidenceRef: `intake:${project.intake.contentDigest}`,
            },
          },
          signal,
        ),
      );
    }
    return captures;
  }

  async #sendProposal(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    checkoutUrl: string,
    checkoutSessionId: string,
    key: string,
    _signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const changed = structuredClone(project);
    addPendingEffect(
      changed,
      key,
      "send_proposal",
      { proposalDigest: proposal.digest, checkoutSessionId },
      this.#timestamp(),
    );
    let saved = this.#save(changed, {
      type: "email.proposal_queued",
      actor: "system",
      payload: {
        status: project.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_proposal",
      },
    });
    const draft = proposalEmail({
      customerName: saved.customer.displayName ?? "there",
      projectTitle: proposal.projectTitle,
      proposalVersion: proposal.version,
      proposalDigest: proposal.digest,
      summary: proposal.plan.summary.text,
      scopeItems: proposal.plan.deliverables.map((item) => item.text),
      hardRequirements: proposal.contract.requirements
        .filter((requirement) => requirement.priority === "hard")
        .map((requirement) => requirement.description),
      preferences: proposal.contract.requirements
        .filter((requirement) => requirement.priority === "preference")
        .map((requirement) => requirement.description),
      supportedFacts: proposal.contract.approvedFacts.map((fact) => {
        const sources = fact.sourceIds
          .map((sourceId) =>
            proposal.sources.find((source) => source.sourceId === sourceId),
          )
          .filter((source) => source !== undefined)
          .map((source) =>
            source.kind === "research" ? source.url : "caller conversation",
          );
        return `${fact.statement} (source: ${[...new Set(sources)].join(", ")})`;
      }),
      exclusions: proposal.plan.exclusions,
      unknowns: proposal.plan.unknowns,
      verificationSummary: proofSummary(proposal),
      amountMinor: proposal.quote.amountMinor,
      currency: proposal.quote.currency,
      checkoutUrl,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    markEffectAttempt(key);
    const sent = await this.#mail.send(
      this.#mailRequest(saved, proposal.version, key, draft),
    );
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "proposal",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    saved = this.#save(withMessage, {
      type: "email.proposal_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_proposal",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
    return saved;
  }

  async #sendPaymentConfirmation(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    _signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const key = `mail:payment:${project.projectId}:v${proposal.version}`;
    const changed = structuredClone(project);
    addPendingEffect(
      changed,
      key,
      "send_payment_confirmation",
      { proposalDigest: proposal.digest },
      this.#timestamp(),
    );
    let saved = this.#save(changed, {
      type: "email.payment_confirmation_queued",
      actor: "system",
      payload: {
        status: project.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_payment_confirmation",
      },
    });
    const draft = paymentConfirmationEmail({
      customerName: saved.customer.displayName ?? "there",
      projectTitle: proposal.projectTitle,
      proposalVersion: proposal.version,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    markEffectAttempt(key);
    const sent = await this.#mail.send(
      this.#mailRequest(saved, proposal.version, key, draft),
    );
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "payment_confirmation",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    saved = this.#save(withMessage, {
      type: "email.payment_confirmation_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "send_payment_confirmation",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
    return saved;
  }

  async #sendDashboardAccess(
    project: ProjectAggregate,
    proposal: ProposalVersion,
  ): Promise<ProjectAggregate> {
    const batch = activeBuildBatch(project);
    if (
      batch.proposalVersion !== proposal.version ||
      batch.proposalDigest !== proposal.digest ||
      batch.runs.length !== batch.requestedCandidateCount ||
      !["building", "verifying", "completed"].includes(batch.status)
    ) {
      throw new OrchestrationPolicyError(
        "Dashboard access cannot be issued before the exact paid build is fully dispatched",
      );
    }
    const email = project.customer.email;
    if (!email?.verified) {
      throw new OrchestrationPolicyError(
        "Dashboard access requires a passwordless-verified customer email",
      );
    }
    const prefix = dashboardAccessMailEffectPrefix(
      project.projectId,
      batch.batchId,
    );
    let latest = latestCapabilityMailEffect(
      project,
      "send_dashboard_access",
      prefix,
    );
    if (latest?.status === "completed" || latest?.status === "failed") {
      return project;
    }

    let saved = project;
    if (
      latest &&
      capabilityEffectExpired(
        latest,
        this.#now(),
        this.#dashboardLoginTtlSeconds,
      )
    ) {
      saved = this.#rotateCapabilityMailEffect(
        saved,
        latest,
        dashboardAccessMailEffectKey(
          saved.projectId,
          batch.batchId,
          capabilityEffectGeneration(latest.key) + 1,
        ),
        "send_dashboard_access",
      );
      latest = latestCapabilityMailEffect(
        saved,
        "send_dashboard_access",
        prefix,
      );
      if (latest?.status !== "pending") {
        return saved;
      }
    }
    const generation = latest ? capabilityEffectGeneration(latest.key) : 1;
    const key =
      latest?.key ??
      dashboardAccessMailEffectKey(
        project.projectId,
        batch.batchId,
        generation,
      );
    if (!latest) {
      const changed = structuredClone(saved);
      const createdAt = this.#timestamp();
      const expiresAt = new Date(
        Date.parse(createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
      ).toISOString();
      addPendingEffect(
        changed,
        key,
        "send_dashboard_access",
        {
          projectId: project.projectId,
          buildBatchId: batch.batchId,
          emailDigest: sha256(normalizeEmail(email.value)),
          generation,
          expiresAt,
        },
        createdAt,
      );
      saved = this.#save(changed, {
        type: "email.dashboard_access_queued",
        actor: "system",
        payload: {
          status: changed.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          buildBatchId: batch.batchId,
          effectKey: key,
          effectType: "send_dashboard_access",
        },
      });
    }

    const effect = requireEffect(saved, key);
    const expiresAt = new Date(
      Date.parse(effect.createdAt) + this.#dashboardLoginTtlSeconds * 1_000,
    ).toISOString();
    markEffectAttempt(key);
    const dashboardUrl = this.#customerDashboardAccess.createLoginLink({
      projectId: saved.projectId,
      email: email.value,
      expiresAt,
      nonce: `dashboard-login:${sha256(key).slice(0, 32)}`,
    });
    const draft = dashboardAccessEmail({
      customerName: saved.customer.displayName ?? "there",
      projectTitle: proposal.projectTitle,
      dashboardUrl,
      replyTo: this.#replyAddresses.create(saved.projectId),
    });
    const sent = await this.#mail.send(
      this.#mailRequest(saved, proposal.version, key, draft),
    );
    const withMessage = structuredClone(saved);
    withMessage.messages.push(
      outboundMessage(
        saved,
        draft,
        sent.messageId,
        key,
        "dashboard_access",
        this.#messageIdDomain,
        this.#timestamp(),
      ),
    );
    completeEffect(withMessage, key, sent.messageId, sent, this.#timestamp());
    saved = this.#save(withMessage, {
      type: "email.dashboard_access_sent",
      actor: "provider",
      payload: {
        status: withMessage.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        buildBatchId: batch.batchId,
        effectKey: key,
        effectType: "send_dashboard_access",
        messageId: withMessage.messages.at(-1)!.messageId,
      },
    });
    return saved;
  }

  async #expireCurrentCheckout(
    project: ProjectAggregate,
    _signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    const proposal = activeProposal(project);
    const current = project.checkoutSessions.find(
      (session) =>
        session.proposalVersion === proposal.version &&
        session.status === "open",
    );
    if (!current) {
      return project;
    }
    const authoritative = await this.#payment.retrieveCheckoutSession(
      current.sessionId,
    );
    validateReconciledCheckoutBinding(
      authoritative,
      current.sessionId,
      project,
      proposal,
      this.#expectedStripeLivemode,
    );
    if (authoritative.paymentStatus === "paid") {
      throw new OrchestrationPolicyError(
        "Payment completed while a proposal revision was arriving",
      );
    }
    const key = `checkout:expire:${project.projectId}:v${proposal.version}`;
    const existingEffect = project.effects.find((effect) => effect.key === key);
    if (authoritative.status === "expired") {
      if (
        authoritative.paymentStatus !== "unpaid" ||
        authoritative.paymentIntentId !== null
      ) {
        throw new OrchestrationPolicyError(
          "Expired Stripe Checkout has contradictory settlement evidence",
        );
      }
      const recovered = structuredClone(project);
      addPendingEffect(
        recovered,
        key,
        "expire_checkout_session",
        { sessionId: current.sessionId },
        this.#timestamp(),
      );
      const stored = recovered.checkoutSessions.find(
        (session) => session.sessionId === authoritative.sessionId,
      );
      if (!stored) {
        throw new OrchestrationPolicyError(
          "Authoritative Stripe Checkout is missing from project state",
        );
      }
      stored.status = "expired";
      stored.updatedAt = this.#timestamp();
      completeEffect(
        recovered,
        key,
        authoritative.sessionId,
        authoritative,
        this.#timestamp(),
      );
      return this.#save(recovered, {
        type: "checkout.expiration_recovered",
        actor: "provider",
        payload: {
          status: project.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: key,
          effectType: "expire_checkout_session",
          correlationId: authoritative.sessionId,
        },
      });
    }
    if (authoritative.status !== "open") {
      throw new OrchestrationPolicyError(
        "Stripe Checkout cannot be safely expired from its authoritative state",
      );
    }
    if (existingEffect?.status === "completed") {
      throw new OrchestrationPolicyError(
        "Completed Checkout expiration conflicts with authoritative open state",
      );
    }
    let saved = project;
    if (!existingEffect) {
      const changed = structuredClone(project);
      addPendingEffect(
        changed,
        key,
        "expire_checkout_session",
        { sessionId: current.sessionId },
        this.#timestamp(),
      );
      saved = this.#save(changed, {
        type: "checkout.expiration_queued",
        actor: "system",
        payload: {
          status: project.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          effectKey: key,
          effectType: "expire_checkout_session",
        },
      });
    }
    markEffectAttempt(key);
    const expired = await this.#payment.expireCheckoutSession(
      current.sessionId,
    );
    validateReconciledCheckoutBinding(
      expired,
      current.sessionId,
      saved,
      proposal,
      this.#expectedStripeLivemode,
    );
    if (
      expired.status !== "expired" ||
      expired.paymentStatus !== "unpaid" ||
      expired.paymentIntentId !== null
    ) {
      throw new OrchestrationPolicyError(
        "Stripe did not confirm an exact unpaid Checkout expiration",
      );
    }
    const withExpired = structuredClone(saved);
    const stored = withExpired.checkoutSessions.find(
      (session) => session.sessionId === expired.sessionId,
    );
    if (!stored) {
      throw new OrchestrationPolicyError(
        "Expired Stripe Checkout is missing from project state",
      );
    }
    stored.status = "expired";
    stored.updatedAt = this.#timestamp();
    completeEffect(
      withExpired,
      key,
      expired.sessionId,
      expired,
      this.#timestamp(),
    );
    saved = this.#save(withExpired, {
      type: "checkout.expired",
      actor: "provider",
      payload: {
        status: saved.status,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        effectKey: key,
        effectType: "expire_checkout_session",
        correlationId: expired.sessionId,
      },
    });
    return saved;
  }

  async #dispatchBuildBatch(
    project: ProjectAggregate,
    proposal: ProposalVersion,
    signal?: AbortSignal,
  ): Promise<ProjectAggregate> {
    this.#assertNoUnresolvedInboundMail(project.projectId);
    const paymentBasisVersion =
      proposal.commercialBasisVersion ?? proposal.version;
    const payment = project.payments.find(
      (receipt) =>
        receipt.proposalVersion === paymentBasisVersion &&
        receipt.status === "paid",
    );
    if (!payment) {
      throw new OrchestrationPolicyError(
        "A verified payment receipt is required before build dispatch",
      );
    }
    const compiled = compileBuildAssignments({
      projectId: project.projectId,
      proposal,
      customer: project.customer,
      requestedAt: proposal.createdAt,
      ...(this.#sandboxSnapshot
        ? { sandboxSnapshot: this.#sandboxSnapshot }
        : {}),
    });
    const batchId = `batch:${sha256(
      `${project.projectId}:${proposal.digest}`,
    ).slice(0, 24)}`;
    const key = `build:dispatch:${project.projectId}:v${proposal.version}`;
    let saved = project;
    let batch = saved.buildBatches.find(
      (candidate) => candidate.batchId === batchId,
    );
    if (!batch) {
      const changed = structuredClone(saved);
      const createdAt = this.#timestamp();
      changed.buildBatches.push({
        batchId,
        projectId: changed.projectId,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        paymentReceiptId: payment.receiptId,
        paymentProposalVersion: payment.proposalVersion,
        contractVersion: proposal.contract.version,
        contractDigest: proposal.contract.digest,
        buildContractHash: compiled.contractHash,
        requestedCandidateCount: compiled.assignments.length,
        runs: [],
        buildDeadlineAt: new Date(
          Date.parse(createdAt) + this.#buildDeadlineMs,
        ).toISOString(),
        status: "pending",
        createdAt,
      });
      changed.activeBuildBatchId = batchId;
      addPendingEffect(
        changed,
        key,
        "dispatch_build_batch",
        { batchId, contractHash: compiled.contractHash },
        this.#timestamp(),
      );
      saved = this.#save(changed, {
        type: "build.batch_queued",
        actor: "system",
        payload: {
          previousStatus: project.status,
          status: project.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          buildBatchId: batchId,
          effectKey: key,
          effectType: "dispatch_build_batch",
          count: compiled.assignments.length,
        },
      });
    } else if (
      batch.proposalDigest !== proposal.digest ||
      batch.paymentReceiptId !== payment.receiptId ||
      batch.buildContractHash !== compiled.contractHash ||
      batch.requestedCandidateCount !== compiled.assignments.length
    ) {
      throw new OrchestrationPolicyError(
        "Persisted build batch does not match its deterministic proposal/payment/contract",
      );
    }

    for (const assignment of compiled.assignments) {
      batch = activeBuildBatch(saved);
      if (
        batch.runs.some((run) => run.assignmentId === assignment.assignmentId)
      ) {
        continue;
      }
      markEffectAttempt(key);
      const receipt = await this.#build.dispatchBuild(assignment, signal);
      if (
        receipt.run.assignmentId !== assignment.assignmentId ||
        receipt.run.projectId !== assignment.projectId ||
        receipt.run.candidateId !== assignment.candidateId ||
        receipt.run.contractHash !== compiled.contractHash
      ) {
        throw new OrchestrationPolicyError(
          "Build dispatch receipt does not match its exact assignment",
        );
      }
      const withRun = structuredClone(saved);
      const storedBatch = activeBuildBatch(withRun);
      storedBatch.runs.push({
        runId: receipt.run.id,
        candidateId: receipt.run.candidateId,
        assignmentId: receipt.run.assignmentId,
        status: receipt.run.status,
      });
      storedBatch.status = "dispatched";
      saved = this.#save(withRun, {
        type: "build.assignment_dispatched",
        actor: "provider",
        payload: {
          status: saved.status,
          proposalVersion: proposal.version,
          proposalDigest: proposal.digest,
          buildBatchId: batchId,
          runId: receipt.run.id,
          candidateId: receipt.run.candidateId,
          effectKey: key,
          effectType: "dispatch_build_batch",
          count: storedBatch.runs.length,
        },
      });
    }

    batch = activeBuildBatch(saved);
    if (batch.runs.length !== batch.requestedCandidateCount) {
      return saved;
    }
    if (completedEffect(saved, key) && batch.status === "building") {
      return this.#sendDashboardAccess(saved, proposal);
    }
    const withRuns = structuredClone(saved);
    const completedBatch = activeBuildBatch(withRuns);
    completedBatch.status = "building";
    const nextStatus = buildProgressStatus(saved, "building");
    withRuns.status = nextStatus;
    completeEffect(
      withRuns,
      key,
      batchId,
      { runIds: completedBatch.runs.map((run) => run.runId) },
      this.#timestamp(),
    );
    saved = this.#save(withRuns, {
      type: "build.batch_dispatched",
      actor: "system",
      payload: {
        previousStatus: saved.status,
        status: nextStatus,
        proposalVersion: proposal.version,
        proposalDigest: proposal.digest,
        buildBatchId: batchId,
        effectKey: key,
        effectType: "dispatch_build_batch",
        count: completedBatch.runs.length,
      },
    });
    return this.#sendDashboardAccess(saved, proposal);
  }

  #mailRequest(
    project: ProjectAggregate,
    proposalVersion: number,
    idempotencyKey: string,
    draft: CustomerEmailDraft,
  ): SendMailRequest {
    const thread = outboundThreadContext(project);
    const messageId = deterministicRfcMessageId(
      project,
      idempotencyKey,
      this.#messageIdDomain,
    );
    return {
      from: this.#fromEmail,
      to: project.customer.email!.value,
      subject: draft.subject,
      replyTo: draft.replyTo,
      text: draft.text,
      html: draft.html,
      tags: [
        { name: "project", value: project.projectId },
        { name: "proposal_version", value: String(proposalVersion) },
      ],
      idempotencyKey,
      headers: {
        "Message-ID": messageId,
        ...(thread.headers ?? {}),
      },
    };
  }

  #save(
    project: ProjectAggregate,
    event: ProjectEventInput,
    inbox?: VerifiedInboxEvent,
    customerDashboardLogin?: CustomerDashboardLoginConsumption,
  ): ProjectAggregate {
    const consumedMessageIds = event.payload?.consumedMessageIds ?? [];
    if (consumedMessageIds.length > 0) {
      if (
        ![
          "proposal.created",
          "proposal.paid_revision_created",
          "revision.no_scope_change",
        ].includes(event.type)
      ) {
        throw new OrchestrationPolicyError(
          "Only a proposal or no-scope decision may consume customer messages",
        );
      }
      const authenticatedInboundIds = new Set(
        project.messages
          .filter(
            (message) =>
              message.direction === "inbound" && message.senderAuthenticated,
          )
          .map((message) => message.messageId),
      );
      if (
        consumedMessageIds.some(
          (messageId) => !authenticatedInboundIds.has(messageId),
        )
      ) {
        throw new OrchestrationPolicyError(
          "Customer-message consumption references untrusted or missing input",
        );
      }
    }
    return this.#store.saveProject(
      project,
      project.revision,
      event,
      inbox,
      customerDashboardLogin,
    );
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

class ProjectSerialExecutor {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const predecessor = this.#tails.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => turn);
    this.#tails.set(projectId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#tails.get(projectId) === tail) {
        this.#tails.delete(projectId);
      }
    }
  }
}

function buildIntake(
  input: AcceptIntakeRequest,
  findings: PiiFinding[],
): Intake {
  const base = {
    intakeId: input.intakeId,
    receivedAt: input.receivedAt,
    content: input.content,
    contentDigest: sha256(input.content),
    piiSpans: findings.map(toDomainPii),
  };
  if (input.channel === "voice") {
    return IntakeSchema.parse({
      kind: "voice",
      ...base,
      source: {
        provider: "elevenlabs",
        conversationId: input.sourceId,
      },
    });
  }
  if (input.channel === "email") {
    return IntakeSchema.parse({
      kind: "email",
      ...base,
      source: {
        provider: input.provider ?? "resend",
        providerMessageId: input.sourceId,
        signatureVerified: input.emailVerified,
      },
    });
  }
  return IntakeSchema.parse({
    kind: "text",
    ...base,
    source: {
      provider: input.provider ?? "internal",
      providerMessageId: input.sourceId,
      signatureVerified: input.emailVerified,
    },
  });
}

function toDomainPii(finding: PiiFinding) {
  const category = {
    person_name: "name",
    email: "email",
    phone: "phone",
    address: "postal_address",
    government_id: "government_identifier",
    financial: "financial",
    other: "other_sensitive",
  } as const;
  let handling: "retain_in_profile" | "tokenize" = "tokenize";
  if (["person_name", "email", "phone"].includes(finding.type)) {
    handling = "retain_in_profile";
  }
  return {
    category: category[finding.type],
    startOffset: finding.startOffset,
    endOffset: finding.endOffset,
    valueDigest: finding.sha256,
    confidence: finding.confidence,
    handling,
  };
}

function activeProposal(project: ProjectAggregate): ProposalVersion {
  const version = project.activeProposalVersion;
  const proposal = project.proposals.find(
    (candidate) => candidate.version === version,
  );
  if (!proposal) {
    throw new OrchestrationPolicyError(
      "Project has no active proposal version",
    );
  }
  return proposal;
}

function activeBuildBatch(project: ProjectAggregate): BuildBatch {
  const batch = project.buildBatches.find(
    (candidate) => candidate.batchId === project.activeBuildBatchId,
  );
  if (!batch) {
    throw new OrchestrationPolicyError("Project has no active build batch");
  }
  return batch;
}

function proposalForBatch(
  project: ProjectAggregate,
  batch: BuildBatch,
): ProposalVersion {
  const proposal = project.proposals.find(
    (candidate) =>
      candidate.version === batch.proposalVersion &&
      candidate.digest === batch.proposalDigest,
  );
  if (!proposal) {
    throw new OrchestrationPolicyError(
      "Active build batch has no exact proposal",
    );
  }
  return proposal;
}

function requireProvenCandidate(
  project: ProjectAggregate,
  batchId: string,
  candidateId: string,
): ProvenCandidate {
  const candidate = project.provenCandidates.find(
    (item) =>
      item.batchId === batchId &&
      item.event.payload.candidateId === candidateId,
  );
  if (!candidate) {
    throw new OrchestrationPolicyError(
      "Selected winner has no persisted proven event",
    );
  }
  return candidate;
}

function validateProvenEvent(
  event: OutboxEvent,
  project: ProjectAggregate,
  batch: BuildBatch,
): void {
  const run = batch.runs.find((candidate) => candidate.runId === event.runId);
  if (
    !run ||
    run.status !== "passed" ||
    event.payload.projectId !== project.projectId ||
    event.payload.candidateId !== run.candidateId ||
    event.payload.contractHash !== batch.buildContractHash
  ) {
    throw new OrchestrationPolicyError(
      "Proven event does not match a passed run in the active project/contract",
    );
  }
}

function validateFrozenPreview(
  preview: FrozenProvenPreview,
  event: OutboxEvent,
  now: Date,
  minimumExpiryMs = now.getTime() + 1,
): void {
  const url = new URL(preview.url);
  if (
    preview.kind !== "frozen_proven_preview" ||
    preview.eventId !== event.eventId ||
    preview.runId !== event.runId ||
    preview.artifactId !== event.payload.artifact.artifactId ||
    preview.revisionHash !== event.revisionHash ||
    preview.artifactSha256 !== event.payload.artifact.sha256 ||
    preview.snapshotId !== event.payload.artifact.daytonaSnapshot ||
    url.protocol !== "https:" ||
    Date.parse(preview.expiresAt) <= now.getTime() ||
    Date.parse(preview.expiresAt) < minimumExpiryMs
  ) {
    throw new OrchestrationPolicyError(
      "Frozen preview does not match the selected proven artifact",
    );
  }
}

function validateDeployment(
  receipt: FlyDeploymentReceipt,
  event: OutboxEvent,
): void {
  const url = new URL(receipt.productionUrl);
  if (
    receipt.provider !== "fly" ||
    receipt.projectId !== event.payload.projectId ||
    receipt.candidateId !== event.payload.candidateId ||
    receipt.contractHash !== event.payload.contractHash ||
    receipt.revisionHash !== event.revisionHash ||
    receipt.sourceArtifactSha256 !== event.payload.artifact.sha256 ||
    receipt.verifiedLabels.releaseKey !== receipt.releaseKey ||
    receipt.verifiedLabels.artifactSha256 !== event.payload.artifact.sha256 ||
    !/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest) ||
    receipt.flyReleaseId.length === 0 ||
    !Number.isInteger(receipt.flyReleaseVersion) ||
    receipt.flyReleaseVersion <= 0 ||
    receipt.machineIds.length === 0 ||
    receipt.machineIds.length !== receipt.machineInstanceIds.length ||
    url.protocol !== "https:" ||
    Date.parse(receipt.releaseVerifiedAt) < Date.parse(receipt.deployedAt) ||
    Date.parse(receipt.healthVerifiedAt) < Date.parse(receipt.releaseVerifiedAt)
  ) {
    throw new OrchestrationPolicyError(
      "Fly deployment receipt does not match the selected proven artifact",
    );
  }
}

function completedEffect(project: ProjectAggregate, key: string): boolean {
  return project.effects.some(
    (effect) => effect.key === key && effect.status === "completed",
  );
}

function proofSummary(proposal: ProposalVersion): string {
  const allHardRequirements = proposal.contract.requirements.filter(
    (requirement) => requirement.priority === "hard",
  );
  const hardRequirements = allHardRequirements
    .slice(0, 10)
    .map((requirement) => requirement.description.slice(0, 160));
  if (allHardRequirements.length > hardRequirements.length) {
    hardRequirements.push(
      `${allHardRequirements.length - hardRequirements.length} additional hard checks`,
    );
  }
  return [
    "build",
    "configured tests",
    "preview checks",
    "CodeRabbit critical review",
    `hard contract checks (${hardRequirements.join("; ")})`,
    "unsupported-claim scan",
  ].join(", ");
}

function activeRequiredMailEffect(
  project: ProjectAggregate,
  message: ProjectMessage,
): DurableEffect | undefined {
  if (
    message.direction !== "outbound" ||
    !message.providerMessageId ||
    ![
      "email_verification",
      "clarification",
      "proposal",
      "payment_confirmation",
      "dashboard_access",
      "proven_preview",
      "steering",
      "final_delivery",
    ].includes(message.purpose)
  ) {
    return undefined;
  }
  const findExact = (
    type: DurableEffect["type"],
    key: string | undefined,
  ): DurableEffect | undefined =>
    key
      ? project.effects.find(
          (effect) =>
            effect.type === type &&
            effect.key === key &&
            effect.status === "completed" &&
            effect.providerId === message.providerMessageId,
        )
      : undefined;

  if (message.purpose === "email_verification") {
    return project.effects.find(
      (effect) =>
        effect.type === "send_email_verification" &&
        effect.status === "completed" &&
        effect.providerId === message.providerMessageId,
    );
  }

  if (message.purpose === "clarification") {
    const key =
      project.status === "needs_clarification" &&
      project.openClarificationQuestions.length > 0
        ? `mail:clarification:${project.projectId}:${digestJson(
            project.openClarificationQuestions,
          ).slice(0, 24)}`
        : undefined;
    return findExact("send_clarification", key);
  }

  if (message.purpose === "proposal") {
    if (
      ![
        "proposal_drafting",
        "awaiting_customer_revision",
        "awaiting_payment",
      ].includes(project.status)
    ) {
      return undefined;
    }
    const proposal = project.proposals.find(
      (candidate) => candidate.version === project.activeProposalVersion,
    );
    const proposalCheckouts = proposal
      ? project.checkoutSessions.filter(
          (session) =>
            session.proposalVersion === proposal.version &&
            session.proposalDigest === proposal.digest,
        )
      : [];
    const openCheckout = [...proposalCheckouts]
      .reverse()
      .find((session) => session.status === "open");
    const attempt = openCheckout
      ? proposalCheckouts.findIndex(
          (session) => session.sessionId === openCheckout.sessionId,
        ) + 1
      : 0;
    return findExact(
      "send_proposal",
      proposal && attempt > 0
        ? proposalMailEffectKey(project.projectId, proposal.version, attempt)
        : undefined,
    );
  }

  if (message.purpose === "payment_confirmation") {
    const version = project.paidProposalVersion;
    return findExact(
      "send_payment_confirmation",
      version === undefined
        ? undefined
        : `mail:payment:${project.projectId}:v${version}`,
    );
  }

  if (message.purpose === "dashboard_access") {
    return project.effects.find(
      (effect) =>
        (effect.type === "send_dashboard_access" ||
          effect.type === "send_dashboard_login") &&
        effect.status === "completed" &&
        effect.providerId === message.providerMessageId,
    );
  }

  if (message.purpose === "steering") {
    const version = project.activeProposalVersion;
    return findExact(
      "send_steering_acknowledgement",
      version === undefined
        ? undefined
        : `mail:steering:${project.projectId}:v${version}`,
    );
  }

  const batch = project.buildBatches.find(
    (candidate) => candidate.batchId === project.activeBuildBatchId,
  );
  if (!batch) {
    return undefined;
  }
  if (message.purpose === "proven_preview") {
    const preview = [...project.previews]
      .reverse()
      .find(
        (candidate) =>
          candidate.batchId === batch.batchId &&
          candidate.proposalVersion === batch.proposalVersion &&
          candidate.proposalDigest === batch.proposalDigest,
      );
    return findExact(
      "send_proven_preview",
      preview
        ? previewMailEffectKey(
            project.projectId,
            batch.proposalVersion,
            preview.revisionHash,
          )
        : undefined,
    );
  }
  const deployment = [...project.deployments]
    .reverse()
    .find(
      (candidate) =>
        candidate.batchId === batch.batchId &&
        candidate.proposalVersion === batch.proposalVersion &&
        candidate.proposalDigest === batch.proposalDigest,
    );
  return findExact(
    "send_final_delivery",
    deployment
      ? `mail:delivery:${project.projectId}:v${batch.proposalVersion}:${deployment.revisionHash}`
      : undefined,
  );
}

function analysisForPlanning(
  analysis: ConversationAnalysis,
): ConversationAnalysis {
  return {
    ...analysis,
    customer: { name: "[CUSTOMER]" },
    piiSpans: [],
  };
}

function validateExtractedIdentity(
  conversation: string,
  analysis: ConversationAnalysis,
  trustedSenderEmail?: string,
): void {
  const { name, email, phone } = analysis.customer;
  if (name) {
    const coveredByNameSpan = analysis.piiSpans.some(
      (span) =>
        span.type === "person_name" &&
        conversation.slice(span.startOffset, span.endOffset) === name,
    );
    if (!coveredByNameSpan) {
      throw new OrchestrationPolicyError(
        "Extracted customer name lacks exact transcript evidence and a matching PII span",
      );
    }
  }
  if (
    email &&
    !conversation.includes(email) &&
    normalizeEmail(email) !== normalizeEmail(trustedSenderEmail ?? "")
  ) {
    throw new OrchestrationPolicyError(
      "Extracted customer email lacks trusted source evidence",
    );
  }
  if (phone && !conversation.includes(phone)) {
    throw new OrchestrationPolicyError(
      "Extracted customer phone lacks exact transcript evidence",
    );
  }
}

function maskHighlySensitivePii(input: string): string {
  const sensitive = identifyAndMinimizePii(input, []).findings.filter(
    (finding) =>
      finding.type === "address" ||
      finding.type === "government_id" ||
      finding.type === "financial",
  );
  let masked = input;
  for (const finding of [...sensitive].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    masked =
      masked.slice(0, finding.startOffset) +
      "█".repeat(finding.endOffset - finding.startOffset) +
      masked.slice(finding.endOffset);
  }
  return masked;
}

function proposalToPlan(proposal: ProposalVersion): ProposalPlan {
  const citationFor = (
    sourceIds: readonly string[],
  ): ProposalPlan["scopeItems"][number]["citation"] => {
    const source = sourceIds
      .map((sourceId) =>
        proposal.sources.find((candidate) => candidate.sourceId === sourceId),
      )
      .find((candidate) => candidate !== undefined);
    if (!source) {
      throw new OrchestrationPolicyError(
        "Persisted proposal item lacks its exact evidence source",
      );
    }
    return source.kind === "research"
      ? {
          kind: "research",
          url: source.url,
          excerpt: source.excerpt,
        }
      : {
          kind: "conversation",
          excerpt: source.excerpt,
        };
  };
  return {
    title: proposal.projectTitle,
    summary: proposal.plan.summary.text,
    scopeItems: proposal.plan.deliverables.map((item) => ({
      id: item.itemId,
      text: item.text,
      citation: citationFor(item.sourceIds),
    })),
    buildPrompt: proposal.buildPrompt,
    strategyLabels: proposal.strategyLabels,
    assets: [],
    clarificationQuestions: proposal.plan.unknowns,
    contractDraft: {
      approvedFacts: proposal.contract.approvedFacts.map((fact) => ({
        id: fact.factId,
        statement: fact.statement,
        citation: citationFor(fact.sourceIds),
      })),
      forbiddenClaims: proposal.contract.forbiddenClaims,
      requirements: proposal.contract.requirements.map((requirement) => ({
        id: requirement.requirementId,
        description: requirement.description,
        priority: requirement.priority,
        citation: citationFor(requirement.sourceIds),
        verifiers: requirement.verifiers,
      })),
      verification: proposal.contract.verification,
    },
  };
}

function blockingQuestions(
  project: ProjectAggregate,
  analysis: ConversationAnalysis,
): string[] {
  const questions = [...analysis.clarificationQuestions];
  if (!analysis.customer.name && !project.customer.displayName) {
    questions.push("What name should we use for this project?");
  }
  if (!project.customer.email) {
    questions.push("What email address should receive your project link?");
  } else if (!project.customer.email.verified) {
    questions.push(EMAIL_OWNERSHIP_CLARIFICATION);
  }
  if (!analysis.quote) {
    questions.push("What exact price and currency did we agree on?");
  }
  return [...new Set(questions)];
}

function isEmailOwnershipClarification(question: string): boolean {
  return (
    question === EMAIL_OWNERSHIP_CLARIFICATION ||
    question === "What verified email address should receive the proposal?"
  );
}

function buildProgressStatus(
  project: ProjectAggregate,
  nextStatus: ProjectAggregate["status"],
): ProjectAggregate["status"] {
  const activeBatch = project.buildBatches.find(
    (batch) => batch.batchId === project.activeBuildBatchId,
  );
  if (!activeBatch) {
    return nextStatus;
  }
  if (project.openClarificationQuestions.length > 0) {
    return "needs_clarification";
  }
  const activeProposal = project.proposals.find(
    (proposal) => proposal.version === project.activeProposalVersion,
  );
  if (
    !activeProposal ||
    activeProposal.version === activeBatch.proposalVersion
  ) {
    return nextStatus;
  }
  const paymentBasisVersion =
    activeProposal.commercialBasisVersion ?? activeProposal.version;
  const proposalIsFunded = project.payments.some(
    (payment) =>
      payment.proposalVersion === paymentBasisVersion &&
      payment.status === "paid",
  );
  if (proposalIsFunded) {
    return nextStatus;
  }
  if (
    project.checkoutSessions.some(
      (checkout) =>
        checkout.proposalVersion === activeProposal.version &&
        checkout.proposalDigest === activeProposal.digest &&
        checkout.status === "open",
    )
  ) {
    return "awaiting_payment";
  }
  if (project.status === "proposal_drafting") {
    return "proposal_drafting";
  }
  return nextStatus;
}

function stableProjectStatus(
  project: ProjectAggregate,
): ProjectAggregate["status"] {
  if (
    !["revision_pending", "awaiting_customer_revision"].includes(project.status)
  ) {
    return project.status;
  }
  const batch = project.buildBatches.find(
    (candidate) => candidate.batchId === project.activeBuildBatchId,
  );
  if (batch) {
    const deployment = project.deployments.find(
      (candidate) =>
        candidate.batchId === batch.batchId &&
        candidate.proposalVersion === batch.proposalVersion &&
        candidate.proposalDigest === batch.proposalDigest,
    );
    if (deployment) {
      const deliveryEffect = project.effects.find(
        (effect) =>
          effect.type === "send_final_delivery" &&
          effect.status === "completed" &&
          effect.key ===
            `mail:delivery:${project.projectId}:v${batch.proposalVersion}:${deployment.revisionHash}`,
      );
      const finalMessage = deliveryEffect?.providerId
        ? project.messages.find(
            (message) =>
              message.direction === "outbound" &&
              message.purpose === "final_delivery" &&
              message.providerMessageId === deliveryEffect.providerId,
          )
        : undefined;
      if (finalMessage?.deliveryStatus === "delivered") {
        return "completed";
      }
      return finalMessage ? "delivering" : "deploying";
    }
    if (project.previews.some((preview) => preview.batchId === batch.batchId)) {
      return "preview_ready";
    }
    if (batch.status === "verifying") {
      return "verifying";
    }
    if (["pending", "dispatched", "building"].includes(batch.status)) {
      return "building";
    }
  }
  if (project.checkoutSessions.some((session) => session.status === "open")) {
    return "awaiting_payment";
  }
  return project.payments.length > 0 ? "paid" : "needs_clarification";
}

export function assertCumulativePaidRevision(
  prior: ProposalVersion,
  plan: ProposalPlan,
  classification?: ChangeClassification,
  customerChange?: string,
): void {
  const supersededScopeEvidence = new Map(
    (classification?.supersededScopeItems ?? []).map((item) => [
      item.value,
      item.evidenceExcerpt,
    ]),
  );
  const supersededRequirementEvidence = new Map(
    (classification?.supersededRequirementIds ?? []).map((item) => [
      item.id,
      item.evidenceExcerpt,
    ]),
  );
  const supersededFactEvidence = new Map(
    (classification?.supersededFactIds ?? []).map((item) => [
      item.id,
      item.evidenceExcerpt,
    ]),
  );
  const supersededScopeItems = new Set(supersededScopeEvidence.keys());
  const supersededRequirementIds = new Set(
    supersededRequirementEvidence.keys(),
  );
  const supersededFactIds = new Set(supersededFactEvidence.keys());
  const priorScopeItems = new Set(
    prior.plan.deliverables.map((deliverable) => deliverable.text),
  );
  const priorRequirementIds = new Set(
    prior.contract.requirements.map((requirement) => requirement.requirementId),
  );
  const priorFactIds = new Set(
    prior.contract.approvedFacts.map((fact) => fact.factId),
  );
  if (
    [...supersededScopeItems].some((item) => !priorScopeItems.has(item)) ||
    [...supersededRequirementIds].some((id) => !priorRequirementIds.has(id)) ||
    [...supersededFactIds].some((id) => !priorFactIds.has(id))
  ) {
    throw new OrchestrationPolicyError(
      "Paid revision declared a supersession outside the active contract",
    );
  }
  for (const [item, evidenceExcerpt] of supersededScopeEvidence) {
    assertAuthenticatedSupersessionEvidence(
      customerChange,
      evidenceExcerpt,
      item,
      item,
    );
  }
  for (const [id, evidenceExcerpt] of supersededRequirementEvidence) {
    const requirement = prior.contract.requirements.find(
      (candidate) => candidate.requirementId === id,
    )!;
    assertAuthenticatedSupersessionEvidence(
      customerChange,
      evidenceExcerpt,
      requirement.description,
      id,
    );
  }
  for (const [id, evidenceExcerpt] of supersededFactEvidence) {
    const fact = prior.contract.approvedFacts.find(
      (candidate) => candidate.factId === id,
    )!;
    assertAuthenticatedSupersessionEvidence(
      customerChange,
      evidenceExcerpt,
      fact.statement,
      id,
    );
  }

  const nextScopeItems = new Set(plan.scopeItems.map((item) => item.text));
  for (const deliverable of prior.plan.deliverables) {
    if (
      !nextScopeItems.has(deliverable.text) &&
      !supersededScopeItems.has(deliverable.text)
    ) {
      throw new OrchestrationPolicyError(
        `Paid revision silently removed deliverable ${deliverable.itemId}`,
      );
    }
  }

  const nextRequirements = new Map(
    plan.contractDraft.requirements.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  for (const requirement of prior.contract.requirements) {
    const next = nextRequirements.get(requirement.requirementId);
    const nextVerifierDigests = new Set(
      next?.verifiers.map((verifier) => digestJson(verifier)) ?? [],
    );
    if (
      !next ||
      next.description !== requirement.description ||
      next.priority !== requirement.priority ||
      requirement.verifiers.some(
        (verifier) => !nextVerifierDigests.has(digestJson(verifier)),
      )
    ) {
      if (supersededRequirementIds.has(requirement.requirementId)) {
        continue;
      }
      throw new OrchestrationPolicyError(
        `Paid revision silently removed or weakened requirement ${requirement.requirementId}`,
      );
    }
  }

  const nextFacts = new Map(
    plan.contractDraft.approvedFacts.map((fact) => [fact.id, fact.statement]),
  );
  for (const fact of prior.contract.approvedFacts) {
    if (
      nextFacts.get(fact.factId) !== fact.statement &&
      !supersededFactIds.has(fact.factId)
    ) {
      throw new OrchestrationPolicyError(
        `Paid revision silently removed or changed approved fact ${fact.factId}`,
      );
    }
  }

  if (
    [...supersededScopeItems].some((item) => nextScopeItems.has(item)) ||
    [...supersededRequirementIds].some((id) => {
      const priorRequirement = prior.contract.requirements.find(
        (requirement) => requirement.requirementId === id,
      );
      const nextRequirement = nextRequirements.get(id);
      return (
        priorRequirement !== undefined &&
        nextRequirement !== undefined &&
        nextRequirement.description === priorRequirement.description &&
        nextRequirement.priority === priorRequirement.priority &&
        digestJson(nextRequirement.verifiers) ===
          digestJson(priorRequirement.verifiers)
      );
    }) ||
    [...supersededFactIds].some(
      (id) =>
        nextFacts.get(id) ===
        prior.contract.approvedFacts.find((fact) => fact.factId === id)
          ?.statement,
    )
  ) {
    throw new OrchestrationPolicyError(
      "Paid revision declared a supersession but retained the same contract item",
    );
  }

  const nextForbiddenClaims = new Set(plan.contractDraft.forbiddenClaims);
  for (const claim of prior.contract.forbiddenClaims) {
    if (!nextForbiddenClaims.has(claim)) {
      throw new OrchestrationPolicyError(
        "Paid revision silently removed a forbidden business claim",
      );
    }
  }

  const priorVerification = prior.contract.verification;
  const nextVerification = plan.contractDraft.verification;
  const nextTestCommands = new Set(nextVerification.testCommands);
  if (
    nextVerification.buildCommand !== priorVerification.buildCommand ||
    nextVerification.previewCommand !== priorVerification.previewCommand ||
    nextVerification.previewPort !== priorVerification.previewPort ||
    priorVerification.testCommands.some(
      (command) => !nextTestCommands.has(command),
    )
  ) {
    throw new OrchestrationPolicyError(
      "Paid revision silently weakened the verification plan",
    );
  }
}

function assertAuthenticatedSupersessionEvidence(
  customerChange: string | undefined,
  evidenceExcerpt: string,
  priorText: string,
  priorId: string,
): void {
  if (
    !customerChange ||
    !customerChange.includes(evidenceExcerpt) ||
    !/\b(?:change|replace|remove|delete|instead|no longer|correct|update|switch|rename|drop)\b/iu.test(
      evidenceExcerpt,
    )
  ) {
    throw new OrchestrationPolicyError(
      "Paid revision supersession lacks exact authenticated edit evidence",
    );
  }
  const stopWords = new Set([
    "and",
    "are",
    "for",
    "from",
    "into",
    "that",
    "the",
    "this",
    "use",
    "with",
  ]);
  const priorTokens = new Set(
    `${priorText} ${priorId}`
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
  const evidenceTokens = new Set(
    evidenceExcerpt
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3),
  );
  if (![...priorTokens].some((token) => evidenceTokens.has(token))) {
    throw new OrchestrationPolicyError(
      "Paid revision supersession evidence does not identify the prior contract item",
    );
  }
}

function validateCreatedCheckout(
  checkout: ProviderCheckoutSession,
  project: ProjectAggregate,
  proposal: ProposalVersion,
  expectedLivemode: boolean,
): void {
  if (
    checkout.livemode !== expectedLivemode ||
    checkout.status !== "open" ||
    checkout.paymentStatus !== "unpaid" ||
    !checkout.url ||
    checkout.projectId !== project.projectId ||
    checkout.proposalId !== proposal.proposalId ||
    checkout.proposalVersion !== proposal.version ||
    checkout.proposalDigest !== proposal.digest ||
    checkout.amountMinor !== proposal.quote.amountMinor ||
    checkout.currency !== proposal.quote.currency ||
    normalizeEmail(checkout.customerEmail ?? "") !==
      normalizeEmail(project.customer.email?.value ?? "")
  ) {
    throw new OrchestrationPolicyError(
      "Stripe Checkout Session does not match the exact proposal",
    );
  }
}

function validatePaidCheckout(
  checkout: ProviderCheckoutSession,
  project: ProjectAggregate,
  proposal: ProposalVersion,
  expectedLivemode: boolean,
  expectedSessionId: string,
  event?: PaidCheckoutWebhook,
): void {
  validateReconciledCheckoutBinding(
    checkout,
    expectedSessionId,
    project,
    proposal,
    expectedLivemode,
  );
  if (
    (event !== undefined &&
      (event.livemode !== expectedLivemode ||
        checkout.sessionId !== event.session.sessionId)) ||
    checkout.status !== "complete" ||
    checkout.paymentStatus !== "paid" ||
    !checkout.paymentIntentId
  ) {
    throw new OrchestrationPolicyError(
      "Stripe payment does not match the current proposal, amount, currency, and mode",
    );
  }
}

function validateReconciledCheckoutBinding(
  checkout: ProviderCheckoutSession,
  expectedSessionId: string,
  project: ProjectAggregate,
  proposal: ProposalVersion,
  expectedLivemode: boolean,
): void {
  if (
    checkout.livemode !== expectedLivemode ||
    checkout.sessionId !== expectedSessionId ||
    checkout.projectId !== project.projectId ||
    checkout.proposalId !== proposal.proposalId ||
    checkout.proposalVersion !== proposal.version ||
    checkout.proposalDigest !== proposal.digest ||
    checkout.amountMinor !== proposal.quote.amountMinor ||
    checkout.currency !== proposal.quote.currency ||
    checkout.paymentStatus === "no_payment_required" ||
    normalizeEmail(checkout.customerEmail ?? "") !==
      normalizeEmail(project.customer.email?.value ?? "")
  ) {
    throw new OrchestrationPolicyError(
      "Stripe Checkout reconciliation does not match the current customer proposal",
    );
  }
}

function addPendingEffect(
  project: ProjectAggregate,
  key: string,
  type: DurableEffect["type"],
  input: unknown,
  now: string,
  proofSnapshot?: {
    snapshotId: string;
    snapshotDigest: string;
  },
): void {
  const existing = project.effects.find((effect) => effect.key === key);
  if (existing) {
    if (
      existing.type !== type ||
      existing.inputDigest !== sha256(JSON.stringify(input)) ||
      existing.proofSnapshotId !== proofSnapshot?.snapshotId ||
      existing.proofSnapshotDigest !== proofSnapshot?.snapshotDigest
    ) {
      throw new OrchestrationPolicyError(
        "Durable effect key was reused with different input",
      );
    }
    return;
  }
  project.effects.push({
    key,
    type,
    status: "pending",
    attempts: 1,
    inputDigest: sha256(JSON.stringify(input)),
    ...(proofSnapshot
      ? {
          proofSnapshotId: proofSnapshot.snapshotId,
          proofSnapshotDigest: proofSnapshot.snapshotDigest,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
}

function safeProofSnapshotInput(
  project: ProjectAggregate,
  binding: RecordedProofBinding,
): ProofSummarySnapshotInput {
  try {
    return createRecordedProofSnapshot(
      project,
      binding,
      protectedPublicationValues(project),
    );
  } catch {
    throw new OrchestrationPolicyError(
      "The exact proof summary could not cross the customer publication boundary",
    );
  }
}

function protectedPublicationValues(
  project: ProjectAggregate,
): ProtectedPublicationValue[] {
  const spans = project.intake.piiSpans;
  if (spans.length > MAX_PROOF_PII_SPANS) {
    throw new OrchestrationPolicyError(
      "The proof-summary protected-value budget was exceeded",
    );
  }
  let nameSpanCount = 0;
  for (const span of spans) {
    const width = span.endOffset - span.startOffset;
    if (
      width <= 0 ||
      width > MAX_PROOF_PROTECTED_VALUE_CHARS ||
      (span.category === "name" && width > MAX_PROOF_PERSON_NAME_SPAN_CHARS)
    ) {
      throw new OrchestrationPolicyError(
        "A protected proof-summary span exceeded its width budget",
      );
    }
    if (span.category === "name") {
      nameSpanCount += 1;
      if (nameSpanCount > MAX_PROOF_PERSON_NAME_SPANS) {
        throw new OrchestrationPolicyError(
          "The proof-summary person-name span budget was exceeded",
        );
      }
    }
  }

  const base = boundProtectedPublicationValues([
    ...(project.customer.displayName
      ? [
          {
            value: project.customer.displayName,
            kind: "person_name_full" as const,
          },
        ]
      : []),
    ...(project.customer.email
      ? [{ value: project.customer.email.value, kind: "exact" as const }]
      : []),
    ...(project.customer.phone
      ? [{ value: project.customer.phone.value, kind: "exact" as const }]
      : []),
    ...spans.map((span) => ({
      value: project.intake.content.slice(span.startOffset, span.endOffset),
      kind:
        span.category === "name"
          ? ("person_name_full" as const)
          : ("exact" as const),
    })),
  ]);

  const tokens: ProtectedPublicationValue[] = [];
  const seenTokens = new Set<string>();
  for (const name of base.filter(
    (value) => value.kind === "person_name_full",
  )) {
    const parts = name.value.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
    if (parts.length <= 1) {
      continue;
    }
    for (const token of parts) {
      if (Array.from(token).length < 2) {
        continue;
      }
      const key = token.toLocaleLowerCase("en-US");
      if (seenTokens.has(key)) {
        continue;
      }
      seenTokens.add(key);
      if (seenTokens.size > MAX_PROOF_PERSON_NAME_TOKENS) {
        throw new OrchestrationPolicyError(
          "The proof-summary person-name token budget was exceeded",
        );
      }
      tokens.push({ value: token, kind: "person_name_token" });
    }
  }
  return boundProtectedPublicationValues([...base, ...tokens]);
}

function requireProofSnapshotCoordinates(
  effect: DurableEffect,
  binding: RecordedProofBinding,
): { snapshotId: string; snapshotDigest: string } {
  if (
    !["persist_proof_summary_snapshot", "send_final_delivery"].includes(
      effect.type,
    ) ||
    !effect.proofSnapshotId ||
    !effect.proofSnapshotDigest ||
    (effect.type === "persist_proof_summary_snapshot" &&
      effect.status === "completed" &&
      effect.providerId !== effect.proofSnapshotId)
  ) {
    throw new OrchestrationPolicyError(
      "The durable effect lacks an exact proof-summary snapshot binding",
    );
  }
  const expectedPrefix = `proof-summary:${sha256(canonicalJson(binding)).slice(
    0,
    32,
  )}`;
  if (effect.proofSnapshotId !== expectedPrefix) {
    throw new OrchestrationPolicyError(
      "The proof-summary effect is bound to a different deployment",
    );
  }
  return {
    snapshotId: effect.proofSnapshotId,
    snapshotDigest: effect.proofSnapshotDigest,
  };
}

function requireExactProofSnapshot(
  snapshot: ProofSummarySnapshot | undefined,
  coordinates: { snapshotId: string; snapshotDigest: string },
  binding: RecordedProofBinding,
): void {
  if (
    !snapshot ||
    snapshot.snapshotId !== coordinates.snapshotId ||
    snapshot.snapshotDigest !== coordinates.snapshotDigest ||
    snapshot.projectId !== binding.projectId ||
    snapshot.deploymentReceiptId !== binding.deploymentReceiptId ||
    snapshot.revisionHash !== binding.revisionHash ||
    snapshot.revokedAt
  ) {
    throw new OrchestrationPolicyError(
      "The exact immutable proof-summary snapshot is unavailable or revoked",
    );
  }
  try {
    parseRecordedProofSnapshot(snapshot);
  } catch {
    throw new OrchestrationPolicyError(
      "The exact immutable proof-summary snapshot failed verification",
    );
  }
}

function markEffectAttempt(key: string): void {
  effectAttemptContext.getStore()?.attemptedEffectKeys.push(key);
}

function completeEffect(
  project: ProjectAggregate,
  key: string,
  providerId: string,
  receipt: unknown,
  now: string,
): void {
  const effect = project.effects.find((candidate) => candidate.key === key);
  if (!effect) {
    throw new OrchestrationPolicyError("Durable effect intent is missing");
  }
  effect.status = "completed";
  effect.providerId = providerId;
  effect.receiptDigest = sha256(JSON.stringify(receipt));
  effect.updatedAt = now;
  effect.completedAt = now;
  delete effect.error;
  delete effect.nextAttemptAt;
  delete effect.nextCheckAt;
}

function earliestScheduledRetryEffect(
  project: ProjectAggregate,
): DurableEffect | undefined {
  return project.effects
    .filter(
      (effect) =>
        effect.status === "pending" && effect.nextAttemptAt !== undefined,
    )
    .sort(
      (left, right) =>
        Date.parse(left.nextAttemptAt!) - Date.parse(right.nextAttemptAt!) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt),
    )[0];
}

function requireEffect(project: ProjectAggregate, key: string): DurableEffect {
  const effect = project.effects.find((candidate) => candidate.key === key);
  if (!effect) {
    throw new OrchestrationPolicyError("Durable effect intent is missing");
  }
  return effect;
}

function classifyEffectError(
  error: unknown,
  effect: DurableEffect,
  occurredAt: string,
): ProjectAggregate["errors"][number] {
  const upstreamCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const security = upstreamCode === "INVALID_WEBHOOK";
  const permanentCodes = new Set([
    "ARTIFACT_INTEGRITY_FAILED",
    "INVALID_INPUT",
    "INVALID_PROVIDER_RESPONSE",
    "INVALID_WEBHOOK",
    "POLICY_BLOCKED",
    "RELEASE_FENCED",
    "UNSAFE_ARCHIVE",
  ]);
  const policy =
    error instanceof OrchestrationPolicyError ||
    (upstreamCode !== undefined && permanentCodes.has(upstreamCode));
  const category = security ? "security" : policy ? "policy" : "transient";
  const normalizedCode = security
    ? "effect.security_failure"
    : policy
      ? "effect.policy_failure"
      : "effect.provider_failure";
  return {
    errorId: effectErrorId(effect.key, effect.attempts, normalizedCode),
    code: normalizedCode,
    category,
    message:
      category === "transient"
        ? "A provider effect failed and is eligible for bounded retry"
        : "A provider effect failed closed and requires operator attention",
    retryable: category === "transient",
    effectKey: effect.key,
    occurredAt,
  };
}

function isTransientProviderFailure(error: unknown): boolean {
  if (error instanceof OrchestrationPolicyError) {
    return false;
  }
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  return !new Set([
    "ARTIFACT_INTEGRITY_FAILED",
    "INVALID_INPUT",
    "INVALID_PROVIDER_RESPONSE",
    "INVALID_WEBHOOK",
    "POLICY_BLOCKED",
    "RELEASE_FENCED",
    "UNSAFE_ARCHIVE",
  ]).has(code ?? "");
}

function safeEffectError(
  effect: DurableEffect,
  code: string,
  occurredAt: string,
): ProjectAggregate["errors"][number] {
  return {
    errorId: effectErrorId(effect.key, effect.attempts, code),
    code: `effect.${code}`,
    category: "permanent",
    message: "A provider effect exhausted its bounded retry policy",
    retryable: false,
    effectKey: effect.key,
    occurredAt,
  };
}

function effectErrorId(
  effectKey: string,
  attempt: number,
  code: string,
): string {
  return `effect-error:${sha256(
    `${effectKey}\0${String(attempt)}\0${code}`,
  ).slice(0, 24)}`;
}

function boundedRetryInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function checkoutEffectKey(
  projectId: string,
  version: number,
  attempt = 1,
): string {
  const base = `checkout:create:${projectId}:v${version}`;
  return attempt === 1 ? base : `${base}:attempt:${attempt}`;
}

function buildCancellationEffectKey(batchId: string, runId: string): string {
  return `build:cancel:${batchId}:${runId}`;
}

function paymentReconciliationEffectKey(
  projectId: string,
  version: number,
  checkoutSessionId: string,
): string {
  return `payment:reconcile:${projectId}:v${version}:${checkoutSessionId}`;
}

function verifiedStripeEvidenceDigest(verified: VerifiedStripePayment): string {
  return digestJson({
    source: "stripe_authoritative_checkout_and_payment_intent",
    checkoutSessionId: verified.checkout.sessionId,
    paymentIntentId: verified.settlement.paymentIntentId,
    projectId: verified.settlement.projectId,
    proposalId: verified.settlement.proposalId,
    proposalVersion: verified.settlement.proposalVersion,
    proposalDigest: verified.settlement.proposalDigest,
    amountMinor: verified.settlement.amountMinor,
    amountReceivedMinor: verified.settlement.amountReceivedMinor,
    currency: verified.settlement.currency,
    customerEmailDigest: sha256(
      normalizeEmail(verified.settlement.customerEmail),
    ),
    customerId: verified.settlement.customerId,
    livemode: verified.settlement.livemode,
    checkoutStatus: verified.settlement.checkoutStatus,
    paymentStatus: verified.settlement.paymentStatus,
    paymentIntentStatus: verified.settlement.paymentIntentStatus,
    paymentIntentCreatedAt: verified.settlement.paymentIntentCreatedAt,
  });
}

function proposalMailEffectKey(
  projectId: string,
  version: number,
  checkoutAttempt = 1,
): string {
  const base = `mail:proposal:${projectId}:v${version}`;
  return checkoutAttempt === 1
    ? base
    : `${base}:checkout-attempt:${checkoutAttempt}`;
}

function emailVerificationMailEffectPrefix(projectId: string): string {
  return `mail:email-verification:${projectId}`;
}

function emailVerificationMailEffectKey(
  projectId: string,
  generation = 1,
): string {
  return capabilityMailEffectKey(
    emailVerificationMailEffectPrefix(projectId),
    generation,
  );
}

function dashboardLoginMailEffectProjectPrefix(projectId: string): string {
  return `mail:dashboard-login:${projectId}:request:`;
}

function dashboardLoginMailEffectPrefix(
  projectId: string,
  requestDigest: string,
): string {
  return `${dashboardLoginMailEffectProjectPrefix(projectId)}${requestDigest}`;
}

function dashboardLoginMailEffectKey(
  projectId: string,
  requestDigest: string,
  generation = 1,
): string {
  return capabilityMailEffectKey(
    dashboardLoginMailEffectPrefix(projectId, requestDigest),
    generation,
  );
}

function dashboardLoginMailEffects(project: ProjectAggregate): DurableEffect[] {
  const prefix = dashboardLoginMailEffectProjectPrefix(project.projectId);
  return project.effects.filter(
    (effect) =>
      effect.type === "send_dashboard_login" && effect.key.startsWith(prefix),
  );
}

function latestDashboardLoginMailEffect(
  project: ProjectAggregate,
): DurableEffect | undefined {
  return dashboardLoginMailEffects(project).sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
      right.key.localeCompare(left.key),
  )[0];
}

function dashboardAccessMailEffectPrefix(
  projectId: string,
  batchId: string,
): string {
  return `mail:dashboard-access:${projectId}:${batchId}`;
}

function dashboardAccessMailEffectKey(
  projectId: string,
  batchId: string,
  generation = 1,
): string {
  return capabilityMailEffectKey(
    dashboardAccessMailEffectPrefix(projectId, batchId),
    generation,
  );
}

function capabilityMailEffectKey(prefix: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new OrchestrationPolicyError(
      "Passwordless capability generation is invalid",
    );
  }
  return generation === 1 ? prefix : `${prefix}:generation:${generation}`;
}

function capabilityEffectGeneration(key: string): number {
  const match = /:generation:(\d+)$/u.exec(key);
  if (!match) {
    return 1;
  }
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation) || generation < 2) {
    throw new OrchestrationPolicyError(
      "Passwordless capability generation is invalid",
    );
  }
  return generation;
}

function capabilityEffectBaseKey(key: string): string {
  return key.replace(/:generation:\d+$/u, "");
}

function latestCapabilityMailEffect(
  project: ProjectAggregate,
  type:
    | "send_email_verification"
    | "send_dashboard_login"
    | "send_dashboard_access",
  prefix: string,
): DurableEffect | undefined {
  return project.effects
    .filter(
      (effect) =>
        effect.type === type &&
        (effect.key === prefix ||
          effect.key.startsWith(`${prefix}:generation:`)),
    )
    .sort(
      (left, right) =>
        capabilityEffectGeneration(right.key) -
        capabilityEffectGeneration(left.key),
    )[0];
}

function capabilityEffectExpired(
  effect: DurableEffect,
  now: Date,
  ttlSeconds: number,
): boolean {
  return Date.parse(effect.createdAt) + ttlSeconds * 1_000 <= now.getTime();
}

function isOptimisticConcurrencyFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "OptimisticConcurrencyError";
}

function previewMailEffectKey(
  projectId: string,
  version: number,
  revisionHash: string,
): string {
  return `mail:preview:${projectId}:v${version}:${revisionHash}`;
}

function outboundMessage(
  project: ProjectAggregate,
  draft: CustomerEmailDraft,
  providerMessageId: string,
  idempotencyKey: string,
  purpose:
    | "email_verification"
    | "clarification"
    | "proposal"
    | "payment_confirmation"
    | "dashboard_access"
    | "proven_preview"
    | "final_delivery"
    | "steering",
  messageIdDomain: string,
  createdAt: string,
): ProjectMessage {
  const thread = outboundThreadContext(project);
  const messageId = deterministicRfcMessageId(
    project,
    idempotencyKey,
    messageIdDomain,
  );
  return ProjectMessageSchema.parse({
    messageId: `message:${sha256(providerMessageId).slice(0, 24)}`,
    direction: "outbound",
    channel: "email",
    purpose,
    provider: "resend",
    providerMessageId,
    rfcMessageId: encodeMessageIdentifier(messageId),
    ...(thread.threadId ? { threadId: thread.threadId } : {}),
    ...(thread.inReplyTo ? { inReplyTo: thread.inReplyTo } : {}),
    references: thread.references,
    subject: draft.subject,
    content: draft.text,
    contentDigest: sha256(draft.text),
    senderAuthenticated: true,
    deliveryStatus: "sent",
    createdAt,
  });
}

interface OutboundThreadContext {
  headers?: Readonly<Record<string, string>>;
  threadId?: string;
  inReplyTo?: string;
  references: string[];
}

function outboundThreadContext(
  project: ProjectAggregate,
): OutboundThreadContext {
  const parent = project.messages.findLast(
    (message) =>
      message.channel === "email" &&
      message.provider === "resend" &&
      ((message.direction === "inbound" &&
        message.senderAuthenticated &&
        message.providerMessageId !== undefined) ||
        (message.direction === "outbound" &&
          message.rfcMessageId !== undefined)),
  );
  if (!parent) {
    return { references: [] };
  }
  const parentIdentifier =
    parent.direction === "inbound"
      ? parent.providerMessageId
      : parent.rfcMessageId;
  if (!parentIdentifier) {
    return { references: [] };
  }
  const inReplyTo = decodeProviderIdentifier(parentIdentifier);
  if (!inReplyTo || !isSafeRfcMessageId(inReplyTo)) {
    return { references: [] };
  }

  const priorReferences =
    parent.direction === "inbound"
      ? parseInboundReferences(parent.threadId)
      : parent.references
          .map((reference) => decodeProviderIdentifier(reference))
          .filter(
            (reference): reference is string =>
              reference !== undefined && isSafeRfcMessageId(reference),
          );
  const headerReferences = boundedRfcReferences([
    ...priorReferences,
    inReplyTo,
  ]);
  return {
    headers: {
      "In-Reply-To": inReplyTo,
      References: headerReferences.join(" "),
    },
    ...(parent.threadId ? { threadId: parent.threadId } : {}),
    inReplyTo: parentIdentifier,
    references: headerReferences.map(encodeMessageIdentifier),
  };
}

function decodeProviderIdentifier(value: string): string | undefined {
  const marker = "resend-message:";
  if (!value.startsWith(marker)) {
    return undefined;
  }
  const encoded = value.slice(marker.length);
  if (
    encoded.length === 0 ||
    encoded.startsWith("sha256:") ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (
    Buffer.from(decoded, "utf8").toString("base64url") !== encoded ||
    Buffer.byteLength(decoded) > 8_192 ||
    /[\r\n\0]/.test(decoded)
  ) {
    return undefined;
  }
  return decoded;
}

function parseInboundReferences(threadId: string | undefined): string[] {
  if (!threadId) {
    return [];
  }
  const marker = "resend-thread:";
  if (!threadId.startsWith(marker)) {
    return [];
  }
  const encoded = threadId.slice(marker.length);
  if (
    encoded.length === 0 ||
    encoded.startsWith("sha256:") ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return [];
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (
    Buffer.from(decoded, "utf8").toString("base64url") !== encoded ||
    Buffer.byteLength(decoded) > 8_192 ||
    /[\r\n\0]/.test(decoded)
  ) {
    return [];
  }
  return parseSafeRfcReferences(decoded);
}

function encodeMessageIdentifier(messageId: string): string {
  return `resend-message:${Buffer.from(messageId, "utf8").toString(
    "base64url",
  )}`;
}

function deterministicRfcMessageId(
  project: ProjectAggregate,
  idempotencyKey: string,
  domain: string,
): string {
  return `<${sha256(`${project.projectId}\0${idempotencyKey}`)}@${domain}>`;
}

function validateMessageIdDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    normalized.length < 4 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  ) {
    throw new OrchestrationPolicyError("Invalid outbound Message-ID domain");
  }
  return normalized;
}

function parseSafeRfcReferences(value: string): string[] {
  const references = value.trim().split(/[ \t]+/);
  if (
    references.length === 0 ||
    references.length > 500 ||
    references.some((reference) => !isSafeRfcMessageId(reference))
  ) {
    return [];
  }
  return references;
}

function isSafeRfcMessageId(value: string): boolean {
  return (
    value.length <= 998 &&
    /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value) &&
    encodeMessageIdentifier(value).length <= 256
  );
}

function boundedRfcReferences(references: readonly string[]): string[] {
  const deduplicated = [...new Set(references)];
  while (
    deduplicated.length > 500 ||
    Buffer.byteLength(deduplicated.join(" ")) > 8_192
  ) {
    deduplicated.shift();
  }
  return deduplicated;
}

interface ConversationSegment {
  kind: "intake" | "customer_message";
  id: string;
  content: string;
  digest: string;
}

function boundedPendingMessageBatch(
  project: ProjectAggregate,
  pendingMessages: readonly ProjectMessage[],
): ProjectMessage[] {
  if (project.intake.content.length > MAX_MODEL_CONTEXT_CHARS) {
    throw new OrchestrationPolicyError(
      "Intake exceeds the bounded orchestration model context",
    );
  }
  const selected: ProjectMessage[] = [];
  let length = project.intake.content.length;
  for (const message of pendingMessages) {
    if (selected.length >= MAX_CONTEXT_MESSAGES) {
      break;
    }
    const additional = message.content.length + 2;
    if (length + additional > MAX_MODEL_CONTEXT_CHARS) {
      if (selected.length === 0) {
        throw new OrchestrationPolicyError(
          "Oldest pending customer message exceeds the bounded orchestration model context",
        );
      }
      break;
    }
    selected.push(message);
    length += additional;
  }
  if (selected.length === 0) {
    throw new OrchestrationPolicyError(
      "No pending customer message fits the bounded orchestration model context",
    );
  }
  return selected;
}

function canonicalConversation(
  project: ProjectAggregate,
  requiredMessageIds?: readonly string[],
): {
  content: string;
  segments: ConversationSegment[];
} {
  if (project.intake.content.length > MAX_MODEL_CONTEXT_CHARS) {
    throw new OrchestrationPolicyError(
      "Intake exceeds the bounded orchestration model context",
    );
  }
  const intakeSegment: ConversationSegment = {
    kind: "intake",
    id: project.intake.intakeId,
    content: project.intake.content,
    digest: project.intake.contentDigest,
  };
  const orderedInbound = project.messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.direction === "inbound")
    .sort(
      (left, right) =>
        Date.parse(left.message.createdAt) -
          Date.parse(right.message.createdAt) || left.index - right.index,
    )
    .map(({ message }) => ({
      kind: "customer_message" as const,
      id: message.messageId,
      content: message.content,
      digest: message.contentDigest,
    }));
  const requiredIds = requiredMessageIds
    ? new Set(requiredMessageIds)
    : undefined;
  if (requiredIds && requiredIds.size !== requiredMessageIds!.length) {
    throw new OrchestrationPolicyError(
      "Required customer message identities must be unique",
    );
  }
  const inbound = requiredIds
    ? orderedInbound.filter((segment) => requiredIds.has(segment.id))
    : orderedInbound.slice(-MAX_CONTEXT_MESSAGES);
  if (
    requiredIds &&
    (inbound.length !== requiredIds.size ||
      inbound.length > MAX_CONTEXT_MESSAGES)
  ) {
    throw new OrchestrationPolicyError(
      "Required customer messages are missing or exceed the bounded context window",
    );
  }
  const selected: ConversationSegment[] = [];
  let length = intakeSegment.content.length;
  if (requiredIds) {
    for (const segment of inbound) {
      const additional = segment.content.length + 2;
      if (length + additional > MAX_MODEL_CONTEXT_CHARS) {
        throw new OrchestrationPolicyError(
          "Required customer messages exceed the bounded orchestration model context",
        );
      }
      selected.push(segment);
      length += additional;
    }
  } else {
    for (const segment of [...inbound].reverse()) {
      const additional = segment.content.length + 2;
      if (additional + intakeSegment.content.length > MAX_MODEL_CONTEXT_CHARS) {
        if (selected.length === 0) {
          throw new OrchestrationPolicyError(
            "Latest customer message exceeds the bounded orchestration model context",
          );
        }
        continue;
      }
      if (length + additional <= MAX_MODEL_CONTEXT_CHARS) {
        selected.push(segment);
        length += additional;
      }
    }
    selected.reverse();
  }
  const segments: ConversationSegment[] = [intakeSegment, ...selected];
  return {
    content: segments.map((segment) => segment.content).join("\n\n"),
    segments,
  };
}

function minimizeSegments(
  segments: ConversationSegment[],
  minimizedConversation: string,
): ConversationEvidenceSegment[] {
  let offset = 0;
  return segments.map((segment, index) => {
    const minimizedContent = minimizedConversation.slice(
      offset,
      offset + segment.content.length,
    );
    offset += segment.content.length + (index < segments.length - 1 ? 2 : 0);
    return segment.kind === "intake"
      ? {
          kind: "intake",
          intakeId: segment.id,
          contentDigest: segment.digest,
          minimizedContent,
        }
      : {
          kind: "customer_message",
          messageId: segment.id,
          contentDigest: segment.digest,
          minimizedContent,
        };
  });
}

function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}
