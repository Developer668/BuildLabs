import { randomUUID } from "node:crypto";

import { EventType, type AGUIEvent } from "@ag-ui/core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import {
  AG_UI_MAX_ACTIVE_STREAMS,
  BUILD_RUN_EVENT_NAME,
  createBuildRunAgUiHandler,
  parseBuildLabsAgUiRunInput,
  streamBuildRunAsAgUi,
} from "../src/http/ag-ui.js";
import { assignment } from "./fixtures.js";

describe("BuildLabs AG-UI durable resume", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("emits run-bound SSE ids and maps Last-Event-ID to the durable cursor", async () => {
    const run = store.createRun(assignment("ag-ui-last-event-id")).run;
    store.requestCancel(run.id);
    const history = store.listEvents(run.id, 0);
    const resumeAfter = history[0]!.sequence;
    const server = Fastify();
    server.post("/ag-ui", createBuildRunAgUiHandler({ store }));

    try {
      const response = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: {
          accept: "text/event-stream",
          "last-event-id": `${run.id}:${resumeAfter}`,
        },
        payload: runInput(run.id),
      });
      const records = parseSseRecords(response.body);
      const replayed = records
        .map((record) => record.event)
        .filter(
          (event) =>
            event.type === EventType.CUSTOM &&
            event.name === BUILD_RUN_EVENT_NAME,
        )
        .map((event): unknown => event.value);

      expect(response.statusCode).toBe(200);
      expect(replayed).toEqual(
        history.filter((event) => event.sequence > resumeAfter),
      );
      const snapshotRecord = records.find(
        ({ event }) => event.type === EventType.STATE_SNAPSHOT,
      );
      expect(snapshotRecord?.event).toMatchObject({
        snapshot: { buildRunId: run.id, cursor: history.at(-1)!.sequence },
      });
      expect(snapshotRecord?.id).toBe(`${run.id}:${history.at(-1)!.sequence}`);
      expect(
        records.flatMap(({ id }) => (id === undefined ? [] : [id])),
      ).toEqual(
        expect.arrayContaining([`${run.id}:${history.at(-1)!.sequence}`]),
      );
      expect(
        records
          .flatMap(({ id }) => (id === undefined ? [] : [id]))
          .every((id) => id.startsWith(`${run.id}:`)),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects malformed, cross-run, and future Last-Event-ID cursors", async () => {
    const requested = store.createRun(assignment("ag-ui-requested")).run;
    const other = store.createRun(assignment("ag-ui-other")).run;
    const server = Fastify();
    server.post("/ag-ui", createBuildRunAgUiHandler({ store }));

    try {
      const crossRun = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: { "last-event-id": `${other.id}:0` },
        payload: runInput(requested.id),
      });
      const malformed = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: { "last-event-id": `${requested.id}:01` },
        payload: runInput(requested.id),
      });
      const future = await server.inject({
        method: "POST",
        url: "/ag-ui",
        headers: {
          "last-event-id": `${requested.id}:${
            store.getLatestEventSequence(requested.id) + 1
          }`,
        },
        payload: runInput(requested.id),
      });

      expect(crossRun.statusCode).toBe(400);
      expect(crossRun.json()).toMatchObject({
        error: "invalid_ag_ui_request",
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({
        error: "invalid_ag_ui_request",
      });
      expect(future.statusCode).toBe(409);
      expect(future.json()).toMatchObject({ error: "invalid_event_cursor" });
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "duplicate",
      (events: ReturnType<SqliteRunStore["listEvents"]>) => [
        events[0]!,
        events[0]!,
      ],
    ],
    [
      "out-of-order",
      (events: ReturnType<SqliteRunStore["listEvents"]>) => [
        events[1]!,
        events[0]!,
      ],
    ],
  ])(
    "fails closed before forwarding a %s durable store page",
    async (_case, mutate) => {
      const run = store.createRun(assignment(`ag-ui-${_case}`)).run;
      store.requestCancel(run.id);
      const history = store.listEvents(run.id, 0);
      vi.spyOn(store, "listEvents").mockReturnValue(mutate(history));

      const events = await collectEvents(
        streamBuildRunAsAgUi(
          parseBuildLabsAgUiRunInput(runInput(run.id)),
          store,
        ),
      );

      expect(events).toEqual([
        expect.objectContaining({ type: EventType.RUN_STARTED }),
        {
          type: EventType.RUN_ERROR,
          code: "buildlabs_ag_ui_internal_error",
          message: "The build-run event stream failed",
        },
      ]);
    },
  );

  it("releases completed streams and tells capacity-limited clients when to retry", async () => {
    const run = store.createRun(assignment("ag-ui-stream-release")).run;
    store.requestCancel(run.id);
    const activeStreams = new Set<AbortController>();
    const server = Fastify();
    server.post("/ag-ui", createBuildRunAgUiHandler({ store, activeStreams }));

    try {
      const completed = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: runInput(run.id),
      });
      expect(completed.statusCode).toBe(200);
      expect(activeStreams.size).toBe(0);

      for (let index = 0; index < AG_UI_MAX_ACTIVE_STREAMS; index += 1) {
        activeStreams.add(new AbortController());
      }
      const limited = await server.inject({
        method: "POST",
        url: "/ag-ui",
        payload: runInput(run.id),
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("1");
      expect(activeStreams.size).toBe(AG_UI_MAX_ACTIVE_STREAMS);
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

function parseSseRecords(body: string): Array<{
  id: string | undefined;
  event: AGUIEvent;
}> {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((record) => {
      const lines = record.split("\n");
      const data = lines.find((line) => line.startsWith("data: "));
      const id = lines.find((line) => line.startsWith("id: "));
      if (!data) {
        throw new Error("SSE record is missing data");
      }
      return {
        id: id?.slice("id: ".length),
        event: JSON.parse(data.slice("data: ".length)) as AGUIEvent,
      };
    });
}
