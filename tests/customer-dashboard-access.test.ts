import { describe, expect, it } from "vitest";

import {
  CustomerDashboardAccessCodec,
  InvalidCustomerDashboardAccessError,
} from "../src/orchestration/application/customer-dashboard-access.js";

const NOW = "2026-07-24T12:00:00.000Z";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("CustomerDashboardAccessCodec", () => {
  it("creates deterministic, email-bound login links for durable mail retries", () => {
    const codec = createCodec();
    const input = {
      projectId: PROJECT_ID,
      email: "Customer@Example.com",
      expiresAt: "2026-07-24T12:15:00.000Z",
      nonce: "dashboard-mail-effect-001",
    };

    const first = codec.createLoginLink(input);
    const second = codec.createLoginLink(input);
    expect(second).toBe(first);

    const grant = codec.parseLoginLink(loginToken(first));
    expect(grant).toMatchObject({
      purpose: "login",
      projectId: PROJECT_ID,
      emailDigest: codec.emailDigest("customer@example.com"),
      nonce: "dashboard-mail-effect-001",
    });
    expect(first).not.toContain("Customer");
    expect(first).not.toContain("example.com");
    expect(new URL(first).pathname).toBe(
      "/v1/orchestration/customer-dashboard/access",
    );
    expect(new URL(first).hash).toContain("#token=login.v1.");
  });

  it("separates short login capabilities from longer customer sessions", () => {
    const codec = createCodec();
    const loginUrl = codec.createLoginLink({
      projectId: PROJECT_ID,
      email: "customer@example.com",
      nonce: "dashboard-login-nonce-001",
    });
    const login = codec.parseLoginLink(loginToken(loginUrl));
    const session = codec.createSession(login);

    expect(codec.parseSession(session.token)).toEqual(session.grant);
    expect(codec.verifyCsrfToken(session.token, session.csrfToken)).toBe(true);
    expect(
      codec.verifyCsrfToken(
        session.token,
        `${session.csrfToken.slice(0, -1)}x`,
      ),
    ).toBe(false);
    expect(() => codec.parseLoginLink(session.token)).toThrow(
      InvalidCustomerDashboardAccessError,
    );
    expect(session.grant.emailDigest).toBe(login.emailDigest);
    expect(session.grant.projectId).toBe(login.projectId);
    expect(session.grant.expiresAt).toBeGreaterThan(login.expiresAt);
  });

  it("rejects tampering, wrong email bindings, and expiry", () => {
    let now = new Date(NOW);
    const codec = createCodec(() => now);
    const loginUrl = codec.createLoginLink({
      projectId: PROJECT_ID,
      email: "customer@example.com",
      nonce: "dashboard-login-nonce-002",
    });
    const token = loginToken(loginUrl);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    expect(() => codec.parseLoginLink(tampered)).toThrow(
      InvalidCustomerDashboardAccessError,
    );
    expect(codec.emailDigest("customer@example.com")).not.toBe(
      codec.emailDigest("other@example.com"),
    );

    now = new Date("2026-07-26T12:00:00.000Z");
    expect(() => codec.parseLoginLink(token)).toThrow(
      InvalidCustomerDashboardAccessError,
    );
  });

  it("accepts only recently expired signed login capabilities for reissue", () => {
    let now = new Date(NOW);
    const codec = createCodec(() => now);
    const token = loginToken(
      codec.createLoginLink({
        projectId: PROJECT_ID,
        email: "customer@example.com",
        nonce: "dashboard-login-reissue-001",
      }),
    );

    now = new Date("2026-08-01T12:00:00.000Z");
    expect(codec.parseLoginLinkForReissue(token)).toMatchObject({
      projectId: PROJECT_ID,
      purpose: "login",
    });

    now = new Date("2026-08-24T12:15:00.000Z");
    expect(() => codec.parseLoginLinkForReissue(token)).toThrow(
      InvalidCustomerDashboardAccessError,
    );
    expect(() =>
      codec.parseLoginLinkForReissue(`${token.slice(0, -1)}x`),
    ).toThrow(InvalidCustomerDashboardAccessError);
  });
});

function loginToken(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
}

function createCodec(now: () => Date = () => new Date(NOW)) {
  return new CustomerDashboardAccessCodec({
    publicBaseUrl: "https://orchestrator.buildlabs.example",
    secret: Buffer.alloc(32, 11),
    now,
  });
}
