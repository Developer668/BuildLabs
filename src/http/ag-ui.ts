import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  EventType,
  RunAgentInputSchema,
  type AGUIEvent,
  type ActivitySnapshotEvent,
  type CustomEvent,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StateSnapshotEvent,
} from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AgentProgressSchema,
  isTerminalStatus,
  type BuildRun,
  type RunEvent,
} from "../domain/run.js";
import type { RunStore } from "../ports/index.js";

export const AG_UI_MAX_INPUT_BYTES = 256 * 1_024;
export const AG_UI_MAX_ACTIVE_STREAMS = 64;
export const AG_UI_EVENT_PAGE_SIZE = 256;
export const BUILD_RUN_ACTIVITY_TYPE = "buildlabs.candidate";
export const BUILD_RUN_EVENT_NAME = "buildlabs.run_event";
export const BUILD_RUN_KEEPALIVE_NAME = "buildlabs.keepalive";

const MAX_MESSAGES = 100;
const MAX_CONTEXT_ITEMS = 32;
const MAX_RESUME_ITEMS = 32;
const MAX_IDENTIFIER_LENGTH = 128;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 5_000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const MIN_KEEPALIVE_INTERVAL_MS = 1_000;
const MAX_KEEPALIVE_INTERVAL_MS = 60_000;

const BuildRunForwardedPropsSchema = z
  .object({
    buildRunId: z.uuid(),
    afterSequence: z.number().int().nonnegative().default(0),
  })
  .strip();

export class AgUiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgUiInputError";
  }
}

export interface BuildLabsAgUiRunInput extends RunAgentInput {
  forwardedProps: {
    buildRunId: string;
    afterSequence: number;
  };
}

export interface BuildRunCandidateView {
  runId: string;
  projectId: string;
  candidateId: string;
  status: BuildRun["status"];
  stage: BuildRun["stage"];
  slotId: number | null;
  sandboxAttached: boolean;
  revisionHash: string | null;
  preview: {
    state: "probe_required" | "unavailable";
    endpoint: string | null;
  };
  contract: {
    approvedFactCount: number;
    hardRequirementCount: number;
    preferenceCount: number;
  };
  progress: {
    completedToolCalls: number;
    failedToolCalls: number;
    lastToolName: string | null;
    repairRound: number;
  };
  proof: {
    receiptCount: number;
    passCount: number;
    failCount: number;
    errorCount: number;
    byKind: Record<string, number>;
    artifactAvailable: boolean;
  };
  cancelRequested: boolean;
  errorCode: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface BuildRunAgUiState {
  version: 1;
  buildRunId: string;
  cursor: number;
  candidate: BuildRunCandidateView;
}

interface AgentProgressSummary {
  completedToolCalls: number;
  failedToolCalls: number;
  lastToolName: string | null;
  repairRound: number;
}

interface ContractSummary {
  approvedFactCount: number;
  hardRequirementCount: number;
  preferenceCount: number;
}

interface ProofProgressSummary {
  receiptCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  byKind: Record<string, number>;
}

const EvidenceRecordedPayloadSchema = z.object({
  kind: z.string().min(1).max(128),
  status: z.enum(["PASS", "FAIL", "ERROR"]),
});

export interface BuildRunAgUiStreamOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  now?: () => number;
  waitForPoll?: (
    milliseconds: number,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
}

export interface BuildRunAgUiHandlerOptions {
  store: RunStore;
  activeStreams?: Set<AbortController>;
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
  now?: () => number;
}

export function parseBuildLabsAgUiRunInput(
  value: unknown,
): BuildLabsAgUiRunInput {
  assertJsonSize(value);
  const record = requireRecord(value);
  const messages = requireArray(record, "messages");
  const tools = requireArray(record, "tools");
  const context = requireArray(record, "context");
  const resume = record.resume;

  if (messages.length > MAX_MESSAGES) {
    throw new AgUiInputError(
      `messages may contain at most ${MAX_MESSAGES} items`,
    );
  }
  if (tools.length !== 0) {
    throw new AgUiInputError(
      "Client-provided tools are not accepted by this observer transport",
    );
  }
  if (context.length > MAX_CONTEXT_ITEMS) {
    throw new AgUiInputError(
      `context may contain at most ${MAX_CONTEXT_ITEMS} items`,
    );
  }
  if (
    resume !== undefined &&
    (!Array.isArray(resume) || resume.length > MAX_RESUME_ITEMS)
  ) {
    throw new AgUiInputError(
      `resume must contain at most ${MAX_RESUME_ITEMS} items`,
    );
  }
  if (Array.isArray(resume) && resume.length > 0) {
    throw new AgUiInputError(
      "Interrupt resume entries are not supported by this observer transport",
    );
  }

  const parsed = RunAgentInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgUiInputError(
      "Request does not match the AG-UI RunAgentInput schema",
    );
  }

