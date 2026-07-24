import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "../lib/operator-auth";
import {
  DELETE,
  GET,
  POST,
} from "../app/api/copilotkit/operator/[[...slug]]/route";

const OPERATOR_TOKEN = "operator-token-for-runtime-tests";
const ORIGINAL_OPERATOR_TOKEN = process.env.BUILDLABS_OPERATOR_TOKEN;
const ORIGINAL_BACKEND_URL = process.env.BUILDLABS_BUILD_BACKEND_URL;
const ORIGINAL_INTERNAL_TOKEN = process.env.BUILDLABS_INTERNAL_TOKEN;

describe("operator CopilotKit runtime authorization", () => {
  beforeEach(() => {
    process.env.BUILDLABS_OPERATOR_TOKEN = OPERATOR_TOKEN;
    process.env.BUILDLABS_BUILD_BACKEND_URL = "http://127.0.0.1:65534";
    process.env.BUILDLABS_INTERNAL_TOKEN =
      "internal-token-never-returned-to-browser";
  });

  afterEach(() => {
    restoreEnv("BUILDLABS_OPERATOR_TOKEN", ORIGINAL_OPERATOR_TOKEN);
    restoreEnv("BUILDLABS_BUILD_BACKEND_URL", ORIGINAL_BACKEND_URL);
    restoreEnv("BUILDLABS_INTERNAL_TOKEN", ORIGINAL_INTERNAL_TOKEN);
  });

  it.each([
    {
      method: "GET",
      handler: GET,
      path: "/api/copilotkit/operator/info",
    },
    {
      method: "POST",
      handler: POST,
      path: "/api/copilotkit/operator/agent/studio-observer/run",
    },
    {
      method: "DELETE",
      handler: DELETE,
      path: "/api/copilotkit/operator/threads/forged-thread",
    },
  ] as const)(
    "rejects an unauthenticated $method before routing",
    async ({ method, handler, path }) => {
      const response = await handler(
        new Request(`http://dashboard.test${path}`, { method }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({
        error: "operator_unauthorized",
        message: "A valid operator session is required.",
      });
    },
  );

  it("rejects duplicate and forged session cookies", async () => {
    const session = createOperatorSession();
    const validCookie = `${OPERATOR_SESSION_COOKIE}=${session.token}`;
    const forgedToken = `${session.token.slice(0, -1)}${
      session.token.at(-1) === "A" ? "B" : "A"
    }`;

    for (const cookie of [
      `${validCookie}; ${validCookie}`,
      `${OPERATOR_SESSION_COOKIE}=${forgedToken}`,
    ]) {
      const response = await GET(
        new Request("http://dashboard.test/api/copilotkit/operator/info", {
          headers: { cookie },
        }),
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects an expired session before an agent can be selected", async () => {
    const expired = createOperatorSession(Date.now() - 9 * 60 * 60 * 1_000);
    const response = await GET(
      new Request("http://dashboard.test/api/copilotkit/operator/info", {
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${expired.token}`,
        },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("returns only allowlisted runtime metadata to an authenticated operator", async () => {
    const session = createOperatorSession();
    const response = await GET(
      new Request("http://dashboard.test/api/copilotkit/operator/info", {
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${session.token}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      a2uiEnabled: boolean;
      agents: Record<
        string,
        { className: string; description?: string; name: string }
      >;
      openGenerativeUIEnabled: boolean;
    };
    expect(body.agents).toEqual({
      "studio-observer": expect.objectContaining({
        name: "studio-observer",
        description:
          "Read-only durable BuildLabs candidate observation for the operator studio.",
      }),
    });
    expect(body.a2uiEnabled).toBe(false);
    expect(body.openGenerativeUIEnabled).toBe(false);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(
      "internal-token-never-returned-to-browser",
    );
    expect(serialized).not.toContain("http://127.0.0.1:65534");
  });

  it("registers no upstream agent when internal authentication is unavailable", async () => {
    delete process.env.BUILDLABS_INTERNAL_TOKEN;
    const session = createOperatorSession();
    const response = await GET(
      new Request("http://dashboard.test/api/copilotkit/operator/info", {
        headers: {
          cookie: `${OPERATOR_SESSION_COOKIE}=${session.token}`,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        agents: {},
        a2uiEnabled: false,
        openGenerativeUIEnabled: false,
      }),
    );
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
