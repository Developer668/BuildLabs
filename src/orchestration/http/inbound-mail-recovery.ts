import { z } from "zod";

import { digestJson, sha256 } from "../../lib/canonical-json.js";
import { ProviderAdapterError } from "../adapters/providers/provider-error.js";
import type { ReplyAddressCodec } from "../application/reply-address.js";
import type {
  InboundMailEnvelope,
  InboundMailEnvelopeStore,
} from "../domain/store.js";
import type {
  InboundMail,
  InboundMailNotification,
  InboundSenderAuthentication,
  MailPort,
} from "../ports/mail.js";
import {
  InvalidInboundContentError,
  normalizeInboundEmailEvidence,
} from "./inbound-content.js";
import type { OrchestrationHttpController } from "./controller.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_INITIAL_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;

export interface InboundMailRecoveryOptions {
  store: InboundMailEnvelopeStore;
  mail: Pick<MailPort, "retrieveInboundEmail">;
  controller: Pick<OrchestrationHttpController, "receiveCustomerMessage">;
  replyAddresses: ReplyAddressCodec;
  now?: () => Date;
  maxAttempts?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  claimLeaseMs?: number;
  batchSize?: number;
}

export interface InboundMailRecoveryStatus {
  eventId: string;
  status: InboundMailEnvelope["status"];
  attempts: number;
  receivedAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
}

/**
 * Durable boundary between a signed Resend notification and provider
 * enrichment. Only hashes plus the opaque Resend email ID are queued. Raw
 * sender/recipient/subject/body data stays in the provider until retrieved,
 * cryptographically authenticated, minimized, and committed to the project.
 */
export class InboundMailRecovery {
  readonly #store: InboundMailEnvelopeStore;
  readonly #mail: Pick<MailPort, "retrieveInboundEmail">;
  readonly #controller: Pick<
    OrchestrationHttpController,
    "receiveCustomerMessage"
  >;
  readonly #replyAddresses: ReplyAddressCodec;
  readonly #now: () => Date;
  readonly #maxAttempts: number;
  readonly #retryInitialDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #claimLeaseMs: number;
  readonly #batchSize: number;

