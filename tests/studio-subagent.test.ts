import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import { StudioCommandService } from "../src/application/studio-command-service.js";
import { StudioSubagent } from "../src/application/studio-subagent.js";
import type { BuildRun } from "../src/domain/run.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type {
  AgentMessage,
  AgentToolDefinition,
  CancellationRequest,
  ContractEvaluationInput,
  ContractEvaluationOutput,
  ModelPort,
  ModelRequestContext,
  ModelTurn,
  StudioTraceInput,
  TracePort,
  TraceSpan,
} from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

describe("StudioSubagent", () => {
  let store: SqliteRunStore;

  beforeEach(() => {
    store = new SqliteRunStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  it("uses a fresh authoritative read before a voice-triggered cancellation", async () => {
    const run = store.createRun(assignment("studio-cancel")).run;
    const secret = `fw_${"x".repeat(32)}`;
    const privateReasoning = "PRIVATE_STUDIO_REASONING";
    const rawConversationId = "conversation-test-sensitive";
    const model = new SequenceModel([
      {
        content: null,
        reasoningContent: privateReasoning,
        toolCalls: [
          {
            id: "read",
            name: "get_candidate",
            argumentsJson: JSON.stringify({ runId: run.id }),
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "cancel",
            name: "cancel_candidate",
            argumentsJson: JSON.stringify({
              runId: run.id,
              expectedStatus: "queued",
              expectedUpdatedAt: run.updatedAt,
            }),
          },
        ],
      },
      {
        content: "Cancellation requested.",
        toolCalls: [],
      },
    ]);
    const commands = new StudioCommandService(
      store,
      cancellationControl(store),
    );
    const trace = new RecordingTrace();

    const response = await new StudioSubagent(model, commands, trace).respond(
      [
        {
          role: "user",
          content: `Cancel build run ${run.id}. My key is ${secret}.`,
        },
      ],
      rawConversationId,
    );

    expect(response).toBe("Cancellation requested.");
    expect(store.getRun(run.id)?.cancelRequested).toBe(true);
    expect(model.contexts).toHaveLength(3);
    expect(
      new Set(model.contexts.map((context) => context.trajectoryId)).size,
    ).toBe(1);
    expect(
      new Set(model.contexts.map((context) => context.promptCacheIsolationKey))
        .size,
    ).toBe(1);
    expect(model.contexts[0]?.trajectoryId).not.toBe(
      model.contexts[0]?.promptCacheIsolationKey,
    );
    expect(JSON.stringify(model.contexts)).not.toContain(rawConversationId);

    const conversationCorrelationId = sha256(
      `studio-conversation:${rawConversationId}`,
    );
    const cancellationEvent = store
      .listEvents(run.id, 0)
      .find((event) => event.type === "run.cancelled");
    expect(cancellationEvent?.payload).toMatchObject({
      runId: run.id,
      source: "studio_speech_engine",
      conversationCorrelationId,
      reasonCode: "explicit_operator_cancellation",
    });
    const traceJson = JSON.stringify({
      roots: trace.rootInputs,
      spans: trace.spans,
    });
    expect(traceJson).toContain(conversationCorrelationId);
    expect(traceJson).toContain(run.id);
    expect(
      trace.spans
        .filter((span) => span.name !== "studio-root")
        .map((span) => span.name),
    ).toEqual([
      "fireworks.studio.turn",
      "studio.tool.get_candidate",
      "fireworks.studio.turn",
      "studio.tool.cancel_candidate",
      "fireworks.studio.turn",
    ]);
    expect(traceJson).not.toContain(rawConversationId);
    expect(traceJson).not.toContain(privateReasoning);
    expect(traceJson).not.toContain(secret);
    expect(traceJson).not.toContain("Cancel build run");
  });

  it("isolates Fireworks prompt caches between voice conversations", async () => {
    const model = new SequenceModel([
      { content: "First response.", toolCalls: [] },
      { content: "Second response.", toolCalls: [] },
    ]);
    const commands = new StudioCommandService(
      store,
      cancellationControl(store),
    );
    const subagent = new StudioSubagent(model, commands);

    await subagent.respond(
      [{ role: "user", content: "Give me a bounded response." }],
      "conversation-a",
    );
    await subagent.respond(
      [{ role: "user", content: "Give me another bounded response." }],
      "conversation-b",
    );

    expect(model.contexts[0]?.promptCacheIsolationKey).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(model.contexts[1]?.promptCacheIsolationKey).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(model.contexts[0]?.promptCacheIsolationKey).not.toBe(
      model.contexts[1]?.promptCacheIsolationKey,
    );
  });

  it("refuses a cancellation tool call that skipped the state read", async () => {
    const run = store.createRun(assignment("studio-guard")).run;
    const model = new SequenceModel([
      {
        content: null,
        toolCalls: [
          {
            id: "cancel",
            name: "cancel_candidate",
            argumentsJson: JSON.stringify({
              runId: run.id,
              expectedStatus: "queued",
              expectedUpdatedAt: run.updatedAt,
            }),
          },
        ],
      },
      {
        content: "I need to confirm the current candidate state first.",
        toolCalls: [],
      },
    ]);
    const commands = new StudioCommandService(
      store,
      cancellationControl(store),
    );

    await new StudioSubagent(model, commands).respond(
      [{ role: "user", content: `Cancel ${run.id}.` }],
      "conversation-guard",
    );

    expect(store.getRun(run.id)?.cancelRequested).toBe(false);
    const toolResults = model.messages
      .flat()
      .filter(
        (message): message is Extract<AgentMessage, { role: "tool" }> =>
          message.role === "tool",
      );
    expect(toolResults.map((message) => message.content).join("\n")).toContain(
      "must confirm",
    );
  });

  it("refuses cancellation without an explicit operator request", async () => {
    const run = store.createRun(assignment("studio-intent")).run;
    const model = new SequenceModel([
      {
        content: null,
        toolCalls: [
          {
            id: "read",
            name: "get_candidate",
            argumentsJson: JSON.stringify({ runId: run.id }),
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "cancel",
            name: "cancel_candidate",
            argumentsJson: JSON.stringify({
              runId: run.id,
              expectedStatus: "queued",
              expectedUpdatedAt: run.updatedAt,
            }),
          },
        ],
      },
      {
        content: "The candidate is still queued.",
        toolCalls: [],
      },
    ]);
    const commands = new StudioCommandService(
      store,
      cancellationControl(store),
    );

    await new StudioSubagent(model, commands).respond(
      [{ role: "user", content: `What is the status of ${run.id}?` }],
      "conversation-intent",
    );

    expect(store.getRun(run.id)?.cancelRequested).toBe(false);
    expect(JSON.stringify(model.messages)).toContain(
      "did not explicitly request cancellation",
    );
  });

  it("does not treat a request to stop speaking as build cancellation", async () => {
    const run = store.createRun(assignment("studio-stop-speaking")).run;
    const model = new SequenceModel([
      {
        content: null,
        toolCalls: [
          {
            id: "read",
            name: "get_candidate",
            argumentsJson: JSON.stringify({ runId: run.id }),
          },
        ],
      },
      {
        content: null,
        toolCalls: [
          {
            id: "cancel",
            name: "cancel_candidate",
            argumentsJson: JSON.stringify({
              runId: run.id,
              expectedStatus: "queued",
              expectedUpdatedAt: run.updatedAt,
            }),
          },
        ],
      },
      {
        content: "Understood.",
        toolCalls: [],
      },
    ]);

    await new StudioSubagent(
      model,
      new StudioCommandService(store, cancellationControl(store)),
    ).respond(
      [{ role: "user", content: "Stop talking and let me inspect it." }],
      "conversation-stop-speaking",
    );

    expect(store.getRun(run.id)?.cancelRequested).toBe(false);
    expect(JSON.stringify(model.messages)).toContain(
      "did not explicitly request cancellation",
    );
  });

  it("does not execute tools from a model turn completed after interruption", async () => {
    const run = store.createRun(assignment("studio-abort")).run;
    const controller = new AbortController();
    const model = new SequenceModel(
      [
        {
          content: null,
          toolCalls: [
            {
              id: "cancel",
              name: "cancel_candidate",
              argumentsJson: JSON.stringify({
                runId: run.id,
                expectedStatus: "queued",
                expectedUpdatedAt: run.updatedAt,
              }),
            },
          ],
        },
      ],
      () => controller.abort(new Error("Operator interrupted the turn")),
    );
    const commands = new StudioCommandService(
      store,
      cancellationControl(store),
    );

    await expect(
      new StudioSubagent(model, commands).respond(
        [{ role: "user", content: `Cancel ${run.id}.` }],
        "conversation-abort",
        controller.signal,
      ),
    ).rejects.toThrow("Operator interrupted");
    expect(store.getRun(run.id)?.cancelRequested).toBe(false);
  });

  it("settles tracing promptly when an interrupted provider call ignores abort", async () => {
    const pendingTurn = deferred<ModelTurn>();
    const model: ModelPort = {
      complete: () => pendingTurn.promise,
      evaluateContract: () => Promise.reject(new Error("Not used")),
      health: () => Promise.resolve(),
    };
    const trace = new RecordingTrace();
    const controller = new AbortController();
    const response = new StudioSubagent(
      model,
      new StudioCommandService(store, cancellationControl(store)),
      trace,
    ).respond(
      [{ role: "user", content: "Read a candidate." }],
      "conversation-hanging-provider",
      controller.signal,
    );

    controller.abort(new Error("Studio shutdown"));
    await expect(response).rejects.toThrow("Studio shutdown");
    const traceAfterAbort = structuredClone(trace.spans);

    pendingTurn.resolve({
      content: "This late provider response must be ignored.",
      toolCalls: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(trace.spans).toEqual(traceAfterAbort);
  });
});

class SequenceModel implements ModelPort {
  readonly messages: AgentMessage[][] = [];
  readonly contexts: ModelRequestContext[] = [];

  constructor(
    private readonly turns: ModelTurn[],
    private readonly onComplete?: () => void,
  ) {}

  complete(
    messages: AgentMessage[],
    _tools: AgentToolDefinition[],
    context: ModelRequestContext,
  ): Promise<ModelTurn> {
    this.messages.push(structuredClone(messages));
    this.contexts.push(structuredClone(context));
    const turn = this.turns.shift();
    if (!turn) {
      throw new Error("No studio model turn configured");
    }
    this.onComplete?.();
    return Promise.resolve(turn);
  }

  evaluateContract(
    _input: ContractEvaluationInput,
  ): Promise<ContractEvaluationOutput> {
    throw new Error("Not used");
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

function cancellationControl(store: SqliteRunStore) {
  return {
    cancel: (runId: string, request: CancellationRequest) =>
      store.requestCancel(runId, request),
  };
}

interface RecordedSpan {
  name: string;
  type: string;
  input: unknown;
  logs: unknown[];
}

class RecordingTrace implements TracePort {
  readonly rootInputs: StudioTraceInput[] = [];
  readonly spans: RecordedSpan[] = [];

  run<T>(
    _run: BuildRun,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(new RecordingSpan("build", "task", {}, this.spans));
  }

  studio<T>(
    input: StudioTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    this.rootInputs.push(structuredClone(input));
    return operation(
      new RecordingSpan("studio-root", "task", input, this.spans),
    );
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class RecordingSpan implements TraceSpan {
  readonly traceId = "a".repeat(64);
  private recorded: RecordedSpan | undefined;

  constructor(
    private readonly name: string,
    private readonly type: string,
    private readonly input: unknown,
    private readonly spans: RecordedSpan[],
  ) {}

  log(event: Parameters<TraceSpan["log"]>[0]): void {
    const span = this.record();
    span.logs.push(structuredClone(event));
  }

  child<T>(
    name: string,
    type: Parameters<TraceSpan["child"]>[1],
    input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const child = new RecordingSpan(name, type, input, this.spans);
    child.record();
    return operation(child);
  }

  private record(): RecordedSpan {
    if (!this.recorded) {
      this.recorded = {
        name: this.name,
        type: this.type,
        input: structuredClone(this.input),
        logs: [],
      };
      this.spans.push(this.recorded);
    }
    return this.recorded;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
