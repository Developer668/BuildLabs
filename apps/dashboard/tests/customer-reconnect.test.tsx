import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCustomerProject } from "../components/use-customer-project";
import {
  CUSTOMER_FIXTURE_PROJECT_ID,
  customerProjectFixture,
} from "../lib/fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("customer project stream recovery", () => {
  it("backs off before retrying a stale stream cursor", async () => {
    vi.useFakeTimers();
    let eventRequests = 0;
    let snapshotRequests = 0;
    let resolveFirstSnapshotRequest!: () => void;
    const firstSnapshotRequest = new Promise<void>((resolve) => {
      resolveFirstSnapshotRequest = resolve;
    });
    const fetchMock = vi.fn(
      async (request: RequestInfo | URL): Promise<Response> => {
        if (String(request).endsWith("/events")) {
          eventRequests += 1;
          return new Response(null, { status: 409 });
        }
        snapshotRequests += 1;
        resolveFirstSnapshotRequest();
        return Response.json(customerProjectFixture);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = renderHook(() =>
      useCustomerProject({
        fixture: false,
        initialSnapshot: customerProjectFixture,
        projectAlias: CUSTOMER_FIXTURE_PROJECT_ID,
      }),
    );

    await act(async () => {
      await firstSnapshotRequest;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(eventRequests).toBe(1);
    expect(snapshotRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(eventRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(eventRequests).toBe(2);
    expect(snapshotRequests).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(eventRequests).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(eventRequests).toBe(3);

    view.unmount();
  });
});
