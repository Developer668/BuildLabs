import { z } from "zod";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import type {
  ActiveCapabilityProbe,
  ActiveCapabilityResult,
  FireworksCapabilityRouter,
  FireworksModelPin,
  RoleCapabilityRequirements,
} from "./model-router.js";

const OpaqueIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TokenCountSchema = z.number().int().nonnegative().max(10_000_000);
const MAX_STREAM_BYTES = 16 * 1_024 * 1_024;
const MAX_EVENT_BYTES = 2 * 1_024 * 1_024;
const MAX_INPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_REASONING_BYTES = 2 * 1_024 * 1_024;
const MAX_TRANSIENT_REASONING_ITEMS = 8;
const ToolParametersSchema = z
  .object({
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).max(256).optional(),
  })
  .passthrough()
  .superRefine((parameters, context) => {
    for (const [index, required] of (parameters.required ?? []).entries()) {
      if (!(required in parameters.properties)) {
        context.addIssue({
          code: "custom",
          message: "Required tool property is not declared",
          path: ["required", index],
        });
      }
    }
  });
const ToolDefinitionSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
    description: z.string().min(1).max(4_096),
    parameters: ToolParametersSchema,
  })
  .strict();
const FunctionCallItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("function_call"),
    call_id: z.string().min(1).max(256).nullable().optional(),
    name: z.string().min(1).max(64),
    arguments: z.string().max(1_048_576),
    status: z.string().max(64).nullable().optional(),
  })
  .passthrough();
const ReasoningSummaryPartSchema = z
  .object({
    type: z.literal("summary_text"),
    text: z.string().max(MAX_REASONING_BYTES),
  })
  .strict();
const TransientReasoningItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("reasoning"),
    summary: z.array(ReasoningSummaryPartSchema).max(128),
  })
  .strict();
const TransientReasoningItemsSchema = z
  .array(TransientReasoningItemSchema)
  .max(MAX_TRANSIENT_REASONING_ITEMS);
const EchoedInputPartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("input_text"),
      text: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("input_image"),
      image_url: z.string().min(1).max(MAX_INPUT_BYTES),
      detail: z.enum(["auto", "low", "high"]).optional(),
    })
    .strict(),
]);
const EchoedInputMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("message"),
    role: z.enum(["system", "user"]),
    content: z.array(EchoedInputPartSchema).max(128),
    status: z.literal("completed"),
  })
  .passthrough();
const UsageSchema = z
  .object({
    prompt_tokens: TokenCountSchema.optional(),
    completion_tokens: TokenCountSchema.optional(),
    total_tokens: TokenCountSchema.optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: TokenCountSchema.optional() })
      .passthrough()
      .optional(),
    input_tokens: TokenCountSchema.optional(),
    output_tokens: TokenCountSchema.optional(),
    input_tokens_details: z
      .object({ cached_tokens: TokenCountSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const CompletedResponseSchema = z
  .object({
    id: z.union([z.null(), z.string().min(1).max(512)]),
    object: z.literal("response"),
    previous_response_id: z.null(),
    store: z.literal(false),
    model: z.string().min(1).max(512),
    status: z.literal("completed"),
    output: z.array(z.unknown()).max(128),
    reasoning: z.unknown().optional(),
    usage: UsageSchema,
  })
  .passthrough();

export interface FireworksResponseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly argumentsValidator: z.ZodType;
}

export interface FireworksResponseToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentsJson: string;
}

export interface FireworksTransientReasoningItem {
  readonly id: string;
  readonly type: "reasoning";
  readonly summary: readonly {
    readonly type: "summary_text";
    readonly text: string;
  }[];
}

