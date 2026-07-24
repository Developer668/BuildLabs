export type OrchestrationTraceOperation =
  "intake_analysis" | "proposal_planning" | "change_classification";

export interface OrchestrationTraceEvent {
  operation: OrchestrationTraceOperation;
  input: Readonly<Record<string, unknown>>;
}

export interface OrchestrationTraceLogEntry {
  output?: Readonly<Record<string, unknown>>;
  error?: string;
}

export interface OrchestrationTraceSpan {
  log(event: OrchestrationTraceLogEntry): void;
}

export class OrchestrationTraceError extends Error {
  override readonly name = "OrchestrationTraceError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Tracing is part of the orchestration policy boundary, not best-effort
 * telemetry. Implementations must reject when a trace cannot be recorded or
 * durably flushed.
 */
export interface OrchestrationTracePort {
  /**
   * Performs a read-only authenticated Braintrust project probe.
   */
  health(signal?: AbortSignal): Promise<void>;
  run<T>(
    event: OrchestrationTraceEvent,
    operation: (span: OrchestrationTraceSpan) => Promise<T>,
  ): Promise<T>;
  flush(): Promise<void>;
}
