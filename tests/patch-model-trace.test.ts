import { createHmac } from "node:crypto";

import type { initLogger, Span } from "braintrust";
import { describe, expect, it, vi } from "vitest";

import {
  BraintrustPatchModelTrace,
  type BraintrustPatchTraceOptions,
  type PatchTracePayload,
} from "../src/adapters/braintrust/patch-model-trace.js";
const TRACE_DIGEST_KEY = "braintrust-trace-digest-key-v1!".repeat(2);

function keyedDigest(value: string): string {
  return createHmac("sha256", TRACE_DIGEST_KEY).update(value).digest("hex");
}

function payload(status: PatchTracePayload["status"] = "completed") {
  return {
    correlationDigest: keyedDigest("opaque-correlation"),
    digestKeyId: "buildlabs-trace-hmac-v1",
    role: "patch" as const,
    status,
    counts: {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 75,
      toolCalls: 1,
      trialCount: 3,
      latencyMs: 250,
    },
    enums: {
      serviceTier: "standard" as const,
      apiKind: "responses" as const,
      cacheStatus: "hit" as const,
      fallbackReason: "none" as const,
      providerState: "provider-validated" as const,
    },
    digests: {
      modelResource: keyedDigest("model"),
      capabilitySnapshot: keyedDigest("capabilities"),
      routerPolicy: keyedDigest("router"),
      input: keyedDigest("input"),
      output: keyedDigest("output"),
      evidence: keyedDigest("evidence"),
      fallbackReason: keyedDigest("fallback-reason"),
      evaluationPolicy: keyedDigest("evaluation-policy"),
      matrix: keyedDigest("matrix"),
      trials: keyedDigest("trials"),
    },
    scores: {
      terminal: 1,
      proofGate: 1,
      privacy: 1,
      supportedClaims: 1,
      minimalPatch: 1,
    },
  };
}

function recordingFactory(
  events: unknown[],
  captureOptions?: (options: Parameters<typeof initLogger>[0]) => void,
): NonNullable<BraintrustPatchTraceOptions["loggerFactory"]> {
  const root = new RecordingSpan(events);
  return (options) => {
    captureOptions?.(options);
    return {
      traced: async (
        callback: (span: Span) => Promise<unknown>,
        args: unknown,
      ) => {
        events.push(structuredClone(args));
        return callback(root.value);
      },
      flush: vi.fn(() => Promise.resolve()),
    } as unknown as ReturnType<typeof initLogger>;
  };
}

class RecordingSpan {
  readonly value: Span;

  constructor(private readonly events: unknown[]) {
    this.value = {
      log: (event: unknown) => {
        this.events.push(structuredClone(event));
      },
      traced: async (
        callback: (span: Span) => Promise<unknown>,
        args: unknown,
      ) => {
        this.events.push(structuredClone(args));
        return callback(new RecordingSpan(this.events).value);
      },
    } as unknown as Span;
  }
}

describe("Braintrust Patch Model native trace", () => {
  it("emits native task, llm, tool, score, review, and eval spans", async () => {
    const events: unknown[] = [];
    const trace = new BraintrustPatchModelTrace(
      {
        apiKey: "braintrust-secret",
        appUrl: "https://www.braintrust.dev",
        projectName: "BuildLabs",
      },
      { loggerFactory: recordingFactory(events) },
    );

    await trace.run(
      "patch.dataset.publish",
      "task",
      payload(),
      async (root) => {
        await root.child("patch.inference", "llm", payload(), async (llm) => {
          await llm.child("patch.tool", "tool", payload(), () =>
            Promise.resolve(undefined),
          );
        });
        await root.child("patch.score", "score", payload(), () =>
          Promise.resolve(undefined),
        );
        await root.child("patch.review", "review", payload(), () =>
          Promise.resolve(undefined),
        );
        await root.child("patch.evaluate", "eval", payload(), () =>
          Promise.resolve(undefined),
        );
      },
    );

    const serialized = JSON.stringify(events);
    for (const type of ["task", "llm", "tool", "score", "review", "eval"]) {
      expect(serialized).toContain(`"type":"${type}"`);
    }
    expect(serialized).toContain('"prompt_tokens":100');
    expect(serialized).toContain('"completion_tokens":20');
    expect(serialized).toContain('"prompt_cached_tokens":75');
    expect(serialized).toContain('"latency":0.25');
    expect(serialized).toContain("counts-enums-keyed-digests");
    expect(serialized).not.toContain("braintrust-secret");
  });

  it("rejects trace leakage instead of recursively redacting it", async () => {
    const events: unknown[] = [];
    const trace = new BraintrustPatchModelTrace(
      {
        apiKey: "braintrust-secret",
        appUrl: "https://www.braintrust.dev",
        projectName: "BuildLabs",
      },
      { loggerFactory: recordingFactory(events) },
    );
    const contaminated = {
      ...payload(),
      rawPrompt: "private@example.com private reasoning customer patch",
    };

    await expect(
      trace.run(
        "patch.inference",
        "llm",
        contaminated as unknown as PatchTracePayload,
        () => Promise.resolve(undefined),
      ),
    ).rejects.toThrow("Unrecognized key");
    expect(JSON.stringify(events)).not.toContain("private@example.com");
  });

  it("rejects metrics outside the bounded trace contract", async () => {
    const events: unknown[] = [];
    const trace = new BraintrustPatchModelTrace(
      {
        apiKey: "braintrust-secret",
        appUrl: "https://www.braintrust.dev",
        projectName: "BuildLabs",
      },
      { loggerFactory: recordingFactory(events) },
    );
    const unbounded = {
      ...payload(),
      counts: {
        ...payload().counts,
        inputTokens: 10_000_001,
      },
    };

    await expect(
      trace.run("patch.inference", "llm", unbounded, () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("does not let provider error text enter trace events", async () => {
    const events: unknown[] = [];
    const trace = new BraintrustPatchModelTrace(
      {
        apiKey: "braintrust-secret",
        appUrl: "https://www.braintrust.dev",
        projectName: "BuildLabs",
      },
      { loggerFactory: recordingFactory(events) },
    );
    const error = new Error(
      "RAW_PROVIDER_TRANSCRIPT_WITH_PRIVATE_REASONING private@example.com",
    );

    await expect(
      trace.run("patch.inference", "llm", payload("failed"), () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("patch_trace_operation_failed");
    expect(serialized).not.toContain(error.message);
    expect(serialized).not.toContain("private@example.com");
  });

  it("fails closed when a required SDK flush reports an error", async () => {
    const events: unknown[] = [];
    let options: Parameters<typeof initLogger>[0] | undefined;
    const trace = new BraintrustPatchModelTrace(
      {
        apiKey: "braintrust-secret",
        appUrl: "https://www.braintrust.dev",
        projectName: "BuildLabs",
      },
      {
        loggerFactory: recordingFactory(events, (value) => {
          options = value;
        }),
      },
    );
    options?.onFlushError?.(new Error("provider unavailable"));

    await expect(trace.flush()).rejects.toThrow(
      "Braintrust Patch Model trace flush failed",
    );
  });
});