export type FireworksResponseInput =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly transientReasoningItems?: readonly FireworksTransientReasoningItem[];
      readonly toolCalls?: readonly {
        readonly id: string;
        readonly name: string;
        readonly argumentsJson: string;
      }[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

export interface FireworksResponsesRequest {
  readonly pin: FireworksModelPin;
  readonly trajectoryId: string;
  readonly promptCacheKey: string;
  readonly promptCacheIsolationKey: string;
  readonly input: readonly FireworksResponseInput[];
  readonly tools?: readonly FireworksResponseTool[];
  readonly maxParallelTools?: number;
  readonly maxOutputTokens?: number;
  readonly responseJsonSchema?: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface FireworksSafeInferenceMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly toolCallCount: number;
  readonly latencyMs: number;
  readonly timeToFirstTokenMs: number | null;
}

export interface FireworksResponsesResult<TStructured = never> {
  readonly text: string;
  readonly transientReasoning: unknown;
  readonly transientReasoningItems: readonly FireworksTransientReasoningItem[];
  readonly toolCalls: readonly FireworksResponseToolCall[];
  readonly structured: TStructured | null;
  readonly metrics: FireworksSafeInferenceMetrics;
  readonly pin: FireworksModelPin;
}

export interface FireworksResponsesClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class FireworksResponsesError extends Error {
  constructor(
    readonly code:
      | "capability_mismatch"
      | "invalid_request"
      | "malformed_stream"
      | "malformed_tool"
      | "provider_error"
      | "service_tier_mismatch"
      | "stored_state"
      | "structured_output"
      | "tool_limit",
    message: string,
  ) {
    super(message);
    this.name = "FireworksResponsesError";
  }
}

interface ParsedTool {
  readonly provider: z.infer<typeof ToolDefinitionSchema>;
  readonly argumentsValidator: z.ZodType;
}

function providerTool(tool: FireworksResponseTool): ParsedTool {
  if (
    typeof tool.argumentsValidator !== "object" ||
    tool.argumentsValidator === null ||
    typeof tool.argumentsValidator.safeParse !== "function"
  ) {
    throw new FireworksResponsesError(
      "invalid_request",
      "Every response tool requires a local arguments validator",
    );
  }
  return {
    provider: ToolDefinitionSchema.parse({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
    argumentsValidator: tool.argumentsValidator,
  };
}

function providerToolDefinition(tool: ParsedTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.provider.name,
    description: tool.provider.description,
    parameters: tool.provider.parameters,
    strict: true,
  };
}

function leadingStablePrefix(
  input: readonly FireworksResponseInput[],
): FireworksResponseInput[] {
  const prefix: FireworksResponseInput[] = [];
  for (const item of input) {
    if (item.role !== "system") break;
    prefix.push(item);
  }
  return prefix;
}

export function createFireworksPromptCacheKey(
  input: readonly FireworksResponseInput[],
  tools: readonly FireworksResponseTool[] = [],
): string {
  const parsedTools = tools.map(providerTool);
  return sha256(
    canonicalJson({
      stablePrefix: leadingStablePrefix(input),
      tools: parsedTools.map(providerToolDefinition),
    }),
  );
}

function parseToolArguments(
  name: string,
  argumentsJson: string,
  validator: z.ZodType,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new FireworksResponsesError(
      "malformed_tool",
      `Fireworks emitted malformed arguments for ${name}`,
    );
  }
  const validated = validator.safeParse(parsed);
  if (
    !validated.success ||
    typeof validated.data !== "object" ||
    validated.data === null ||
    Array.isArray(validated.data)
  ) {
    throw new FireworksResponsesError(
      "malformed_tool",
      `Fireworks emitted schema-invalid arguments for ${name}`,
    );
  }
  return validated.data as Readonly<Record<string, unknown>>;
}

function validateAndConvertInput(
  input: readonly FireworksResponseInput[],
  tools: ReadonlyMap<string, ParsedTool>,
): unknown[] {
  const calls = new Map<string, { name: string; consumed: boolean }>();
  const reasoningIds = new Set<string>();
  const providerInput: unknown[] = [];
  for (const item of input) {
    if (item.role === "system" || item.role === "user") {
      providerInput.push({
        role: item.role,
        content: z.string().min(1).max(2_000_000).parse(item.content),
      });
      continue;
    }
    if (item.role === "assistant") {
      const reasoningItems = TransientReasoningItemsSchema.safeParse(
        item.transientReasoningItems ?? [],
      );
      if (!reasoningItems.success) {
        throw new FireworksResponsesError(
          "invalid_request",
          "Prior transient reasoning items are malformed or oversized",
        );
      }
      for (const reasoningItem of reasoningItems.data) {
        if (
          !meaningfulReasoning(reasoningItem) ||
          reasoningIds.has(reasoningItem.id)
        ) {
          throw new FireworksResponsesError(
            "invalid_request",
            "Prior transient reasoning items must be meaningful and unique",
          );
        }
        reasoningIds.add(reasoningItem.id);
        providerInput.push(reasoningItem);
      }
      if (item.content !== null) {
        providerInput.push({
          role: "assistant",
          content: z.string().max(2_000_000).parse(item.content),
        });
      }
      if (
        item.content === null &&
        reasoningItems.data.length === 0 &&
        (item.toolCalls?.length ?? 0) === 0
      ) {
        throw new FireworksResponsesError(
          "invalid_request",
          "An assistant turn must contain text, reasoning, or a tool call",
        );
      }
      for (const call of item.toolCalls ?? []) {
        if (calls.has(call.id)) {
          throw new FireworksResponsesError(
            "invalid_request",
            "Prior response tool-call IDs must be unique",
          );
        }
        const tool = tools.get(call.name);
        if (tool === undefined) {
          throw new FireworksResponsesError(
            "invalid_request",
            "Prior response references an undeclared tool",
          );
        }
        const id = z.string().min(1).max(256).parse(call.id);
        const argumentsJson = z
          .string()
          .max(1_048_576)
          .parse(call.argumentsJson);
        parseToolArguments(call.name, argumentsJson, tool.argumentsValidator);
        calls.set(id, { name: call.name, consumed: false });
        providerInput.push({
          id,
          type: "function_call",
          call_id: id,
          name: call.name,
          arguments: argumentsJson,
          status: "completed",
        });
      }
      continue;
    }
    const prior = calls.get(item.toolCallId);
    if (prior === undefined || prior.consumed) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Tool output must reference one unconsumed prior function call",
      );
    }
    prior.consumed = true;
    providerInput.push({
      type: "tool_output",
      tool_call_id: item.toolCallId,
      output: z.string().max(2_000_000).parse(item.content),
    });
  }
  if ([...calls.values()].some((call) => !call.consumed)) {
    throw new FireworksResponsesError(
      "invalid_request",
      "Every prior function call must have exactly one tool output",
    );
  }
  if (
    Buffer.byteLength(canonicalJson(providerInput), "utf8") > MAX_INPUT_BYTES
  ) {
    throw new FireworksResponsesError(
      "invalid_request",
      "Responses input exceeds the bounded byte limit",
    );
  }
  return providerInput;
}

