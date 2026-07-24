import { randomBytes } from "node:crypto";

import { z } from "zod";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const CorrelationIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const CountSchema = z.number().int().nonnegative().max(1_000_000_000);

const FireworksRolloutMetadataSchema = z.strictObject({
  invocation_id: CorrelationIdSchema,
  experiment_id: CorrelationIdSchema,
  rollout_id: CorrelationIdSchema,
  run_id: CorrelationIdSchema,
  row_id: CorrelationIdSchema,
});

export const FireworksRolloutInitCorrelationSchema = z.strictObject({
  model_base_url: z.url(),
  metadata: FireworksRolloutMetadataSchema,
});
export type FireworksRolloutInitCorrelation = z.infer<
  typeof FireworksRolloutInitCorrelationSchema
>;

export const FireworksRolloutMetricsSchema = z.strictObject({
  modelDigest: Sha256Schema,
  datasetDigest: Sha256Schema,
  policyDigest: Sha256Schema,
  capabilitySnapshotDigest: Sha256Schema,
  inputTokenCount: CountSchema,
  outputTokenCount: CountSchema,
  toolCallCount: z.number().int().nonnegative().max(128),
  retryCount: z.number().int().nonnegative().max(32),
  durationMs: CountSchema,
});
export type FireworksRolloutMetrics = z.infer<
  typeof FireworksRolloutMetricsSchema
>;

export const FireworksRolloutErrorCodeSchema = z.enum([
  "cancelled",
  "deadline_exceeded",
  "internal",
  "invalid_argument",
  "provider_unavailable",
  "reward_rejected",
  "tool_failure",
]);
export type FireworksRolloutErrorCode = z.infer<
  typeof FireworksRolloutErrorCodeSchema
>;

const ERROR_STATUS: Readonly<Record<FireworksRolloutErrorCode, number>> = {
  cancelled: 1,
  deadline_exceeded: 4,
  internal: 13,
  invalid_argument: 3,
  provider_unavailable: 14,
  reward_rejected: 3,
  tool_failure: 13,
};

const EventNameSchema = z.enum([
  "rollout_error",
  "rollout_finished",
  "rollout_heartbeat",
  "rollout_started",
]);
type EventName = z.infer<typeof EventNameSchema>;

const TraceExtrasSchema = z.strictObject({
  schemaVersion: z.literal(1),
  event: EventNameSchema,
  sequence: z.number().int().positive().max(1_000_000),
  phase: z.enum(["evaluation", "training"]),
  metrics: FireworksRolloutMetricsSchema,
  reward: z.number().min(0).max(1).optional(),
  errorCode: FireworksRolloutErrorCodeSchema.optional(),
});

const TraceStatusSchema = z.strictObject({
  code: z.number().int().min(1).max(101),
  message: z.enum(["Rollout failed", "Rollout finished", "Rollout is running"]),
  details: z.tuple([]),
});

