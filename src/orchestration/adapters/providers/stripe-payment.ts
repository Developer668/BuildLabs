import Stripe from "stripe";

import type {
  CheckoutSession,
  CreateCheckoutSessionRequest,
  PaidCheckoutWebhook,
  PaymentPort,
  RawStripeWebhook,
  VerifiedSettlement,
  VerifySettlementRequest,
} from "../../ports/payment.js";
import { ProviderAdapterError } from "./provider-error.js";

const STRIPE_API_VERSION = "2026-06-24.dahlia";
const MAX_METADATA_VALUE_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_WEBHOOK_BODY_BYTES = 2 * 1_024 * 1_024;

export const STRIPE_PROPOSAL_METADATA = {
  projectId: "projectId",
  proposalId: "proposalId",
  proposalVersion: "proposalVersion",
  proposalDigest: "proposalDigest",
} as const;

export interface StripePaymentClient {
  checkout: {
    sessions: Pick<
      Stripe["checkout"]["sessions"],
      "create" | "expire" | "list" | "retrieve"
    >;
  };
  paymentIntents: Pick<Stripe["paymentIntents"], "retrieve">;
  webhookEndpoints: Pick<Stripe["webhookEndpoints"], "list">;
  webhooks: Pick<Stripe["webhooks"], "constructEvent">;
}

export interface StripePaymentAdapterOptions {
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  productName?: string;
  expectedLivemode?: boolean;
  webhookEndpointUrl?: string;
  client?: StripePaymentClient;
}

export class StripePaymentAdapter implements PaymentPort {
  readonly #client: StripePaymentClient;
  readonly #webhookSecret: string;
  readonly #successUrl: string;
  readonly #cancelUrl: string;
  readonly #productName: string;
  readonly #expectedLivemode: boolean | undefined;
  readonly #webhookEndpointUrl: string | undefined;

  constructor(options: StripePaymentAdapterOptions) {
    assertSecret(options.secretKey);
    assertSecret(options.webhookSecret);
    this.#successUrl = assertRedirectUrl(options.successUrl);
    this.#cancelUrl = assertRedirectUrl(options.cancelUrl);
    this.#productName =
      options.productName?.trim() || "Buildlapse software engagement";
    this.#expectedLivemode =
      options.expectedLivemode ?? inferLivemode(options.secretKey);
    this.#webhookEndpointUrl = options.webhookEndpointUrl
      ? assertRedirectUrl(options.webhookEndpointUrl)
      : undefined;
    if (this.#productName.length > 250) {
      throw new ProviderAdapterError(
        "stripe",
        "configuration",
        "INVALID_INPUT",
      );
    }
    this.#webhookSecret = options.webhookSecret;
    this.#client =
      options.client ??
      new Stripe(options.secretKey, {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 20_000,
        telemetry: false,
      });
  }