async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    totalBytes += read.value.byteLength;
    if (totalBytes > MAX_STREAM_BYTES) {
      throw new FireworksResponsesError(
        "malformed_stream",
        "Fireworks response stream exceeded its byte limit",
      );
    }
    buffer += decoder.decode(read.value, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (frame.length > MAX_EVENT_BYTES) {
        throw new FireworksResponsesError(
          "malformed_stream",
          "Fireworks emitted an oversized response event",
        );
      }
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data !== "" && data !== "[DONE]") {
        try {
          yield JSON.parse(data) as unknown;
        } catch {
          throw new FireworksResponsesError(
            "malformed_stream",
            "Fireworks emitted malformed event JSON",
          );
        }
      }
      separator = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    throw new FireworksResponsesError(
      "malformed_stream",
      "Fireworks response stream ended with an incomplete event",
    );
  }
}

function eventRecord(event: unknown): Record<string, unknown> {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new FireworksResponsesError(
      "malformed_stream",
      "Fireworks emitted a non-object event",
    );
  }
  return event as Record<string, unknown>;
}

function parseCompletedResponse(
  value: unknown,
): z.infer<typeof CompletedResponseSchema> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks returned a malformed completed response",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.previous_response_id !== null || record.store !== false) {
    throw new FireworksResponsesError(
      "stored_state",
      "Fireworks did not attest a completed, non-stored response",
    );
  }
  const parsed = CompletedResponseSchema.safeParse(record);
  if (!parsed.success) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks returned a malformed completed response",
    );
  }
  return parsed.data;
}

function assistantOutputText(output: readonly unknown[]): string {
  const text: string[] = [];
  for (const item of output) {
    const record = eventRecord(item);
    if (record.type === "function_call" || record.type === "reasoning") {
      continue;
    }
    if (record.type === "message" && record.role !== "assistant") {
      const echoed = EchoedInputMessageSchema.safeParse(record);
      if (
        !echoed.success ||
        Buffer.byteLength(canonicalJson(echoed.data), "utf8") > MAX_INPUT_BYTES
      ) {
        throw new FireworksResponsesError(
          "provider_error",
          "Fireworks returned a malformed echoed input message",
        );
      }
      continue;
    }
    if (record.type !== "message") {
      throw new FireworksResponsesError(
        "provider_error",
        "Fireworks emitted an unsupported response output item",
      );
    }
    const content = z.array(z.unknown()).max(128).parse(record.content);
    for (const part of content) {
      const partRecord = eventRecord(part);
      if (
        !["output_text", "text"].includes(String(partRecord.type)) ||
        typeof partRecord.text !== "string"
      ) {
        throw new FireworksResponsesError(
          "provider_error",
          "Fireworks emitted an unsupported or refused response content part",
        );
      }
      text.push(partRecord.text);
    }
  }
  return text.join("");
}

function meaningfulReasoning(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REASONING_BYTES) {
    throw new FireworksResponsesError(
      "malformed_stream",
      "Fireworks reasoning exceeded the transient byte limit",
    );
  }
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(meaningfulReasoning);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return ["content", "text", "summary", "reasoning"].some(
      (key) => key in record && meaningfulReasoning(record[key]),
    );
  }
  return false;
}

