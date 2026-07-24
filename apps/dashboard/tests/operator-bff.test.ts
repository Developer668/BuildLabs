import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "../lib/operator-auth";
import {
  handleOperatorIntegrations,
  handleOperatorPreview,
  handleOperatorProjectEvidence,
  handleOperatorRuns,
} from "../lib/operator-server";
import type { OperatorFetch } from "../lib/operator-server/client";

const OPERATOR_TOKEN = "operator-token-for-bff-tests-123456789";
const INTERNAL_TOKEN = "internal-token-for-bff-tests-123456789";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const ORIGINAL_ENV = {
  BUILDLABS_OPERATOR_TOKEN: process.env.BUILDLABS_OPERATOR_TOKEN,
  BUILDLABS_INTERNAL_TOKEN: process.env.BUILDLABS_INTERNAL_TOKEN,
  BUILDLABS_BUILD_BACKEND_URL: process.env.BUILDLABS_BUILD_BACKEND_URL,
  BUILDLABS_ORCHESTRATION_URL: process.env.BUILDLABS_ORCHESTRATION_URL,
};

describe("operator read-only BFF", () => {
  beforeEach(() => {
    process.env.BUILDLABS_OPERATOR_TOKEN = OPERATOR_TOKEN;
    process.env.BUILDLABS_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.BUILDLABS_BUILD_BACKEND_URL = "http://127.0.0.1:3000";
    process.env.BUILDLABS_ORCHESTRATION_URL = "http://127.0.0.1:3100";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(
      "BUILDLABS_OPERATOR_TOKEN",
      ORIGINAL_ENV.BUILDLABS_OPERATOR_TOKEN,
    );
    restoreEnv(
      "BUILDLABS_INTERNAL_TOKEN",
      ORIGINAL_ENV.BUILDLABS_INTERNAL_TOKEN,
    );
    restoreEnv(
      "BUILDLABS_BUILD_BACKEND_URL",
      ORIGINAL_ENV.BUILDLABS_BUILD_BACKEND_URL,
    );
    restoreEnv(
      "BUILDLABS_ORCHESTRATION_URL",
      ORIGINAL_ENV.BUILDLABS_ORCHESTRATION_URL,
    );
  });

  it("rejects missing, customer-only, forged, and duplicate operator sessions before fetching", async () => {
    const fetcher = vi.fn<OperatorFetch>();
    const validToken = createOperatorSession().token;
    const responses = await Promise.all([
      handleOperatorRuns(request("/api/operator/runs"), fetcher),
      handleOperatorProjectEvidence(
        request(
          `/api/operator/projects/${PROJECT_ID}/evidence`,
          "buildlabs_dashboard_session=customer-session",
        ),
        PROJECT_ID,
        fetcher,
      ),
      handleOperatorIntegrations(
        request(
          "/api/operator/integrations",
          `${OPERATOR_SESSION_COOKIE}=operator.v1.forged.signature`,
        ),
        fetcher,
      ),
      handleOperatorPreview(
        request(
          `/api/operator/runs/${RUN_ID}/preview`,
          `${OPERATOR_SESSION_COOKIE}=${validToken}; ${OPERATOR_SESSION_COOKIE}=${validToken}`,
        ),
        RUN_ID,
        fetcher,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401,
    ]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      await expect(response.json()).resolves.toMatchObject({
        error: "operator_unauthorized",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects forged IDs, duplicate parameters, unknown keys, and out-of-range windows", async () => {
    const fetcher = vi.fn<OperatorFetch>();
    const cases = [
      handleOperatorProjectEvidence(
        authenticatedRequest("/api/operator/projects/forged/evidence"),
        "../../forged",
        fetcher,
      ),
      handleOperatorPreview(
        authenticatedRequest("/api/operator/runs/forged/preview"),
        `${RUN_ID}/cancel`,
        fetcher,
      ),
      handleOperatorRuns(
        authenticatedRequest("/api/operator/runs?projectId=not-a-uuid"),
        fetcher,
      ),
      handleOperatorRuns(
        authenticatedRequest(
          `/api/operator/runs?projectId=${PROJECT_ID}&projectId=${PROJECT_ID}`,
        ),
        fetcher,
      ),
      handleOperatorRuns(
        authenticatedRequest("/api/operator/runs?limit=101"),
        fetcher,
      ),
      handleOperatorProjectEvidence(
        authenticatedRequest(
          `/api/operator/projects/${PROJECT_ID}/evidence?afterSequence=-1`,
        ),
        PROJECT_ID,
        fetcher,
      ),
      handleOperatorProjectEvidence(
        authenticatedRequest(
          `/api/operator/projects/${PROJECT_ID}/evidence?limit=501`,
        ),
        PROJECT_ID,
        fetcher,
      ),
      handleOperatorIntegrations(
        authenticatedRequest("/api/operator/integrations?probe=true"),
        fetcher,
      ),
    ];

    const responses = await Promise.all(cases);
    expect(responses).toHaveLength(8);
    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_operator_request",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards only bounded read requests with the server bearer token", async () => {
    const seen: Array<{
      url: string;
      method: string | undefined;
      authorization: string | null;
      cookie: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    const fetcher: OperatorFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        method: init?.method,
        authorization: headers.get("authorization"),
        cookie: headers.get("cookie"),
        redirect: init?.redirect,
      });
      const url = new URL(String(input));
      if (url.pathname === "/v1/studio/runs") {
        return jsonResponse({ runs: [] });
      }
      if (url.pathname.endsWith("/evidence")) {
        return jsonResponse({ project: { projectId: PROJECT_ID }, events: [] });
      }
      if (url.pathname === "/v1/integrations") {
        return jsonResponse({ status: { daytona: "configured" } });
      }
      return jsonResponse({
        kind: "ephemeral_daytona_preview",
        url: "https://preview.example.test/session",
      });
    };

    const responses = await Promise.all([
      handleOperatorRuns(
        authenticatedRequest(
          `/api/operator/runs?limit=7&projectId=${PROJECT_ID}`,
        ),
        fetcher,
      ),
      handleOperatorProjectEvidence(
        authenticatedRequest(
          `/api/operator/projects/${PROJECT_ID}/evidence?afterSequence=8&limit=9`,
        ),
        PROJECT_ID,
        fetcher,
      ),
      handleOperatorIntegrations(
        authenticatedRequest("/api/operator/integrations"),
        fetcher,
      ),
      handleOperatorPreview(
        authenticatedRequest(`/api/operator/runs/${RUN_ID}/preview`),
        RUN_ID,
        fetcher,
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(seen.map((entry) => entry.url)).toEqual([
      `http://127.0.0.1:3000/v1/studio/runs?limit=7&projectId=${PROJECT_ID}`,
      `http://127.0.0.1:3100/v1/orchestration/projects/${PROJECT_ID}/evidence?afterSequence=8&limit=9`,
      "http://127.0.0.1:3000/v1/integrations",
      `http://127.0.0.1:3000/v1/build-runs/${RUN_ID}/preview`,
    ]);
    for (const entry of seen) {
      expect(entry.method).toBe("GET");
      expect(entry.authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
      expect(entry.cookie).toBeNull();
      expect(entry.redirect).toBe("manual");
    }
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe(
        "application/json; charset=utf-8",
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain(INTERNAL_TOKEN);
    }
  });

  it("fails closed on upstream failures, content types, oversized JSON, and token reflection", async () => {
    const cases: OperatorFetch[] = [
      async () =>
        jsonResponse(
          {
            error: "provider_failed",
            detail: `Bearer ${INTERNAL_TOKEN}`,
          },
          { status: 500 },
        ),
      async () =>
        new Response("<html>provider error</html>", {
          headers: { "content-type": "text/html" },
        }),
      async () =>
        jsonResponse(
          { runs: [] },
          { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
        ),
      async () =>
        new Response(`{"payload":"${"x".repeat(2 * 1024 * 1024)}"}`, {
          headers: { "content-type": "application/json" },
        }),
      async () =>
        jsonResponse({
          runs: [],
          accidentalCredential: `Bearer ${INTERNAL_TOKEN}`,
        }),
    ];

    const responses = [];
    for (const fetcher of cases) {
      responses.push(
        await handleOperatorRuns(
          authenticatedRequest("/api/operator/runs"),
          fetcher,
        ),
      );
    }

    expect(responses.map((response) => response.status)).toEqual([
      503, 502, 502, 502, 502,
    ]);
    for (const response of responses) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = await response.text();
      expect(body).not.toContain(INTERNAL_TOKEN);
      expect(body).not.toContain("provider_failed");
    }
  });

  it("fails closed when the internal token or upstream origin is unsafe", async () => {
    const fetcher = vi.fn<OperatorFetch>();
    delete process.env.BUILDLABS_INTERNAL_TOKEN;
    const missingToken = await handleOperatorRuns(
      authenticatedRequest("/api/operator/runs"),
      fetcher,
    );
    expect(missingToken.status).toBe(503);

    process.env.BUILDLABS_INTERNAL_TOKEN = INTERNAL_TOKEN;
    process.env.BUILDLABS_BUILD_BACKEND_URL =
      "https://user:password@backend.example.test";
    const unsafeOrigin = await handleOperatorIntegrations(
      authenticatedRequest("/api/operator/integrations"),
      fetcher,
    );
    expect(unsafeOrigin.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps missing and not-ready resources without relaying upstream text", async () => {
    const missing = await handleOperatorProjectEvidence(
      authenticatedRequest(`/api/operator/projects/${PROJECT_ID}/evidence`),
      PROJECT_ID,
      async () =>
        jsonResponse(
          { error: "project_not_found", projectId: PROJECT_ID },
          { status: 404 },
        ),
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: "operator_resource_not_found",
      message: "The requested operator resource was not found.",
    });

    const notReady = await handleOperatorPreview(
      authenticatedRequest(`/api/operator/runs/${RUN_ID}/preview`),
      RUN_ID,
      async () =>
        jsonResponse(
          { error: "preview_not_ready", sandboxId: "raw-sandbox-id" },
          { status: 409 },
        ),
    );
    expect(notReady.status).toBe(409);
    const body = await notReady.text();
    expect(body).not.toContain("raw-sandbox-id");
    expect(body).not.toContain("preview_not_ready");
  });
});

function request(path: string, cookie?: string): Request {
  return new Request(`https://dashboard.buildlabs.test${path}`, {
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

function authenticatedRequest(path: string): Request {
  const session = createOperatorSession();
  return request(path, `${OPERATOR_SESSION_COOKIE}=${session.token}`);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