  async health(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let page: Awaited<
      ReturnType<StripePaymentClient["checkout"]["sessions"]["list"]>
    >;
    let webhookPage:
      | Awaited<ReturnType<StripePaymentClient["webhookEndpoints"]["list"]>>
      | undefined;
    try {
      [page, webhookPage] = await Promise.all([
        this.#client.checkout.sessions.list(
          { limit: 1 },
          { maxNetworkRetries: 0, timeout: 10_000 },
        ),
        this.#webhookEndpointUrl
          ? this.#client.webhookEndpoints.list(
              { limit: 100 },
              { maxNetworkRetries: 0, timeout: 10_000 },
            )
          : Promise.resolve(undefined),
      ]);
    } catch {
      throw new ProviderAdapterError("stripe", "health", "PROVIDER_FAILURE");
    }
    throwIfAborted(signal);
    if (
      page.object !== "list" ||
      !Array.isArray(page.data) ||
      page.data.some(
        (session) =>
          session.object !== "checkout.session" ||
          (this.#expectedLivemode !== undefined &&
            session.livemode !== this.#expectedLivemode),
      )
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "health",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    if (
      this.#webhookEndpointUrl &&
      (!webhookPage ||
        webhookPage.object !== "list" ||
        !Array.isArray(webhookPage.data) ||
        !webhookPage.data.some(
          (endpoint) =>
            endpoint.object === "webhook_endpoint" &&
            endpoint.url === this.#webhookEndpointUrl &&
            endpoint.status === "enabled" &&
            endpoint.application === null &&
            (this.#expectedLivemode === undefined ||
              endpoint.livemode === this.#expectedLivemode) &&
            webhookEventsEnabled(endpoint.enabled_events),
        ))
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "health_webhook_endpoint",
        "POLICY_BLOCKED",
      );
    }
  }

  async createCheckoutSession(
    request: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession> {
    const normalized = validateCreateRequest(request);
    const metadata = {
      [STRIPE_PROPOSAL_METADATA.projectId]: normalized.projectId,
      [STRIPE_PROPOSAL_METADATA.proposalId]: normalized.proposalId,
      [STRIPE_PROPOSAL_METADATA.proposalVersion]: String(
        normalized.proposalVersion,
      ),
      [STRIPE_PROPOSAL_METADATA.proposalDigest]: normalized.proposalDigest,
    };

    let session: Stripe.Checkout.Session;
    try {
      session = await this.#client.checkout.sessions.create(
        {
          mode: "payment",
          submit_type: "pay",
          customer_email: normalized.customerEmail,
          client_reference_id: normalized.projectId,
          success_url: this.#successUrl,
          cancel_url: this.#cancelUrl,
          metadata,
          payment_intent_data: {
            metadata,
            receipt_email: normalized.customerEmail,
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: normalized.currency,
                unit_amount: normalized.amountMinor,
                product_data: {
                  name: this.#productName,
                  metadata,
                },
              },
            },
          ],
        },
        { idempotencyKey: normalized.idempotencyKey },
      );
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "create_checkout_session",
        "PROVIDER_FAILURE",
      );
    }

    const checkout = toCheckoutSession(session, this.#expectedLivemode);
    if (checkout.url === null) {
      throw new ProviderAdapterError(
        "stripe",
        "create_checkout_session",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    return checkout;
  }

  async expireCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    assertOpaqueId(sessionId);
    let session: Stripe.Checkout.Session;
    try {
      session = await this.#client.checkout.sessions.expire(sessionId);
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "expire_checkout_session",
        "PROVIDER_FAILURE",
      );
    }
    return toCheckoutSession(session, this.#expectedLivemode);
  }

  parseWebhook(webhook: RawStripeWebhook): PaidCheckoutWebhook | null {
    if (
      !webhook.signature ||
      rawBodyLength(webhook.rawBody) > MAX_WEBHOOK_BODY_BYTES ||
      (typeof webhook.rawBody === "string" &&
        Buffer.byteLength(webhook.rawBody) === 0) ||
      (typeof webhook.rawBody !== "string" && webhook.rawBody.byteLength === 0)
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "verify_webhook",
        "INVALID_WEBHOOK",
      );
    }

    let event: Stripe.Event;
    try {
      const rawBody =
        typeof webhook.rawBody === "string"
          ? webhook.rawBody
          : Buffer.from(webhook.rawBody);
      event = this.#client.webhooks.constructEvent(
        rawBody,
        webhook.signature,
        this.#webhookSecret,
      );
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "verify_webhook",
        "INVALID_WEBHOOK",
      );
    }

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return null;
    }
    const object = event.data.object;
    if (
      object.object !== "checkout.session" ||
      object.payment_status !== "paid"
    ) {
      return null;
    }
    if (
      event.livemode !== object.livemode ||
      (this.#expectedLivemode !== undefined &&
        object.livemode !== this.#expectedLivemode)
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "verify_webhook_mode",
        "INVALID_WEBHOOK",
      );
    }

    return {
      provider: "stripe",
      eventId: event.id,
      createdAt: epochSecondsToIso(event.created),
      livemode: object.livemode,
      session: toCheckoutSession(object, this.#expectedLivemode),
    };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    assertOpaqueId(sessionId);
    let session: Stripe.Checkout.Session;
    try {
      session = await this.#client.checkout.sessions.retrieve(sessionId);
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "retrieve_checkout_session",
        "PROVIDER_FAILURE",
      );
    }
    return toCheckoutSession(session, this.#expectedLivemode);
  }

  async verifySettlement(
    request: VerifySettlementRequest,
  ): Promise<VerifiedSettlement> {
    const expected = validateSettlementRequest(request);
    let session: Stripe.Checkout.Session;
    let paymentIntent: Stripe.PaymentIntent;
    try {
      [session, paymentIntent] = await Promise.all([
        this.#client.checkout.sessions.retrieve(expected.checkoutSessionId),
        this.#client.paymentIntents.retrieve(expected.paymentIntentId),
      ]);
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "verify_settlement",
        "PROVIDER_FAILURE",
      );
    }

    const checkout = toCheckoutSession(session, this.#expectedLivemode);
    const paymentIntentCustomerId = providerObjectId(
      paymentIntent.customer,
      "verify_settlement",
    );
    const receiptEmail = paymentIntent.receipt_email;
    const expectedEmail = normalizeEmail(expected.customerEmail);
    const sessionCustomerMatches =
      checkout.customerEmail !== null &&
      normalizeEmail(checkout.customerEmail) === expectedEmail;
    const receiptEmailMatches =
      receiptEmail !== null && normalizeEmail(receiptEmail) === expectedEmail;
    const customerIdMatches =
      checkout.customerId !== null &&
      paymentIntentCustomerId !== null &&
      checkout.customerId === paymentIntentCustomerId;
    const hasInvalidCustomerBinding =
      (checkout.customerId !== null || paymentIntentCustomerId !== null) &&
      !customerIdMatches;
    const metadata = paymentIntent.metadata;

    if (
      checkout.sessionId !== expected.checkoutSessionId ||
      checkout.status !== "complete" ||
      checkout.paymentStatus !== "paid" ||
      checkout.paymentIntentId !== expected.paymentIntentId ||
      checkout.projectId !== expected.projectId ||
      checkout.proposalId !== expected.proposalId ||
      checkout.proposalVersion !== expected.proposalVersion ||
      checkout.proposalDigest !== expected.proposalDigest ||
      checkout.amountMinor !== expected.amountMinor ||
      checkout.currency !== expected.currency ||
      checkout.livemode !== expected.livemode ||
      !sessionCustomerMatches ||
      paymentIntent.object !== "payment_intent" ||
      paymentIntent.id !== expected.paymentIntentId ||
      paymentIntent.status !== "succeeded" ||
      paymentIntent.amount !== expected.amountMinor ||
      paymentIntent.amount_received !== expected.amountMinor ||
      paymentIntent.currency !== expected.currency ||
      paymentIntent.livemode !== expected.livemode ||
      metadata[STRIPE_PROPOSAL_METADATA.projectId] !== expected.projectId ||
      metadata[STRIPE_PROPOSAL_METADATA.proposalId] !== expected.proposalId ||
      metadata[STRIPE_PROPOSAL_METADATA.proposalVersion] !==
        String(expected.proposalVersion) ||
      metadata[STRIPE_PROPOSAL_METADATA.proposalDigest] !==
        expected.proposalDigest ||
      (receiptEmail !== null && !receiptEmailMatches) ||
      hasInvalidCustomerBinding ||
      (!receiptEmailMatches && !customerIdMatches) ||
      !Number.isSafeInteger(paymentIntent.created) ||
      paymentIntent.created <= 0
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "verify_settlement",
        "INVALID_PROVIDER_RESPONSE",
      );
    }

    return {
      provider: "stripe",
      checkoutSessionId: checkout.sessionId,
      paymentIntentId: paymentIntent.id,
      projectId: expected.projectId,
      proposalId: expected.proposalId,
      proposalVersion: expected.proposalVersion,
      proposalDigest: expected.proposalDigest,
      amountMinor: paymentIntent.amount,
      amountReceivedMinor: paymentIntent.amount_received,
      currency: paymentIntent.currency,
      customerEmail: expected.customerEmail,
      customerId: paymentIntentCustomerId,
      livemode: paymentIntent.livemode,
      checkoutStatus: "complete",
      paymentStatus: "paid",
      paymentIntentStatus: "succeeded",
      paymentIntentCreatedAt: epochSecondsToIso(paymentIntent.created),
    };
  }
}