function completedReasoningItems(
  output: readonly unknown[],
): FireworksTransientReasoningItem[] {
  const reasoningItems: FireworksTransientReasoningItem[] = [];
  const ids = new Set<string>();
  for (const item of output) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      (item as Record<string, unknown>).type !== "reasoning"
    ) {
      continue;
    }
    const parsed = TransientReasoningItemSchema.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) {
      throw new FireworksResponsesError(
        "provider_error",
        "Fireworks returned malformed or duplicate reasoning items",
      );
    }
    ids.add(parsed.data.id);
    if (meaningfulReasoning(parsed.data)) {
      reasoningItems.push(parsed.data);
    }
  }
  if (reasoningItems.length > MAX_TRANSIENT_REASONING_ITEMS) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks returned too many transient reasoning items",
    );
  }
  return reasoningItems;
}

function transientReasoning(
  response: z.infer<typeof CompletedResponseSchema>,
): unknown {
  const reasoningItems = completedReasoningItems(response.output);
  if (reasoningItems.length > 0) return reasoningItems;
  return meaningfulReasoning(response.reasoning) ? response.reasoning : null;
}

function completedToolCalls(
  output: readonly unknown[],
  tools: ReadonlyMap<string, ParsedTool>,
): FireworksResponseToolCall[] {
  const result: FireworksResponseToolCall[] = [];
  const ids = new Set<string>();
  for (const item of output) {
    const record = eventRecord(item);
    if (record.type === "message" || record.type === "reasoning") {
      continue;
    }
    if (record.type !== "function_call") {
      throw new FireworksResponsesError(
        "provider_error",
        "Fireworks emitted an unsupported response output item",
      );
    }
    const call = FunctionCallItemSchema.parse(item);
    const callId = call.call_id ?? call.id;
    const tool = tools.get(call.name);
    if (tool === undefined || ids.has(callId)) {
      throw new FireworksResponsesError(
        "malformed_tool",
        "Fireworks emitted an unknown or duplicate function call",
      );
    }
    ids.add(callId);
    result.push({
      id: callId,
      name: call.name,
      arguments: parseToolArguments(
        call.name,
        call.arguments,
        tool.argumentsValidator,
      ),
      argumentsJson: call.arguments,
    });
  }
  return result;
}

function boundedHeaderCount(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  if (!/^(?:0|[1-9]\d{0,7})$/.test(raw)) {
    throw new FireworksResponsesError(
      "provider_error",
      `Fireworks returned an invalid ${name} metric`,
    );
  }
  return TokenCountSchema.parse(Number(raw));
}

function usageMetrics(
  usage: z.infer<typeof UsageSchema>,
  headers: Headers,
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
} {
  if (
    (usage.prompt_tokens === undefined && usage.input_tokens === undefined) ||
    (usage.completion_tokens === undefined &&
      usage.output_tokens === undefined) ||
    (usage.prompt_tokens !== undefined &&
      usage.input_tokens !== undefined &&
      usage.prompt_tokens !== usage.input_tokens) ||
    (usage.completion_tokens !== undefined &&
      usage.output_tokens !== undefined &&
      usage.completion_tokens !== usage.output_tokens)
  ) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks omitted or contradicted authoritative token usage",
    );
  }
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens!;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens!;
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
  const promptCached = usage.prompt_tokens_details?.cached_tokens;
  const inputCached = usage.input_tokens_details?.cached_tokens;
  if (
    promptCached !== undefined &&
    inputCached !== undefined &&
    promptCached !== inputCached
  ) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks contradicted authoritative cache usage",
    );
  }
  const cachedInputTokens = promptCached ?? inputCached ?? 0;
  const headerInput = boundedHeaderCount(headers, "fireworks-prompt-tokens");
  const headerCached = boundedHeaderCount(
    headers,
    "fireworks-cached-prompt-tokens",
  );
  if (
    totalTokens !== inputTokens + outputTokens ||
    cachedInputTokens > inputTokens ||
    (headerInput !== null && headerInput !== inputTokens) ||
    (headerCached !== null && headerCached !== cachedInputTokens) ||
    (headerInput !== null &&
      headerCached !== null &&
      headerCached > headerInput)
  ) {
    throw new FireworksResponsesError(
      "provider_error",
      "Fireworks returned inconsistent token or cache metrics",
    );
  }
  return {
    inputTokens: headerInput ?? inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: headerCached ?? cachedInputTokens,
  };
}

