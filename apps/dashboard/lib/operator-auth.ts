import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OPERATOR_SESSION_COOKIE = "buildlabs_operator_session";
const SESSION_VERSION = "operator.v1";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface OperatorSessionPayload {
  expiresAt: number;
  issuedAt: number;
  nonce: string;
}

export function operatorTokenConfigured(): boolean {
  return validSecret(process.env.BUILDLABS_OPERATOR_TOKEN);
}

export function verifyOperatorToken(candidate: string): boolean {
  const expected = process.env.BUILDLABS_OPERATOR_TOKEN;
  if (!validSecret(expected) || candidate.length > 4_096) {
    return false;
  }
  return constantTimeEqual(candidate, expected);
}

export function createOperatorSession(now = Date.now()): {
  token: string;
  maxAge: number;
} {
  const secret = requireSigningSecret();
  const issuedAt = Math.floor(now / 1_000);
  const payload: OperatorSessionPayload = {
    issuedAt,
    expiresAt: issuedAt + SESSION_TTL_SECONDS,
    nonce: randomBytes(18).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = sign(encoded, secret);
  return {
    token: `${SESSION_VERSION}.${encoded}.${signature}`,
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function verifyOperatorSession(
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || token.length > 2_048) {
    return false;
  }
  const secret = signingSecret();
  if (!secret) {
    return false;
  }
  const parts = token.split(".");
  if (
    parts.length !== 4 ||
    `${parts[0]}.${parts[1]}` !== SESSION_VERSION ||
    !parts[2] ||
    !parts[3]
  ) {
    return false;
  }
  const encoded = parts[2];
  if (!constantTimeEqual(parts[3], sign(encoded, secret))) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<OperatorSessionPayload>;
    const current = Math.floor(now / 1_000);
    return (
      Number.isSafeInteger(payload.issuedAt) &&
      Number.isSafeInteger(payload.expiresAt) &&
      typeof payload.nonce === "string" &&
      /^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) &&
      payload.issuedAt! <= current &&
      payload.expiresAt! > current &&
      payload.expiresAt! - payload.issuedAt! === SESSION_TTL_SECONDS
    );
  } catch {
    return false;
  }
}

export function operatorCookieFromHeader(
  cookieHeader: string | null,
): string | undefined {
  if (!cookieHeader || Buffer.byteLength(cookieHeader) > 8_192) {
    return undefined;
  }
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${OPERATOR_SESSION_COOKIE}=`))
    .map((part) => part.slice(OPERATOR_SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

export function operatorSessionCookie(token: string, maxAge: number): string {
  return [
    `${OPERATOR_SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

export function clearOperatorSessionCookie(): string {
  return [
    `${OPERATOR_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

function validSecret(value: string | undefined): value is string {
  return value !== undefined && Buffer.byteLength(value) >= 20;
}

function signingSecret(): string | undefined {
  return validSecret(process.env.BUILDLABS_OPERATOR_TOKEN)
    ? process.env.BUILDLABS_OPERATOR_TOKEN
    : undefined;
}

function requireSigningSecret(): string {
  const secret = signingSecret();
  if (!secret) {
    throw new Error("BUILDLABS_OPERATOR_TOKEN is not configured");
  }
  return secret;
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`buildlabs-operator-session-v1:${encoded}`)
    .digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