  assertIdentifier(parsed.data.threadId, "threadId");
  assertIdentifier(parsed.data.runId, "runId");
  if (parsed.data.parentRunId !== undefined) {
    assertIdentifier(parsed.data.parentRunId, "parentRunId");
  }

  const forwardedProps = BuildRunForwardedPropsSchema.safeParse(
    parsed.data.forwardedProps,
  );
  if (!forwardedProps.success) {
    throw new AgUiInputError("forwardedProps.buildRunId must be a valid UUID");
  }
  if (parsed.data.runId === forwardedProps.data.buildRunId) {
    throw new AgUiInputError(
      "AG-UI runId must be distinct from forwardedProps.buildRunId",
    );
  }

  return {
    ...parsed.data,
    forwardedProps: forwardedProps.data,
  };
}

export async function* streamBuildRunAsAgUi(
  input: BuildLabsAgUiRunInput,
  store: RunStore,
  options: BuildRunAgUiStreamOptions = {},
): AsyncGenerator<AGUIEvent> {
  const buildRunId = input.forwardedProps.buildRunId;
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  const keepaliveIntervalMs = boundedKeepaliveInterval(
    options.keepaliveIntervalMs,
  );
  const now = options.now ?? Date.now;
  const waitForPoll = options.waitForPoll ?? defaultWaitForPoll;
  let cursor = input.forwardedProps.afterSequence;
  const progress = summarizeAgentProgress([]);
  const proof = emptyProofProgress();
  let emittedSnapshot = false;
  let lastEmissionAt: number;

  yield runStartedEvent(input);

  try {
    if (cursor > 0) {
      let reconstructionCursor = 0;
      let reconstructionPages = 0;
      while (reconstructionCursor < cursor) {
        const page = readNewEvents(store, buildRunId, reconstructionCursor);
        if (page.length === 0) {
          break;
        }
        for (const event of page) {
          if (event.sequence > cursor) {
            break;
          }
          applyAgentProgressEvent(progress, event);
          applyProofProgressEvent(proof, event);
          reconstructionCursor = event.sequence;
        }
        reconstructionPages += 1;
        if (reconstructionPages > 100) {
          throw new Error(
            "AG-UI progress reconstruction exceeded its page limit",
          );
        }
        if (page.at(-1)!.sequence > cursor) {
          break;
        }
      }
    }
    const contract = requireContractSummary(store, buildRunId);
    lastEmissionAt = requireFiniteTime(now());
    while (!options.signal?.aborted) {
      const replay = readNewEvents(store, buildRunId, cursor);
      let emittedRunUpdate = false;
      for (const event of replay) {
        if (options.signal?.aborted) {
          return;
        }
        cursor = event.sequence;
        applyAgentProgressEvent(progress, event);
        applyProofProgressEvent(proof, event);
        yield durableRunEvent(event);
        emittedRunUpdate = true;
      }

      let run: BuildRun;
      let stabilizationReads = 0;
      while (true) {
        run = requireBuildRun(store, buildRunId);
        const concurrentReplay = readNewEvents(store, buildRunId, cursor);
        if (concurrentReplay.length === 0) {
          break;
        }
        for (const event of concurrentReplay) {
          if (options.signal?.aborted) {
            return;
          }
          cursor = event.sequence;
          applyAgentProgressEvent(progress, event);
          applyProofProgressEvent(proof, event);
          yield durableRunEvent(event);
          emittedRunUpdate = true;
        }
        stabilizationReads += 1;
        if (stabilizationReads > 100) {
          throw new Error("Run state did not stabilize for an AG-UI snapshot");
        }
      }

      if (
        !emittedSnapshot ||
        emittedRunUpdate ||
        isTerminalStatus(run.status)
      ) {
        const state = buildRunState(
          run,
          cursor,
          store,
          contract,
          progress,
          proof,
        );
        yield stateSnapshotEvent(state);
        yield activitySnapshotEvent(state.candidate);
        emittedSnapshot = true;
        emittedRunUpdate = true;
      }

      if (isTerminalStatus(run.status)) {
        yield runFinishedEvent(input, run, cursor);
        return;
      }

      if (emittedRunUpdate) {
        lastEmissionAt = requireFiniteTime(now());
      } else {
        const currentTime = requireFiniteTime(now());
        if (currentTime - lastEmissionAt >= keepaliveIntervalMs) {
          yield keepaliveEvent(buildRunId, cursor);
          lastEmissionAt = currentTime;
        }
      }

      await waitForPoll(pollIntervalMs, options.signal);
    }
  } catch (_error) {
    if (!options.signal?.aborted) {
      yield internalRunErrorEvent();
    }
  }
}