function validateCreateRequest(
  request: CreateCheckoutSessionRequest,
): CreateCheckoutSessionRequest {
  assertMetadataValue(request.projectId, "create_checkout_session");
  assertMetadataValue(request.proposalId, "create_checkout_session");
  assertMetadataValue(request.proposalDigest, "create_checkout_session");
  if (
    !Number.isSafeInteger(request.proposalVersion) ||
    request.proposalVersion <= 0
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "create_checkout_session",
      "INVALID_INPUT",
    );
  }
  if (!Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) {
    throw new ProviderAdapterError(
      "stripe",
      "create_checkout_session",
      "INVALID_INPUT",
    );
  }
  const currency = request.currency.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new ProviderAdapterError(
      "stripe",
      "create_checkout_session",
      "INVALID_INPUT",
    );
  }
  const customerEmail = request.customerEmail.trim();
  if (
    customerEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "create_checkout_session",
      "INVALID_INPUT",
    );
  }
  const idempotencyKey = request.idempotencyKey.trim();
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    /[\r\n]/.test(idempotencyKey)
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "create_checkout_session",
      "INVALID_INPUT",
    );
  }
  return {
    ...request,
    currency,
    customerEmail,
    idempotencyKey,
    projectId: request.projectId.trim(),
    proposalId: request.proposalId.trim(),
    proposalDigest: request.proposalDigest.trim(),
  };
}