const TracePayloadSchema = z
  .strictObject({
    program: z.literal("buildlabs-patch-rollout"),
    status: TraceStatusSchema,
    message: EventNameSchema,
    tags: z
      .tuple([
        z.string().regex(/^rollout_id:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        z.string().regex(/^invocation_id:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        z.string().regex(/^experiment_id:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        z.string().regex(/^run_id:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        z.string().regex(/^row_id:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        z
          .string()
          .regex(/^event:rollout_(?:error|finished|heartbeat|started)$/),
      ])
      .readonly(),
    extras: TraceExtrasSchema,
  })
  .superRefine((payload, context) => {
    if (payload.message !== payload.extras.event) {
      context.addIssue({
        code: "custom",
        message: "Rollout trace message and event must match",
        path: ["message"],
      });
    }
    if (
      (payload.message === "rollout_started" ||
        payload.message === "rollout_heartbeat") &&
      (payload.status.code !== 101 ||
        payload.status.message !== "Rollout is running" ||
        payload.extras.reward !== undefined ||
        payload.extras.errorCode !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Running rollout trace has invalid terminal fields",
        path: ["status"],
      });
    }
    if (
      payload.message === "rollout_finished" &&
      (payload.status.code !== 100 ||
        payload.status.message !== "Rollout finished" ||
        payload.extras.reward === undefined ||
        payload.extras.errorCode !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Finished rollout trace requires a bounded reward",
        path: ["status"],
      });
    }
    if (
      payload.message === "rollout_error" &&
      (payload.extras.errorCode === undefined ||
        payload.extras.reward !== undefined ||
        payload.status.code !==
          (payload.extras.errorCode === undefined
            ? -1
            : ERROR_STATUS[payload.extras.errorCode]) ||
        payload.status.message !== "Rollout failed")
    ) {
      context.addIssue({
        code: "custom",
        message: "Error rollout trace has an invalid status",
        path: ["status"],
      });
    }
  });

export interface FireworksRolloutTraceTransport {
  post(input: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<{ status: number }>;
}

const defaultTransport: FireworksRolloutTraceTransport = {
  async post(input) {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
    });
    return { status: response.status };
  },
};

export interface FireworksRolloutTraceReceipt {
  rolloutId: string;
  event: EventName;
  sequence: number;
  endpoint: "logs" | "v1-logs";
  payloadDigest: string;
}

interface TraceClientConfig {
  apiKey: string;
  transport?: FireworksRolloutTraceTransport;
  baseUrl?: string;
}

interface SessionConfig {
  correlation: FireworksRolloutInitCorrelation;
  phase: "evaluation" | "training";
  heartbeatTimeoutMs: number;
  now?: () => number;
}

export function createFireworksRolloutId(): string {
  return randomBytes(32).toString("hex");
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function requireCorrelatedModelBaseUrl(
  input: FireworksRolloutInitCorrelation,
  tracingOrigin: string,
): FireworksRolloutInitCorrelation {
  const correlation = FireworksRolloutInitCorrelationSchema.parse(input);
  const modelBaseUrl = new URL(correlation.model_base_url);
  if (
    modelBaseUrl.protocol !== "https:" ||
    modelBaseUrl.origin !== tracingOrigin ||
    modelBaseUrl.username !== "" ||
    modelBaseUrl.password !== "" ||
    modelBaseUrl.search !== "" ||
    modelBaseUrl.hash !== ""
  ) {
    throw new Error(
      "Fireworks rollout model base URL must use the configured tracing origin without credentials or query data",
    );
  }
  const segments = modelBaseUrl.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));
  for (const [key, value] of Object.entries(correlation.metadata)) {
    const matches = segments.reduce<number[]>((indices, segment, index) => {
      if (segment === key) indices.push(index);
      return indices;
    }, []);
    if (matches.length !== 1 || segments[matches[0]! + 1] !== value) {
      throw new Error(`Fireworks rollout model base URL does not bind ${key}`);
    }
  }
  return correlation;
}

function traceStatus(
  event: EventName,
  errorCode?: FireworksRolloutErrorCode,
): z.infer<typeof TraceStatusSchema> {
  if (event === "rollout_finished") {
    return { code: 100, message: "Rollout finished", details: [] };
  }
  if (event === "rollout_error") {
    if (errorCode === undefined) {
      throw new Error("Fireworks rollout error requires an error code");
    }
    return {
      code: ERROR_STATUS[errorCode],
      message: "Rollout failed",
      details: [],
    };
  }
  return { code: 101, message: "Rollout is running", details: [] };
}

export class FireworksRolloutTraceClient {
  readonly #apiKey: string;
  readonly #transport: FireworksRolloutTraceTransport;
  readonly #baseUrl: string;

  constructor(input: TraceClientConfig) {
    if (input.apiKey.length === 0 || input.apiKey.length > 8_192) {
      throw new Error("Fireworks tracing API key is required");
    }
    this.#apiKey = input.apiKey;
    this.#transport = input.transport ?? defaultTransport;
    this.#baseUrl = (input.baseUrl ?? "https://tracing.fireworks.ai").replace(
      /\/+$/u,
      "",
    );
  }

  createSession(input: SessionConfig): FireworksRolloutTraceSession {
    return new FireworksRolloutTraceSession(this, {
      ...input,
      correlation: requireCorrelatedModelBaseUrl(
        input.correlation,
        new URL(this.#baseUrl).origin,
      ),
    });
  }

  async post(
    correlationInput: FireworksRolloutInitCorrelation,
    event: EventName,
    extras: z.input<typeof TraceExtrasSchema>,
  ): Promise<FireworksRolloutTraceReceipt> {
    const correlation = requireCorrelatedModelBaseUrl(
      correlationInput,
      new URL(this.#baseUrl).origin,
    );
    const parsedExtras = TraceExtrasSchema.parse(extras);
    const metadata = correlation.metadata;
    const payload = TracePayloadSchema.parse({
      program: "buildlabs-patch-rollout",
      status: traceStatus(event, parsedExtras.errorCode),
      message: event,
      tags: [
        `rollout_id:${metadata.rollout_id}`,
        `invocation_id:${metadata.invocation_id}`,
        `experiment_id:${metadata.experiment_id}`,
        `run_id:${metadata.run_id}`,
        `row_id:${metadata.row_id}`,
        `event:${event}`,
      ],
      extras: parsedExtras,
    });
    const body = canonicalJson(payload);
    const headers = {
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
    };
    const primary = await this.#transport.post({
      url: `${this.#baseUrl}/logs`,
      headers,
      body,
    });
    let endpoint: FireworksRolloutTraceReceipt["endpoint"] = "logs";
    let response = primary;
    if (primary.status === 404 || primary.status === 405) {
      endpoint = "v1-logs";
      response = await this.#transport.post({
        url: `${this.#baseUrl}/v1/logs`,
        headers,
        body,
      });
    }
    if (!isSuccess(response.status)) {
      throw new Error(
        `Fireworks rollout trace was not acknowledged (${response.status})`,
      );
    }
    return {
      rolloutId: metadata.rollout_id,
      event,
      sequence: payload.extras.sequence,
      endpoint,
      payloadDigest: sha256(body),
    };
  }
}

