import { beforeEach, describe, expect, it } from "vitest";

import {
  CustomerStreamCapacity,
  customerStreamCapacity,
  handleCustomerEventStream,
} from "../lib/server/customer-stream";
import { validateEventWindow } from "../lib/server/customer-snapshot";
import type { DashboardFetch } from "../lib/server/orchestration-client";
import {
  TEST_ALIAS_SECRET,
  customerAuth,
  jsonResponse,
  snapshotFetcher,
  upstreamEvent,
  upstreamProject,
} from "./bff-fixtures";

describe("customer project SSE", () => {
  beforeEach(() => {
    process.env.BUILDLABS_DASHBOARD_ALIAS_SECRET = TEST_ALIAS_SECRET;
    customerStreamCapacity.clear();
  });

  it("rejects duplicate and out-of-order upstream windows", () => {
    expect(() =>
      validateEventWindow(
        {
          items: [upstreamEvent(12), upstreamEvent(11)],
          nextAfterSequence: 11,
          hasMore: false,
        },
        10,
      ),
    ).toThrow("invalid customer projection");
    expect(() =>
      validateEventWindow(
        {
          items: [upstreamEvent(12), upstreamEvent(12)],
          nextAfterSequence: 12,
          hasMore: false,
        },
        10,
      ),
    ).toThrow("invalid customer projection");
  });

  it("emits one current snapshot then closes before unsafe ordering is exposed", async () => {
    const auth = customerAuth();
    const fetcher: DashboardFetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/events")) {
        return jsonResponse(upstreamProject());
      }
      const after = Number(url.searchParams.get("afterSequence"));
      if (after === 0) {
        return jsonResponse({
          items: [upstreamEvent(10)],
          nextAfterSequence: 10,
          hasMore: false,
        });
      }
      return jsonResponse({
        items: [upstreamEvent(12), upstreamEvent(11)],
        nextAfterSequence: 11,
        hasMore: false,
      });
    };
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("event: snapshot");
    expect(body).not.toContain("event: project_event");
    expect(customerStreamCapacity.active).toBe(0);
  });

  it("maps four simultaneous candidate transitions to contiguous public cursors", async () => {
    const auth = customerAuth();
    let snapshotReads = 0;
    const allEvents = [
      upstreamEvent(10),
      upstreamEvent(20, {
        type: "build.run_updated",
        status: "building",
        runId: "run-1",
        candidateId: "candidate-1",
      }),
      upstreamEvent(30, {
        type: "build.run_updated",
        status: "building",
        runId: "run-2",
        candidateId: "candidate-2",
      }),
      upstreamEvent(40, {
        type: "build.run_updated",
        status: "building",
        runId: "run-3",
        candidateId: "candidate-3",
      }),
      upstreamEvent(50, {
        type: "build.run_updated",
        status: "building",
        runId: "run-4",
        candidateId: "candidate-4",
      }),
    ];
    const fetcher: DashboardFetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/events")) {
        snapshotReads += 1;
        return jsonResponse(
          upstreamProject({
            revision: snapshotReads === 1 ? 0 : 4,
            updatedAt:
              snapshotReads === 1
                ? "2026-07-24T12:00:00.000Z"
                : "2026-07-24T12:00:04.000Z",
          }),
        );
      }
      const after = Number(url.searchParams.get("afterSequence"));
      const limit = Number(url.searchParams.get("limit"));
      const remaining = allEvents.filter(
        (event) => Number(event.sequence) > after,
      );
      const items = remaining.slice(0, limit);
      return jsonResponse({
        items,
        nextAfterSequence: Number(items.at(-1)?.sequence) || after,
        hasMore: remaining.length > items.length,
      });
    };
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    const transitions = decoder.decode((await reader.read()).value);
    await reader.cancel();
    await Promise.resolve();

    expect(first).toContain("id: 1\nevent: snapshot");
    expect(transitions.match(/event: project_event/g)).toHaveLength(4);
    expect(transitions).toContain("id: 2");
    expect(transitions).toContain("id: 3");
    expect(transitions).toContain("id: 4");
    expect(transitions).toContain("id: 5");
    expect(transitions).not.toContain("run-1");
    expect(transitions).not.toContain("candidate-1");
    expect(customerStreamCapacity.active).toBe(0);
  });

  it("rejects forged future Last-Event-ID values", async () => {
    const auth = customerAuth();
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        {
          headers: {
            cookie: auth.cookie,
            "last-event-id": "99",
          },
        },
      ),
      projectAlias: auth.projectAlias,
      fetcher: async (input) => {
        const url = new URL(String(input));
        return url.pathname.endsWith("/events")
          ? jsonResponse({
              items: [upstreamEvent(10)],
              nextAfterSequence: 10,
              hasMore: false,
            })
          : jsonResponse(upstreamProject());
      },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "cursor_ahead",
    });
    expect(customerStreamCapacity.active).toBe(0);
  });

  it("resumes after a valid public cursor without replaying a snapshot", async () => {
    const auth = customerAuth();
    const allEvents = [
      upstreamEvent(10),
      upstreamEvent(40, {
        type: "proposal.created",
        status: "awaiting_payment",
      }),
    ];
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        {
          headers: {
            cookie: auth.cookie,
            "last-event-id": "1",
          },
        },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(
        upstreamProject({
          revision: 1,
          status: "awaiting_payment",
          plan: {
            version: 1,
            title: "Customer project",
            summary: "A bounded project.",
            deliverables: [],
            requirements: [],
            unknowns: [],
          },
        }),
        allEvents,
      ),
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const prelude = decoder.decode((await reader.read()).value);
    const event = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(prelude).toBe("retry: 2000\n\n");
    expect(event).toContain("id: 2\nevent: project_event");
    expect(event).not.toContain("event: snapshot");
  });

  it("treats public cursor zero as a valid replay position", async () => {
    const auth = customerAuth();
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        {
          headers: {
            cookie: auth.cookie,
            "last-event-id": "0",
          },
        },
      ),
      projectAlias: auth.projectAlias,
      fetcher: snapshotFetcher(upstreamProject(), [upstreamEvent(10)]),
      pollIntervalMs: 5,
      heartbeatIntervalMs: 60_000,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const prelude = decoder.decode((await reader.read()).value);
    const event = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(response.status).toBe(200);
    expect(prelude).toBe("retry: 2000\n\n");
    expect(event).toContain("id: 1\nevent: project_event");
    expect(event).not.toContain("event: snapshot");
  });

  it("fails a stale snapshot whose revision has no matching durable event", async () => {
    const auth = customerAuth();
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher: async (input) => {
        const url = new URL(String(input));
        return url.pathname.endsWith("/events")
          ? jsonResponse({
              items:
                Number(url.searchParams.get("afterSequence")) === 0
                  ? [upstreamEvent(10)]
                  : [],
              nextAfterSequence: 10,
              hasMore: false,
            })
          : jsonResponse(upstreamProject({ revision: 1 }));
      },
    });

    expect(response.status).toBe(502);
    expect(customerStreamCapacity.active).toBe(0);
  });

  it("sends heartbeats without advancing the event cursor", async () => {
    const auth = customerAuth();
    const fetcher: DashboardFetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/events")) {
        return jsonResponse(upstreamProject());
      }
      const after = Number(url.searchParams.get("afterSequence"));
      return jsonResponse({
        items: after === 0 ? [upstreamEvent(10)] : [],
        nextAfterSequence: after === 0 ? 10 : after,
        hasMore: false,
      });
    };
    const response = await handleCustomerEventStream({
      request: new Request(
        `https://dashboard.buildlabs.test/v1/customer/projects/${auth.projectAlias}/events`,
        { headers: { cookie: auth.cookie } },
      ),
      projectAlias: auth.projectAlias,
      fetcher,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 5,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const snapshot = decoder.decode((await reader.read()).value);
    const heartbeat = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(snapshot).toContain("event: snapshot");
    expect(heartbeat).toMatch(/^: heartbeat \d+\n\n$/);
    expect(heartbeat).not.toContain("id:");
  });

  it("caps streams per customer session and releases leases once", () => {
    const capacity = new CustomerStreamCapacity();
    const leases = Array.from({ length: 4 }, () => capacity.acquire("same"));

    expect(leases.every(Boolean)).toBe(true);
    expect(capacity.acquire("same")).toBeUndefined();
    expect(capacity.active).toBe(4);
    leases[0]!.release();
    leases[0]!.release();
    expect(capacity.active).toBe(3);
    expect(capacity.acquire("same")).toBeDefined();
  });
});
