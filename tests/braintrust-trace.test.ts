import { randomUUID } from "node:crypto";

import type { initLogger, Span } from "braintrust";
import { describe, expect, it, vi } from "vitest";

import {
  BraintrustTrace,
  prepareBraintrustLogEvent,
  prepareStudioToolTraceInput,
  prepareStudioTraceInput,
  type BraintrustTraceOptions,
} from "../src/adapters/braintrust/braintrust-trace.js";
import { loadConfig } from "../src/config.js";
import type { BuildRun } from "../src/domain/run.js";

const CONFIG = loadConfig({
  NODE_ENV: "test",
  DAYTONA_API_KEY: "d".repeat(20),
  FIREWORKS_API_KEY: "f".repeat(20),
  BRAINTRUST_API_KEY: "b".repeat(20),
  CODERABBIT_AUTH_MODE: "oauth",
});

describe("Braintrust trace telemetry", () => {
  it("owns bounded flushing without installing an SDK exit flush", () => {
    let loggerOptions: Parameters<typeof initLogger>[0] | undefined;
    new BraintrustTrace(CONFIG, {
      loggerFactory: (options) => {
        loggerOptions = options;
        return {
          flush: vi.fn(() => Promise.resolve()),
        } as unknown as ReturnType<typeof initLogger>;
      },
    });

    expect(loggerOptions).toMatchObject({
      asyncFlush: true,
      noExitFlush: true,
    });
  });

  it("logs Fireworks usage and latency using Braintrust-native metrics", () => {
    expect(
      prepareBraintrustLogEvent({
        metadata: {
          model: "accounts/fireworks/models/kimi-k2p5",
          promptTokens: 1_200,
          completionTokens: 80,
          totalTokens: 1_280,
          cachedPromptTokens: 900,
          serverTimeToFirstTokenMs: 250,
          serverProcessingTimeMs: 1_500,
        },
      }),
    ).toEqual({
      metadata: {
        model: "accounts/fireworks/models/kimi-k2p5",
        promptTokens: 1_200,
        completionTokens: 80,
        totalTokens: 1_280,
        cachedPromptTokens: 900,
        serverTimeToFirstTokenMs: 250,
        serverProcessingTimeMs: 1_500,
      },
      metrics: {
        prompt_tokens: 1_200,
        completion_tokens: 80,
        tokens: 1_280,
        prompt_cached_tokens: 900,
        time_to_first_token: 0.25,
        server_processing_time: 1.5,
      },
    });
  });

  it("ignores invalid telemetry and keeps secret redaction in force", () => {
    expect(
      prepareBraintrustLogEvent({
        metadata: {
          promptTokens: Number.NaN,
          completionTokens: -1,
          totalTokens: Number.POSITIVE_INFINITY,
          apiKey: "do-not-log-me",
        },
      }),
    ).toEqual({
      metadata: {
        promptTokens: Number.NaN,
        completionTokens: -1,
        totalTokens: Number.POSITIVE_INFINITY,
        apiKey: "[REDACTED]",
      },
    });
  });

  it("bounds studio trace inputs to opaque correlations and counts", () => {
    expect(
      prepareStudioTraceInput({
        conversationCorrelationId: "raw-conversation-id",
        transcriptMessageCount: 5_000,
        userMessageCount: Number.NaN,
        transcriptBytes: Number.POSITIVE_INFINITY,
        explicitCancellationRequested: true,
      }),
    ).toEqual({
      conversationCorrelationId: "invalid",
      transcriptMessageCount: 50,
      userMessageCount: 0,
      transcriptBytes: 0,
      explicitCancellationRequested: true,
    });
    expect(
      prepareStudioToolTraceInput({
        conversationCorrelationId: "a".repeat(64),
        runId: randomUUID(),
        tool: "cancel_candidate",
      }),
    ).toMatchObject({
      conversationCorrelationId: "a".repeat(64),
      tool: "cancel_candidate",
    });
  });

  it("does not expose thrown provider text through SDK auto-error capture", async () => {
    const events: unknown[] = [];
    const trace = new BraintrustTrace(CONFIG, {
      loggerFactory: recordingLoggerFactory(events),
    });
    const sentinel = "RAW_PROVIDER_ERROR_WITH_TRANSCRIPT_AND_PRIVATE_REASONING";
    const original = new Error(sentinel);

    await expect(
      trace.run(minimalRun(), (root) =>
        root.child(
          "test.provider",
          "tool",
          { apiKey: "do-not-record-this" },
          () => Promise.reject(original),
        ),
      ),
    ).rejects.toBe(original);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("do-not-record-this");
    expect(serialized).toContain("child_operation_failed");
    expect(serialized).toContain("build_run_failed");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sdkAutoError");
  });

  it("shares one failed flush generation across overlapping callers", async () => {
    const pending = deferred<void>();
    let reportFlushError: ((error: Error) => void) | undefined;
    let flushCalls = 0;
    const logger = {
      flush: vi.fn(() => {
        flushCalls += 1;
        return flushCalls === 1 ? pending.promise : Promise.resolve();
      }),
    } as unknown as ReturnType<typeof initLogger>;
    const trace = new BraintrustTrace(CONFIG, {
      loggerFactory: (options) => {
        reportFlushError = (error) => {
          options?.onFlushError?.(error);
        };
        return logger;
      },
    });

    const first = trace.flush();
    const second = trace.flush();
    expect(first).toBe(second);
    expect(flushCalls).toBe(1);

    reportFlushError?.(new Error("provider unavailable"));
    pending.resolve();
    await expect(first).rejects.toThrow("Braintrust flush failed");
    await expect(second).rejects.toThrow("Braintrust flush failed");

    await expect(trace.flush()).resolves.toBeUndefined();
    expect(flushCalls).toBe(2);
  });
});

function recordingLoggerFactory(
  events: unknown[],
): NonNullable<BraintrustTraceOptions["loggerFactory"]> {
  const root = new RecordingSdkSpan(events);
  return () =>
    ({
      traced: async (
        callback: (span: Span) => Promise<unknown>,
        args: unknown,
      ) => {
        events.push(structuredClone(args));
        try {
          return await callback(root.value);
        } catch (error) {
          events.push({
            sdkAutoError:
              error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      flush: () => Promise.resolve(),
    }) as unknown as ReturnType<typeof initLogger>;
}

class RecordingSdkSpan {
  readonly value: Span;

  constructor(private readonly events: unknown[]) {
    this.value = {
      rootSpanId: "a".repeat(64),
      log: (event: unknown) => {
        this.events.push(structuredClone(event));
      },
      traced: async (
        callback: (span: Span) => Promise<unknown>,
        args: unknown,
      ) => {
        this.events.push(structuredClone(args));
        const child = new RecordingSdkSpan(this.events);
        try {
          return await callback(child.value);
        } catch (error) {
          this.events.push({
            sdkAutoError:
              error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    } as unknown as Span;
  }
}

function minimalRun(): BuildRun {
  return {
    id: randomUUID(),
    assignmentId: randomUUID(),
    assignmentHash: "a".repeat(64),
    projectId: "project-test",
    candidateId: "candidate-test",
    contractHash: "b".repeat(64),
    status: "queued",
    stage: "queued",
    cancelRequested: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