export class FireworksRolloutTraceSession {
  readonly #client: FireworksRolloutTraceClient;
  readonly #correlation: FireworksRolloutInitCorrelation;
  readonly #rolloutId: string;
  readonly #modelBaseUrl: string;
  readonly #phase: SessionConfig["phase"];
  readonly #heartbeatTimeoutMs: number;
  readonly #now: () => number;
  #started = false;
  #ended = false;
  #busy = false;
  #sequence = 0;
  #heartbeatCount = 0;
  #startedAt: number | null = null;
  #lastAcknowledgedHeartbeatAt: number | null = null;

  constructor(client: FireworksRolloutTraceClient, input: SessionConfig) {
    this.#client = client;
    this.#correlation = FireworksRolloutInitCorrelationSchema.parse(
      input.correlation,
    );
    this.#rolloutId = this.#correlation.metadata.rollout_id;
    this.#modelBaseUrl = this.#correlation.model_base_url;
    this.#phase = input.phase;
    if (
      !Number.isInteger(input.heartbeatTimeoutMs) ||
      input.heartbeatTimeoutMs < 1_000 ||
      input.heartbeatTimeoutMs > 300_000
    ) {
      throw new Error(
        "Fireworks rollout heartbeat timeout must be between 1s and 5m",
      );
    }
    this.#heartbeatTimeoutMs = input.heartbeatTimeoutMs;
    this.#now = input.now ?? Date.now;
  }

  get rolloutId(): string {
    return this.#rolloutId;
  }

  get modelBaseUrl(): string {
    return this.#modelBaseUrl;
  }

  async #send(
    event: EventName,
    metrics: FireworksRolloutMetrics,
    terminal?: {
      reward?: number;
      errorCode?: FireworksRolloutErrorCode;
    },
  ): Promise<FireworksRolloutTraceReceipt> {
    if (this.#busy) {
      throw new Error("Concurrent rollout trace events are forbidden");
    }
    this.#busy = true;
    try {
      const sequence = this.#sequence + 1;
      const receipt = await this.#client.post(this.#correlation, event, {
        schemaVersion: 1,
        event,
        sequence,
        phase: this.#phase,
        metrics: FireworksRolloutMetricsSchema.parse(metrics),
        ...(terminal?.reward === undefined
          ? {}
          : { reward: z.number().min(0).max(1).parse(terminal.reward) }),
        ...(terminal?.errorCode === undefined
          ? {}
          : {
              errorCode: FireworksRolloutErrorCodeSchema.parse(
                terminal.errorCode,
              ),
            }),
      });
      this.#sequence = sequence;
      return receipt;
    } finally {
      this.#busy = false;
    }
  }

  async start(
    metrics: FireworksRolloutMetrics,
  ): Promise<FireworksRolloutTraceReceipt> {
    if (this.#started || this.#ended) {
      throw new Error("Fireworks rollout trace session already started");
    }
    const receipt = await this.#send("rollout_started", metrics);
    this.#started = true;
    this.#startedAt = this.#now();
    return receipt;
  }

  async heartbeat(
    metrics: FireworksRolloutMetrics,
  ): Promise<FireworksRolloutTraceReceipt> {
    this.#assertActive();
    const heartbeatBaseline =
      this.#lastAcknowledgedHeartbeatAt ?? this.#startedAt;
    if (
      heartbeatBaseline === null ||
      this.#now() - heartbeatBaseline > this.#heartbeatTimeoutMs
    ) {
      throw new Error("Fireworks rollout heartbeat deadline was missed");
    }
    const receipt = await this.#send("rollout_heartbeat", metrics);
    this.#lastAcknowledgedHeartbeatAt = this.#now();
    this.#heartbeatCount += 1;
    return receipt;
  }

  assertHeartbeatFresh(): void {
    this.#assertActive();
    if (
      this.#heartbeatCount === 0 ||
      this.#lastAcknowledgedHeartbeatAt === null
    ) {
      throw new Error("Fireworks rollout has no acknowledged heartbeat");
    }
    if (
      this.#now() - this.#lastAcknowledgedHeartbeatAt >
      this.#heartbeatTimeoutMs
    ) {
      throw new Error("Fireworks rollout heartbeat deadline was missed");
    }
  }

  async finish(
    metrics: FireworksRolloutMetrics,
    reward: number,
  ): Promise<FireworksRolloutTraceReceipt> {
    this.assertHeartbeatFresh();
    const receipt = await this.#send("rollout_finished", metrics, {
      reward,
    });
    this.#ended = true;
    return receipt;
  }

  async fail(
    metrics: FireworksRolloutMetrics,
    errorCode: FireworksRolloutErrorCode,
  ): Promise<FireworksRolloutTraceReceipt> {
    this.#assertActive();
    const parsedErrorCode = FireworksRolloutErrorCodeSchema.parse(errorCode);
    const receipt = await this.#send("rollout_error", metrics, {
      errorCode: parsedErrorCode,
    });
    this.#ended = true;
    return receipt;
  }

  #assertActive(): void {
    if (!this.#started) {
      throw new Error("Fireworks rollout trace session has not started");
    }
    if (this.#ended) {
      throw new Error("Fireworks rollout trace session is already terminal");
    }
  }
}
