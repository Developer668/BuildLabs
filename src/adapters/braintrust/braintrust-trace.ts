import { initLogger, type Span } from "braintrust";

import type { AppConfig } from "../../config.js";
import type { BuildRun } from "../../domain/run.js";
import { redactValue } from "../../lib/redaction.js";
import type {
  StudioToolTraceInput,
  StudioTraceInput,
  TracePort,
  TraceSpan,
} from "../../ports/index.js";

type TraceLogEvent = Parameters<TraceSpan["log"]>[0];
type BraintrustLogEvent = Parameters<Span["log"]>[0];

export interface BraintrustTraceOptions {
  loggerFactory?: (
    options: Parameters<typeof initLogger>[0],
  ) => ReturnType<typeof initLogger>;
}

export class BraintrustTrace implements TracePort {
  readonly #logger: ReturnType<typeof initLogger>;
  readonly #apiKey: string;
  readonly #apiUrl: string;
  readonly #projectName: string;
  #activeFlushGeneration: number | undefined;
  #backgroundFlushError: Error | undefined;
  #flushGeneration = 0;
  readonly #flushErrors = new Map<number, Error>();
  #flushInFlight: Promise<void> | undefined;

  constructor(config: AppConfig, options: BraintrustTraceOptions = {}) {
    this.#apiKey = config.BRAINTRUST_API_KEY;
    this.#apiUrl = config.BRAINTRUST_API_URL.replace(/\/+$/, "");
    this.#projectName = config.BRAINTRUST_PROJECT_NAME;
    this.#logger = (options.loggerFactory ?? initLogger)({
      projectName: config.BRAINTRUST_PROJECT_NAME,
      apiKey: config.BRAINTRUST_API_KEY,
      appUrl: config.BRAINTRUST_APP_URL,
      asyncFlush: true,
      debugLogLevel: false,
      noExitFlush: true,
      onFlushError: (error) => {
        const normalized =
          error instanceof Error ? error : new Error("Braintrust flush failed");
        if (this.#activeFlushGeneration === undefined) {
          this.#backgroundFlushError = normalized;
        } else {
          this.#flushErrors.set(this.#activeFlushGeneration, normalized);
        }
      },
    });
  }

  async run<T>(
    run: BuildRun,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const outcome = await this.#logger.traced(
      async (span) => {
        const wrapped = new BraintrustSpan(span);
        try {
          const result = await operation(wrapped);
          wrapped.log({
            output: {
              status: "completed",
              runId: run.id,
            },
          });
          return { ok: true, value: result } as const;
        } catch (error) {
          wrapped.log({
            error: "build_run_failed",
            metadata: {
              errorCode: traceErrorCode(error),
            },
          });
          return { ok: false, error } as const;
        }
      },
      {
        name: "buildlabs.build-agent.run",
        type: "task",
        event: {
          input: {
            runId: run.id,
            projectId: run.projectId,
            candidateId: run.candidateId,
            contractHash: run.contractHash,
          },
          metadata: {
            component: "build-agent-backend",
            slotId: run.slotId,
          },
        },
      },
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  async studio<T>(
    input: StudioTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const outcome = await this.#logger.traced(
      async (span): Promise<TraceOutcome<T>> => {
        const wrapped = new BraintrustSpan(span);
        try {
          const value = await operation(wrapped);
          wrapped.log({
            metadata: {
              studioStatus: "completed",
            },
          });
          return { ok: true, value };
        } catch (error) {
          // Resolve the traced callback so the SDK cannot auto-record a
          // provider error that may contain transcript or prompt fragments.
          wrapped.log({
            error: "studio_operation_failed",
            metadata: {
              studioStatus: "failed",
            },
          });
          return { ok: false, error };
        }
      },
      {
        name: "buildlabs.studio.voice-turn",
        type: "task",
        event: {
          input: prepareStudioTraceInput(input),
          metadata: {
            component: "build-agent-backend",
            channel: "elevenlabs-speech-engine",
            contentCapture: "disabled",
          },
        },
      },
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  async studioTool<T>(
    input: StudioToolTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const safeInput = prepareStudioToolTraceInput(input);
    const outcome = await this.#logger.traced(
      async (span): Promise<TraceOutcome<T>> => {
        const wrapped = new BraintrustSpan(span);
        try {
          const value = await operation(wrapped);
          wrapped.log({
            metadata: {
              studioToolStatus: "completed",
            },
          });
          return { ok: true, value };
        } catch (error) {
          wrapped.log({
            error: "studio_tool_failed",
            metadata: {
              studioToolStatus: "failed",
            },
          });
          return { ok: false, error };
        }
      },
      {
        name: `buildlabs.studio.webhook.${safeInput.tool}`,
        type: "tool",
        event: {
          input: safeInput,
          metadata: {
            component: "build-agent-backend",
            channel: "elevenlabs-webhook",
            contentCapture: "disabled",
          },
        },
      },
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  flush(): Promise<void> {
    if (this.#flushInFlight) {
      return this.#flushInFlight;
    }
    const generation = ++this.#flushGeneration;
    const priorError = this.#backgroundFlushError;
    this.#backgroundFlushError = undefined;
    this.#activeFlushGeneration = generation;
    const flush = this.#flushGenerationOnce(generation, priorError);
    this.#flushInFlight = flush;
    void flush.then(
      () => {
        if (this.#flushInFlight === flush) {
          this.#flushInFlight = undefined;
        }
      },
      () => {
        if (this.#flushInFlight === flush) {
          this.#flushInFlight = undefined;
        }
      },
    );
    return flush;
  }

  async health(signal?: AbortSignal): Promise<void> {
    const url = new URL("v1/project", `${this.#apiUrl}/`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("project_name", this.#projectName);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `Braintrust project readiness probe failed (${response.status})`,
      );
    }
    const result = (await response.json()) as {
      objects?: Array<{ id?: unknown; name?: unknown }>;
    };
    const project = result.objects?.[0];
    if (
      !project ||
      result.objects?.length !== 1 ||
      typeof project.id !== "string" ||
      project.id.length === 0 ||
      project.name !== this.#projectName
    ) {
      throw new Error(
        "Braintrust project readiness probe returned an invalid project",
      );
    }
    if (this.#backgroundFlushError) {
      throw this.#backgroundFlushError;
    }
  }

  async #flushGenerationOnce(
    generation: number,
    priorError: Error | undefined,
  ): Promise<void> {
    try {
      await this.#logger.flush();
      const flushError = this.#flushErrors.get(generation) ?? priorError;
      if (flushError) {
        throw new Error("Braintrust flush failed", { cause: flushError });
      }
    } finally {
      this.#flushErrors.delete(generation);
      if (this.#activeFlushGeneration === generation) {
        this.#activeFlushGeneration = undefined;
      }
    }
  }
}

type TraceOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

class BraintrustSpan implements TraceSpan {
  constructor(private readonly span: Span) {}

  get traceId(): string {
    return this.span.rootSpanId;
  }

  log(event: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    scores?: Record<string, number>;
    error?: string;
  }): void {
    this.span.log(prepareBraintrustLogEvent(event));
  }

  async child<T>(
    name: string,
    type: "function" | "llm" | "review" | "score" | "task" | "tool",
    input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    const outcome = await this.span.traced(
      async (childSpan): Promise<TraceOutcome<T>> => {
        const wrapped = new BraintrustSpan(childSpan);
        try {
          return { ok: true, value: await operation(wrapped) };
        } catch (error) {
          wrapped.log({
            error: "child_operation_failed",
            metadata: {
              errorCode: traceErrorCode(error),
            },
          });
          return { ok: false, error };
        }
      },
      {
        name,
        type,
        event: { input: redactValue(input) },
      },
    );
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }
}

