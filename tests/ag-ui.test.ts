import { randomUUID } from "node:crypto";

import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import { AGUI_MEDIA_TYPE, EventEncoder } from "@ag-ui/encoder";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import {
  AG_UI_MAX_ACTIVE_STREAMS,
  AG_UI_MAX_INPUT_BYTES,
  BUILD_RUN_ACTIVITY_TYPE,
  BUILD_RUN_EVENT_NAME,
  BUILD_RUN_KEEPALIVE_NAME,
  AgUiInputError,
  buildRunActivityMessageId,
  createBuildRunAgUiHandler,
  parseBuildLabsAgUiRunInput,
  streamBuildRunAsAgUi,
} from "../src/http/ag-ui.js";
import type { RunStore } from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

describe("BuildLabs AG-UI transport", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("parses bounded official RunAgentInput without accepting client tools", () => {
    const buildRunId = randomUUID();
    const parsed = parseBuildLabsAgUiRunInput(runInput(buildRunId));
    expect(parsed.forwardedProps).toEqual({
      buildRunId,
      afterSequence: 0,
    });

    expect(() =>
      parseBuildLabsAgUiRunInput({
        ...runInput(buildRunId),
        tools: [
          {
            name: "cancel_anything",
            description: "Untrusted client tool",
            parameters: {},
          },
        ],
      }),
    ).toThrow(/Client-provided tools/);

    expect(() =>
      parseBuildLabsAgUiRunInput({
        ...runInput(buildRunId),
        forwardedProps: { buildRunId: "not-a-uuid" },
      }),
    ).toThrow(/valid UUID/);

    expect(() =>
      parseBuildLabsAgUiRunInput({
        ...runInput(buildRunId),
        runId: buildRunId,
      }),
    ).toThrow(/must be distinct/);

    expect(() =>
      parseBuildLabsAgUiRunInput({
        ...runInput(buildRunId),
        state: { padding: "x".repeat(AG_UI_MAX_INPUT_BYTES) },
      }),
    ).toThrow(AgUiInputError);

    expect(() =>
      parseBuildLabsAgUiRunInput({
        ...runInput(buildRunId),
        resume: [{ interruptId: "unsupported", payload: {} }],
      }),
    ).toThrow(/Interrupt resume entries/);
  });

  it("resumes durable observation after an explicit sequence", async () => {
    const run = store.createRun(assignment("ag-ui-resume")).run;
    store.requestCancel(run.id);
    const history = store.listEvents(run.id, 0);
    const afterSequence = history[0]!.sequence;
    const input = parseBuildLabsAgUiRunInput({
      ...runInput(run.id),
      forwardedProps: { buildRunId: run.id, afterSequence },
    });

    const events = await collectEvents(streamBuildRunAsAgUi(input, store));
    const replayed = events
      .filter(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === BUILD_RUN_EVENT_NAME,
      )
      .map((event): unknown => event.value);

    expect(replayed).toEqual(
      history.filter((event) => event.sequence > afterSequence),
    );
    expect(
      events.find((event) => event.type === EventType.STATE_SNAPSHOT),
    ).toMatchObject({
      snapshot: { cursor: history.at(-1)!.sequence },
    });
  });

  it("replays every durable event and finishes domain failures normally", async () => {
    const run = store.createRun(assignment("ag-ui-terminal")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.markFailed(run.id, lease, "sandbox_failed", "Sandbox failed");
    const input = parseBuildLabsAgUiRunInput(runInput(run.id));

    const events = await collectEvents(
      streamBuildRunAsAgUi(input, store, {
        waitForPoll: () => Promise.resolve(),
      }),
    );
    const customEvents = events.filter(
      (event) =>
        event.type === EventType.CUSTOM && event.name === BUILD_RUN_EVENT_NAME,
    );

    expect(customEvents.map((event): unknown => event.value)).toEqual(
      store.listEvents(run.id, 0),
    );
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.CUSTOM,
      EventType.CUSTOM,
      EventType.STATE_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      result: {
        buildRunId: run.id,
        status: "failed",
      },
      outcome: { type: "success" },
    });
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    events.forEach((event) => {
      expect(EventSchemas.safeParse(event).success).toBe(true);
    });
  });

  it("performs a final durable read before finishing a concurrently terminal run", async () => {
    const buildRunId = randomUUID();
    const input = parseBuildLabsAgUiRunInput(runInput(buildRunId));
    const durableEvents = [
      {
        sequence: 1,
        runId: buildRunId,
        type: "run.queued",
        stage: "queued" as const,
        payload: {},
        createdAt: "2026-07-23T12:00:00.000Z",
      },
      {
        sequence: 2,
        runId: buildRunId,
        type: "run.cancelled",
        stage: "complete" as const,
        payload: {},
        createdAt: "2026-07-23T12:00:01.000Z",
      },
    ];
    let reads = 0;
    const racingStore = {
      getRun: () => ({
        id: buildRunId,
        assignmentId: "assignment",
        assignmentHash: "a".repeat(64),
        projectId: "project",
        candidateId: "candidate",
        contractHash: "b".repeat(64),
        status: "cancelled",
        stage: "complete",
        cancelRequested: true,
        createdAt: "2026-07-23T12:00:00.000Z",
        updatedAt: "2026-07-23T12:00:01.000Z",
        completedAt: "2026-07-23T12:00:01.000Z",
      }),
      listEvents: (_runId: string, afterSequence: number) => {
        reads += 1;
        if (reads === 1) {
          return durableEvents.filter(
            (event) => event.sequence === 1 && event.sequence > afterSequence,
          );
        }
        return durableEvents.filter((event) => event.sequence > afterSequence);
      },
      getAssignment: () => assignment("ag-ui-racing"),
      listEvidence: () => [],
      getArtifact: () => undefined,
    } as unknown as RunStore;

    const events = await collectEvents(
      streamBuildRunAsAgUi(input, racingStore),
    );
    const replayed = events
      .filter(
        (event) =>
          event.type === EventType.CUSTOM &&
          event.name === BUILD_RUN_EVENT_NAME,
      )
      .map((event): unknown => event.value);

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(replayed).toEqual(durableEvents);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("keeps a stable activity identity while following a live run", async () => {
    const run = store.createRun(assignment("ag-ui-live")).run;
    const input = parseBuildLabsAgUiRunInput(runInput(run.id));
    let polls = 0;

    const events = await collectEvents(
      streamBuildRunAsAgUi(input, store, {
        waitForPoll: () => {
          polls += 1;
          store.requestCancel(run.id);
          return Promise.resolve();
        },
      }),
    );
    const activities = events.filter(
      (event) => event.type === EventType.ACTIVITY_SNAPSHOT,
    );

    expect(polls).toBe(1);
    expect(activities).toHaveLength(2);
    expect(new Set(activities.map((event) => event.messageId))).toEqual(
      new Set([buildRunActivityMessageId(run.id)]),
    );
    expect(activities[0]).toMatchObject({
      activityType: BUILD_RUN_ACTIVITY_TYPE,
      content: { status: "queued", stage: "queued" },
      replace: true,
    });
    expect(activities[1]).toMatchObject({
      content: { status: "cancelled", stage: "complete" },
    });
  });

  it("does not rescan full durable progress history for each snapshot", async () => {
    const run = store.createRun(assignment("ag-ui-incremental")).run;
    const listEvents = vi.spyOn(store, "listEvents");

    await collectEvents(
      streamBuildRunAsAgUi(
        parseBuildLabsAgUiRunInput(runInput(run.id)),
        store,
        {
          waitForPoll: () => {
            store.requestCancel(run.id);
            return Promise.resolve();
          },
        },
      ),
    );

    expect(
      listEvents.mock.calls.filter(
        ([runId, afterSequence]) => runId === run.id && afterSequence === 0,
      ),
    ).toHaveLength(1);
  });

  it("exposes contract, agent progress, and proof summaries in state", async () => {
    const run = store.createRun(assignment("ag-ui-state")).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    store.startRun(run.id, lease);
    store.updateStage(run.id, lease, "generating");
    store.recordAgentProgress(run.id, lease, {
      step: 1,
      repairRound: 0,
      toolName: "write_files",
      ok: true,
    });
    store.markCancelled(run.id, lease);

    const events = await collectEvents(
      streamBuildRunAsAgUi(parseBuildLabsAgUiRunInput(runInput(run.id)), store),
    );
    expect(
      events.find((event) => event.type === EventType.STATE_SNAPSHOT),
    ).toMatchObject({
      snapshot: {
        candidate: {
          contract: {
            approvedFactCount: 1,
            hardRequirementCount: 1,
            preferenceCount: 1,
          },
          progress: {
            completedToolCalls: 1,
            failedToolCalls: 0,
            lastToolName: "write_files",
            repairRound: 0,
          },
          proof: {
            receiptCount: 0,
            passCount: 0,
            failCount: 0,
            errorCount: 0,
            artifactAvailable: false,
          },
        },
      },
    });
  });

  it("emits a protocol-valid keepalive only after a long idle interval", async () => {
    const run = store.createRun(assignment("ag-ui-keepalive")).run;
    const input = parseBuildLabsAgUiRunInput(runInput(run.id));
    let now = 0;

    const events = await collectEvents(
      streamBuildRunAsAgUi(input, store, {
        now: () => now,
        keepaliveIntervalMs: 10_000,
        waitForPoll: () => {
          now += 5_000;
          if (now === 15_000) {
            store.requestCancel(run.id);
          }
          return Promise.resolve();
        },
      }),
    );
    const keepalives = events.filter(
      (event) =>
        event.type === EventType.CUSTOM &&
        event.name === BUILD_RUN_KEEPALIVE_NAME,
    );

    expect(keepalives).toEqual([
      {
        type: EventType.CUSTOM,
        name: BUILD_RUN_KEEPALIVE_NAME,
        value: {
          buildRunId: run.id,
          cursor: store.listEvents(run.id, 0)[0]!.sequence,
        },
      },
    ]);
    expect(EventSchemas.safeParse(keepalives[0]).success).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it("uses RUN_ERROR only when the observer transport itself fails", async () => {
    const buildRunId = randomUUID();
    const input = parseBuildLabsAgUiRunInput(runInput(buildRunId));
    const brokenStore = {
      getRun: () => ({
        id: buildRunId,
        assignmentId: "assignment",
        assignmentHash: "a".repeat(64),
        projectId: "project",
        candidateId: "candidate",
        contractHash: "b".repeat(64),
        status: "running",
        stage: "generating",
        cancelRequested: false,
        createdAt: "2026-07-23T12:00:00.000Z",
        updatedAt: "2026-07-23T12:00:00.000Z",
      }),
      listEvents: () => {
        throw new Error("database unavailable");
      },
    } as unknown as RunStore;

    const events = await collectEvents(
      streamBuildRunAsAgUi(input, brokenStore),
    );
    expect(events).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.RUN_ERROR,
        code: "buildlabs_ag_ui_internal_error",
        message: "The build-run event stream failed",
      },
    ]);
  });

  it("streams negotiated SSE and protobuf from a Fastify handler", async () => {
    const run = store.createRun(assignment("ag-ui-handler")).run;
    store.requestCancel(run.id);
    const input = parseBuildLabsAgUiRunInput(runInput(run.id));
    const expectedEvents = await collectEvents(
      streamBuildRunAsAgUi(input, store),
    );
    const server = Fastify();
    server.post(
      "/ag-ui",
      createBuildRunAgUiHandler({ store, pollIntervalMs: 10 }),
    );

    try {
      const sse = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: { accept: "text/event-stream" },
        payload: input,
      });
      expect(sse.statusCode).toBe(200);
      expect(sse.headers["content-type"]).toContain("text/event-stream");
      expect(parseSse(sse.body)).toEqual(expectedEvents);

      const protobuf = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: { accept: AGUI_MEDIA_TYPE },
        payload: input,
      });
      const encoder = new EventEncoder({ accept: AGUI_MEDIA_TYPE });
      const expectedBinary = Buffer.concat(
        expectedEvents.map((event) => Buffer.from(encoder.encodeBinary(event))),
      );
      expect(protobuf.statusCode).toBe(200);
      expect(protobuf.headers["content-type"]).toContain(AGUI_MEDIA_TYPE);
      expect(protobuf.rawPayload).toEqual(expectedBinary);
      expect(protobuf.headers.vary).toBe("Accept");
    } finally {
      await server.close();
    }
  });

  it("rejects malformed input before opening a stream", async () => {
    const server = Fastify();
    server.post("/ag-ui", createBuildRunAgUiHandler({ store }));

    try {
      const invalid = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: runInput("not-a-uuid"),
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({
        error: "invalid_ag_ui_request",
      });

      const missing = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: runInput(randomUUID()),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "run_not_found" });

      const run = store.createRun(assignment("ag-ui-cursor")).run;
      const invalidCursor = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: {
          ...runInput(run.id),
          forwardedProps: {
            buildRunId: run.id,
            afterSequence: 10_000,
          },
        },
      });
      expect(invalidCursor.statusCode).toBe(409);
      expect(invalidCursor.json()).toMatchObject({
        error: "invalid_event_cursor",
      });
    } finally {
      await server.close();
    }
  });

  it("caps concurrent observer streams", async () => {
    const run = store.createRun(assignment("ag-ui-capacity")).run;
    const activeStreams = new Set(
      Array.from(
        { length: AG_UI_MAX_ACTIVE_STREAMS },
        () => new AbortController(),
      ),
    );
    const server = Fastify();
    server.post("/ag-ui", createBuildRunAgUiHandler({ store, activeStreams }));

    try {
      const response = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: runInput(run.id),
      });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        error: "ag_ui_capacity_exceeded",
      });
      expect(activeStreams).toHaveLength(AG_UI_MAX_ACTIVE_STREAMS);
    } finally {
      await server.close();
    }
  });
});

function runInput(buildRunId: string): Record<string, unknown> {
  return {
    threadId: "studio-project-mission-peak",
    runId: `studio-observation-${randomUUID()}`,
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: { buildRunId },
  };
}

async function collectEvents(
  source: AsyncIterable<AGUIEvent>,
): Promise<AGUIEvent[]> {
  const events: AGUIEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

function parseSse(body: string): AGUIEvent[] {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((record) => {
      const data = record.split("\n").find((line) => line.startsWith("data: "));
      expect(data).toBeDefined();
      return EventSchemas.parse(JSON.parse(data!.slice("data: ".length)));
    });
}
