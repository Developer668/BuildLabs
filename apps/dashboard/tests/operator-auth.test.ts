import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOperatorSessionCookie,
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
  operatorCookieFromHeader,
  operatorSessionCookie,
  operatorTokenConfigured,
  verifyOperatorSession,
  verifyOperatorToken,
} from "../lib/operator-auth";
import {
  DELETE as signOut,
  GET as readSession,
  POST as signIn,
} from "../app/api/operator/session/route";

const OPERATOR_TOKEN = "operator-token-for-dashboard-tests";
const ORIGINAL_OPERATOR_TOKEN = process.env.BUILDLABS_OPERATOR_TOKEN;

describe("operator authentication", () => {
  beforeEach(() => {
    process.env.BUILDLABS_OPERATOR_TOKEN = OPERATOR_TOKEN;
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv("BUILDLABS_OPERATOR_TOKEN", ORIGINAL_OPERATOR_TOKEN);
  });

  it("fails closed when the operator secret is absent or too short", () => {
    delete process.env.BUILDLABS_OPERATOR_TOKEN;
    expect(operatorTokenConfigured()).toBe(false);
    expect(verifyOperatorToken(OPERATOR_TOKEN)).toBe(false);
    expect(() => createOperatorSession()).toThrow(
      "BUILDLABS_OPERATOR_TOKEN is not configured",
    );

    process.env.BUILDLABS_OPERATOR_TOKEN = "too-short";
    expect(operatorTokenConfigured()).toBe(false);
    expect(verifyOperatorToken("too-short")).toBe(false);
  });

  it("accepts only the exact bounded operator token", () => {
    expect(operatorTokenConfigured()).toBe(true);
    expect(verifyOperatorToken(OPERATOR_TOKEN)).toBe(true);
    expect(verifyOperatorToken(`${OPERATOR_TOKEN}-forged`)).toBe(false);
    expect(verifyOperatorToken("x".repeat(4_097))).toBe(false);
  });

  it("rejects forged, future-issued, and expired sessions", () => {
    const issuedAt = Date.UTC(2026, 6, 24, 12, 0, 0);
    const session = createOperatorSession(issuedAt);
    expect(verifyOperatorSession(session.token, issuedAt)).toBe(true);

    const parts = session.token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        issuedAt: Math.floor(issuedAt / 1_000),
        expiresAt: Math.floor(issuedAt / 1_000) + 16 * 60 * 60,
        nonce: "forged_nonce_123456789",
      }),
      "utf8",
    ).toString("base64url");
    expect(
      verifyOperatorSession(
        `${parts[0]}.${parts[1]}.${forgedPayload}.${parts[3]}`,
        issuedAt,
      ),
    ).toBe(false);

    const replacement = parts[3]!.at(-1) === "A" ? "B" : "A";
    const forgedSignature = `${parts[3]!.slice(0, -1)}${replacement}`;
    expect(
      verifyOperatorSession(
        `${parts[0]}.${parts[1]}.${parts[2]}.${forgedSignature}`,
        issuedAt,
      ),
    ).toBe(false);
    expect(verifyOperatorSession(session.token, issuedAt - 1_000)).toBe(false);
    expect(
      verifyOperatorSession(session.token, issuedAt + session.maxAge * 1_000),
    ).toBe(false);
  });

  it("rejects ambiguous duplicate session cookies and oversized headers", () => {
    const session = createOperatorSession();
    expect(
      operatorCookieFromHeader(
        `theme=dark; ${OPERATOR_SESSION_COOKIE}=${session.token}`,
      ),
    ).toBe(session.token);
    expect(
      operatorCookieFromHeader(
        `${OPERATOR_SESSION_COOKIE}=${session.token}; ${OPERATOR_SESSION_COOKIE}=${session.token}`,
      ),
    ).toBeUndefined();
    expect(operatorCookieFromHeader("x".repeat(8_193))).toBeUndefined();
  });

  it("establishes an HttpOnly strict session through the sign-in route", async () => {
    const response = await signIn(
      jsonRequest("/api/operator/session", "POST", {
        token: OPERATOR_TOKEN,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${OPERATOR_SESSION_COOKIE}=operator.v1.`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const token = cookieValue(cookie, OPERATOR_SESSION_COOKIE);
    const authenticated = await readSession(
      new Request("http://dashboard.test/api/operator/session", {
        headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
      }),
    );
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toEqual({
      authenticated: true,
    });
  });

  it("returns the same generic rejection when the secret is unconfigured", async () => {
    delete process.env.BUILDLABS_OPERATOR_TOKEN;
    vi.useFakeTimers();

    const pending = signIn(
      jsonRequest("/api/operator/session", "POST", {
        token: OPERATOR_TOKEN,
      }),
    );
    await vi.runAllTimersAsync();
    const response = await pending;

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: "operator_unauthorized",
      message: "The operator session could not be established.",
    });
  });

  it("clears the browser cookie without claiming server-side revocation", async () => {
    const session = createOperatorSession();
    const cookieHeader = `${OPERATOR_SESSION_COOKIE}=${session.token}`;

    const before = await readSession(
      new Request("http://dashboard.test/api/operator/session", {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(before.status).toBe(200);

    const signedOut = signOut();
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toBe(
      clearOperatorSessionCookie(),
    );
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");

    const afterCookieClear = await readSession(
      new Request("http://dashboard.test/api/operator/session"),
    );
    expect(afterCookieClear.status).toBe(401);

    // A racing request that already carries the stateless token remains valid.
    const racingRequest = await readSession(
      new Request("http://dashboard.test/api/operator/session", {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(racingRequest.status).toBe(200);
    expect(verifyOperatorSession(session.token)).toBe(true);
  });

  it("serializes and clears cookies with the same scope", () => {
    const session = createOperatorSession();
    const active = operatorSessionCookie(session.token, session.maxAge);
    const cleared = clearOperatorSessionCookie();

    for (const attribute of [
      `${OPERATOR_SESSION_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
    ]) {
      expect(active).toContain(attribute);
      expect(cleared).toContain(attribute);
    }
  });
});

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://dashboard.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cookieValue(header: string | null, name: string): string {
  const value = header?.split(";")[0]?.slice(`${name}=`.length);
  if (!value) {
    throw new Error(`Missing ${name} cookie`);
  }
  return value;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
