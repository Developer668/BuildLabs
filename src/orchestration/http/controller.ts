import type { OutboundMailDeliveryStatus } from "../ports/mail.js";
import type { PaidCheckoutWebhook } from "../ports/payment.js";

/**
 * The transport boundary intentionally depends on this small structural
 * interface instead of the concrete orchestration engine. Implementations own
 * durable inbox deduplication and all lifecycle state transitions.
 */
export interface OrchestrationHttpController {
  acceptIntake(
    input: OrchestrationIntakeCommand,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  verifyEmailOwnership(
    input: OrchestrationEmailOwnershipCommand,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  requestCustomerDashboardAccess(
    input: OrchestrationCustomerDashboardAccessRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  confirmPayment(
    event: PaidCheckoutWebhook,
    eventDigest: string,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  receiveCustomerMessage(
    input: OrchestrationCustomerMessageCommand,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  recordMailDelivery(
    input: OrchestrationMailDeliveryCommand,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
  reconcileProject(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<OrchestrationHttpProjectResult>;
}

export interface OrchestrationHttpProjectResult {
  projectId: string;
  status: string;
  revision?: number;
  openClarificationQuestions?: string[];
}

export interface OrchestrationIntakeCommand {
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
   * Return once the intake is durably recorded, leaving reasoning and the first
   * customer mail to the reconciliation worker.
   */
  deferAnalysis?: boolean;
}

export interface OrchestrationEmailOwnershipCommand {
  projectId: string;
  method: "passwordless_email";
  provider: string;
  providerEventId: string;
  eventDigest: string;
  email: string;
  verifiedAt: string;
  dashboardLogin?: {
    tokenDigest: string;
    expiresAt: string;
  };
}

export interface OrchestrationCustomerDashboardAccessRequest {
  projectId: string;
  emailDigest: string;
  capabilityDigest: string;
}

export interface OrchestrationCustomerMessageCommand {
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

export interface OrchestrationMailDeliveryCommand {
  projectId: string;
  providerEventId: string;
  eventDigest: string;
  providerMessageId: string;
  occurredAt: string;
  deliveryStatus: OutboundMailDeliveryStatus;
  permanent: boolean;
}
