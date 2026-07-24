import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";

const EMAIL_MAX_LENGTH = 320;
const TOKEN_PATTERN =
  /^(login|session)\.v1\.([A-Za-z0-9_-]{1,768})\.([A-Za-z0-9_-]{32})$/;
const CSRF_TOKEN_PATTERN = /^csrf\.v1\.([A-Za-z0-9_-]{43})$/;
const ACCESS_PATH = "v1/orchestration/customer-dashboard/access";
const MIN_TTL_SECONDS = 60;
const MAX_LOGIN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_REISSUE_GRACE_SECONDS = 30 * 24 * 60 * 60;

const DashboardGrantSchema = z
  .object({
    version: z.literal(1),
    purpose: z.enum(["login", "session"]),
    projectId: z.uuid(),
    emailDigest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    nonce: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.expiresAt <= grant.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Dashboard access must expire after it is issued",
      });
    }
  });

export type CustomerDashboardGrant = z.infer<typeof DashboardGrantSchema>;

export interface CustomerDashboardAccessCodecOptions {
  publicBaseUrl: string;
  secret: Buffer;
  now?: () => Date;
  loginTtlSeconds?: number;
  sessionTtlSeconds?: number;
}

export interface CreateCustomerDashboardLoginLinkInput {
  projectId: string;
  email: string;
  /**
   * Stable callers should provide both `expiresAt` and `nonce` so durable mail
   * retries reproduce the exact same capability and idempotency payload.
   */
  expiresAt?: string;
  nonce?: string;
}

export class InvalidCustomerDashboardAccessError extends Error {
  constructor() {
    super("The customer dashboard capability is invalid or expired");
    this.name = "InvalidCustomerDashboardAccessError";
  }
}

export class CustomerDashboardAccessCodec {
  readonly #publicBaseUrl: URL;
  readonly #loginSigningKey: Buffer;
  readonly #sessionSigningKey: Buffer;
  readonly #now: () => Date;
  readonly #loginTtlSeconds: number;
  readonly #sessionTtlSeconds: number;

