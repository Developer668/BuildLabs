import { createHmac, timingSafeEqual } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^build\+([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})@([^@\s]+)$/;

export interface ReplyAddressCodecOptions {
  domain: string;
  secret: Buffer;
}

export class InvalidReplyAddressError extends Error {
  constructor() {
    super("The inbound recipient is not a valid project reply address");
    this.name = "InvalidReplyAddressError";
  }
}

export class ReplyAddressCodec {
  readonly #domain: string;
  readonly #secret: Buffer;

  constructor(options: ReplyAddressCodecOptions) {
    const domain = options.domain.trim().toLowerCase();
    if (
      domain.length > 253 ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        domain,
      )
    ) {
      throw new TypeError("Reply address domain is invalid");
    }
    if (!Buffer.isBuffer(options.secret) || options.secret.length < 32) {
      throw new TypeError("Reply address secret must be at least 32 bytes");
    }
    this.#domain = domain;
    this.#secret = Buffer.from(options.secret);
  }

  create(projectId: string): string {
    const normalized = projectId.toLowerCase();
    if (!UUID.test(normalized)) {
      throw new TypeError("Reply addresses require a UUID project id");
    }
    const encodedProject = Buffer.from(
      normalized.replaceAll("-", ""),
      "hex",
    ).toString("base64url");
    const signature = this.#signature(encodedProject).toString("base64url");
    return `build+${encodedProject}.${signature}@${this.#domain}`;
  }

  parse(address: string): string {
    const match = TOKEN.exec(address.trim());
    if (!match?.[1] || !match[2] || match[3]?.toLowerCase() !== this.#domain) {
      throw new InvalidReplyAddressError();
    }
    const encodedProject = match[1];
    const actualSignature = Buffer.from(match[2], "base64url");
    const expectedSignature = this.#signature(encodedProject);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      throw new InvalidReplyAddressError();
    }

    const hex = Buffer.from(encodedProject, "base64url").toString("hex");
    if (hex.length !== 32) {
      throw new InvalidReplyAddressError();
    }
    const projectId = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
    if (!UUID.test(projectId)) {
      throw new InvalidReplyAddressError();
    }
    return projectId;
  }

  #signature(encodedProject: string): Buffer {
    return createHmac("sha256", this.#secret)
      .update(`buildlapse-reply-v1:${encodedProject}`)
      .digest()
      .subarray(0, 12);
  }
}
