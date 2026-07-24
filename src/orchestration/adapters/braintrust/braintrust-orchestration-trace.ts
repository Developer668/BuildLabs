import { initLogger } from "braintrust";

import { redactValue } from "../../../lib/redaction.js";
import {
  OrchestrationTraceError,
  type OrchestrationTraceEvent,
  type OrchestrationTraceLogEntry,
  type OrchestrationTracePort,
  type OrchestrationTraceSpan,
} from "../../ports/trace.js";

export interface BraintrustOrchestrationSdkSpan {
  readonly rootSpanId: string;
  log(event: unknown): void;
}

export interface BraintrustOrchestrationLogger {
  traced<T>(
    operation: (span: BraintrustOrchestrationSdkSpan) => Promise<T>,
    options: {
      name: string;
      type: "task";
      event: {
        input: unknown;
        metadata: Readonly<Record<string, unknown>>;
      };
    },
  ): Promise<T>;
  flush(): Promise<void>;
}

export interface BraintrustOrchestrationTraceOptions {
  apiKey: string;
  apiUrl?: string;
  appUrl?: string;
  projectName: string;
  logger?: BraintrustOrchestrationLogger;
  fetch?: typeof fetch;
}

const NO_OPERATION_ERROR = Symbol("no-operation-error");

export class BraintrustOrchestrationTrace implements OrchestrationTracePort {
  readonly #logger: BraintrustOrchestrationLogger;
  readonly #apiKey: string;
  readonly #apiUrl: string;
  readonly #projectName: string;
  readonly #fetch: typeof fetch;
  #backgroundFlushError: unknown = undefined;

  constructor(options: BraintrustOrchestrationTraceOptions) {
    const apiKey = validateSecret(options.apiKey);
    const projectName = validateProjectName(options.projectName);
    const apiUrl = validateBaseUrl(
      options.apiUrl ?? "https://api.braintrust.dev",
    );
    const appUrl = validateBaseUrl(
      options.appUrl ?? "https://www.braintrust.dev",
    );
    this.#apiKey = apiKey;
    this.#apiUrl = apiUrl;
    this.#projectName = projectName;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#logger =
      options.logger ??
      initLogger({
        projectName,
        apiKey,
        appUrl,
        asyncFlush: true,
        setCurrent: false,
        noExitFlush: true,
        debugLogLevel: false,
        onFlushError: (error) => {
          this.#backgroundFlushError = error;
        },
      });
  }

  async health(signal?: AbortSignal): Promise<void> {
    const url = new URL("v1/project", `${this.#apiUrl}/`);
    url.searchParams.set("limit", "1");
    url.searchParams.set("project_name", this.#projectName);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
        },
        redirect: "error",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new OrchestrationTraceError(
        "Braintrust orchestration readiness probe failed",
        { cause: error },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OrchestrationTraceError(
        "Braintrust orchestration readiness probe failed",
      );
    }
    let result: {
      objects?: Array<{ id?: unknown; name?: unknown }>;
    };
    try {
      result = (await response.json()) as typeof result;
    } catch (error) {
      throw new OrchestrationTraceError(
        "Braintrust orchestration readiness probe returned invalid data",
        { cause: error },
      );
    }
    const project = result.objects?.[0];
    if (
      result.objects?.length !== 1 ||
      typeof project?.id !== "string" ||
      project.id.length === 0 ||
      project.name !== this.#projectName ||
      this.#backgroundFlushError !== undefined
    ) {
      throw new OrchestrationTraceError(
        "Braintrust orchestration readiness probe returned invalid data",
      );
    }
  }

  async run<T>(
    event: OrchestrationTraceEvent,
    operation: (span: OrchestrationTraceSpan) => Promise<T>,
  ): Promise<T> {
    let operationError: unknown = NO_OPERATION_ERROR;
    let providerVisibleOperationError: Error | undefined;
    try {
      return await this.#logger.traced(
        async (span) => {
          try {
            return await operation(new RedactingBraintrustSpan(span));
          } catch (error) {
            operationError = error;
            providerVisibleOperationError = new ProviderVisibleOperationError(
              safeErrorName(error),
            );
            throw providerVisibleOperationError;
          }
        },
        {
          name: `buildlabs.orchestration.${event.operation}`,
          type: "task",
          event: {
            input: redactValue(event.input),
            metadata: {
              component: "general-orchestrator",
              operation: event.operation,
              ...(typeof event.input.projectCorrelation === "string"
                ? { projectCorrelation: event.input.projectCorrelation }
                : {}),
              ...(typeof event.input.proposalVersion === "number"
                ? { proposalVersion: event.input.proposalVersion }
                : {}),
            },
          },
        },
      );
    } catch (error) {
      if (
        operationError !== NO_OPERATION_ERROR &&
        error === providerVisibleOperationError
      ) {
        throw operationError;
      }
      if (error instanceof OrchestrationTraceError) {
        throw error;
      }
      throw new OrchestrationTraceError(
        `Could not record ${event.operation} trace`,
        { cause: error },
      );
    }
  }

  async flush(): Promise<void> {
    const priorBackgroundError = this.#backgroundFlushError;
    this.#backgroundFlushError = undefined;
    try {
      await this.#logger.flush();
    } catch (error) {
      throw new OrchestrationTraceError(
        "Could not durably flush orchestration traces",
        { cause: error },
      );
    }
    const backgroundError = this.#backgroundFlushError ?? priorBackgroundError;
    if (backgroundError !== undefined) {
      throw new OrchestrationTraceError(
        "Could not durably flush orchestration traces",
        { cause: backgroundError },
      );
    }
  }
}

class ProviderVisibleOperationError extends Error {
  override readonly name = "OrchestrationOperationError";

  constructor(errorName: string) {
    super(`Orchestration operation failed (${errorName})`);
  }
}

class RedactingBraintrustSpan implements OrchestrationTraceSpan {
  constructor(private readonly span: BraintrustOrchestrationSdkSpan) {}

  log(event: OrchestrationTraceLogEntry): void {
    try {
      this.span.log(redactValue(event));
    } catch (error) {
      throw new OrchestrationTraceError(
        "Could not record orchestration trace output",
        { cause: error },
      );
    }
  }
}

function validateSecret(value: string): string {
  if (
    value.length < 16 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new OrchestrationTraceError(
      "Braintrust orchestration trace configuration is invalid",
    );
  }
  return value;
}

function validateProjectName(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new OrchestrationTraceError(
      "Braintrust orchestration trace configuration is invalid",
    );
  }
  return value;
}

function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OrchestrationTraceError(
      "Braintrust orchestration trace configuration is invalid",
      { cause: error },
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new OrchestrationTraceError(
      "Braintrust orchestration trace configuration is invalid",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
