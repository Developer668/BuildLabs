import { Resend } from "resend";
import type {
  CreateEmailOptions,
  CreateEmailRequestOptions,
  CreateEmailResponse,
  GetEmailResponse,
  GetEmailResponseSuccess,
  GetReceivingEmailOptions,
  GetReceivingEmailResponse,
  WebhookEventPayload,
} from "resend";
import { authenticate, type AuthenticateResult } from "mailauth";
import { z } from "zod";

import type {
  InboundMail,
  InboundSenderAuthentication,
  MailWebhookNotification,
  MailPort,
  OutboundMailDeliveryNotification,
  OutboundMailProviderState,
  RawResendWebhook,
  SendMailRequest,
  SentMail,
} from "../../ports/mail.js";
import { ProviderAdapterError } from "./provider-error.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_BODY_BYTES = 5 * 1_024 * 1_024;
const MAX_RAW_EMAIL_BYTES = 10 * 1_024 * 1_024;
const MAX_WEBHOOK_BODY_BYTES = 2 * 1_024 * 1_024;
const MAX_INBOUND_HEADERS = 500;
const MAX_INBOUND_HEADER_BYTES = 8_192;
const RAW_EMAIL_TIMEOUT_MILLISECONDS = 15_000;
const RAW_EMAIL_MINIMUM_VALIDITY_MILLISECONDS = 30_000;
const RESEND_API_ORIGIN = "https://api.resend.com";
const HEALTH_TIMEOUT_MILLISECONDS = 10_000;
const API_REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const MAX_HEALTH_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const RETAINED_INBOUND_HEADERS = new Set([
  "in-reply-to",
  "message-id",
  "references",
]);
const BLOCKED_CUSTOM_HEADERS = new Set([
  "bcc",
  "cc",
  "content-length",
  "content-type",
  "from",
  "reply-to",
  "subject",
  "to",
]);
const HealthDomainSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum([
      "pending",
      "verified",
      "failed",
      "not_started",
      "partially_verified",
      "partially_failed",
    ]),
    capabilities: z
      .object({
        sending: z.enum(["enabled", "disabled"]),
        receiving: z.enum(["enabled", "disabled"]),
      })
      .passthrough(),
  })
  .passthrough();
const HealthWebhookSchema = z
  .object({
    endpoint: z.url(),
    status: z.enum(["enabled", "disabled"]),
    events: z.array(z.string()).nullable(),
  })
  .passthrough();

function healthListSchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      object: z.literal("list"),
      data: z.array(item).max(1_000),
    })
    .passthrough();
}

export interface ResendMailClient {
  domains: Pick<Resend["domains"], "list">;
  emails: {
    send(
      payload: CreateEmailOptions,
      options?: CreateEmailRequestOptions,
    ): Promise<CreateEmailResponse>;
    get(id: string): Promise<GetEmailResponse>;
    receiving: {
      get(
        id: string,
        options?: GetReceivingEmailOptions,
      ): Promise<GetReceivingEmailResponse>;
    };
  };
  webhooks: Pick<Resend["webhooks"], "list" | "verify">;
}

export interface ResendMailAdapterOptions {
  apiKey: string;
  webhookSecret: string;
  client?: ResendMailClient;
  healthFetch?: typeof fetch;
  rawEmailFetcher?: RawEmailFetcher;
  rawEmailAuthenticator?: RawEmailAuthenticator;
  now?: () => Date;
  sendingDomain?: string;
  receivingDomain?: string;
  webhookEndpointUrl?: string;
  requestTimeoutMilliseconds?: number;
}

export type RawEmailFetcher = (url: string) => Promise<Uint8Array>;
export type RawEmailAuthenticator = (
  rawEmail: Uint8Array,
  senderEmail: string,
) => Promise<InboundSenderAuthentication>;

export class ResendMailAdapter implements MailPort {
  readonly #client: ResendMailClient;
  readonly #apiKey: string;
  readonly #healthFetch: typeof fetch;
  readonly #webhookSecret: string;
  readonly #rawEmailFetcher: RawEmailFetcher;
  readonly #rawEmailAuthenticator: RawEmailAuthenticator;
  readonly #now: () => Date;
  readonly #sendingDomain: string | undefined;
  readonly #receivingDomain: string | undefined;
  readonly #webhookEndpointUrl: string | undefined;
  readonly #requestTimeoutMilliseconds: number;

