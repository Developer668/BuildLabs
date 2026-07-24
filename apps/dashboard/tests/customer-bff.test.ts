import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleCustomerAccess,
  handleCustomerAccessReissue,
} from "../lib/server/access-proxy";
import {
  createCustomerAliasContext,
  opaqueAlias,
  openCustomerAliasContext,
  sealCustomerAliasContext,
  sessionBinding,
} from "../lib/server/aliases";
import {
  getSetCookieHeaders,
  rewriteDashboardCookies,
} from "../lib/server/cookies";
import { handleCustomerSnapshot } from "../lib/server/customer-snapshot";
import { handleCustomerSteering } from "../lib/server/customer-steering";
import { handleCustomerLogout } from "../lib/server/logout";
import type { DashboardFetch } from "../lib/server/orchestration-client";
import { customerProjectionRegistry } from "../lib/server/projection-registry";
import {
  TEST_ALIAS_SECRET,
  TEST_CSRF,
  TEST_OTHER_PROJECT_ID,
  TEST_PROJECT_ID,
  TEST_SESSION,
  customerAuth,
  jsonResponse,
  snapshotFetcher,
  upstreamEvent,
  upstreamProject,
} from "./bff-fixtures";

describe("customer dashboard BFF", () => {
  beforeEach(() => {
    process.env.BUILDLABS_DASHBOARD_ALIAS_SECRET = TEST_ALIAS_SECRET;
    customerProjectionRegistry.clear();
  });

  it("rewrites only the complete session pair to the dashboard path", () => {
    const rewritten = rewriteDashboardCookies([
      "buildlabs_dashboard_session=session.v1.token; Path=/v1/orchestration/customer-dashboard; Max-Age=3600; HttpOnly; Secure; SameSite=Strict",
      `buildlabs_dashboard_csrf=${TEST_CSRF}; Path=/; Max-Age=3600; Secure; SameSite=Strict`,
      "provider_cookie=must-not-cross; Path=/; Max-Age=3600",
    ]);

    expect(rewritten.cookies).toHaveLength(2);
    expect(rewritten.cookies.every((cookie) => cookie.includes("Path=/"))).toBe(
      true,
    );
    expect(rewritten.cookies.join(" ")).not.toContain("provider_cookie");
    expect(rewritten.cookies[0]).toContain("HttpOnly");
  });

  it("exchanges a fragment capability for opaque routing and bounded cookies", async () => {
    const fetcher = vi.fn<DashboardFetch>(async (_input, init) => {
      expect(init?.body).toBe(JSON.stringify({ token: "login.v1.signed" }));
      const headers = new Headers({ "content-type": "application/json" });
      headers.append(
        "set-cookie",
        "buildlabs_dashboard_session=session.v1.issued; Path=/v1/orchestration/customer-dashboard; Max-Age=3600; HttpOnly; Secure; SameSite=Strict",
      );
      headers.append(
        "set-cookie",
        `buildlabs_dashboard_csrf=${TEST_CSRF}; Path=/; Max-Age=3600; Secure; SameSite=Strict`,
      );
      return new Response(
        JSON.stringify({
          redirectTo: `/dashboard/projects/${TEST_PROJECT_ID}`,
        }),
        { status: 200, headers },
      );
    });
    const response = await handleCustomerAccess(
      new Request("https://dashboard.buildlabs.test/v1/customer/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "login.v1.signed" }),
      }),
      fetcher,
    );
    const body = (await response.json()) as { redirectTo: string };
    const cookies = getSetCookieHeaders(response.headers);

    expect(response.status).toBe(200);
    expect(body.redirectTo).toMatch(/^\/dashboard\/projects\/prj_/);
    expect(JSON.stringify(body)).not.toContain(TEST_PROJECT_ID);
    expect(cookies).toHaveLength(3);
    expect(cookies.every((cookie) => cookie.includes("SameSite=Strict"))).toBe(
      true,
    );
  });

  it("keeps the capability out of the request URL and reissues once after failure", async () => {
    const response = await handleCustomerAccess(
      new Request("https://dashboard.buildlabs.test/v1/customer/access"),
    );
    const html = await response.text();
    const queryAttempt = await handleCustomerAccess(
      new Request(
        "https://dashboard.buildlabs.test/v1/customer/access?token=must-not-travel",
      ),
    );

    expect(response.status).toBe(200);
    expect(html).toContain('history.replaceState(null, "", location.pathname)');
    expect(html).toContain('location.pathname + "/requests"');
    expect(html).not.toContain("must-not-travel");
    expect(queryAttempt.status).toBe(404);
  });

  it("keeps access reissue generic across malformed and provider-failed requests", async () => {
    const failing = vi
      .fn<DashboardFetch>()
      .mockRejectedValue(new Error("provider unavailable"));
    const malformed = await handleCustomerAccessReissue(
      new Request(
        "https://dashboard.buildlabs.test/v1/customer/access/requests",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "<not-valid>" }),
        },
      ),
      failing,
    );
    const providerFailure = await handleCustomerAccessReissue(
      new Request(
        "https://dashboard.buildlabs.test/v1/customer/access/requests",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "login.v1.signed" }),
        },
      ),
      failing,
    );

    expect(malformed.status).toBe(202);
    expect(providerFailure.status).toBe(202);
    expect(await malformed.json()).toEqual({ status: "accepted" });
    expect(await providerFailure.json()).toEqual({ status: "accepted" });
  });

  it("rejects alias tampering and session replay across projects", () => {
    const context = createCustomerAliasContext({
      internalProjectId: TEST_PROJECT_ID,
      sessionToken: TEST_SESSION,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      secret: TEST_ALIAS_SECRET,
    });
    const sealed = sealCustomerAliasContext(context, TEST_ALIAS_SECRET);

    expect(() =>
      openCustomerAliasContext({
        sealed,
        projectAlias: customerAuth(TEST_SESSION, TEST_OTHER_PROJECT_ID)
          .projectAlias,
        sessionToken: TEST_SESSION,
        secret: TEST_ALIAS_SECRET,
      }),
    ).toThrow("valid customer session");
    expect(() =>
      openCustomerAliasContext({
        sealed,
        projectAlias: context.projectAlias,
        sessionToken: `${TEST_SESSION}-forged`,
        secret: TEST_ALIAS_SECRET,
      }),
    ).toThrow("valid customer session");
  });

  it("returns a raw allowlisted snapshot with a per-project cursor", async () => {
    const auth = customerAuth();
    const response = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(upstreamProject(), [upstreamEvent(91)]),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.projectId).toBe(auth.projectAlias);
    expect(body.eventCursor).toBe(1);
    expect(body).not.toHaveProperty("snapshot");
    expect(JSON.stringify(body)).not.toContain(TEST_PROJECT_ID);
  });

  it("fails closed on unsafe customer text instead of forwarding it", async () => {
    const auth = customerAuth();
    const snapshot = upstreamProject({
      revision: 1,
      status: "awaiting_payment",
      plan: {
        version: 1,
        title: "<script>unsafe</script>",
        summary: "A bounded project.",
        deliverables: [],
        requirements: [],
        unknowns: [],
      },
    });
    const response = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(snapshot, [
        upstreamEvent(91),
        upstreamEvent(107, {
          type: "proposal.created",
          status: "awaiting_payment",
        }),
      ]),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "invalid_customer_projection",
    });
  });

  it("does not register WIP fences before the complete snapshot validates", async () => {
    const auth = customerAuth();
    const runId = "run-unpaid-invalid-snapshot";
    const candidateId = "candidate-unpaid-invalid-snapshot";
    const snapshot = upstreamProject({
      revision: 1,
      status: "building",
      plan: {
        version: 1,
        title: "Customer project",
        summary: "A bounded project.",
        deliverables: [],
        requirements: [],
        unknowns: [],
      },
      payment: {
        state: "awaiting",
        verifiedAt: null,
      },
      activeBuild: {
        batchId: "batch-unpaid-invalid-snapshot",
        status: "building",
        proposalVersion: 1,
        requestedCandidateCount: 1,
        createdAt: "2026-07-24T12:00:01.000Z",
        completedAt: null,
        runs: [
          {
            runId,
            candidateId,
            status: "running",
            stage: "generating",
            progress: {
              completedToolCalls: 0,
              failedToolCalls: 0,
              repairRound: 0,
            },
            proof: { receiptCount: 0 },
            workspace: { state: "starting" },
            timeline: { items: [] },
            updatedAt: "2026-07-24T12:00:02.000Z",
            completedAt: null,
          },
        ],
      },
    });
    const response = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(snapshot, [
        upstreamEvent(91),
        upstreamEvent(107, {
          type: "build.batch_started",
          status: "building",
        }),
      ]),
    });
    const builderAlias = opaqueAlias(
      "bld",
      `${runId}\0${candidateId}`,
      TEST_ALIAS_SECRET,
    );

    expect(response.status).toBe(502);
    expect(
      customerProjectionRegistry.get(
        auth.projectAlias,
        builderAlias,
        sessionBinding(TEST_SESSION, TEST_ALIAS_SECRET),
      ),
    ).toBeUndefined();
  });

  it("fails closed on malformed or oversized contract collections", async () => {
    const auth = customerAuth();
    const validPlan = {
      version: 1,
      title: "Customer project",
      summary: "A bounded project.",
      deliverables: [{ id: "deliverable-1", text: "Primary deliverable" }],
      requirements: [
        { id: "requirement-1", text: "Primary requirement", priority: "hard" },
      ],
      unknowns: ["One open question"],
    };
    const invalidPlans: Array<{
      label: string;
      plan: Record<string, unknown>;
    }> = [
      {
        label: "non-array deliverables",
        plan: { ...validPlan, deliverables: "not-a-collection" },
      },
      {
        label: "malformed deliverable item",
        plan: {
          ...validPlan,
          deliverables: [{ id: "deliverable-1", text: 42 }],
        },
      },
      {
        label: "unknown requirement priority",
        plan: {
          ...validPlan,
          requirements: [
            {
              id: "requirement-1",
              text: "Primary requirement",
              priority: "optional",
            },
          ],
        },
      },
      {
        label: "malformed unknown",
        plan: { ...validPlan, unknowns: [{ text: "not a string" }] },
      },
      {
        label: "oversized deliverables",
        plan: {
          ...validPlan,
          deliverables: Array.from({ length: 501 }, (_, index) => ({
            id: `deliverable-${index}`,
            text: "Bounded deliverable",
          })),
        },
      },
    ];

    for (const { label, plan } of invalidPlans) {
      const response = await handleCustomerSnapshot({
        request: new Request(
          `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
          { headers: { cookie: auth.cookie } },
        ),
        projectAlias: auth.projectAlias,
        fetcher: snapshotFetcher(
          upstreamProject({
            revision: 1,
            status: "awaiting_payment",
            plan,
          }),
          [upstreamEvent(91), upstreamEvent(107)],
        ),
      });

      expect(response.status, label).toBe(502);
      expect(await response.json(), label).toMatchObject({
        error: "invalid_customer_projection",
      });
    }
  });

  it("fails closed on unknown batch, builder, and stage states", async () => {
    const auth = customerAuth();
    const invalidStates = [
      {
        label: "batch state",
        batchStatus: "future-batch-state",
        builderStatus: "running",
        stage: "generating",
      },
      {
        label: "builder state",
        batchStatus: "building",
        builderStatus: "future-builder-state",
        stage: "generating",
      },
      {
        label: "builder stage",
        batchStatus: "building",
        builderStatus: "running",
        stage: "future-builder-stage",
      },
    ];

    for (const invalid of invalidStates) {
      const response = await handleCustomerSnapshot({
        request: new Request(
          `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
          { headers: { cookie: auth.cookie } },
        ),
        projectAlias: auth.projectAlias,
        fetcher: snapshotFetcher(
          upstreamProject({
            revision: 1,
            status: "building",
            plan: {
              version: 1,
              title: "Customer project",
              summary: "A bounded project.",
              deliverables: [],
              requirements: [],
              unknowns: [],
            },
            payment: {
              state: "verified",
              verifiedAt: "2026-07-24T12:00:01.000Z",
            },
            activeBuild: {
              batchId: "internal-batch-1",
              status: invalid.batchStatus,
              proposalVersion: 1,
              requestedCandidateCount: 1,
              createdAt: "2026-07-24T12:00:01.000Z",
              completedAt: null,
              runs: [
                {
                  runId: "internal-run-1",
                  candidateId: "internal-candidate-1",
                  status: invalid.builderStatus,
                  stage: invalid.stage,
                  updatedAt: "2026-07-24T12:00:02.000Z",
                  completedAt: null,
                },
              ],
            },
          }),
          [upstreamEvent(91), upstreamEvent(107)],
        ),
      });

      expect(response.status, invalid.label).toBe(502);
      expect(await response.json(), invalid.label).toMatchObject({
        error: "invalid_customer_projection",
      });
    }
  });

  it("drops raw workspace, provider, and log fields from an active build", async () => {
    const auth = customerAuth();
    const snapshot = upstreamProject({
      revision: 1,
      status: "building",
      plan: {
        version: 1,
        title: "Customer project",
        summary: "A bounded project.",
        deliverables: [],
        requirements: [],
        unknowns: [],
      },
      payment: {
        state: "verified",
        verifiedAt: "2026-07-24T12:00:01.000Z",
        paymentIntentId: "must-not-cross",
      },
      activeBuild: {
        batchId: "internal-batch-1",
        status: "building",
        proposalVersion: 1,
        requestedCandidateCount: 1,
        createdAt: "2026-07-24T12:00:01.000Z",
        completedAt: null,
        runs: [
          {
            runId: "internal-run-1",
            candidateId: "internal-candidate-1",
            status: "running",
            stage: "generating",
            progress: {
              completedToolCalls: 2,
              failedToolCalls: 0,
              repairRound: 0,
            },
            proof: { receiptCount: 0 },
            workspace: {
              state: "starting",
              customerRenderable: false,
              sandboxId: "raw-workspace-id",
              url: "https://raw-preview.invalid",
            },
            timeline: {
              items: [
                {
                  sequence: 1,
                  occurredAt: "2026-07-24T12:00:02.000Z",
                  category: "workspace",
                  tool: "write_file",
                  succeeded: true,
                  rawLog: "provider output",
                },
              ],
            },
            updatedAt: "2026-07-24T12:00:02.000Z",
            completedAt: null,
          },
        ],
      },
    });
    const response = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(snapshot, [
        upstreamEvent(91),
        upstreamEvent(107, {
          type: "build.batch_started",
          status: "building",
        }),
      ]),
    });
    const encoded = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(encoded).not.toContain("internal-run-1");
    expect(encoded).not.toContain("internal-candidate-1");
    expect(encoded).not.toContain("raw-workspace-id");
    expect(encoded).not.toContain("raw-preview.invalid");
    expect(encoded).not.toContain("provider output");
    expect(encoded).not.toContain("paymentIntentId");
  });

  it("suppresses credentialed preview URLs and rejects proven artifact mismatches", async () => {
    const auth = customerAuth();
    const plan = {
      version: 1,
      title: "Customer project",
      summary: "A bounded project.",
      deliverables: [],
      requirements: [],
      unknowns: [],
    };
    const base = {
      revision: 1,
      status: "completed",
      plan,
      payment: {
        state: "verified",
        verifiedAt: "2026-07-24T12:00:01.000Z",
      },
    };
    const unsafeUrl = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(
        upstreamProject({
          ...base,
          deliverables: {
            frozenProvenPreview: {
              contractVersion: 1,
              artifactDigest: "a".repeat(64),
              revisionHash: "c".repeat(64),
              url: "https://user:secret@preview.example.test/",
              expiresAt: "2026-07-25T12:00:00.000Z",
              verifiedAt: "2026-07-24T12:00:02.000Z",
            },
            production: null,
          },
        }),
        [upstreamEvent(91), upstreamEvent(107)],
      ),
    });
    const unsafeBody = (await unsafeUrl.json()) as {
      preview: unknown;
    };
    const mismatch = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(
        upstreamProject({
          ...base,
          deliverables: {
            frozenProvenPreview: {
              contractVersion: 1,
              artifactDigest: "a".repeat(64),
              revisionHash: "c".repeat(64),
              url: "https://preview.example.test/",
              expiresAt: "2026-07-25T12:00:00.000Z",
              verifiedAt: "2026-07-24T12:00:02.000Z",
            },
            production: {
              contractVersion: 1,
              artifactDigest: "b".repeat(64),
              imageDigest: `sha256:${"d".repeat(64)}`,
              releaseVersion: 1,
              url: "https://production.example.test/",
              verifiedAt: "2026-07-24T12:00:03.000Z",
            },
          },
        }),
        [upstreamEvent(91), upstreamEvent(107)],
      ),
    });

    expect(unsafeUrl.status).toBe(200);
    expect(unsafeBody.preview).toBeNull();
    expect(mismatch.status).toBe(502);
  });

  it("retains a canonical domain image digest for a verified production receipt", async () => {
    const auth = customerAuth();
    const artifactDigest = "a".repeat(64);
    const imageDigest = "d".repeat(64);
    const response = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(
        upstreamProject({
          revision: 1,
          status: "completed",
          plan: {
            version: 1,
            title: "Customer project",
            summary: "A bounded project.",
            deliverables: [],
            requirements: [],
            unknowns: [],
          },
          payment: {
            state: "verified",
            verifiedAt: "2026-07-24T12:00:01.000Z",
          },
          deliverables: {
            frozenProvenPreview: {
              contractVersion: 1,
              artifactDigest,
              revisionHash: "c".repeat(64),
              url: "https://preview.example.test/",
              expiresAt: "2026-07-25T12:00:00.000Z",
              verifiedAt: "2026-07-24T12:00:02.000Z",
            },
            production: {
              contractVersion: 1,
              artifactDigest,
              imageDigest: `sha256:${imageDigest}`,
              releaseVersion: 1,
              url: "https://production.example.test/",
              verifiedAt: "2026-07-24T12:00:03.000Z",
            },
          },
        }),
        [upstreamEvent(91), upstreamEvent(107)],
      ),
    });
    const body = (await response.json()) as {
      currentProductionVersion: number | null;
      pendingAction: string;
      production: { imageDigest: string } | null;
    };

    expect(response.status).toBe(200);
    expect(body.currentProductionVersion).toBe(1);
    expect(body.pendingAction).toBe("open_production");
    expect(body.production?.imageDigest).toBe(imageDigest);
  });

  it("enforces CSRF and maps stale steering without leaking internal IDs", async () => {
    const auth = customerAuth();
    const fetcher = vi.fn<DashboardFetch>(async (input) => {
      expect(String(input)).toContain(TEST_PROJECT_ID);
      return jsonResponse({ error: "orchestration_conflict" }, { status: 409 });
    });
    const body = JSON.stringify({
      expectedRevision: 3,
      expectedProposalVersion: 1,
      subject: "Primary action",
      content: "Please make the primary action more prominent.",
    });
    const missingCsrf = await handleCustomerSteering({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/steering`,
        {
          method: "POST",
          headers: {
            cookie: auth.cookie,
            "content-type": "application/json",
            "idempotency-key": "steering-001",
          },
          body,
        },
      ),
      projectAlias: auth.projectAlias,
      fetcher,
    });
    const stale = await handleCustomerSteering({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/steering`,
        {
          method: "POST",
          headers: {
            cookie: auth.cookie,
            "content-type": "application/json",
            "idempotency-key": "steering-001",
            "x-buildlabs-csrf": TEST_CSRF,
          },
          body,
        },
      ),
      projectAlias: auth.projectAlias,
      fetcher,
    });

    expect(missingCsrf.status).toBe(403);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "project_changed",
      message: "The project changed before the request could be applied",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears only the local stateless session and does not claim revocation", async () => {
    const auth = customerAuth();
    const response = handleCustomerLogout(
      new Request("https://dashboard.buildlabs.test/logout", {
        method: "POST",
        headers: {
          cookie: auth.cookie,
          "x-buildlabs-csrf": TEST_CSRF,
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "local_session_cleared",
      globalRevocation: false,
    });
    const cookies = getSetCookieHeaders(response.headers);
    expect(cookies).toHaveLength(3);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });

  it("keeps the logout race boundary explicit for copied stateless cookies", async () => {
    const auth = customerAuth();
    handleCustomerLogout(
      new Request("https://dashboard.buildlabs.test/logout", {
        method: "POST",
        headers: {
          cookie: auth.cookie,
          "x-buildlabs-csrf": TEST_CSRF,
        },
      }),
    );
    const racedRead = await handleCustomerSnapshot({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(upstreamProject(), [upstreamEvent(91)]),
    });

    // Clearing the browser cookie is not represented as server-side revocation.
    expect(racedRead.status).toBe(200);
  });
});
