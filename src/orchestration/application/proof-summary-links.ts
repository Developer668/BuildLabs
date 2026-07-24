import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../../lib/canonical-json.js";
import {
  OrchestrationIdSchema,
  OrchestrationSha256Schema,
} from "../domain/project.js";

const ProofSummaryGrantSchema = z
  .object({
    snapshotId: OrchestrationIdSchema,
    snapshotDigest: OrchestrationSha256Schema,
  })
  .strict();

const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{1,384})\.([A-Za-z0-9_-]{32})$/;
const PROOF_SUMMARY_PATH = "v1/orchestration/proof-summaries/";

export type ProofSummaryGrant = z.infer<typeof ProofSummaryGrantSchema>;

export interface ProofSummaryLinkCodecOptions {
  publicBaseUrl: string;
  secret: Buffer;
}

export class InvalidProofSummaryLinkError extends Error {
  constructor() {
    super("The proof-summary capability is invalid");
    this.name = "InvalidProofSummaryLinkError";
  }
}

/**
 * Creates a deterministic, narrowly scoped customer capability.
 *
 * The key is purpose-derived before signing so a proof link cannot be reused
 * as a reply-address signature even when both codecs receive the same root
 * secret. The capability contains only an opaque immutable snapshot identity
 * and its canonical digest; it contains no project, contact, or billing data.
 */
export class ProofSummaryLinkCodec {
  readonly #publicBaseUrl: URL;
  readonly #signingKey: Buffer;

  constructor(options: ProofSummaryLinkCodecOptions) {
    const publicBaseUrl = parsePublicBaseUrl(options.publicBaseUrl);
    if (
      !Buffer.isBuffer(options.secret) ||
      options.secret.length < 32 ||
      options.secret.length > 1_024
    ) {
      throw new TypeError("Proof-summary secret must contain 32-1024 bytes");
    }
    this.#publicBaseUrl = publicBaseUrl;
    this.#signingKey = createHmac("sha256", options.secret)
      .update("buildlabs-proof-summary-signing-key-v1")
      .digest();
  }

  create(input: ProofSummaryGrant): string {
    const grant = ProofSummaryGrantSchema.parse(input);
    const encoded = Buffer.from(canonicalJson(grant), "utf8").toString(
      "base64url",
    );
    const token = `v1.${encoded}.${this.#signature(encoded).toString("base64url")}`;
    return new URL(`${PROOF_SUMMARY_PATH}${token}`, this.#publicBaseUrl).href;
  }

  parse(token: string): ProofSummaryGrant {
    const match = TOKEN_PATTERN.exec(token);
    if (!match?.[1] || !match[2]) {
      throw new InvalidProofSummaryLinkError();
    }
    const encoded = match[1];
    const actualSignature = Buffer.from(match[2], "base64url");
    const expectedSignature = this.#signature(encoded);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      throw new InvalidProofSummaryLinkError();
    }

    try {
      const json = Buffer.from(encoded, "base64url").toString("utf8");
      const grant = ProofSummaryGrantSchema.parse(JSON.parse(json) as unknown);
      if (
        Buffer.from(canonicalJson(grant), "utf8").toString("base64url") !==
        encoded
      ) {
        throw new InvalidProofSummaryLinkError();
      }
      return grant;
    } catch (error) {
      if (error instanceof InvalidProofSummaryLinkError) {
        throw error;
      }
      throw new InvalidProofSummaryLinkError();
    }
  }

  #signature(encodedGrant: string): Buffer {
    return createHmac("sha256", this.#signingKey)
      .update(`buildlabs-proof-summary-v1:${encodedGrant}`)
      .digest()
      .subarray(0, 24);
  }
}

function parsePublicBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Proof-summary public base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      "Proof-summary public base URL must be credential-free HTTPS",
    );
  }
  parsed.pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return parsed;
}