  constructor(options: InboundMailRecoveryOptions) {
    this.#store = options.store;
    this.#mail = options.mail;
    this.#controller = options.controller;
    this.#replyAddresses = options.replyAddresses;
    this.#now = options.now ?? (() => new Date());
    this.#maxAttempts = boundedInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      1,
      20,
      "maxAttempts",
    );
    this.#retryInitialDelayMs = boundedInteger(
      options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_MS,
      100,
      5 * 60_000,
      "retryInitialDelayMs",
    );
    this.#retryMaxDelayMs = boundedInteger(
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS,
      this.#retryInitialDelayMs,
      24 * 60 * 60 * 1_000,
      "retryMaxDelayMs",
    );
    this.#claimLeaseMs = boundedInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      1_000,
      10 * 60_000,
      "claimLeaseMs",
    );
    this.#batchSize = boundedInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      1,
      100,
      "batchSize",
    );
  }

  async acceptSignedNotification(
    notification: InboundMailNotification,
    providerEventId: string,
    eventDigest: string,
    signal?: AbortSignal,
  ): Promise<{ routed: boolean; projectId?: string }> {
    const projectId = resolveInboundProject(
      notification.to,
      this.#replyAddresses,
    );
    if (!projectId) {
      return { routed: false };
    }
    this.#store.stageInboundMailEnvelope({
      provider: "resend",
      eventId: providerEventId,
      eventDigest,
      projectId,
      emailId: notification.emailId,
      identityDigest: inboundMailIdentityDigest(notification),
      receivedAt: notification.createdAt,
    });
    await this.#processReady(projectId, signal);
    return { routed: true, projectId };
  }

  /**
   * Called by the normal project reconciliation worker before any lifecycle
   * action. An unresolved signed envelope fences deploy/delivery until it is
   * enriched or explicitly resolved, including for already-completed projects.
   */
  async recoverProject(projectId: string, signal?: AbortSignal): Promise<void> {
    await this.#processReady(projectId, signal);
    if (this.#store.hasUnresolvedInboundMailEnvelope(projectId)) {
      throw new InboundMailRecoveryDeferredError("pending");
    }
  }

  status(projectId: string): InboundMailRecoveryStatus[] {
    return this.#store.listInboundMailEnvelopes(projectId).map((envelope) => ({
      eventId: envelope.eventId,
      status: envelope.status,
      attempts: envelope.attempts,
      receivedAt: envelope.receivedAt,
      updatedAt: envelope.updatedAt,
      ...(envelope.nextAttemptAt
        ? { nextAttemptAt: envelope.nextAttemptAt }
        : {}),
      ...(envelope.lastErrorCode
        ? { lastErrorCode: envelope.lastErrorCode }
        : {}),
    }));
  }

  resolve(
    projectId: string,
    eventId: string,
    resolution: "retry" | "discard",
  ): void {
    this.#store.resolveInboundMailEnvelope(
      projectId,
      eventId,
      resolution,
      this.#timestamp(),
    );
  }

  async #processReady(projectId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const now = this.#timestamp();
    const leaseUntil = new Date(
      Date.parse(now) + this.#claimLeaseMs,
    ).toISOString();
    const claimed = this.#store.claimPendingInboundMailEnvelopes(
      projectId,
      now,
      leaseUntil,
      this.#batchSize,
    );
    for (const envelope of claimed) {
      try {
        throwIfAborted(signal);
        const inbound = await this.#mail.retrieveInboundEmail(envelope.emailId);
        throwIfAborted(signal);
        await this.#acceptRetrievedEnvelope(envelope, inbound, signal);
        this.#store.completeInboundMailEnvelope(
          envelope.provider,
          envelope.eventId,
          envelope.eventDigest,
          this.#timestamp(),
        );
      } catch (error) {
        if (
          this.#store.hasVerifiedInboxEvent(
            "resend",
            envelope.eventId,
            envelope.eventDigest,
          )
        ) {
          this.#store.completeInboundMailEnvelope(
            envelope.provider,
            envelope.eventId,
            envelope.eventDigest,
            this.#timestamp(),
          );
          continue;
        }
        if (signal?.aborted) {
          throw error;
        }
        const failure = classifyInboundFailure(error);
        const retryable =
          failure.retryable && envelope.attempts < this.#maxAttempts;
        const failedAt = this.#timestamp();
        const retryDelay = Math.min(
          this.#retryInitialDelayMs * 2 ** (envelope.attempts - 1),
          this.#retryMaxDelayMs,
        );
        this.#store.recordInboundMailEnvelopeFailure({
          provider: envelope.provider,
          eventId: envelope.eventId,
          eventDigest: envelope.eventDigest,
          errorCode: retryable
            ? failure.code
            : failure.retryable
              ? "inbound_mail.retry_exhausted"
              : failure.code,
          retryable,
          ...(!retryable
            ? {
                terminalStatus: failure.retryable
                  ? ("failed" as const)
                  : failure.terminalStatus,
              }
            : {}),
          ...(retryable
            ? {
                nextAttemptAt: new Date(
                  Date.parse(failedAt) + retryDelay,
                ).toISOString(),
              }
            : {}),
          failedAt,
        });
        throw error;
      }
    }
  }

  async #acceptRetrievedEnvelope(
    envelope: InboundMailEnvelope,
    inbound: InboundMail,
    signal?: AbortSignal,
  ): Promise<void> {
    if (inboundMailIdentityDigest(inbound) !== envelope.identityDigest) {
      throw new InboundMailRecoveryError(
        502,
        "inbound_identity_mismatch",
        "The retrieved email did not match its signed notification",
      );
    }
    if (
      resolveInboundProject(inbound.to, this.#replyAddresses) !==
      envelope.projectId
    ) {
      throw new InboundMailRecoveryError(
        502,
        "inbound_project_mismatch",
        "The retrieved email did not match its signed project recipient",
      );
    }
    const senderEmail = extractMailbox(inbound.from);
    verifyAuthenticatedSender(inbound.senderAuthentication, senderEmail);
    if (inbound.attachments.length > 0) {
      throw new InboundMailRecoveryError(
        422,
        "inbound_attachments_require_operator",
        "Inbound attachments require explicit operator review",
      );
    }
    const content = normalizeInboundEmailEvidence(
      inbound.subject,
      inbound.text,
      inbound.html,
    );
    const threadHeader =
      inbound.headers?.references ?? inbound.headers?.["in-reply-to"];
    const command = {
      projectId: envelope.projectId,
      providerEventId: envelope.eventId,
      eventDigest: envelope.eventDigest,
      providerMessageId: encodeProviderIdentifier(
        "resend-message",
        inbound.messageId,
      ),
      receivedAt: inbound.createdAt,
      senderEmail,
      subject: inbound.subject,
      content,
      ...(threadHeader
        ? {
            threadId: encodeProviderIdentifier("resend-thread", threadHeader),
          }
        : {}),
    };
    if (signal) {
      await this.#controller.receiveCustomerMessage(command, signal);
    } else {
      await this.#controller.receiveCustomerMessage(command);
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export class InboundMailRecoveryError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(statusCode: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "InboundMailRecoveryError";
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export class InboundMailRecoveryDeferredError extends Error {
  constructor(status: InboundMailEnvelope["status"]) {
    super(`Inbound mail recovery is unresolved (${status})`);
    this.name = "InboundMailRecoveryDeferredError";
  }
}

function inboundMailIdentityDigest(
  mail: Pick<
    InboundMailNotification,
    "emailId" | "createdAt" | "from" | "to" | "subject" | "messageId"
  >,
): string {
  return digestJson({
    emailId: mail.emailId,
    createdAt: new Date(mail.createdAt).toISOString(),
    from: extractMailbox(mail.from).toLowerCase(),
    to: canonicalMailboxSet(mail.to),
    subject: mail.subject,
    messageId: mail.messageId,
  });
}

function resolveInboundProject(
  recipients: readonly string[],
  codec: ReplyAddressCodec,
): string | undefined {
  const projectIds = new Set<string>();
  for (const recipient of recipients) {
    const mailbox = extractMailbox(recipient);
    try {
      projectIds.add(codec.parse(mailbox));
    } catch {
      // Other recipients on a valid inbound message are outside this workflow.
    }
  }
  if (projectIds.size > 1) {
    throw new InboundMailRecoveryError(
      409,
      "ambiguous_reply_address",
      "The inbound message targets more than one orchestration project",
    );
  }
  return projectIds.values().next().value;
}

function canonicalMailboxSet(addresses: readonly string[]): string[] {
  return [
    ...new Set(addresses.map((value) => extractMailbox(value).toLowerCase())),
  ].sort();
}

function extractMailbox(value: string): string {
  if (value.length === 0 || value.length > 998 || hasControlCharacters(value)) {
    throw new InboundMailRecoveryError(
      502,
      "invalid_mailbox",
      "The provider returned an invalid email address",
    );
  }
  const trimmed = value.trim();
  const displayMatch = /<([^<>]+)>$/.exec(trimmed);
  const candidate = (displayMatch?.[1] ?? trimmed).trim();
  if (!z.email().max(320).safeParse(candidate).success) {
    throw new InboundMailRecoveryError(
      502,
      "invalid_mailbox",
      "The provider returned an invalid email address",
    );
  }
  const at = candidate.lastIndexOf("@");
  return `${candidate.slice(0, at)}@${candidate.slice(at + 1).toLowerCase()}`;
}

function verifyAuthenticatedSender(
  authentication: InboundSenderAuthentication,
  senderEmail: string,
): void {
  const senderDomain = senderEmail.slice(senderEmail.lastIndexOf("@") + 1);
  if (
    authentication.method !== "aligned_dkim" ||
    authentication.result !== "pass" ||
    !domainsAlign(authentication.signingDomain, senderDomain)
  ) {
    throw new InboundMailRecoveryError(
      403,
      "unauthenticated_sender",
      "The inbound sender could not be authenticated",
    );
  }
}

function domainsAlign(signingDomain: string, senderDomain: string): boolean {
  const signing = signingDomain.toLowerCase().replace(/\.$/, "");
  const sender = senderDomain.toLowerCase().replace(/\.$/, "");
  return (
    signing === sender ||
    signing.endsWith(`.${sender}`) ||
    sender.endsWith(`.${signing}`)
  );
}

function encodeProviderIdentifier(prefix: string, value: string): string {
  const encoded = `${prefix}:${Buffer.from(value, "utf8").toString("base64url")}`;
  return encoded.length <= 256 ? encoded : `${prefix}:sha256:${sha256(value)}`;
}

function classifyInboundFailure(error: unknown): {
  code: string;
  retryable: boolean;
  terminalStatus: "rejected" | "failed";
} {
  if (error instanceof ProviderAdapterError) {
    return {
      code:
        error.code === "PROVIDER_FAILURE"
          ? "inbound_mail.provider_failure"
          : "inbound_mail.invalid_provider_response",
      retryable: error.code === "PROVIDER_FAILURE",
      terminalStatus: "failed",
    };
  }
  if (error instanceof InboundMailRecoveryError) {
    return {
      code: error.code,
      retryable: false,
      terminalStatus:
        error.code === "unauthenticated_sender" ? "rejected" : "failed",
    };
  }
  if (error instanceof InvalidInboundContentError) {
    return {
      code: "inbound_mail.invalid_content",
      retryable: false,
      terminalStatus: "rejected",
    };
  }
  if (
    error instanceof Error &&
    (error.name === "OrchestrationPolicyError" ||
      error.name === "InboxConflictError" ||
      error.name === "InboundMailEnvelopeConflictError")
  ) {
    return {
      code: "inbound_mail.policy_blocked",
      retryable: false,
      terminalStatus:
        error instanceof Error && error.name === "InboxConflictError"
          ? "failed"
          : "rejected",
    };
  }
  return {
    code: "inbound_mail.transient_failure",
    retryable: true,
    terminalStatus: "failed",
  };
}

function boundedInteger(
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Inbound mail recovery aborted");
  }
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
