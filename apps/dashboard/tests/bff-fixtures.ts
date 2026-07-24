import {
  createCustomerAliasContext,
  sealCustomerAliasContext,
} from "../lib/server/aliases";
import {
  DASHBOARD_ALIAS_COOKIE,
  DASHBOARD_CSRF_COOKIE,
  DASHBOARD_SESSION_COOKIE,
} from "../lib/server/cookies";
import type { DashboardFetch } from "../lib/server/orchestration-client";

export const TEST_ALIAS_SECRET = "alias-secret-for-dashboard-tests-123456789";
export const TEST_INTERNAL_TOKEN = "internal-dashboard-frame-token-123456789";
export const TEST_WIP_POLICY_DIGEST = "b".repeat(64);
export const TEST_WIP_ATTESTATION_SECRET =
  "wip-attestation-secret-for-dashboard-tests";
export const TEST_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_SESSION = "session.v1.dashboard-test-session";
export const TEST_CSRF = `csrf.v1.${"a".repeat(43)}`;

export function customerAuth(
  sessionToken = TEST_SESSION,
  projectId = TEST_PROJECT_ID,
): {
  projectAlias: string;
  cookie: string;
} {
  const context = createCustomerAliasContext({
    internalProjectId: projectId,
    sessionToken,
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    secret: TEST_ALIAS_SECRET,
  });
  const sealed = sealCustomerAliasContext(context, TEST_ALIAS_SECRET);
  return {
    projectAlias: context.projectAlias,
    cookie: [
      `${DASHBOARD_SESSION_COOKIE}=${sessionToken}`,
      `${DASHBOARD_CSRF_COOKIE}=${TEST_CSRF}`,
      `${DASHBOARD_ALIAS_COOKIE}=${sealed}`,
    ].join("; "),
  };
}

export function dashboardRequest(
  path: string,
  init: RequestInit = {},
): Request {
  const auth = customerAuth();
  const headers = new Headers(init.headers);
  headers.set("cookie", auth.cookie);
  return new Request(`https://dashboard.buildlabs.test${path}`, {
    ...init,
    headers,
  });
}

export function upstreamProject(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    projectId: TEST_PROJECT_ID,
    status: "intake_received",
    revision: 0,
    plan: null,
    payment: {
      state: "awaiting",
      verifiedAt: null,
    },
    activeBuild: null,
    observation: {
      state: "unavailable",
      note: "No build batch has started.",
    },
    deliverables: {
      frozenProvenPreview: null,
      production: null,
    },
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  };
}

export function upstreamEvent(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    type: "project.created",
    actor: "system",
    status: "intake_received",
    runId: null,
    candidateId: null,
    occurredAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  };
}

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function snapshotFetcher(
  snapshot: Record<string, unknown>,
  events: Record<string, unknown>[],
): DashboardFetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) {
      const after = Number(url.searchParams.get("afterSequence"));
      const limit = Number(url.searchParams.get("limit"));
      const remaining = events.filter(
        (event) => Number(event.sequence) > after,
      );
      const items = remaining.slice(0, limit);
      return jsonResponse({
        items,
        nextAfterSequence: Number(items.at(-1)?.sequence) || after,
        hasMore: remaining.length > items.length,
      });
    }
    return jsonResponse(snapshot);
  };
}
