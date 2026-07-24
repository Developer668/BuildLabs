import { createHmac, randomUUID } from "node:crypto";

/**
 * Stripe signs `{timestamp}.{payload}` with HMAC-SHA256 keyed by the raw
 * `whsec_...` string and ships it as `t=<unix>,v1=<hex>`.
 */
export function stripeSignatureHeader(
  payload: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

export interface SvixSignature {
  id: string;
  timestamp: string;
  signature: string;
}

/**
 * Resend delivers Svix-signed webhooks: HMAC-SHA256 over
 * `{id}.{timestamp}.{payload}` keyed by the base64 body of `whsec_<base64>`.
 */
export function svixSignatureHeaders(
  payload: string,
  secret: string,
  options: { id?: string; timestampSeconds?: number } = {},
): SvixSignature {
  const id = options.id ?? `msg_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(
    options.timestampSeconds ?? Math.floor(Date.now() / 1_000),
  );
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${payload}`, "utf8")
    .digest("base64");
  return { id, timestamp, signature: `v1,${signature}` };
}

/**
 * ElevenLabs post-call webhooks use `t=<unix>,v0=<hex>` over
 * `{timestamp}.{payload}` keyed by the raw shared secret.
 */
export function elevenLabsSignatureHeader(
  payload: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v0=${signature}`;
}
