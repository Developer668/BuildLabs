export interface MailTag {
  name: string;
  value: string;
}

export interface SendMailRequest {
  from: string;
  to: string | readonly string[];
  subject: string;
  replyTo: string | readonly string[];
  text: string;
  html: string;
  tags: readonly MailTag[];
  idempotencyKey: string;
  headers?: Readonly<Record<string, string>>;
}

export interface SentMail {
  provider: "resend";
  messageId: string;
}

export type OutboundMailProviderStatus =
  "pending" | "delivered" | "bounced" | "failed";

export interface OutboundMailProviderState {
  provider: "resend";
  messageId: string;
  status: OutboundMailProviderStatus;
  /**
   * Resend's retrieve endpoint exposes the latest state but not the event
   * timestamp. The adapter records when that provider state was verified.
   */
  verifiedAt: string;
  permanent: boolean;
}

export interface RawResendWebhook {
  rawBody: string | Uint8Array;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

export interface InboundMailNotification {
  provider: "resend";
  emailId: string;
  createdAt: string;
  from: string;
  to: string[];
  subject: string;
  messageId: string;
}

export type OutboundMailDeliveryStatus = "delivered" | "bounced" | "failed";

export interface OutboundMailDeliveryNotification {
  provider: "resend";
  projectId: string;
  emailId: string;
  occurredAt: string;
  deliveryStatus: OutboundMailDeliveryStatus;
  permanent: boolean;
}

export type MailWebhookNotification =
  InboundMailNotification | OutboundMailDeliveryNotification;

export type InboundSenderAuthentication =
  | {
      method: "aligned_dkim";
      result: "pass";
      signingDomain: string;
    }
  | {
      method: "aligned_dkim";
      result: "fail";
    };

export interface InboundMailAttachment {
  id: string;
  filename: string | null;
  size: number;
  contentType: string;
  contentId: string | null;
  contentDisposition: string | null;
}

export interface InboundMail {
  provider: "resend";
  emailId: string;
  createdAt: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  messageId: string;
  attachments: InboundMailAttachment[];
  senderAuthentication: InboundSenderAuthentication;
  headers?: Readonly<Record<string, string>>;
  text: string | null;
  html: string | null;
}

export interface MailPort {
  /**
   * Performs a read-only authenticated Resend domain/capability probe.
   */
  health(signal?: AbortSignal): Promise<void>;
  send(request: SendMailRequest): Promise<SentMail>;
  /**
   * Reconciles webhook loss against Resend's authoritative sent-email state.
   */
  retrieveOutboundDelivery(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OutboundMailProviderState>;
  /**
   * Verifies the Svix signature over the untouched payload. Valid provider
   * events outside inbound mail and terminal outbound delivery return `null`.
   */
  parseWebhook(webhook: RawResendWebhook): MailWebhookNotification | null;
  retrieveInboundEmail(emailId: string): Promise<InboundMail>;
}