function validateSettlementRequest(
  request: VerifySettlementRequest,
): VerifySettlementRequest {
  assertOpaqueId(request.checkoutSessionId);
  assertOpaqueId(request.paymentIntentId);
  assertMetadataValue(request.projectId, "verify_settlement");
  assertMetadataValue(request.proposalId, "verify_settlement");
  assertMetadataValue(request.proposalDigest, "verify_settlement");
  if (
    !Number.isSafeInteger(request.proposalVersion) ||
    request.proposalVersion <= 0 ||
    !Number.isSafeInteger(request.amountMinor) ||
    request.amountMinor <= 0 ||
    typeof request.livemode !== "boolean"
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "verify_settlement",
      "INVALID_INPUT",
    );
  }
  const currency = request.currency.trim().toLowerCase();
  const customerEmail = request.customerEmail.trim();
  if (
    !/^[a-z]{3}$/.test(currency) ||
    customerEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "verify_settlement",
      "INVALID_INPUT",
    );
  }
  return {
    ...request,
    checkoutSessionId: request.checkoutSessionId.trim(),
    paymentIntentId: request.paymentIntentId.trim(),
    projectId: request.projectId.trim(),
    proposalId: request.proposalId.trim(),
    proposalDigest: request.proposalDigest.trim(),
    currency,
    customerEmail,
  };
}

function assertMetadataValue(value: string, operation: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_METADATA_VALUE_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    throw new ProviderAdapterError("stripe", operation, "INVALID_INPUT");
  }
}

function assertOpaqueId(value: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 255 ||
    /[\s\r\n]/.test(value)
  ) {
    throw new ProviderAdapterError("stripe", "session_id", "INVALID_INPUT");
  }
}

function assertSecret(value: string): void {
  if (value.trim().length === 0 || /[\r\n]/.test(value)) {
    throw new ProviderAdapterError("stripe", "configuration", "INVALID_INPUT");
  }
}

function inferLivemode(secretKey: string): boolean | undefined {
  if (/^[sr]k_live_/.test(secretKey)) {
    return true;
  }
  if (/^[sr]k_test_/.test(secretKey)) {
    return false;
  }
  return undefined;
}

function assertRedirectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderAdapterError("stripe", "configuration", "INVALID_INPUT");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new ProviderAdapterError("stripe", "configuration", "INVALID_INPUT");
  }
  return url.toString();
}

