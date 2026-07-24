import { parseCustomerEvent } from "../contracts/customer";
import { dashboardAliasSecret } from "./aliases";
import { projectCustomerEvent } from "./customer-projection";
import { DashboardBffError, bffErrorResponse, customerJson } from "./http";
import {
  type DashboardFetch,
  fetchCustomerEventWindow,
} from "./orchestration-client";
import {
  type LoadedCustomerSnapshot,
  loadCustomerSnapshot,
  upstreamCursorForPublicSequence,
  validateEventWindow,
} from "./customer-snapshot";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_PAGES_PER_POLL = 4;
const STREAM_HIGH_WATER_MARK_BYTES = 2_500_000;
const BACKPRESSURE_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_STREAMS = 64;
const MAX_STREAMS_PER_SESSION_PROJECT = 4;

interface StreamLease {
  release(): void;
}

export class CustomerStreamCapacity {
  readonly #byKey = new Map<string, number>();
  #total = 0;

  acquire(key: string): StreamLease | undefined {
    const current = this.#byKey.get(key) ?? 0;
    if (
      this.#total >= MAX_ACTIVE_STREAMS ||
      current >= MAX_STREAMS_PER_SESSION_PROJECT
    ) {
      return undefined;
    }
    this.#total += 1;
    this.#byKey.set(key, current + 1);
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        this.#total -= 1;
        const remaining = (this.#byKey.get(key) ?? 1) - 1;
        if (remaining <= 0) this.#byKey.delete(key);
        else this.#byKey.set(key, remaining);
      },
    };
  }

  clear(): void {
    this.#byKey.clear();
    this.#total = 0;
  }

  get active(): number {
    return this.#total;
  }
}

export const customerStreamCapacity = new CustomerStreamCapacity();