export class FireworksResponsesClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #router: FireworksCapabilityRouter;

  constructor(
    router: FireworksCapabilityRouter,
    options: FireworksResponsesClientOptions,
  ) {
    this.#router = router;
    this.#apiKey = z.string().min(1).parse(options.apiKey);
    this.#baseUrl = (
      options.baseUrl ?? "https://api.fireworks.ai/inference/v1"
    ).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async create<TStructured = never>(
    request: FireworksResponsesRequest,
    structuredValidator?: z.ZodType<TStructured>,
    signal?: AbortSignal,
  ): Promise<FireworksResponsesResult<TStructured>> {
    const trajectoryId = OpaqueIdSchema.parse(request.trajectoryId);
    const promptCacheKey = OpaqueIdSchema.parse(request.promptCacheKey);
    const promptCacheIsolationKey = OpaqueIdSchema.parse(
      request.promptCacheIsolationKey,
    );
    this.#router.assertPin(request.pin);
    if (
      trajectoryId !== request.pin.trajectoryId ||
      request.input.length === 0 ||
      request.input[0]?.role !== "system"
    ) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Responses require the pinned trajectory and a stable system prefix",
      );
    }
    if (promptCacheIsolationKey !== request.pin.cacheIsolationKey) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Prompt cache isolation does not match the immutable trajectory pin",
      );
    }
    if (request.pin.serviceTier !== "standard") {
      throw new FireworksResponsesError(
        "service_tier_mismatch",
        "Fireworks Responses does not document Priority Tier; refusing downgrade",
      );
    }

    const parsedTools = (request.tools ?? []).map(providerTool);
    const toolsByName = new Map(
      parsedTools.map((tool) => [tool.provider.name, tool] as const),
    );
    if (toolsByName.size !== parsedTools.length || parsedTools.length > 32) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Response tools must be unique and bounded",
      );
    }
    if (
      promptCacheKey !==
      createFireworksPromptCacheKey(request.input, request.tools)
    ) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Prompt cache key is not bound to the stable prefix and tools",
      );
    }
    const hasResponseSchema = request.responseJsonSchema !== undefined;
    if (hasResponseSchema !== (structuredValidator !== undefined)) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Structured responses require both a provider schema and local validator",
      );
    }
    if (hasResponseSchema && request.pin.capabilitySnapshot.reasoning) {
      throw new FireworksResponsesError(
        "invalid_request",
        "Provider JSON schema disables reasoning; use a strict function tool",
      );
    }

    const maxParallelTools = z
      .number()
      .int()
      .min(1)
      .max(8)
      .parse(request.maxParallelTools ?? 1);
    const maxOutputTokens = z
      .number()
      .int()
      .min(1)
      .max(65_536)
      .parse(request.maxOutputTokens ?? 8_192);
    const body = {
      model: request.pin.modelId,
      input: validateAndConvertInput(request.input, toolsByName),
      tools: parsedTools.map(providerToolDefinition),
      tool_choice: parsedTools.length === 0 ? "none" : "auto",
      parallel_tool_calls: maxParallelTools > 1,
      max_tool_calls: maxParallelTools,
      max_output_tokens: maxOutputTokens,
      stream: true,
      store: false,
      ...(request.pin.capabilitySnapshot.reasoning ? { reasoning: {} } : {}),
      ...(request.responseJsonSchema === undefined
        ? {}
        : {
            text: {
              format: {
                type: "json_schema",
                name: z
                  .string()
                  .regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
                  .parse(request.responseJsonSchema.name),
                schema: request.responseJsonSchema.schema,
                strict: true,
              },
            },
          }),
    };

    const startedAt = this.#now();
    const response = await this.#fetch(`${this.#baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-multi-turn-session-id": trajectoryId,
        "x-session-affinity": trajectoryId,
        "x-prompt-cache-isolation-key": promptCacheIsolationKey,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null) {
      throw new FireworksResponsesError(
        "provider_error",
        `Fireworks Responses failed with status ${response.status}`,
      );
    }

    let streamedText = "";
    let firstTokenAt: number | undefined;
    let completed: z.infer<typeof CompletedResponseSchema> | undefined;
    let lastSequence = -1;
    const streamedCalls = new Map<string, string>();
    for await (const rawEvent of readServerSentEvents(response.body)) {
      if (completed !== undefined) {
        throw new FireworksResponsesError(
          "malformed_stream",
          "Fireworks emitted an event after the terminal response",
        );
      }
      const event = eventRecord(rawEvent);
      const type = z.string().max(128).parse(event.type);
      const sequence = z
        .number()
        .int()
        .nonnegative()
        .parse(event.sequence_number);
      if (sequence !== lastSequence + 1) {
        throw new FireworksResponsesError(
          "malformed_stream",
          "Fireworks response sequence is not contiguous",
        );
      }
      lastSequence = sequence;
      if (
        type === "response.output_text.delta" ||
        type === "response.reasoning_text.delta" ||
        type === "response.reasoning_summary_text.delta"
      ) {
        const delta = z.string().max(1_048_576).parse(event.delta);
        firstTokenAt ??= this.#now();
        if (type === "response.output_text.delta") streamedText += delta;
      } else if (
        type === "response.output_item.done" &&
        event.item !== undefined &&
        eventRecord(event.item).type === "function_call"
      ) {
        const call = FunctionCallItemSchema.parse(event.item);
        firstTokenAt ??= this.#now();
        const callId = call.call_id ?? call.id;
        if (streamedCalls.has(callId)) {
          throw new FireworksResponsesError(
            "malformed_stream",
            "Fireworks repeated a completed function-call item",
          );
        }
        streamedCalls.set(callId, canonicalJson(call));
      } else if (type === "response.completed") {
        if (completed !== undefined) {
          throw new FireworksResponsesError(
            "malformed_stream",
            "Fireworks repeated the terminal response event",
          );
        }
        completed = parseCompletedResponse(event.response);
      } else if (type === "error" || type === "response.failed") {
        throw new FireworksResponsesError(
          "provider_error",
          "Fireworks terminated the response with an error",
        );
      }
    }
    if (completed === undefined) {
      throw new FireworksResponsesError(
        "malformed_stream",
        "Fireworks omitted the terminal response event",
      );
    }
    this.#router.assertResponseModel(request.pin, completed.model);
    const text = assistantOutputText(completed.output);
    if (streamedText !== text) {
      throw new FireworksResponsesError(
        "malformed_stream",
        "Fireworks streamed text differs from its terminal response",
      );
    }
    const toolCalls = completedToolCalls(completed.output, toolsByName);
    if (text === "" && toolCalls.length === 0) {
      throw new FireworksResponsesError(
        "provider_error",
        "Fireworks completed without text or a tool call",
      );
    }
    if (toolCalls.length > maxParallelTools) {
      throw new FireworksResponsesError(
        "tool_limit",
        "Fireworks exceeded the bounded parallel tool limit",
      );
    }
    for (const [id, serialized] of streamedCalls) {
      const terminal = completed.output.find((item) => {
        if (
          typeof item !== "object" ||
          item === null ||
          Array.isArray(item) ||
          (item as Record<string, unknown>).type !== "function_call"
        ) {
          return false;
        }
        const call = FunctionCallItemSchema.parse(item);
        return (call.call_id ?? call.id) === id;
      });
      if (
        terminal === undefined ||
        serialized !== canonicalJson(FunctionCallItemSchema.parse(terminal))
      ) {
        throw new FireworksResponsesError(
          "malformed_stream",
          "Fireworks streamed function call differs from terminal output",
        );
      }
    }
    if (
      toolCalls.length !== streamedCalls.size ||
      toolCalls.some((call) => !streamedCalls.has(call.id))
    ) {
      throw new FireworksResponsesError(
        "malformed_stream",
        "Fireworks terminal function calls do not match streamed completions",
      );
    }
    const reasoningItems = completedReasoningItems(completed.output);
    const reasoning =
      reasoningItems.length > 0
        ? reasoningItems
        : transientReasoning(completed);
    if (
      request.pin.capabilitySnapshot.reasoning &&
      !meaningfulReasoning(reasoning)
    ) {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Pinned Fireworks model omitted required reasoning evidence",
      );
    }

    let structured: TStructured | null = null;
    if (structuredValidator !== undefined && toolCalls.length === 0) {
      try {
        structured = structuredValidator.parse(JSON.parse(text) as unknown);
      } catch {
        throw new FireworksResponsesError(
          "structured_output",
          "Fireworks returned invalid structured output",
        );
      }
    }
    const tokens = usageMetrics(completed.usage, response.headers);
    return {
      text,
      transientReasoning: reasoning,
      transientReasoningItems: reasoningItems,
      toolCalls,
      structured,
      metrics: {
        ...tokens,
        toolCallCount: toolCalls.length,
        latencyMs: Math.max(0, this.#now() - startedAt),
        timeToFirstTokenMs:
          firstTokenAt === undefined
            ? null
            : Math.max(0, firstTokenAt - startedAt),
      },
      pin: request.pin,
    };
  }
}

export interface FireworksResponsesCapabilityProbeOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcYExwwgkhB/AAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yNFQxOToyODo0OCswMDowMNLaOU8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjRUMTk6Mjg6NDgrMDA6MDCjh4HzAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI0VDE5OjI4OjQ4KzAwOjAw9JKgLAAAAAxJREFUCNdjYBjcAAAAoAABYSV9RwAAAABJRU5ErkJggg==";
const BLUE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURQAA/////3vcmSwAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcYExwwgkhB/AAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0yNFQxOToyODo0OCswMDowMNLaOU8AAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMjRUMTk6Mjg6NDgrMDA6MDCjh4HzAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTI0VDE5OjI4OjQ4KzAwOjAw9JKgLAAAAAxJREFUCNdjYBjcAAAAoAABYSV9RwAAAABJRU5ErkJggg==";
const VisionProbeArgumentsSchema = z
  .object({
    first: z.literal("red"),
    second: z.literal("blue"),
  })
  .strict();
const EmptyProbeArgumentsSchema = z.object({}).strict();
const ReadySchema = z.object({ ready: z.literal(true) }).strict();
const ReasoningProbeArgumentsSchema = z
  .object({ answer: z.literal(42) })
  .strict();
const ChatToolCallSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1).max(64),
        arguments: z.string().max(1_048_576),
      })
      .strict(),
  })
  .passthrough();
const ChatAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string().max(2_000_000).nullable(),
    reasoning_content: z
      .string()
      .max(MAX_REASONING_BYTES)
      .nullable()
      .optional(),
    tool_calls: z.array(ChatToolCallSchema).max(1).optional(),
  })
  .passthrough();
const ChatCompletionSchema = z
  .object({
    model: z.string().min(1).max(512),
    choices: z
      .array(
        z
          .object({
            message: ChatAssistantMessageSchema,
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();

function probeFunctionCall(
  output: readonly unknown[],
): z.infer<typeof FunctionCallItemSchema> {
  const calls = output.filter(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "function_call",
  );
  if (calls.length !== 1) {
    throw new FireworksResponsesError(
      "capability_mismatch",
      "Fireworks did not demonstrate one bounded function call",
    );
  }
  return FunctionCallItemSchema.parse(calls[0]);
}

export class FireworksResponsesCapabilityProbe implements ActiveCapabilityProbe {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: FireworksResponsesCapabilityProbeOptions) {
    this.#apiKey = z.string().min(1).parse(options.apiKey);
    this.#baseUrl = (
      options.baseUrl ?? "https://api.fireworks.ai/inference/v1"
    ).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async probe(
    modelId: string,
    requirements: RoleCapabilityRequirements,
    signal?: AbortSignal,
  ): Promise<ActiveCapabilityResult> {
    const reasoningVerified = requirements.reasoning
      ? await this.#probeInterleavedReasoning(modelId, signal)
      : false;
    const functionParameters = requirements.vision
      ? {
          type: "object",
          additionalProperties: false,
          properties: {
            first: { type: "string", enum: ["red", "blue"] },
            second: { type: "string", enum: ["red", "blue"] },
          },
          required: ["first", "second"],
        }
      : {
          type: "object",
          additionalProperties: false,
          properties: {},
        };
    const userContent = requirements.vision
      ? [
          {
            type: "input_text",
            text: "Inspect both images. Report each dominant color in order.",
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${RED_PNG}`,
          },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${BLUE_PNG}`,
          },
        ]
      : "Use the required capability probe tool.";
    const toolResponse = await this.#post(
      {
        model: modelId,
        input: [
          {
            role: "system",
            content:
              "BuildLabs readiness probe. Inspect the input and make the required tool call.",
          },
          { role: "user", content: userContent },
        ],
        tools: [
          {
            type: "function",
            name: "buildlabs_capability_probe",
            description: "Return the observed readiness result.",
            parameters: functionParameters,
            strict: true,
          },
        ],
        tool_choice: "required",
        max_tool_calls: 1,
        parallel_tool_calls: false,
        max_output_tokens: 512,
        store: false,
      },
      signal,
    );
    const call = probeFunctionCall(toolResponse.output);
    if (call.name !== "buildlabs_capability_probe") {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks called the wrong capability probe",
      );
    }
    const probeArguments = JSON.parse(call.arguments) as unknown;
    if (requirements.vision) {
      VisionProbeArgumentsSchema.parse(probeArguments);
    } else {
      EmptyProbeArgumentsSchema.parse(probeArguments);
    }
    assistantOutputText(toolResponse.output);

    const structuredResponse = await this.#post(
      {
        model: modelId,
        input: [
          {
            role: "system",
            content: "Return the capability probe JSON and no other content.",
          },
          { role: "user", content: "Return ready=true." },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "buildlabs_capability_probe",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { ready: { type: "boolean", const: true } },
              required: ["ready"],
            },
            strict: true,
          },
        },
        max_output_tokens: 256,
        store: false,
      },
      signal,
    );
    let parsedStructured: unknown;
    try {
      parsedStructured = JSON.parse(
        assistantOutputText(structuredResponse.output),
      ) as unknown;
    } catch {
      throw new FireworksResponsesError(
        "structured_output",
        "Fireworks did not demonstrate structured-output capability",
      );
    }
    ReadySchema.parse(parsedStructured);
    if (
      toolResponse.model !== modelId ||
      structuredResponse.model !== modelId ||
      structuredResponse.model !== toolResponse.model
    ) {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks changed models during a capability probe",
      );
    }
    return {
      returnedModelId: toolResponse.model,
      tools: true,
      reasoning: reasoningVerified,
      structuredOutput: true,
      vision: requirements.vision,
    };
  }

  async #probeInterleavedReasoning(
    modelId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const tool = {
      type: "function",
      function: {
        name: "buildlabs_reasoning_probe",
        description: "Record the computed readiness value.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { answer: { type: "integer", const: 42 } },
          required: ["answer"],
        },
        strict: true,
      },
    } as const;
    const affinity = sha256(
      canonicalJson({ modelId, probe: "interleaved_reasoning" }),
    );
    const first = await this.#postChat(
      {
        model: modelId,
        messages: [
          {
            role: "system",
            content:
              "Reason briefly, then call the required tool with the exact result.",
          },
          {
            role: "user",
            content: "Add 19 and 23 and submit the result.",
          },
        ],
        tools: [tool],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_completion_tokens: 256,
      },
      affinity,
      signal,
    );
    const firstMessage = first.choices[0]!.message;
    const calls = firstMessage.tool_calls ?? [];
    if (
      first.model !== modelId ||
      !meaningfulReasoning(firstMessage.reasoning_content) ||
      calls.length !== 1 ||
      calls[0]!.function.name !== "buildlabs_reasoning_probe"
    ) {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks did not demonstrate bounded reasoning before a tool call",
      );
    }
    let firstArguments: unknown;
    try {
      firstArguments = JSON.parse(calls[0]!.function.arguments) as unknown;
    } catch {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks emitted malformed reasoning-probe tool arguments",
      );
    }
    if (!ReasoningProbeArgumentsSchema.safeParse(firstArguments).success) {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks emitted incorrect reasoning-probe tool arguments",
      );
    }

    const second = await this.#postChat(
      {
        model: modelId,
        messages: [
          {
            role: "system",
            content:
              "Reason briefly, then call the required tool with the exact result.",
          },
          {
            role: "user",
            content: "Add 19 and 23 and submit the result.",
          },
          {
            role: "assistant",
            content: firstMessage.content,
            reasoning_content: firstMessage.reasoning_content,
            tool_calls: calls,
          },
          {
            role: "tool",
            tool_call_id: calls[0]!.id,
            content: '{"accepted":true}',
          },
        ],
        tools: [tool],
        tool_choice: "none",
        parallel_tool_calls: false,
        max_completion_tokens: 256,
      },
      affinity,
      signal,
    );
    const secondMessage = second.choices[0]!.message;
    if (
      second.model !== modelId ||
      !meaningfulReasoning(secondMessage.reasoning_content) ||
      (secondMessage.tool_calls?.length ?? 0) !== 0
    ) {
      throw new FireworksResponsesError(
        "capability_mismatch",
        "Fireworks did not demonstrate interleaved reasoning after a tool result",
      );
    }
    return true;
  }

  async #post(
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof CompletedResponseSchema>> {
    const affinity = sha256(canonicalJson(body));
    const response = await this.#fetch(`${this.#baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        "x-multi-turn-session-id": affinity,
        "x-session-affinity": affinity,
        "x-prompt-cache-isolation-key": affinity,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new FireworksResponsesError(
        "provider_error",
        `Fireworks capability probe failed with status ${response.status}`,
      );
    }
    return parseCompletedResponse(await response.json());
  }

  async #postChat(
    body: Readonly<Record<string, unknown>>,
    affinity: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof ChatCompletionSchema>> {
    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
        "x-multi-turn-session-id": affinity,
        "x-session-affinity": affinity,
        "x-prompt-cache-isolation-key": affinity,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new FireworksResponsesError(
        "provider_error",
        `Fireworks reasoning probe failed with status ${response.status}`,
      );
    }
    const parsed = ChatCompletionSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new FireworksResponsesError(
        "provider_error",
        "Fireworks returned a malformed reasoning-probe response",
      );
    }
    return parsed.data;
  }
}