  constructor(options: CustomerDashboardAccessCodecOptions) {
    this.#publicBaseUrl = parsePublicBaseUrl(options.publicBaseUrl);
    if (
      !Buffer.isBuffer(options.secret) ||
      options.secret.length < 32 ||
      options.secret.length > 1_024
    ) {
      throw new TypeError("Dashboard access secret must contain 32-1024 bytes");
    }
    this.#loginSigningKey = deriveKey(
      options.secret,
      "buildlabs-dashboard-login-signing-key-v1",
    );
    this.#sessionSigningKey = deriveKey(
      options.secret,
      "buildlabs-dashboard-session-signing-key-v1",
    );
    this.#now = options.now ?? (() => new Date());
    this.#loginTtlSeconds = boundedTtl(
      options.loginTtlSeconds ?? 15 * 60,
      MAX_LOGIN_TTL_SECONDS,
      "loginTtlSeconds",
    );
    this.#sessionTtlSeconds = boundedTtl(
      options.sessionTtlSeconds ?? 7 * 24 * 60 * 60,
      MAX_SESSION_TTL_SECONDS,
      "sessionTtlSeconds",
    );
  }

  createLoginLink(input: CreateCustomerDashboardLoginLinkInput): string {
    const now = epochSeconds(this.#now());
    const expiresAt =
      input.expiresAt === undefined
        ? now + this.#loginTtlSeconds
        : parseExpiry(input.expiresAt);
    const issuedAt =
      input.expiresAt === undefined ? now : expiresAt - this.#loginTtlSeconds;
    if (
      expiresAt <= now ||
      issuedAt > now ||
      expiresAt - issuedAt < MIN_TTL_SECONDS ||
      expiresAt - issuedAt > MAX_LOGIN_TTL_SECONDS
    ) {
      throw new RangeError(
        "Dashboard login expiry must be 60 seconds to 7 days after issuance",
      );
    }
    const grant = DashboardGrantSchema.parse({
      version: 1,
      purpose: "login",
      projectId: input.projectId,
      emailDigest: this.emailDigest(input.email),
      issuedAt,
      expiresAt,
      nonce: input.nonce ?? `login-${randomBytes(18).toString("base64url")}`,
    });
    const token = this.#encode(grant);
    const url = new URL(ACCESS_PATH, this.#publicBaseUrl);
    url.hash = new URLSearchParams({ token }).toString();
    return url.href;
  }

  parseLoginLink(token: string): CustomerDashboardGrant {
    return this.#parse(token, "login");
  }

  parseLoginLinkForReissue(token: string): CustomerDashboardGrant {
    return this.#parse(token, "login", LOGIN_REISSUE_GRACE_SECONDS);
  }

  createSession(loginGrant: CustomerDashboardGrant): {
    token: string;
    grant: CustomerDashboardGrant;
    csrfToken: string;
  } {
    const parsed = DashboardGrantSchema.parse(loginGrant);
    if (parsed.purpose !== "login" || !this.#active(parsed)) {
      throw new InvalidCustomerDashboardAccessError();
    }
    const issuedAt = epochSeconds(this.#now());
    const grant = DashboardGrantSchema.parse({
      ...parsed,
      purpose: "session",
      issuedAt,
      expiresAt: issuedAt + this.#sessionTtlSeconds,
      nonce: `session-${randomBytes(18).toString("base64url")}`,
    });
    const token = this.#encode(grant);
    return {
      token,
      grant,
      csrfToken: this.#csrfToken(token),
    };
  }

  parseSession(token: string): CustomerDashboardGrant {
    return this.#parse(token, "session");
  }

  verifyCsrfToken(sessionToken: string, csrfToken: string): boolean {
    try {
      this.parseSession(sessionToken);
      const match = CSRF_TOKEN_PATTERN.exec(csrfToken);
      if (match?.[1] === undefined) {
        return false;
      }
      const encodedActual = match[1];
      const actual = Buffer.from(encodedActual, "base64url");
      if (actual.toString("base64url") !== encodedActual) {
        return false;
      }
      const expected = Buffer.from(
        this.#csrfToken(sessionToken).slice("csrf.v1.".length),
        "base64url",
      );
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    } catch {
      return false;
    }
  }

  emailDigest(email: string): string {
    return sha256(normalizeEmail(email));
  }

  #encode(grant: CustomerDashboardGrant): string {
    const encoded = Buffer.from(canonicalJson(grant), "utf8").toString(
      "base64url",
    );
    const signature = this.#signature(grant.purpose, encoded).toString(
      "base64url",
    );
    return `${grant.purpose}.v1.${encoded}.${signature}`;
  }

  #parse(
    token: string,
    expectedPurpose: CustomerDashboardGrant["purpose"],
    expiredGraceSeconds = 0,
  ): CustomerDashboardGrant {
    const match = TOKEN_PATTERN.exec(token);
    if (
      match?.[1] !== expectedPurpose ||
      match[2] === undefined ||
      match[3] === undefined
    ) {
      throw new InvalidCustomerDashboardAccessError();
    }
    const encoded = match[2];
    const actualSignature = Buffer.from(match[3], "base64url");
    const expectedSignature = this.#signature(expectedPurpose, encoded);
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      throw new InvalidCustomerDashboardAccessError();
    }
    try {
      const json = Buffer.from(encoded, "base64url").toString("utf8");
      const grant = DashboardGrantSchema.parse(JSON.parse(json) as unknown);
      const now = epochSeconds(this.#now());
      const maximumTtl =
        expectedPurpose === "login"
          ? MAX_LOGIN_TTL_SECONDS
          : MAX_SESSION_TTL_SECONDS;
      if (
        grant.purpose !== expectedPurpose ||
        Buffer.from(canonicalJson(grant), "utf8").toString("base64url") !==
          encoded ||
        grant.issuedAt > now ||
        grant.expiresAt - grant.issuedAt < MIN_TTL_SECONDS ||
        grant.expiresAt - grant.issuedAt > maximumTtl ||
        grant.expiresAt + expiredGraceSeconds <= now
      ) {
        throw new InvalidCustomerDashboardAccessError();
      }
      return grant;
    } catch (error) {
      if (error instanceof InvalidCustomerDashboardAccessError) {
        throw error;
      }
      throw new InvalidCustomerDashboardAccessError();
    }
  }

  #signature(
    purpose: CustomerDashboardGrant["purpose"],
    encodedGrant: string,
  ): Buffer {
    const key =
      purpose === "login" ? this.#loginSigningKey : this.#sessionSigningKey;
    return createHmac("sha256", key)
      .update(`buildlabs-dashboard-${purpose}-v1:${encodedGrant}`)
      .digest()
      .subarray(0, 24);
  }

  #csrfToken(sessionToken: string): string {
    const signature = createHmac("sha256", this.#sessionSigningKey)
      .update(`buildlabs-dashboard-csrf-v1:${sessionToken}`)
      .digest("base64url");
    return `csrf.v1.${signature}`;
  }

  #active(grant: CustomerDashboardGrant): boolean {
    const now = epochSeconds(this.#now());
    return grant.issuedAt <= now && grant.expiresAt > now;
  }
}

function deriveKey(secret: Buffer, purpose: string): Buffer {
  return createHmac("sha256", secret).update(purpose).digest();
}

function normalizeEmail(email: string): string {
  return z
    .email()
    .max(EMAIL_MAX_LENGTH)
    .parse(email.trim())
    .toLocaleLowerCase();
}

function parseExpiry(value: string): number {
  const parsed = z.iso.datetime().parse(value);
  return Math.floor(Date.parse(parsed) / 1_000);
}

function epochSeconds(date: Date): number {
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Dashboard access clock returned an invalid date");
  }
  return Math.floor(milliseconds / 1_000);
}

function boundedTtl(value: number, maximum: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TTL_SECONDS ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be an integer between ${MIN_TTL_SECONDS} and ${maximum}`,
    );
  }
  return value;
}

function parsePublicBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Dashboard public base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      "Dashboard public base URL must be credential-free HTTPS",
    );
  }
  parsed.pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return parsed;
}