function toCheckoutSession(
  session: Stripe.Checkout.Session,
  expectedLivemode?: boolean,
): CheckoutSession {
  const paymentIntentId = providerObjectId(
    session.payment_intent,
    "map_checkout_session",
  );
  const customerId = providerObjectId(session.customer, "map_checkout_session");
  if (
    session.object !== "checkout.session" ||
    session.id.trim().length === 0 ||
    typeof session.livemode !== "boolean" ||
    (expectedLivemode !== undefined && session.livemode !== expectedLivemode) ||
    session.status === null ||
    !["complete", "expired", "open"].includes(session.status) ||
    !["no_payment_required", "paid", "unpaid"].includes(
      session.payment_status,
    ) ||
    (session.amount_total !== null &&
      (!Number.isSafeInteger(session.amount_total) ||
        session.amount_total < 0)) ||
    (session.currency !== null && !/^[a-z]{3}$/.test(session.currency)) ||
    !Number.isSafeInteger(session.created) ||
    session.created <= 0 ||
    !Number.isSafeInteger(session.expires_at) ||
    session.expires_at <= 0 ||
    (session.status === "open" && session.url === null) ||
    (session.payment_status === "paid" && paymentIntentId === null)
  ) {
    throw new ProviderAdapterError(
      "stripe",
      "map_checkout_session",
      "INVALID_PROVIDER_RESPONSE",
    );
  }

  const metadata = session.metadata ?? {};
  const proposalVersion = parseMetadataVersion(
    metadata[STRIPE_PROPOSAL_METADATA.proposalVersion],
  );
  if (session.url !== null) {
    let checkoutUrl: URL;
    try {
      checkoutUrl = new URL(session.url);
    } catch {
      throw new ProviderAdapterError(
        "stripe",
        "map_checkout_session",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
    if (
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.username.length > 0 ||
      checkoutUrl.password.length > 0
    ) {
      throw new ProviderAdapterError(
        "stripe",
        "map_checkout_session",
        "INVALID_PROVIDER_RESPONSE",
      );
    }
  }
  return {
    provider: "stripe",
    sessionId: session.id,
    livemode: session.livemode,
    url: session.url,
    status: session.status,
    paymentStatus: session.payment_status,
    paymentIntentId,
    amountMinor: session.amount_total,
    currency: session.currency,
    customerEmail:
      session.customer_details?.email ?? session.customer_email ?? null,
    customerId,
    projectId: metadata[STRIPE_PROPOSAL_METADATA.projectId] ?? null,
    proposalId: metadata[STRIPE_PROPOSAL_METADATA.proposalId] ?? null,
    proposalVersion,
    proposalDigest: metadata[STRIPE_PROPOSAL_METADATA.proposalDigest] ?? null,
    createdAt: epochSecondsToIso(session.created),
    expiresAt: epochSecondsToIso(session.expires_at),
  };
}

function providerObjectId(
  value: string | { id: string } | null | undefined,
  operation: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const id = typeof value === "string" ? value : value.id;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > 255 ||
    /[\s\r\n]/.test(id)
  ) {
    throw new ProviderAdapterError(
      "stripe",
      operation,
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return id;
}

function parseMetadataVersion(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ProviderAdapterError(
      "stripe",
      "map_checkout_session",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new ProviderAdapterError(
      "stripe",
      "map_checkout_session",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return version;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function rawBodyLength(value: string | Uint8Array): number {
  return typeof value === "string"
    ? Buffer.byteLength(value)
    : value.byteLength;
}

function epochSecondsToIso(value: number): string {
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(value) || !Number.isFinite(milliseconds)) {
    throw new ProviderAdapterError(
      "stripe",
      "map_timestamp",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new ProviderAdapterError(
      "stripe",
      "map_timestamp",
      "INVALID_PROVIDER_RESPONSE",
    );
  }
  return date.toISOString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ProviderAdapterError("stripe", "health", "PROVIDER_FAILURE");
  }
}

function webhookEventsEnabled(events: readonly string[]): boolean {
  const enabled = new Set(events);
  return (
    enabled.has("*") ||
    (enabled.has("checkout.session.completed") &&
      enabled.has("checkout.session.async_payment_succeeded"))
  );
}
