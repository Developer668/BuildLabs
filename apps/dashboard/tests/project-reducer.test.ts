import { describe, expect, it } from "vitest";

import {
  applyCustomerSnapshot,
  initialReducerState,
  reduceCustomerEvent,
} from "../lib/client/project-reducer";
import {
  CUSTOMER_FIXTURE_PROJECT_ID,
  customerEventFixtures,
  customerFixtureSnapshot,
  customerProjectFixture,
} from "../lib/fixtures/customer-project";

describe("customer snapshot and event replay reducer", () => {
  it("starts at the snapshot cursor without inferred activity", () => {
    const state = initialReducerState(customerProjectFixture);
    expect(state.cursor).toBe(48);
    expect(state.events).toEqual([]);
    expect(state.syncState).toBe("synced");
  });

  it("applies ordered events and makes exact duplicates inert", () => {
    const initial = initialReducerState(customerProjectFixture);
    const afterFirst = reduceCustomerEvent(initial, customerEventFixtures[0]);
    const afterDuplicate = reduceCustomerEvent(
      afterFirst,
      customerEventFixtures[0],
    );

    expect(afterFirst.cursor).toBe(49);
    expect(afterFirst.events).toHaveLength(1);
    expect(afterDuplicate.cursor).toBe(49);
    expect(afterDuplicate.events).toHaveLength(1);
    expect(afterDuplicate.duplicateEventCount).toBe(1);
  });

  it("requires reset for event gaps and conflicting identities", () => {
    const initial = initialReducerState(customerProjectFixture);
    const gap = reduceCustomerEvent(initial, customerEventFixtures[1]);
    expect(gap.syncState).toBe("reset_required");
    expect(gap.syncReason).toBe("event_gap");
    expect(gap.cursor).toBe(48);

    const first = reduceCustomerEvent(initial, customerEventFixtures[0]);
    const conflict = reduceCustomerEvent(first, {
      ...customerEventFixtures[0],
      eventId: "evt_zzzzzzzzzzzzzzzzzzzzzz",
    });
    expect(conflict.syncState).toBe("reset_required");
    expect(conflict.syncReason).toBe("event_identity_conflict");
  });

  it("ignores stale tail events without rolling state backward", () => {
    const state = initialReducerState(customerProjectFixture);
    const stale = reduceCustomerEvent(state, {
      ...customerEventFixtures[0],
      eventId: "evt_eeeeeeeeeeeeeeeeeeeeee",
      sequence: 47,
      aggregateRevision: 26,
    });

    expect(stale.cursor).toBe(48);
    expect(stale.staleEventCount).toBe(1);
    expect(stale.snapshot.aggregateRevision).toBe(27);
  });

  it("requests a snapshot for a newer aggregate without inventing lifecycle state", () => {
    const state = initialReducerState(customerProjectFixture);
    const next = reduceCustomerEvent(state, customerEventFixtures[0]);

    expect(next.syncState).toBe("snapshot_required");
    expect(next.syncReason).toBe("newer_aggregate_revision");
    expect(next.snapshot.lifecycle.canonical).toBe("building");
    expect(next.cursor).toBe(49);
  });

  it("accepts snapshot-plus-tail recovery and ignores stale snapshots", () => {
    const state = customerEventFixtures.reduce(
      (current, event) => reduceCustomerEvent(current, event),
      initialReducerState(customerProjectFixture),
    );
    expect(state.cursor).toBe(52);
    expect(state.events).toHaveLength(4);

    const recovered = applyCustomerSnapshot(
      state,
      customerFixtureSnapshot({
        aggregateRevision: 28,
        eventCursor: 52,
        updatedAt: "2026-07-24T16:19:12.000Z",
      }),
    );
    expect(recovered.syncState).toBe("synced");
    expect(recovered.cursor).toBe(52);

    const stale = applyCustomerSnapshot(recovered, customerProjectFixture);
    expect(stale.snapshot.aggregateRevision).toBe(28);
    expect(stale.cursor).toBe(52);
    expect(stale.staleSnapshotCount).toBe(1);
  });

  it("fences cross-project events and snapshots", () => {
    const state = initialReducerState(customerProjectFixture);
    const forgedProject = "prj_zyxwvutsrqponmlkjihgfe";
    expect(forgedProject).not.toBe(CUSTOMER_FIXTURE_PROJECT_ID);

    const eventResult = reduceCustomerEvent(state, {
      ...customerEventFixtures[0],
      projectId: forgedProject,
    });
    expect(eventResult.syncState).toBe("reset_required");
    expect(eventResult.syncReason).toBe("project_mismatch");

    const snapshotResult = applyCustomerSnapshot(
      state,
      customerFixtureSnapshot({ projectId: forgedProject }),
    );
    expect(snapshotResult.syncState).toBe("reset_required");
    expect(snapshotResult.syncReason).toBe("project_mismatch");
  });

  it("preserves all four simultaneous candidate transitions in server order", () => {
    const state = customerEventFixtures.reduce(
      (current, event) => reduceCustomerEvent(current, event),
      initialReducerState(customerProjectFixture),
    );

    expect(state.events.map((event) => event.sequence)).toEqual([
      49, 50, 51, 52,
    ]);
    expect(state.events.map((event) => event.data.builderId)).toEqual([
      "bld_aaaaaaaaaaaaaaaaaaaaaa",
      "bld_bbbbbbbbbbbbbbbbbbbbbb",
      "bld_cccccccccccccccccccccc",
      "bld_dddddddddddddddddddddd",
    ]);
  });
});
