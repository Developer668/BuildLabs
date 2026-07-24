export interface CreateCheckoutSessionRequest {
  projectId: string;
  proposalId: string;
  proposalVersion: number;
  proposalDigest: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  idempotencyKey: string;
}

export type CheckoutSessionStatus = "complete" | "expired" | "open";
export type CheckoutPaymentStatus = "no_payment_required" | "paid" | "unpaid";

export interface CheckoutSession {
  provider: "stripe";
  sessionId: string;
  livemode: boolean;
  url: string | null;
  status: CheckoutSessionStatus;
  paymentStatus: CheckoutPaymentStatus;
  paymentIntentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  customerEmail: string | null;
  customerId: string | null;
  projectId: string | null;
  proposalId: string | null;
  proposalVersion: number | null;
  proposalDigest: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface VerifySettlementRequest {
  checkoutSessionId: string;
  paymentIntentId: string;
  projectId: string;
  proposalId: string;
  proposalVersion: number;
  proposalDigest: string;
  amountMinor: number;
  currency: string;
  customerEmail: string;
  livemode: boolean;
}

/**
 * A settlement returned only after Stripe's authoritative Checkout Session and
 * PaymentIntent both match the pinned proposal and customer.
 */
export interface VerifiedSettlement {
  provider: "stripe";
  checkoutSessionId: string;
  paymentIntentId: string;
  projectId: string;
  proposalId: string;
  proposalVersion: number;
  proposalDigest: string;
  amountMinor: number;
  amountReceivedMinor: number;
  currency: string;
  customerEmail: string;
  customerId: string | null;
  livemode: boolean;
  checkoutStatus: "complete";
  paymentStatus: "paid";
  paymentIntentStatus: "succeeded";
  paymentIntentCreatedAt: string;
}

export interface PaidCheckoutWebhook {
  provider: "stripe";
  eventId: string;
  createdAt: string;
  livemode: boolean;
  session: CheckoutSession;
}

export interface RawStripeWebhook {
  rawBody: string | Uint8Array;
  signature: string;
}

export interface PaymentPort {
  /**
   * Performs a read-only authenticated Stripe Checkout probe.
   */
  health(signal?: AbortSignal): Promise<void>;
  createCheckoutSession(
    request: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSession>;
  expireCheckoutSession(sessionId: string): Promise<CheckoutSession>;
  /**
   * Verifies the provider signature over the untouched request body. Valid
   * events which are not a paid synchronous or asynchronous Checkout
   * settlement return `null`.
   */
  parseWebhook(webhook: RawStripeWebhook): PaidCheckoutWebhook | null;
  /**
   * Re-fetches Stripe's authoritative Session state for reconciliation.
   */
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession>;
  /**
   * Re-fetches and verifies both authoritative Stripe objects. A signed
   * webhook alone is never sufficient to authorize build dispatch.
   */
  verifySettlement(
    request: VerifySettlementRequest,
  ): Promise<VerifiedSettlement>;
}