export function prepareBraintrustLogEvent(
  event: TraceLogEvent,
): BraintrustLogEvent {
  const metrics = braintrustMetrics(event.metadata);
  return redactValue({
    ...event,
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  }) as BraintrustLogEvent;
}

export function prepareStudioTraceInput(
  input: StudioTraceInput,
): StudioTraceInput {
  return {
    conversationCorrelationId: /^[a-f0-9]{64}$/u.test(
      input.conversationCorrelationId,
    )
      ? input.conversationCorrelationId
      : "invalid",
    transcriptMessageCount: boundedInteger(input.transcriptMessageCount, 50),
    userMessageCount: boundedInteger(input.userMessageCount, 50),
    transcriptBytes: boundedInteger(input.transcriptBytes, 128 * 1_024),
    explicitCancellationRequested: input.explicitCancellationRequested,
  };
}

export function prepareStudioToolTraceInput(
  input: StudioToolTraceInput,
): StudioToolTraceInput {
  const tools = new Set<StudioToolTraceInput["tool"]>([
    "cancel_candidate",
    "get_candidate",
    "get_candidate_evidence",
  ]);
  return {
    conversationCorrelationId: /^[a-f0-9]{64}$/u.test(
      input.conversationCorrelationId,
    )
      ? input.conversationCorrelationId
      : "invalid",
    runId: zUuid(input.runId) ? input.runId : "invalid",
    tool: tools.has(input.tool) ? input.tool : "get_candidate",
  };
}

function braintrustMetrics(
  metadata: Record<string, unknown> | undefined,
): Record<string, number> {
  if (!metadata) {
    return {};
  }

  const metrics: Record<string, number> = {};
  addMetric(metrics, "prompt_tokens", metadata.promptTokens);
  addMetric(metrics, "completion_tokens", metadata.completionTokens);
  addMetric(metrics, "tokens", metadata.totalTokens);
  addMetric(metrics, "prompt_cached_tokens", metadata.cachedPromptTokens);
  addMillisecondsMetric(
    metrics,
    "time_to_first_token",
    metadata.serverTimeToFirstTokenMs,
  );
  addMillisecondsMetric(
    metrics,
    "server_processing_time",
    metadata.serverProcessingTimeMs,
  );
  return metrics;
}

function addMetric(
  metrics: Record<string, number>,
  name: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    metrics[name] = value;
  }
}

function boundedInteger(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function zUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function traceErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }
  if (error instanceof Error && error.name === "ZodError") {
    return "validation_failed";
  }
  return "operation_failed";
}

function addMillisecondsMetric(
  metrics: Record<string, number>,
  name: string,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    metrics[name] = value / 1_000;
  }
}
