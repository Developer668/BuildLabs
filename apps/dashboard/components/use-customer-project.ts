"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyCustomerSnapshot,
  initialReducerState,
  reduceCustomerEvent,
  type CustomerProjectReducerState,
} from "../lib/client";
import {
  parseCustomerEvent,
  parseCustomerProjectSnapshot,
  type CustomerProjectSnapshot,
} from "../lib/contracts";

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;

export type CustomerTransportState =
  "connecting" | "live" | "reconnecting" | "delayed" | "offline" | "fixture";

export interface SteeringInput {
  subject: string;
  content: string;
}

export type SteeringState =
  | { state: "idle" }
  | { state: "sending" }
  | {
      state: "received";
      detail: string;
    }
  | {
      state: "conflict";
      detail: string;
    }
  | {
      state: "failed";
      detail: string;
      retry: SteeringInput;
      idempotencyKey: string;
    };

export function useCustomerProject(input: {
  fixture: boolean;
  initialSnapshot?: CustomerProjectSnapshot;
  projectAlias: string;
}) {
  const [projectState, setProjectState] =
    useState<CustomerProjectReducerState | null>(() =>
      input.initialSnapshot ? initialReducerState(input.initialSnapshot) : null,
    );
  const [transport, setTransport] = useState<CustomerTransportState>(
    input.fixture ? "fixture" : "connecting",
  );
  const [sessionExpired, setSessionExpired] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [lastContactAt, setLastContactAt] = useState<number | null>(null);
  const [steering, setSteering] = useState<SteeringState>({ state: "idle" });
  const stateRef = useRef(projectState);
  const cursorRef = useRef(input.initialSnapshot?.eventCursor ?? 0);

  const commit = useCallback((next: CustomerProjectReducerState) => {
    stateRef.current = next;
    cursorRef.current = next.cursor;
    setProjectState(next);
  }, []);

  const refreshSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/v1/customer/projects/${encodeURIComponent(input.projectAlias)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (response.status === 401) {
        setSessionExpired(true);
        throw new Error("customer_session_invalid");
      }
      if (!response.ok) {
        throw new Error("customer_snapshot_unavailable");
      }
      const snapshot = parseCustomerProjectSnapshot(await response.json());
      const current = stateRef.current;
      commit(
        current === null
          ? initialReducerState(snapshot)
          : applyCustomerSnapshot(current, snapshot),
      );
      setLastContactAt(Date.now());
      setLoadError(undefined);
      return snapshot;
    },
    [commit, input.projectAlias],
  );

  useEffect(() => {
    stateRef.current = projectState;
  }, [projectState]);

  useEffect(() => {
    if (input.fixture) return;

    const controller = new AbortController();
    let reconnectAttempt = 0;
    let hasAttemptedConnection = false;

    async function pauseBeforeReconnect() {
      const delay =
        RECONNECT_DELAYS_MS[
          Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
        ] ?? RECONNECT_DELAYS_MS.at(-1)!;
      reconnectAttempt = Math.min(
        reconnectAttempt + 1,
        RECONNECT_DELAYS_MS.length - 1,
      );
      await pause(delay, controller.signal);
    }

    async function run() {
      while (!controller.signal.aborted) {
        try {
          if (stateRef.current === null) {
            await refreshSnapshot(controller.signal);
          }
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            setTransport("offline");
            await pause(1_000, controller.signal);
            continue;
          }
          setTransport(hasAttemptedConnection ? "reconnecting" : "connecting");
          hasAttemptedConnection = true;
          const headers = new Headers({ Accept: "text/event-stream" });
          if (cursorRef.current > 0) {
            headers.set("Last-Event-ID", String(cursorRef.current));
          }
          const response = await fetch(
            `/v1/customer/projects/${encodeURIComponent(input.projectAlias)}/events`,
            {
              cache: "no-store",
              credentials: "same-origin",
              headers,
              signal: controller.signal,
            },
          );
          if (response.status === 401) {
            setSessionExpired(true);
            return;
          }
          if (response.status === 409 || response.status === 410) {
            await refreshSnapshot(controller.signal);
            setTransport("reconnecting");
            await pauseBeforeReconnect();
            continue;
          }
          if (
            !response.ok ||
            !response.body ||
            !response.headers
              .get("content-type")
              ?.toLowerCase()
              .startsWith("text/event-stream")
          ) {
            throw new Error("customer_stream_unavailable");
          }

          reconnectAttempt = 0;
          setTransport("live");
          setLastContactAt(Date.now());
          await consumeEventStream(response.body, {
            signal: controller.signal,
            onContact: () => {
              setLastContactAt(Date.now());
              setTransport("live");
            },
            onEvent: async (event) => {
              if (event.type === "snapshot") {
                const snapshot = parseCustomerProjectSnapshot(
                  JSON.parse(event.data) as unknown,
                );
                const current = stateRef.current;
                commit(
                  current === null
                    ? initialReducerState(snapshot)
                    : applyCustomerSnapshot(current, snapshot),
                );
                return;
              }
              if (event.type !== "project_event") return;
              const value = parseCustomerEvent(
                JSON.parse(event.data) as unknown,
              );
              if (event.id !== null && event.id !== String(value.sequence)) {
                throw new Error("customer_stream_event_identity_invalid");
              }
              const current = stateRef.current;
              if (current === null) {
                await refreshSnapshot(controller.signal);
                return;
              }
              const next = reduceCustomerEvent(current, value);
              commit(next);
              if (next.syncState !== "synced") {
                await refreshSnapshot(controller.signal);
              }
            },
          });
          if (!controller.signal.aborted) {
            throw new Error("customer_stream_closed");
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (
            error instanceof Error &&
            error.message === "customer_session_invalid"
          ) {
            return;
          }
          setLoadError(
            stateRef.current === null
              ? "Project state is temporarily unavailable."
              : undefined,
          );
          setTransport(
            typeof navigator !== "undefined" && !navigator.onLine
              ? "offline"
              : "reconnecting",
          );
          try {
            await pauseBeforeReconnect();
          } catch {
            if (controller.signal.aborted) return;
            throw error;
          }
        }
      }
    }

    const updateConnectivity = () => {
      if (!navigator.onLine) {
        setTransport("offline");
      } else {
        setTransport("reconnecting");
      }
    };
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    void run();

    return () => {
      controller.abort();
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
    };
  }, [commit, input.fixture, input.projectAlias, refreshSnapshot]);

  useEffect(() => {
    if (input.fixture) return;
    const timer = window.setInterval(() => {
      if (!navigator.onLine) {
        setTransport("offline");
      } else if (
        lastContactAt !== null &&
        Date.now() - lastContactAt > 90_000
      ) {
        setTransport("delayed");
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [input.fixture, lastContactAt]);

  const submitSteering = useCallback(
    async (
      value: SteeringInput,
      retainedIdempotencyKey?: string,
    ): Promise<void> => {
      const snapshot = stateRef.current?.snapshot;
      if (!snapshot || snapshot.requestedVersion === null) {
        throw new Error("project_contract_unavailable");
      }
      const idempotencyKey =
        retainedIdempotencyKey ?? `dashboard-${crypto.randomUUID()}`;
      setSteering({ state: "sending" });
      try {
        const csrf = readCookie("buildlabs_dashboard_csrf");
        if (!csrf) {
          setSessionExpired(true);
          throw new Error("customer_session_invalid");
        }
        const response = await fetch(
          `/v1/customer/projects/${encodeURIComponent(input.projectAlias)}/steering`,
          {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              "x-buildlabs-csrf": csrf,
            },
            body: JSON.stringify({
              expectedRevision: snapshot.aggregateRevision,
              expectedProposalVersion: snapshot.requestedVersion,
              subject: value.subject,
              content: value.content,
            }),
          },
        );
        if (response.status === 401 || response.status === 403) {
          setSessionExpired(true);
          throw new Error("customer_session_invalid");
        }
        if (response.status === 409) {
          setSteering({
            state: "conflict",
            detail:
              "The project changed before this request could be received. Review the refreshed version and submit it again.",
          });
          await refreshSnapshot();
          return;
        }
        if (!response.ok) {
          throw new Error("steering_rejected");
        }
        setSteering({
          state: "received",
          detail:
            "Request received. Scope, pricing, and contract impact are still being classified.",
        });
        await refreshSnapshot();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "customer_session_invalid"
        ) {
          throw error;
        }
        setSteering({
          state: "failed",
          detail:
            "The request was not confirmed. Retrying will reuse the same command identity.",
          retry: value,
          idempotencyKey,
        });
        throw error;
      }
    },
    [input.projectAlias, refreshSnapshot],
  );

  return {
    loadError,
    projectState,
    refreshSnapshot,
    sessionExpired,
    steering,
    submitSteering,
    transport,
  };
}

interface ParsedSseEvent {
  data: string;
  id: string | null;
  type: string;
}

async function consumeEventStream(
  stream: ReadableStream<Uint8Array>,
  input: {
    signal: AbortSignal;
    onContact: () => void;
    onEvent: (event: ParsedSseEvent) => Promise<void>;
  },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!input.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      input.onContact();
      buffer += decoder.decode(value, { stream: true });
      if (new TextEncoder().encode(buffer).byteLength > MAX_SSE_BUFFER_BYTES) {
        throw new Error("customer_stream_frame_too_large");
      }
      let boundary = findSseBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer
          .slice(0, boundary.index)
          .replaceAll("\r\n", "\n")
          .replaceAll("\r", "\n");
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseFrame(frame);
        if (event !== null) {
          await input.onEvent(event);
        }
        boundary = findSseBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseBoundary(
  value: string,
): { index: number; length: number } | null {
  const candidates = [
    { index: value.indexOf("\r\n\r\n"), length: 4 },
    { index: value.indexOf("\n\n"), length: 2 },
    { index: value.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  return candidates.sort((left, right) => left.index - right.index)[0] ?? null;
}

function parseSseFrame(frame: string): ParsedSseEvent | null {
  let type = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") type = value;
    if (field === "id" && !value.includes("\u0000")) id = value;
    if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { data: data.join("\n"), id, type };
}

function readCookie(name: string): string | undefined {
  const matches = document.cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  return decodeURIComponent(matches[0]!.slice(name.length + 1));
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
