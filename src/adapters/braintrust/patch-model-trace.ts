import { initLogger, type Span } from "braintrust";
import { z } from "zod";

import { Sha256Schema } from "../../domain/contract.js";

export const PatchTraceSpanTypeSchema = z.enum([
  "task",
  "llm",
  "tool",
  "score",
  "review",
  "eval",
]);
export type PatchTraceSpanType = z.infer<typeof PatchTraceSpanTypeSchema>;

const PatchTraceNameSchema = z.enum([
  "patch.dataset.publish",
  "patch.model.route",
  "patch.inference",
  "patch.tool",
  "patch.score",
  "patch.review",
  "patch.evaluate",
]);

const DigestKeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const PatchTracePayloadSchema = z.strictObject({
  correlationDigest: Sha256Schema,
  digestKeyId: DigestKeyIdSchema,
  role: z
    .enum([
      "builder",
      "patch",
      "orchestration",
      "raster_vision",
      "voice",
      "evaluator",
    ])
    .optional(),
  status: z.enum(["pending", "completed", "failed", "blocked"]),
  counts: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().max(10_000_000).optional(),
      outputTokens: z.number().int().nonnegative().max(10_000_000).optional(),
      cachedTokens: z.number().int().nonnegative().max(10_000_000).optional(),
      toolCalls: z.number().int().nonnegative().max(64).optional(),
      inputBytes: z.number().int().nonnegative().max(100_000_000).optional(),
      outputBytes: z.number().int().nonnegative().max(100_000_000).optional(),
      trialCount: z.number().int().nonnegative().max(2_000_000).optional(),
      caseCount: z.number().int().nonnegative().max(100_000).optional(),
      findingCount: z.number().int().nonnegative().max(100_000).optional(),
      latencyMs: z.number().nonnegative().max(86_400_000).optional(),
    })
    .optional(),
  enums: z
    .strictObject({
      serviceTier: z.enum(["standard", "priority", "fast"]).optional(),
      apiKind: z.enum(["chat-completions", "responses"]).optional(),
      cacheStatus: z.enum(["hit", "miss", "unknown"]).optional(),
      fallbackReason: z
        .enum([
          "none",
          "preferred-unavailable",
          "capability-mismatch",
          "model-disappeared",
        ])
        .optional(),
      providerState: z
        .enum([
          "unconfigured",
          "configured",
          "healthy",
          "provider-validated",
          "submitted",
          "completed",
          "failed",
        ])
        .optional(),
    })
    .optional(),
  digests: z
    .strictObject({
      modelResource: Sha256Schema.optional(),
      capabilitySnapshot: Sha256Schema.optional(),
      routerPolicy: Sha256Schema.optional(),
      input: Sha256Schema.optional(),
      output: Sha256Schema.optional(),
      evidence: Sha256Schema.optional(),
      dataset: Sha256Schema.optional(),
      datasetContent: Sha256Schema.optional(),
      bundle: Sha256Schema.optional(),
      contract: Sha256Schema.optional(),
      review: Sha256Schema.optional(),
      fallbackReason: Sha256Schema.optional(),
      evaluationPolicy: Sha256Schema.optional(),
      matrix: Sha256Schema.optional(),
      trials: Sha256Schema.optional(),
    })
    .optional(),
  scores: z
    .strictObject({
      terminal: z.number().min(0).max(1).optional(),
      proofGate: z.number().min(0).max(1).optional(),
      privacy: z.number().min(0).max(1).optional(),
      supportedClaims: z.number().min(0).max(1).optional(),
      minimalPatch: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type PatchTracePayload = z.infer<typeof PatchTracePayloadSchema>;

export interface BraintrustPatchTraceOptions {
  loggerFactory?: (
    options: Parameters<typeof initLogger>[0],
  ) => ReturnType<typeof initLogger>;
}

type TraceOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function nativeMetrics(payload: PatchTracePayload): Record<string, number> {
  const metrics: Record<string, number> = {};
  const counts = payload.counts;
  if (!counts) return metrics;
  if (counts.inputTokens !== undefined) {
    metrics.prompt_tokens = counts.inputTokens;
  }
  if (counts.outputTokens !== undefined) {
    metrics.completion_tokens = counts.outputTokens;
  }
  if (counts.inputTokens !== undefined && counts.outputTokens !== undefined) {
    metrics.tokens = counts.inputTokens + counts.outputTokens;
  }
  if (counts.cachedTokens !== undefined) {
    metrics.prompt_cached_tokens = counts.cachedTokens;
  }
  if (counts.latencyMs !== undefined) {
    metrics.latency = counts.latencyMs / 1_000;
  }
  return metrics;
}

function event(payload: PatchTracePayload) {
  const { scores, ...input } = PatchTracePayloadSchema.parse(payload);
  const metrics = nativeMetrics(payload);
  const safeScores: Record<string, number> = {};
  for (const [name, value] of Object.entries(scores ?? {})) {
    if (value !== undefined) {
      safeScores[name] = value;
    }
  }
  return {
    input,
    ...(Object.keys(safeScores).length > 0 ? { scores: safeScores } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    metadata: {
      schemaVersion: 1,
      dataClass: "counts-enums-keyed-digests",
      contentCapture: "disabled",
    },
  };
}

export class SafePatchSpan {
  constructor(private readonly span: Span) {}

  async child<T>(
    name: z.input<typeof PatchTraceNameSchema>,
    type: PatchTraceSpanType,
    payload: PatchTracePayload,
    operation: (span: SafePatchSpan) => Promise<T>,
  ): Promise<T> {
    const safeName = PatchTraceNameSchema.parse(name);
    const safeType = PatchTraceSpanTypeSchema.parse(type);
    const safeEvent = event(payload);
    const result: { outcome?: TraceOutcome<T> } = {};
    await this.span.traced(
      async (child): Promise<void> => {
        const wrapped = new SafePatchSpan(child);
        try {
          result.outcome = { ok: true, value: await operation(wrapped) };
        } catch (error) {
          child.log({
            error: "patch_trace_operation_failed",
            metadata: {
              status: "failed",
              errorCode:
                error instanceof z.ZodError
                  ? "validation_failed"
                  : "operation_failed",
            },
          });
          result.outcome = { ok: false, error };
        }
      },
      {
        name: safeName,
        type: safeType,
        event: safeEvent,
      },
    );
    const outcome = result.outcome;
    if (!outcome) {
      throw new Error("Braintrust child trace did not complete");
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}

export class BraintrustPatchModelTrace {
  readonly #logger: ReturnType<typeof initLogger>;
  #flushError: Error | undefined;
  #flushChain: Promise<void> = Promise.resolve();

  constructor(
    config: {
      apiKey: string;
      appUrl: string;
      projectName: string;
    },
    options: BraintrustPatchTraceOptions = {},
  ) {
    this.#logger = (options.loggerFactory ?? initLogger)({
      projectName: config.projectName,
      apiKey: config.apiKey,
      appUrl: config.appUrl,
      asyncFlush: true,
      debugLogLevel: false,
      noExitFlush: true,
      onFlushError: (error) => {
        this.#flushError =
          error instanceof Error ? error : new Error("Braintrust flush failed");
      },
    });
  }

  async run<T>(
    name: z.input<typeof PatchTraceNameSchema>,
    type: PatchTraceSpanType,
    payload: PatchTracePayload,
    operation: (span: SafePatchSpan) => Promise<T>,
  ): Promise<T> {
    const safeName = PatchTraceNameSchema.parse(name);
    const safeType = PatchTraceSpanTypeSchema.parse(type);
    const safeEvent = event(payload);
    const result: { outcome?: TraceOutcome<T> } = {};
    await this.#logger.traced(
      async (span): Promise<void> => {
        try {
          result.outcome = {
            ok: true,
            value: await operation(new SafePatchSpan(span)),
          };
        } catch (error) {
          span.log({
            error: "patch_trace_operation_failed",
            metadata: {
              status: "failed",
              errorCode:
                error instanceof z.ZodError
                  ? "validation_failed"
                  : "operation_failed",
            },
          });
          result.outcome = { ok: false, error };
        }
      },
      {
        name: safeName,
        type: safeType,
        event: safeEvent,
      },
    );
    const outcome = result.outcome;
    if (!outcome) {
      throw new Error("Braintrust Patch Model trace did not complete");
    }
    await this.flush();
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async flush(): Promise<void> {
    const flush = this.#flushChain.then(async () => {
      const priorError = this.#flushError;
      this.#flushError = undefined;
      await this.#logger.flush();
      const flushError = this.#flushError ?? priorError;
      this.#flushError = undefined;
      if (flushError) {
        throw new Error("Braintrust Patch Model trace flush failed", {
          cause: flushError,
        });
      }
    });
    this.#flushChain = flush.catch(() => undefined);
    await flush;
  }
}