export function createBuildRunAgUiHandler(
  options: BuildRunAgUiHandlerOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (request, reply) => {
    let input: BuildLabsAgUiRunInput;
    try {
      input = parseBuildLabsAgUiRunInput(request.body);
    } catch (error) {
      if (error instanceof AgUiInputError) {
        return reply.code(400).send({
          error: "invalid_ag_ui_request",
          message: error.message,
        });
      }
      throw error;
    }

    if (!options.store.getRun(input.forwardedProps.buildRunId)) {
      return reply.code(404).send({
        error: "run_not_found",
        message: "The requested build run was not found",
      });
    }
    const latestSequence = options.store.getLatestEventSequence(
      input.forwardedProps.buildRunId,
    );
    if (input.forwardedProps.afterSequence > latestSequence) {
      return reply.code(409).send({
        error: "invalid_event_cursor",
        message: "afterSequence is ahead of the durable run history",
      });
    }
    if (
      options.activeStreams &&
      options.activeStreams.size >= AG_UI_MAX_ACTIVE_STREAMS
    ) {
      return reply.code(429).send({
        error: "ag_ui_capacity_exceeded",
        message: "The maximum number of active AG-UI streams is in use",
      });
    }

    const abortController = new AbortController();
    options.activeStreams?.add(abortController);
    const abort = () => abortController.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);

    const accept = normalizedAcceptHeader(request.headers.accept);
    const encoder = new EventEncoder(accept === undefined ? {} : { accept });
    const events = streamBuildRunAsAgUi(input, options.store, {
      signal: abortController.signal,
      ...(options.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.keepaliveIntervalMs === undefined
        ? {}
        : { keepaliveIntervalMs: options.keepaliveIntervalMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const body = Readable.from(encodeEvents(events, encoder), {
      objectMode: false,
    });
    body.once("close", () => {
      options.activeStreams?.delete(abortController);
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    });

    return reply
      .type(encoder.getContentType())
      .header("Cache-Control", "no-cache, no-transform")
      .header("Vary", "Accept")
      .header("X-Accel-Buffering", "no")
      .send(body);
  };
}

export function buildRunActivityMessageId(buildRunId: string): string {
  return `candidate:${buildRunId}`;
}

function assertJsonSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    throw new AgUiInputError("Request must be JSON serializable");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > AG_UI_MAX_INPUT_BYTES
  ) {
    throw new AgUiInputError(
      `Request must not exceed ${AG_UI_MAX_INPUT_BYTES} bytes`,
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgUiInputError("Request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireArray(
  record: Record<string, unknown>,
  property: string,
): unknown[] {
  const value = record[property];
  if (!Array.isArray(value)) {
    throw new AgUiInputError(`${property} must be an array`);
  }
  return value;
}

function assertIdentifier(value: string, property: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    throw new AgUiInputError(
      `${property} must contain 1-${MAX_IDENTIFIER_LENGTH} non-padded characters`,
    );
  }
}

function boundedPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    Math.max(MIN_POLL_INTERVAL_MS, Math.floor(value)),
  );
}

function boundedKeepaliveInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_KEEPALIVE_INTERVAL_MS;
  }
  return Math.min(
    MAX_KEEPALIVE_INTERVAL_MS,
    Math.max(MIN_KEEPALIVE_INTERVAL_MS, Math.floor(value)),
  );
}