  constructor(options: ResendMailAdapterOptions) {
    assertSecret(options.apiKey);
    assertSecret(options.webhookSecret);
    this.#apiKey = options.apiKey;
    this.#healthFetch = options.healthFetch ?? globalThis.fetch;
    this.#webhookSecret = options.webhookSecret;
    this.#rawEmailFetcher = options.rawEmailFetcher ?? fetchRawEmail;
    this.#rawEmailAuthenticator =
      options.rawEmailAuthenticator ?? authenticateRawSender;
    this.#now = options.now ?? (() => new Date());
    this.#sendingDomain = optionalDomain(options.sendingDomain);
    this.#receivingDomain = optionalDomain(options.receivingDomain);
    this.#webhookEndpointUrl = optionalHttpsUrl(options.webhookEndpointUrl);
    this.#requestTimeoutMilliseconds = boundedInteger(
      options.requestTimeoutMilliseconds ?? API_REQUEST_TIMEOUT_MILLISECONDS,
      1,
      300_000,
      "requestTimeoutMilliseconds",
    );
    this.#client =
      options.client ??
      new Resend(options.apiKey, {
        baseUrl: RESEND_API_ORIGIN,
      });
  }

  async health(signal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(HEALTH_TIMEOUT_MILLISECONDS);
    const healthSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let domains: z.infer<typeof HealthDomainSchema>[];
    let webhooks: z.infer<typeof HealthWebhookSchema>[] | undefined;
    try {
      [domains, webhooks] = await Promise.all([
        this.#healthList("/domains", HealthDomainSchema, healthSignal),
        this.#webhookEndpointUrl
          ? this.#healthList("/webhooks", HealthWebhookSchema, healthSignal)
          : Promise.resolve(undefined),
      ]);
    } catch {
      throw new ProviderAdapterError("resend", "health", "PROVIDER_FAILURE");
    }
    if (
      this.#sendingDomain &&
      !hasEnabledDomainCapability(domains, this.#sendingDomain, "sending")
    ) {
      throw new ProviderAdapterError(
        "resend",
        "health_sending_domain",
        "POLICY_BLOCKED",
      );
    }
    if (
      this.#receivingDomain &&
      !hasEnabledDomainCapability(domains, this.#receivingDomain, "receiving")
    ) {
      throw new ProviderAdapterError(
        "resend",
        "health_receiving_domain",
        "POLICY_BLOCKED",
      );
    }
    if (
      this.#webhookEndpointUrl &&
      (!webhooks ||
        !webhooks.some(
          (webhook) =>
            webhook.endpoint === this.#webhookEndpointUrl &&
            webhook.status === "enabled" &&
            resendWebhookEventsEnabled(webhook.events),
        ))
    ) {
      throw new ProviderAdapterError(
        "resend",
        "health_webhook_endpoint",
        "POLICY_BLOCKED",
      );
    }
  }

  async #healthList<T extends z.ZodType>(
    path: string,
    itemSchema: T,
    signal: AbortSignal,
  ): Promise<z.infer<T>[]> {
    const response = await abortable(
      this.#healthFetch(new URL(path, RESEND_API_ORIGIN), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal,
      }),
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderAdapterError("resend", "health", "PROVIDER_FAILURE");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_HEALTH_RESPONSE_BYTES
    ) {
      await response.body?.cancel();
      throw new ProviderAdapterError(
        "resend",
        "health",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    const body = await abortable(response.text(), signal);
    if (Buffer.byteLength(body) > MAX_HEALTH_RESPONSE_BYTES) {
      throw new ProviderAdapterError(
        "resend",
        "health",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ProviderAdapterError(
        "resend",
        "health",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    const result = healthListSchema(itemSchema).safeParse(parsed);
    if (!result.success) {
      throw new ProviderAdapterError(
        "resend",
        "health",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return result.data.data;
  }

  async send(request: SendMailRequest): Promise<SentMail> {
    const normalized = validateSendRequest(request);
    const payload: CreateEmailOptions = {
      from: normalized.from,
      to: normalized.to,
      subject: normalized.subject,
      replyTo: normalized.replyTo,
      text: normalized.text,
      html: normalized.html,
      tags: normalized.tags,
      ...(normalized.headers ? { headers: normalized.headers } : {}),
    };

    let response: CreateEmailResponse;
    try {
      response = await withProviderDeadline(
        this.#client.emails.send(payload, {
          idempotencyKey: normalized.idempotencyKey,
        }),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new ProviderAdapterError(
        "resend",
        "send_email",
        "PROVIDER_FAILURE",
      );
    }
    if (
      response.error !== null ||
      response.data === null ||
      !isNonEmptyString(response.data.id)
    ) {
      throw new ProviderAdapterError(
        "resend",
        "send_email",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return {
      provider: "resend",
      messageId: response.data.id,
    };
  }

  async retrieveOutboundDelivery(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<OutboundMailProviderState> {
    assertOpaqueId(messageId);
    let response: GetEmailResponse;
    try {
      response = await withProviderDeadline(
        this.#client.emails.get(messageId),
        this.#requestTimeoutMilliseconds,
        signal,
      );
    } catch {
      throw new ProviderAdapterError(
        "resend",
        "retrieve_outbound_delivery",
        "PROVIDER_FAILURE",
      );
    }
    if (
      response.error !== null ||
      response.data === null ||
      response.data.id !== messageId
    ) {
      throw new ProviderAdapterError(
        "resend",
        "retrieve_outbound_delivery",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return {
      provider: "resend",
      messageId,
      ...mapRetrievedDeliveryStatus(response.data.last_event),
      verifiedAt: this.#now().toISOString(),
    };
  }

  parseWebhook(webhook: RawResendWebhook): MailWebhookNotification | null {
    if (
      !isNonEmptyString(webhook.svixId) ||
      !isNonEmptyString(webhook.svixTimestamp) ||
      !isNonEmptyString(webhook.svixSignature)
    ) {
      throw new ProviderAdapterError(
        "resend",
        "verify_webhook",
        "INVALID_WEBHOOK",
      );
    }
    const payload =
      typeof webhook.rawBody === "string"
        ? webhook.rawBody
        : Buffer.from(webhook.rawBody).toString("utf8");
    if (
      Buffer.byteLength(payload) === 0 ||
      Buffer.byteLength(payload) > MAX_WEBHOOK_BODY_BYTES
    ) {
      throw new ProviderAdapterError(
        "resend",
        "verify_webhook",
        "INVALID_WEBHOOK",
      );
    }

    let event: WebhookEventPayload;
    try {
      event = this.#client.webhooks.verify({
        payload,
        headers: {
          id: webhook.svixId,
          timestamp: webhook.svixTimestamp,
          signature: webhook.svixSignature,
        },
        webhookSecret: this.#webhookSecret,
      });
    } catch {
      throw new ProviderAdapterError(
        "resend",
        "verify_webhook",
        "INVALID_WEBHOOK",
      );
    }

    if (
      event.type === "email.delivered" ||
      event.type === "email.bounced" ||
      event.type === "email.failed" ||
      event.type === "email.suppressed"
    ) {
      return mapOutboundDeliveryEvent(event);
    }
    if (event.type !== "email.received") {
      return null;
    }
    const data = event.data;
    if (
      !isNonEmptyString(data.email_id) ||
      !isNonEmptyString(data.created_at) ||
      !isNonEmptyString(data.from) ||
      !isNonEmptyStringArray(data.to) ||
      !isNonEmptyString(data.subject) ||
      !isNonEmptyString(data.message_id)
    ) {
      throw new ProviderAdapterError(
        "resend",
        "parse_webhook",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return {
      provider: "resend",
      emailId: data.email_id,
      createdAt: assertIsoDate(data.created_at),
      from: data.from,
      to: [...data.to],
      subject: data.subject,
      messageId: data.message_id,
    };
  }

  async retrieveInboundEmail(emailId: string): Promise<InboundMail> {
    assertOpaqueId(emailId);
    let response: GetReceivingEmailResponse;
    try {
      // CID form avoids embedding large base64 images into the HTML body.
      response = await withProviderDeadline(
        this.#client.emails.receiving.get(emailId, {
          html_format: "cid",
        }),
        this.#requestTimeoutMilliseconds,
      );
    } catch {
      throw new ProviderAdapterError(
        "resend",
        "retrieve_inbound_email",
        "PROVIDER_FAILURE",
      );
    }
    if (response.error !== null || response.data === null) {
      throw new ProviderAdapterError(
        "resend",
        "retrieve_inbound_email",
        "INVALID_PROVIDER_RESPONSE",
      );
    }

    const email = response.data;
    if (
      email.id !== emailId ||
      !isNonEmptyString(email.from) ||
      !isNonEmptyStringArray(email.to) ||
      !isNonEmptyString(email.subject) ||
      !isNonEmptyString(email.message_id) ||
      !isNonEmptyString(email.created_at) ||
      !isValidInboundAttachments(email.attachments) ||
      (email.text === null && email.html === null) ||
      (email.text !== null && Buffer.byteLength(email.text) > MAX_BODY_BYTES) ||
      (email.html !== null && Buffer.byteLength(email.html) > MAX_BODY_BYTES) ||
      email.raw === null ||
      email.raw === undefined ||
      !isNonEmptyString(email.raw.download_url) ||
      !isNonEmptyString(email.raw.expires_at)
    ) {
      throw new ProviderAdapterError(
        "resend",
        "retrieve_inbound_email",
        "INVALID_PROVIDER_RESPONSE",
      );
    }

    const senderAuthentication = await this.#authenticateInboundSender(
      email.raw,
      email.from,
    );
    const headers = normalizeInboundHeaders(email.headers);
    return {
      provider: "resend",
      emailId: email.id,
      createdAt: assertIsoDate(email.created_at),
      from: email.from,
      to: [...email.to],
      cc: email.cc ? [...email.cc] : [],
      bcc: email.bcc ? [...email.bcc] : [],
      replyTo: email.reply_to ? [...email.reply_to] : [],
      subject: email.subject,
      messageId: email.message_id,
      attachments: email.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type,
        contentId: attachment.content_id,
        contentDisposition: attachment.content_disposition,
      })),
      senderAuthentication,
      ...(headers ? { headers } : {}),
      text: email.text,
      html: email.html,
    };
  }

  async #authenticateInboundSender(
    raw: { download_url: string; expires_at: string },
    senderEmail: string,
  ): Promise<InboundSenderAuthentication> {
    const expiresAt = new Date(raw.expires_at);
    const now = this.#now();
    if (
      Number.isNaN(expiresAt.getTime()) ||
      Number.isNaN(now.getTime()) ||
      expiresAt.getTime() - now.getTime() <
        RAW_EMAIL_MINIMUM_VALIDITY_MILLISECONDS
    ) {
      throw new ProviderAdapterError(
        "resend",
        "authenticate_inbound_sender",
        "INVALID_PROVIDER_RESPONSE",
      );
    }

    let rawEmail: Uint8Array;
    try {
      rawEmail = await this.#rawEmailFetcher(raw.download_url);
    } catch (error) {
      if (error instanceof ProviderAdapterError) {
        throw error;
      }
      throw new ProviderAdapterError(
        "resend",
        "download_raw_email",
        "PROVIDER_FAILURE",
      );
    }
    if (
      rawEmail.byteLength === 0 ||
      rawEmail.byteLength > MAX_RAW_EMAIL_BYTES
    ) {
      throw new ProviderAdapterError(
        "resend",
        "download_raw_email",
        "INVALID_PROVIDER_RESPONSE",
      );
    }

    try {
      return await this.#rawEmailAuthenticator(rawEmail, senderEmail);
    } catch (error) {
      if (error instanceof ProviderAdapterError) {
        throw error;
      }
      throw new ProviderAdapterError(
        "resend",
        "authenticate_inbound_sender",
        "PROVIDER_FAILURE",
      );
    }
  }
}

function mapRetrievedDeliveryStatus(
  lastEvent: GetEmailResponseSuccess["last_event"],
): Pick<OutboundMailProviderState, "status" | "permanent"> {
  if (
    lastEvent === "delivered" ||
    lastEvent === "opened" ||
    lastEvent === "clicked" ||
    lastEvent === "complained"
  ) {
    return { status: "delivered", permanent: false };
  }
  if (lastEvent === "bounced") {
    return { status: "bounced", permanent: true };
  }
  if (
    lastEvent === "failed" ||
    lastEvent === "suppressed" ||
    lastEvent === "canceled"
  ) {
    return { status: "failed", permanent: true };
  }
  return { status: "pending", permanent: false };
}

async function withProviderDeadline<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Provider request aborted");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Provider request timed out")),
      timeoutMilliseconds,
    );
    timer.unref();
    if (signal) {
      abort = () => reject(new Error("Provider request aborted"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}

async function fetchRawEmail(downloadUrl: string): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    throw new ProviderAdapterError(
      "resend",
      "download_raw_email",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  if (
    downloadUrl.length > 8_192 ||
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== "443") ||
    !isResendRawEmailHost(url.hostname)
  ) {
    throw new ProviderAdapterError(
      "resend",
      "download_raw_email",
      "POLICY_BLOCKED",
    );
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(RAW_EMAIL_TIMEOUT_MILLISECONDS),
    headers: { Accept: "message/rfc822, application/octet-stream" },
  });
  if (!response.ok || response.body === null) {
    throw new ProviderAdapterError(
      "resend",
      "download_raw_email",
      "PROVIDER_FAILURE",
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength <= 0 ||
      parsedLength > MAX_RAW_EMAIL_BYTES
    ) {
      throw new ProviderAdapterError(
        "resend",
        "download_raw_email",
        "POLICY_BLOCKED",
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = response.body.getReader();
  for (;;) {
    const result: unknown = await reader.read();
    if (!isRawEmailReadResult(result)) {
      await reader.cancel();
      throw new ProviderAdapterError(
        "resend",
        "download_raw_email",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    if (result.done) {
      break;
    }
    byteLength += result.value.byteLength;
    if (byteLength > MAX_RAW_EMAIL_BYTES) {
      await reader.cancel();
      throw new ProviderAdapterError(
        "resend",
        "download_raw_email",
        "POLICY_BLOCKED",
      );
    }
    chunks.push(result.value);
  }
  if (byteLength === 0) {
    throw new ProviderAdapterError(
      "resend",
      "download_raw_email",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    byteLength,
  );
}

function isRawEmailReadResult(
  value: unknown,
): value is
  { done: true; value?: undefined } | { done: false; value: Uint8Array } {
  if (typeof value !== "object" || value === null || !("done" in value)) {
    return false;
  }
  if (value.done === true) {
    return true;
  }
  return (
    value.done === false &&
    "value" in value &&
    value.value instanceof Uint8Array
  );
}

function isResendRawEmailHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return ["resend.com", "cloudfront.net", "amazonaws.com"].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

async function authenticateRawSender(
  rawEmail: Uint8Array,
  senderEmail: string,
): Promise<InboundSenderAuthentication> {
  let result: AuthenticateResult;
  try {
    result = await withAuthenticationTimeout(
      authenticate(Buffer.from(rawEmail), {
        disableArc: true,
        disableBimi: true,
        disableDmarc: true,
        minBitLength: 1_024,
      }),
    );
  } catch {
    throw new ProviderAdapterError(
      "resend",
      "authenticate_inbound_sender",
      "PROVIDER_FAILURE",
    );
  }

  return senderAuthenticationFromDkim(result, senderEmail);
}

export function senderAuthenticationFromDkim(
  result: Pick<AuthenticateResult, "dkim">,
  senderEmail: string,
): InboundSenderAuthentication {
  const expectedMailbox = normalizeMailbox(senderEmail);
  if (
    result.dkim.headerFrom.length !== 1 ||
    normalizeMailbox(result.dkim.headerFrom[0] ?? "") !== expectedMailbox
  ) {
    return { method: "aligned_dkim", result: "fail" };
  }
  const alignedPass = result.dkim.results.find(
    (candidate) =>
      candidate.status.result === "pass" &&
      Boolean(candidate.status.aligned) &&
      candidate.status.underSized !== true,
  );
  if (alignedPass) {
    return {
      method: "aligned_dkim",
      result: "pass",
      signingDomain: alignedPass.signingDomain.toLowerCase().replace(/\.$/, ""),
    };
  }
  if (
    result.dkim.results.some(
      (candidate) =>
        candidate.status.result === "temperr" ||
        candidate.status.result === "temperror",
    )
  ) {
    throw new ProviderAdapterError(
      "resend",
      "authenticate_inbound_sender",
      "PROVIDER_FAILURE",
    );
  }
  return { method: "aligned_dkim", result: "fail" };
}

async function withAuthenticationTimeout(
  operation: Promise<AuthenticateResult>,
): Promise<AuthenticateResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Inbound email authentication timed out")),
      RAW_EMAIL_TIMEOUT_MILLISECONDS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function normalizeMailbox(value: string): string {
  const trimmed = value.trim();
  const displayMatch = /<([^<>]+)>$/.exec(trimmed);
  const mailbox = (displayMatch?.[1] ?? trimmed).trim().toLowerCase();
  const at = mailbox.lastIndexOf("@");
  if (
    mailbox.length > 320 ||
    at <= 0 ||
    at === mailbox.length - 1 ||
    /\s/.test(mailbox) ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(mailbox.slice(at + 1))
  ) {
    throw new ProviderAdapterError(
      "resend",
      "authenticate_inbound_sender",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return mailbox;
}

function mapOutboundDeliveryEvent(
  event: Extract<
    WebhookEventPayload,
    {
      type:
        | "email.delivered"
        | "email.bounced"
        | "email.failed"
        | "email.suppressed";
    }
  >,
): OutboundMailDeliveryNotification | null {
  const projectId = event.data.tags?.project;
  if (projectId === undefined) {
    return null;
  }
  if (
    !isOpaqueProviderId(projectId) ||
    !isOpaqueProviderId(event.data.email_id) ||
    !isNonEmptyString(event.created_at) ||
    (event.type === "email.bounced" &&
      !isNonEmptyString(event.data.bounce?.type))
  ) {
    throw new ProviderAdapterError(
      "resend",
      "parse_webhook",
      "INVALID_PROVIDER_RESPONSE",
    );
  }

  if (event.type === "email.delivered") {
    return {
      provider: "resend",
      projectId,
      emailId: event.data.email_id,
      occurredAt: assertIsoDate(event.created_at),
      deliveryStatus: "delivered",
      permanent: false,
    };
  }
  if (event.type === "email.bounced") {
    return {
      provider: "resend",
      projectId,
      emailId: event.data.email_id,
      occurredAt: assertIsoDate(event.created_at),
      deliveryStatus: "bounced",
      permanent: event.data.bounce.type.toLowerCase() === "permanent",
    };
  }
  return {
    provider: "resend",
    projectId,
    emailId: event.data.email_id,
    occurredAt: assertIsoDate(event.created_at),
    deliveryStatus: "failed",
    permanent: true,
  };
}

interface NormalizedSendMailRequest {
  from: string;
  to: string[];
  subject: string;
  replyTo: string[];
  text: string;
  html: string;
  tags: { name: string; value: string }[];
  idempotencyKey: string;
  headers?: Record<string, string>;
}

function validateSendRequest(
  request: SendMailRequest,
): NormalizedSendMailRequest {
  const from = assertHeaderText(request.from);
  const to = normalizeAddressList(request.to);
  const replyTo = normalizeAddressList(request.replyTo);
  const subject = assertHeaderText(request.subject);
  if (
    Buffer.byteLength(request.text) > MAX_BODY_BYTES ||
    Buffer.byteLength(request.html) > MAX_BODY_BYTES ||
    request.text.trim().length === 0 ||
    request.html.trim().length === 0
  ) {
    throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
  }
  const idempotencyKey = request.idempotencyKey.trim();
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[\r\n]/.test(idempotencyKey)
  ) {
    throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
  }
  if (request.tags.length > 10) {
    throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
  }
  const tags = request.tags.map((tag) => {
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(tag.name) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(tag.value)
    ) {
      throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
    }
    return { name: tag.name, value: tag.value };
  });

  let headers: Record<string, string> | undefined;
  if (request.headers) {
    headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lowerName = name.toLowerCase();
      if (
        !/^[A-Za-z0-9-]{1,128}$/.test(name) ||
        BLOCKED_CUSTOM_HEADERS.has(lowerName) ||
        value.length > 8_192 ||
        /[\r\n]/.test(value) ||
        (["message-id", "in-reply-to"].includes(lowerName) &&
          !isSafeRfcMessageId(value)) ||
        (lowerName === "references" && !isSafeRfcReferences(value))
      ) {
        throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
      }
      headers[name] = value;
    }
  }

  return {
    from,
    to,
    subject,
    replyTo,
    text: request.text,
    html: request.html,
    tags,
    idempotencyKey,
    ...(headers ? { headers } : {}),
  };
}

function isSafeRfcMessageId(value: string): boolean {
  return (
    value.length <= 998 &&
    /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value)
  );
}

function isSafeRfcReferences(value: string): boolean {
  const references = value.trim().split(/[ \t]+/);
  return (
    references.length > 0 &&
    references.length <= 500 &&
    references.every(isSafeRfcMessageId)
  );
}

function normalizeAddressList(value: string | readonly string[]): string[] {
  const list = typeof value === "string" ? [value] : [...value];
  if (
    list.length === 0 ||
    list.length > 50 ||
    list.some((address) => !isNonEmptyString(address) || /[\r\n]/.test(address))
  ) {
    throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
  }
  return list.map((address) => address.trim());
}

function assertHeaderText(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 998 ||
    /[\r\n]/.test(normalized)
  ) {
    throw new ProviderAdapterError("resend", "send_email", "INVALID_INPUT");
  }
  return normalized;
}

function assertOpaqueId(value: string): void {
  if (!isOpaqueProviderId(value)) {
    throw new ProviderAdapterError(
      "resend",
      "retrieve_inbound_email",
      "INVALID_INPUT",
    );
  }
}

function isOpaqueProviderId(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function assertSecret(value: string): void {
  if (!isNonEmptyString(value) || /[\r\n]/.test(value)) {
    throw new ProviderAdapterError("resend", "configuration", "INVALID_INPUT");
  }
}

function assertIsoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ProviderAdapterError(
      "resend",
      "map_timestamp",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return date.toISOString();
}

function normalizeInboundHeaders(
  headers: Record<string, string> | null,
): Record<string, string> | undefined {
  if (headers === null) {
    return undefined;
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_INBOUND_HEADERS) {
    throw new ProviderAdapterError(
      "resend",
      "map_inbound_headers",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const retained: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = rawName.trim().toLowerCase();
    if (
      typeof value !== "string" ||
      Buffer.byteLength(rawName) > 256 ||
      Buffer.byteLength(value) > MAX_INBOUND_HEADER_BYTES ||
      /[\r\n\0]/.test(rawName) ||
      /[\r\n\0]/.test(value)
    ) {
      throw new ProviderAdapterError(
        "resend",
        "map_inbound_headers",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    if (!RETAINED_INBOUND_HEADERS.has(name)) {
      continue;
    }
    if (retained[name] !== undefined && retained[name] !== value) {
      throw new ProviderAdapterError(
        "resend",
        "map_inbound_headers",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    retained[name] = value;
  }
  return Object.keys(retained).length > 0 ? retained : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalDomain(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    normalized.length < 4 ||
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  ) {
    throw new ProviderAdapterError("resend", "configuration", "INVALID_INPUT");
  }
  return normalized;
}

function hasEnabledDomainCapability(
  domains: readonly z.infer<typeof HealthDomainSchema>[],
  expectedDomain: string,
  capability: "receiving" | "sending",
): boolean {
  return domains.some(
    (domain) =>
      domain.name.toLowerCase().replace(/\.$/, "") === expectedDomain &&
      domain.capabilities[capability] === "enabled" &&
      (domain.status === "verified" || domain.status === "partially_verified"),
  );
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new ProviderAdapterError("resend", "health", "PROVIDER_FAILURE");
  }
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => {
      reject(new ProviderAdapterError("resend", "health", "PROVIDER_FAILURE"));
    };
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (rejectOnAbort) {
      signal.removeEventListener("abort", rejectOnAbort);
    }
  }
}

function optionalHttpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderAdapterError("resend", "configuration", "INVALID_INPUT");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ProviderAdapterError("resend", "configuration", "INVALID_INPUT");
  }
  return url.toString();
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

function resendWebhookEventsEnabled(events: readonly string[] | null): boolean {
  if (events === null) {
    return true;
  }
  const enabled = new Set(events);
  return [
    "email.received",
    "email.delivered",
    "email.bounced",
    "email.failed",
    "email.suppressed",
  ].every((event) => enabled.has(event));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function isValidInboundAttachments(attachments: unknown): attachments is Array<{
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_id: string | null;
  content_disposition: string | null;
}> {
  return (
    Array.isArray(attachments) &&
    attachments.length <= 100 &&
    attachments.every(isValidInboundAttachment)
  );
}

function isValidInboundAttachment(attachment: unknown): attachment is {
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_id: string | null;
  content_disposition: string | null;
} {
  if (typeof attachment !== "object" || attachment === null) {
    return false;
  }
  const candidate = attachment as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    candidate.id.length <= 256 &&
    (candidate.filename === null ||
      (isNonEmptyString(candidate.filename) &&
        candidate.filename.length <= 1_024)) &&
    typeof candidate.size === "number" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    isNonEmptyString(candidate.content_type) &&
    candidate.content_type.length <= 256 &&
    (candidate.content_id === null ||
      (isNonEmptyString(candidate.content_id) &&
        candidate.content_id.length <= 998)) &&
    (candidate.content_disposition === null ||
      (isNonEmptyString(candidate.content_disposition) &&
        candidate.content_disposition.length <= 256))
  );
}