export async function handleCustomerEventStream(input: {
  request: Request;
  projectAlias: string;
  fetcher?: DashboardFetch;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}): Promise<Response> {
  let initial: LoadedCustomerSnapshot;
  let resumePublicCursor: number | undefined;
  let resumeUpstreamCursor: number | undefined;
  try {
    initial = await loadCustomerSnapshot({
      request: input.request,
      projectAlias: input.projectAlias,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    });
    const lastEventId = parseLastEventId(input.request);
    if (
      lastEventId !== undefined &&
      lastEventId > initial.snapshot.eventCursor
    ) {
      throw new DashboardBffError(
        409,
        "cursor_ahead",
        "The event cursor is newer than this project snapshot",
      );
    }
    if (lastEventId !== undefined) {
      resumePublicCursor = lastEventId;
      resumeUpstreamCursor = await upstreamCursorForPublicSequence({
        request: input.request,
        internalProjectId: initial.aliases.internalProjectId,
        publicSequence: lastEventId,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
    }
  } catch (error) {
    return bffErrorResponse(error);
  }

  const capacityKey = `${initial.aliases.sessionBinding}\0${initial.aliases.projectAlias}`;
  const lease = customerStreamCapacity.acquire(capacityKey);
  if (lease === undefined) {
    return customerJson(
      {
        error: "stream_capacity_exceeded",
        message: "Too many project streams are active",
      },
      { status: 429, headers: { "retry-after": "5" } },
    );
  }

  const pollIntervalMs = boundedInterval(
    input.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const heartbeatIntervalMs = boundedInterval(
    input.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  let cancelled = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lease.release();
  };
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        void runCustomerStream({
          controller,
          encoder,
          initial,
          request: input.request,
          pollIntervalMs,
          heartbeatIntervalMs,
          ...(resumePublicCursor === undefined ||
          resumeUpstreamCursor === undefined
            ? {}
            : {
                resumePublicCursor,
                resumeUpstreamCursor,
              }),
          isCancelled: () => cancelled,
          ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
        })
          .catch(() => {
            // The browser reconnects from the last complete cursor. Internal
            // transport or projection errors are never serialized to customers.
          })
          .finally(() => {
            release();
            try {
              controller.close();
            } catch {
              // The reader may already have cancelled.
            }
          });
      },
      cancel() {
        cancelled = true;
        release();
      },
    },
    new ByteLengthQueuingStrategy({
      highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "private, no-cache, no-store, max-age=0",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

async function runCustomerStream(input: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  initial: LoadedCustomerSnapshot;
  request: Request;
  fetcher?: DashboardFetch;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  resumePublicCursor?: number;
  resumeUpstreamCursor?: number;
  isCancelled(): boolean;
}): Promise<void> {
  const loaded = input.initial;
  let upstreamCursor = input.resumeUpstreamCursor ?? loaded.upstreamCursor;
  let publicCursor = input.resumePublicCursor ?? loaded.snapshot.eventCursor;
  let lastHeartbeatAt = Date.now();
  if (input.resumePublicCursor === undefined) {
    await enqueueWithBackpressure(
      input,
      `retry: 2000\n\n${sseEvent("snapshot", publicCursor, loaded.snapshot)}`,
    );
  } else {
    await enqueueWithBackpressure(input, "retry: 2000\n\n");
  }

  while (!input.isCancelled() && !input.request.signal.aborted) {
    await wait(input.pollIntervalMs, input.request.signal);
    if (input.isCancelled() || input.request.signal.aborted) break;
    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      const window = await fetchCustomerEventWindow({
        request: input.request,
        internalProjectId: loaded.aliases.internalProjectId,
        afterSequence: upstreamCursor,
        limit: 100,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
      const sequences = validateEventWindow(window, upstreamCursor);
      if (sequences.length === 0) break;
      let chunk = "";
      for (const [index, value] of window.items.entries()) {
        publicCursor += 1;
        const event = parseCustomerEvent(
          projectCustomerEvent({
            value,
            aliases: loaded.aliases,
            aggregateRevision: publicCursor - 1,
            contractVersion: null,
            secret: dashboardAliasSecret(),
            publicSequence: publicCursor,
          }),
        );
        chunk += sseEvent("project_event", publicCursor, event);
        upstreamCursor = sequences[index]!;
      }
      await enqueueWithBackpressure(input, chunk);
      if (!window.hasMore) break;
    }

    const now = Date.now();
    if (now - lastHeartbeatAt >= input.heartbeatIntervalMs) {
      await enqueueWithBackpressure(
        input,
        `: heartbeat ${Math.floor(now / 1_000)}\n\n`,
      );
      lastHeartbeatAt = now;
    }
  }
}

async function enqueueWithBackpressure(
  input: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    encoder: TextEncoder;
    request: Request;
    isCancelled(): boolean;
  },
  value: string,
): Promise<void> {
  const bytes = input.encoder.encode(value);
  if (bytes.byteLength > STREAM_HIGH_WATER_MARK_BYTES) {
    throw new DashboardBffError(
      503,
      "stream_payload_too_large",
      "The project stream requires a fresh snapshot",
    );
  }
  const deadline = Date.now() + BACKPRESSURE_TIMEOUT_MS;
  while (
    (input.controller.desiredSize ?? 0) < bytes.byteLength &&
    Date.now() < deadline
  ) {
    if (input.isCancelled() || input.request.signal.aborted) return;
    await wait(25, input.request.signal);
  }
  if (
    input.isCancelled() ||
    input.request.signal.aborted ||
    (input.controller.desiredSize ?? 0) < bytes.byteLength
  ) {
    throw new DashboardBffError(
      503,
      "stream_backpressure",
      "The project stream requires a reconnect",
    );
  }
  input.controller.enqueue(bytes);
}

function sseEvent(type: string, id: number, data: unknown): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseLastEventId(request: Request): number | undefined {
  const value = request.headers.get("last-event-id");
  if (value === null || value === "") return undefined;
  if (!/^(?:0|[1-9]\d{0,15})$/.test(value)) {
    throw new DashboardBffError(
      400,
      "invalid_event_cursor",
      "The event cursor is invalid",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DashboardBffError(
      400,
      "invalid_event_cursor",
      "The event cursor is invalid",
    );
  }
  return parsed;
}

function boundedInterval(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value >= 5 && value <= 60_000
    ? value
    : fallback;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