function requireFiniteTime(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("AG-UI clock returned an invalid time");
  }
  return value;
}

async function defaultWaitForPoll(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal) {
    await delay(milliseconds, undefined, { signal });
    return;
  }
  await delay(milliseconds);
}

function readNewEvents(
  store: RunStore,
  buildRunId: string,
  cursor: number,
): RunEvent[] {
  const events = store.listEvents(buildRunId, cursor, AG_UI_EVENT_PAGE_SIZE);
  if (events.length > AG_UI_EVENT_PAGE_SIZE) {
    throw new Error("RunStore exceeded the AG-UI durable event page size");
  }
  let previousSequence = cursor;
  for (const event of events) {
    if (
      event.runId !== buildRunId ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= previousSequence
    ) {
      throw new Error("RunStore returned an invalid durable event sequence");
    }
    previousSequence = event.sequence;
  }
  return events;
}

function requireBuildRun(store: RunStore, buildRunId: string): BuildRun {
  const run = store.getRun(buildRunId);
  if (!run) {
    throw new Error("Build run disappeared while its AG-UI stream was active");
  }
  return run;
}

function buildRunState(
  run: BuildRun,
  cursor: number,
  store: RunStore,
  contract: ContractSummary,
  progress: AgentProgressSummary,
  proof: ProofProgressSummary,
): BuildRunAgUiState {
  const previewCanBeProbed =
    ["running", "passed"].includes(run.status) &&
    run.sandboxId !== undefined &&
    run.previewPort !== undefined;
  return {
    version: 1,
    buildRunId: run.id,
    cursor,
    candidate: {
      runId: run.id,
      projectId: run.projectId,
      candidateId: run.candidateId,
      status: run.status,
      stage: run.stage,
      slotId: run.slotId ?? null,
      sandboxAttached: run.sandboxId !== undefined,
      revisionHash: run.revisionHash ?? null,
      preview: previewCanBeProbed
        ? {
            state: "probe_required",
            endpoint: `/v1/build-runs/${run.id}/preview`,
          }
        : { state: "unavailable", endpoint: null },
      contract: {
        approvedFactCount: contract.approvedFactCount,
        hardRequirementCount: contract.hardRequirementCount,
        preferenceCount: contract.preferenceCount,
      },
      progress: {
        completedToolCalls: progress.completedToolCalls,
        failedToolCalls: progress.failedToolCalls,
        lastToolName: progress.lastToolName,
        repairRound: progress.repairRound,
      },
      proof: {
        receiptCount: proof.receiptCount,
        passCount: proof.passCount,
        failCount: proof.failCount,
        errorCount: proof.errorCount,
        byKind: { ...proof.byKind },
        artifactAvailable: store.getArtifact(run.id) !== undefined,
      },
      cancelRequested: run.cancelRequested,
      errorCode: run.errorCode ?? null,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null,
    },
  };
}

