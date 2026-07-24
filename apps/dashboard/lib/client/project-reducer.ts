import {
  type CustomerEvent,
  type CustomerProjectSnapshot,
  parseCustomerEvent,
  parseCustomerProjectSnapshot,
} from "../contracts/customer";

const MAX_TIMELINE_EVENTS = 250;
const MAX_SEEN_EVENT_IDS = 1_000;

export type CustomerProjectSyncState =
  "synced" | "snapshot_required" | "reset_required";

export type CustomerProjectSyncReason =
  | "newer_aggregate_revision"
  | "event_gap"
  | "event_identity_conflict"
  | "project_mismatch"
  | "snapshot_cursor_regressed"
  | "event_revision_regressed"
  | null;

export interface CustomerProjectReducerState {
  snapshot: CustomerProjectSnapshot;
  events: CustomerEvent[];
  cursor: number;
  seenEventIds: string[];
  syncState: CustomerProjectSyncState;
  syncReason: CustomerProjectSyncReason;
  lastEventAt: string | null;
  duplicateEventCount: number;
  staleEventCount: number;
  staleSnapshotCount: number;
}

export type CustomerProjectReducerAction =
  { type: "event"; event: unknown } | { type: "snapshot"; snapshot: unknown };

export function initialReducerState(
  value: unknown,
): CustomerProjectReducerState {
  const snapshot = parseCustomerProjectSnapshot(value);
  return {
    snapshot,
    events: [],
    cursor: snapshot.eventCursor,
    seenEventIds: [],
    syncState: "synced",
    syncReason: null,
    lastEventAt: null,
    duplicateEventCount: 0,
    staleEventCount: 0,
    staleSnapshotCount: 0,
  };
}

export function reduceCustomerEvent(
  state: CustomerProjectReducerState,
  value: unknown,
): CustomerProjectReducerState {
  const event = parseCustomerEvent(value);
  if (event.projectId !== state.snapshot.projectId) {
    return requireReset(state, "project_mismatch");
  }

  const knownById = state.events.find(
    (candidate) => candidate.eventId === event.eventId,
  );
  const knownBySequence = state.events.find(
    (candidate) => candidate.sequence === event.sequence,
  );
  const eventIdWasSeen = state.seenEventIds.includes(event.eventId);
  if (
    (knownById !== undefined && knownById.sequence !== event.sequence) ||
    (eventIdWasSeen && event.sequence > state.cursor) ||
    (knownBySequence !== undefined && knownBySequence.eventId !== event.eventId)
  ) {
    return requireReset(state, "event_identity_conflict");
  }
  if (
    (knownById !== undefined && knownById.sequence === event.sequence) ||
    (eventIdWasSeen && event.sequence <= state.cursor) ||
    (event.sequence <= state.cursor && knownBySequence !== undefined)
  ) {
    return {
      ...state,
      duplicateEventCount: state.duplicateEventCount + 1,
    };
  }
  if (event.sequence <= state.cursor) {
    return {
      ...state,
      staleEventCount: state.staleEventCount + 1,
    };
  }
  if (event.sequence !== state.cursor + 1) {
    return requireReset(state, "event_gap");
  }
  if (event.aggregateRevision < state.snapshot.aggregateRevision) {
    return requireReset(state, "event_revision_regressed");
  }

  const nextEvents = [...state.events, event].slice(-MAX_TIMELINE_EVENTS);
  const nextSeen = [...state.seenEventIds, event.eventId].slice(
    -MAX_SEEN_EVENT_IDS,
  );
  const needsSnapshot =
    event.aggregateRevision > state.snapshot.aggregateRevision;
  return {
    ...state,
    events: nextEvents,
    seenEventIds: nextSeen,
    cursor: event.sequence,
    syncState: needsSnapshot ? "snapshot_required" : state.syncState,
    syncReason: needsSnapshot ? "newer_aggregate_revision" : state.syncReason,
    lastEventAt: event.occurredAt,
  };
}

export function applyCustomerSnapshot(
  state: CustomerProjectReducerState,
  value: unknown,
): CustomerProjectReducerState {
  const snapshot = parseCustomerProjectSnapshot(value);
  if (snapshot.projectId !== state.snapshot.projectId) {
    return requireReset(state, "project_mismatch");
  }
  if (
    snapshot.aggregateRevision < state.snapshot.aggregateRevision ||
    (snapshot.aggregateRevision === state.snapshot.aggregateRevision &&
      snapshot.eventCursor < state.snapshot.eventCursor)
  ) {
    return {
      ...state,
      staleSnapshotCount: state.staleSnapshotCount + 1,
    };
  }
  if (
    snapshot.aggregateRevision > state.snapshot.aggregateRevision &&
    snapshot.eventCursor < state.cursor
  ) {
    return requireReset(state, "snapshot_cursor_regressed");
  }
  if (snapshot.eventCursor < state.cursor) {
    return {
      ...state,
      staleSnapshotCount: state.staleSnapshotCount + 1,
    };
  }
  return {
    ...state,
    snapshot,
    cursor: snapshot.eventCursor,
    syncState: "synced",
    syncReason: null,
  };
}

export function customerProjectReducer(
  state: CustomerProjectReducerState,
  action: CustomerProjectReducerAction,
): CustomerProjectReducerState {
  return action.type === "event"
    ? reduceCustomerEvent(state, action.event)
    : applyCustomerSnapshot(state, action.snapshot);
}

function requireReset(
  state: CustomerProjectReducerState,
  reason: Exclude<CustomerProjectSyncReason, "newer_aggregate_revision" | null>,
): CustomerProjectReducerState {
  return {
    ...state,
    syncState: "reset_required",
    syncReason: reason,
  };
}