function requireContractSummary(
  store: RunStore,
  buildRunId: string,
): ContractSummary {
  const assignment = store.getAssignment(buildRunId);
  if (!assignment) {
    throw new Error("Build assignment disappeared while streaming AG-UI state");
  }
  return {
    approvedFactCount: assignment.contract.approvedFacts.length,
    hardRequirementCount: assignment.contract.requirements.filter(
      (requirement) => requirement.priority === "hard",
    ).length,
    preferenceCount: assignment.contract.requirements.filter(
      (requirement) => requirement.priority === "preference",
    ).length,
  };
}

function emptyProofProgress(): ProofProgressSummary {
  return {
    receiptCount: 0,
    passCount: 0,
    failCount: 0,
    errorCount: 0,
    byKind: {},
  };
}

function summarizeAgentProgress(events: RunEvent[]): AgentProgressSummary {
  const summary: AgentProgressSummary = {
    completedToolCalls: 0,
    failedToolCalls: 0,
    lastToolName: null,
    repairRound: 0,
  };
  for (const event of events) {
    applyAgentProgressEvent(summary, event);
  }
  return summary;
}

function applyAgentProgressEvent(
  summary: AgentProgressSummary,
  event: RunEvent,
): void {
  if (event.type !== "agent.tool_completed") {
    return;
  }
  const parsed = AgentProgressSchema.safeParse(event.payload);
  if (!parsed.success) {
    return;
  }
  summary.completedToolCalls += 1;
  if (!parsed.data.ok) {
    summary.failedToolCalls += 1;
  }
  summary.lastToolName = parsed.data.toolName;
  summary.repairRound = parsed.data.repairRound;
}

function applyProofProgressEvent(
  summary: ProofProgressSummary,
  event: RunEvent,
): void {
  if (event.type !== "evidence.recorded") {
    return;
  }
  const parsed = EvidenceRecordedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    return;
  }
  summary.receiptCount += 1;
  summary.byKind[parsed.data.kind] =
    (summary.byKind[parsed.data.kind] ?? 0) + 1;
  if (parsed.data.status === "PASS") {
    summary.passCount += 1;
  } else if (parsed.data.status === "FAIL") {
    summary.failCount += 1;
  } else {
    summary.errorCount += 1;
  }
}

function runStartedEvent(input: BuildLabsAgUiRunInput): RunStartedEvent {
  return {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
  };
}

function durableRunEvent(event: RunEvent): CustomEvent {
  return {
    type: EventType.CUSTOM,
    name: BUILD_RUN_EVENT_NAME,
    value: event,
  };
}

function keepaliveEvent(buildRunId: string, cursor: number): CustomEvent {
  return {
    type: EventType.CUSTOM,
    name: BUILD_RUN_KEEPALIVE_NAME,
    value: {
      buildRunId,
      cursor,
    },
  };
}

function stateSnapshotEvent(state: BuildRunAgUiState): StateSnapshotEvent {
  return {
    type: EventType.STATE_SNAPSHOT,
    snapshot: state,
  };
}

function activitySnapshotEvent(
  candidate: BuildRunCandidateView,
): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: buildRunActivityMessageId(candidate.runId),
    activityType: BUILD_RUN_ACTIVITY_TYPE,
    content: candidate,
    replace: true,
  };
}

function runFinishedEvent(
  input: BuildLabsAgUiRunInput,
  run: BuildRun,
  cursor: number,
): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    result: {
      buildRunId: run.id,
      status: run.status,
      cursor,
    },
    outcome: { type: "success" },
  };
}

function internalRunErrorEvent(): RunErrorEvent {
  return {
    type: EventType.RUN_ERROR,
    code: "buildlabs_ag_ui_internal_error",
    message: "The build-run event stream failed",
  };
}

async function* encodeEvents(
  events: AsyncIterable<AGUIEvent>,
  encoder: EventEncoder,
): AsyncGenerator<Buffer> {
  for await (const event of events) {
    yield Buffer.from(encoder.encodeBinary(event));
  }
}

function normalizedAcceptHeader(
  accept: string | string[] | undefined,
): string | undefined {
  return Array.isArray(accept) ? accept.join(", ") : accept;
}
