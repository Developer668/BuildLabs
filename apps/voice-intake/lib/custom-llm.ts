const PUBLIC_MODEL_ID = "buildlabs-fireworks-voice-v1";
const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export const CUSTOM_LLM_LIMITS = Object.freeze({
  maximumRequestBytes: 96_000,
  maximumResponseBytes: 512_000,
  maximumMessages: 64,
  maximumTools: 12,
  maximumOutputTokens: 384,
  maximumContentBytes: 24_000,
  maximumToolArgumentsBytes: 16_000,
  maximumSseEvents: 1_024,
  firstByteTimeoutMs: 6_000,
  overallTimeoutMs: 15_000,
  retriesBeforeStreaming: 1,
});

type CustomLlmLimits = {
  [Key in keyof typeof CUSTOM_LLM_LIMITS]: number;
};

export type CustomLlmDependencies = {
  fetchImpl?: typeof fetch;
  limits?: Partial<CustomLlmLimits>;
};

type JsonRecord = Record<string, unknown>;

type ValidatedMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

type ValidatedTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: JsonRecord;
    strict?: boolean;
  };
};

type ValidatedRequest = {
  messages: ValidatedMessage[];
  tools: ValidatedTool[];
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  maximumOutputTokens: number;
  temperature: number;
  topP: number;
  contactEvidence: ContactEvidence;
  systemPrompts: string[];
  endCallAuthorized: boolean;
};

type BridgeErrorCode =
  | "invalid_authentication"
  | "not_configured"
  | "invalid_content_type"
  | "request_too_large"
  | "invalid_request"
  | "provider_unavailable"
  | "provider_timeout"
  | "invalid_provider_stream"
  | "unsafe_model_output";

class BridgeError extends Error {
  readonly status: number;
  readonly code: BridgeErrorCode;

  constructor(status: number, code: BridgeErrorCode) {
    super(code);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

class ProviderAttemptError extends Error {
  readonly streamed: boolean;
  readonly retryable: boolean;
  readonly timedOut: boolean;

  constructor(input: {
    streamed: boolean;
    retryable: boolean;
    timedOut?: boolean;
  }) {
    super("provider_attempt_failed");
    this.name = "ProviderAttemptError";
    this.streamed = input.streamed;
    this.retryable = input.retryable;
    this.timedOut = input.timedOut ?? false;
  }
}

type RuntimeConfiguration = {
  customLlmSecret: string;
  fireworksApiKey: string;
  fireworksModel: string;
  fireworksEndpoint: URL;
};

type ContactEvidence = {
  emails: Set<string>;
  phones: Set<string>;
  names: Set<string>;
};

type ParsedProviderStream = {
  events: JsonRecord[];
  spokenContent: string;
  capturedContactEvidence: ContactEvidence;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failInvalidRequest(): never {
  throw new BridgeError(400, "invalid_request");
}

function assertAllowedKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failInvalidRequest();
  }
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  return environment[name]?.trim() ?? "";
}

function loadAuthenticationSecret(environment: NodeJS.ProcessEnv): string {
  const customLlmSecret = cleanEnvironmentValue(
    environment,
    "ELEVENLABS_CUSTOM_LLM_SECRET",
  );
  if (customLlmSecret.length < 32) {
    throw new BridgeError(503, "not_configured");
  }
  return customLlmSecret;
}

function loadConfiguration(
  environment: NodeJS.ProcessEnv,
  customLlmSecret: string,
): RuntimeConfiguration {
  const fireworksApiKey = cleanEnvironmentValue(
    environment,
    "FIREWORKS_API_KEY",
  );
  const fireworksModel = cleanEnvironmentValue(
    environment,
    "FIREWORKS_VOICE_MODEL",
  );
  if (
    fireworksApiKey.length < 20 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(fireworksModel)
  ) {
    throw new BridgeError(503, "not_configured");
  }

  const configuredBaseUrl =
    cleanEnvironmentValue(environment, "FIREWORKS_BASE_URL") ||
    DEFAULT_FIREWORKS_BASE_URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    throw new BridgeError(503, "not_configured");
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if (
    (baseUrl.protocol !== "https:" &&
      !(baseUrl.protocol === "http:" && loopbackHosts.has(baseUrl.hostname))) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new BridgeError(503, "not_configured");
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/chat/completions`;

  return {
    customLlmSecret,
    fireworksApiKey,
    fireworksModel,
    fireworksEndpoint: baseUrl,
  };
}

async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = left.length === right.length ? 0 : 1;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function authenticateRequest(
  request: Request,
  expectedSecret: string,
): Promise<void> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match || !(await secretsEqual(match[1] ?? "", expectedSecret))) {
    throw new BridgeError(401, "invalid_authentication");
  }
}

async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new BridgeError(413, "request_too_large");
  }
  if (!request.body) failInvalidRequest();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new BridgeError(413, "request_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    failInvalidRequest();
  }
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const ALLOWED_VOICE_TOOL_NAMES = new Set([
  "request_clarification",
  "capture_contact",
  "record_research_consent",
  "finalize_requirements",
  "end_call",
]);

function validateJsonTree(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 512 || depth > 12) failInvalidRequest();
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 16_000) failInvalidRequest();
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) failInvalidRequest();
    for (const item of value) validateJsonTree(item, state, depth + 1);
    return;
  }
  if (!isRecord(value)) failInvalidRequest();
  const entries = Object.entries(value);
  if (entries.length > 128) failInvalidRequest();
  for (const [key, item] of entries) {
    if (
      key.length > 128 ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor"
    ) {
      failInvalidRequest();
    }
    validateJsonTree(item, state, depth + 1);
  }
}

function validateToolArguments(
  value: string,
  maximumBytes: number,
): JsonRecord {
  if (!value || encodedLength(value) > maximumBytes) failInvalidRequest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    failInvalidRequest();
  }
  if (!isRecord(parsed)) failInvalidRequest();
  validateJsonTree(parsed, { nodes: 0 });
  return parsed;
}

function validateHistoricalToolCall(
  value: unknown,
  maximumArgumentsBytes: number,
): NonNullable<ValidatedMessage["tool_calls"]>[number] {
  if (!isRecord(value)) failInvalidRequest();
  assertAllowedKeys(value, new Set(["id", "type", "function"]));
  if (
    typeof value.id !== "string" ||
    !TOOL_CALL_ID_PATTERN.test(value.id) ||
    value.type !== "function" ||
    !isRecord(value.function)
  ) {
    failInvalidRequest();
  }
  assertAllowedKeys(value.function, new Set(["name", "arguments"]));
  if (
    typeof value.function.name !== "string" ||
    !TOOL_NAME_PATTERN.test(value.function.name) ||
    typeof value.function.arguments !== "string"
  ) {
    failInvalidRequest();
  }
  validateToolArguments(value.function.arguments, maximumArgumentsBytes);
  return {
    id: value.id,
    type: "function",
    function: {
      name: value.function.name,
      arguments: value.function.arguments,
    },
  };
}

function validateMessages(
  value: unknown,
  limits: CustomLlmLimits,
): {
  messages: ValidatedMessage[];
  contactEvidence: ContactEvidence;
  systemPrompts: string[];
  endCallAuthorized: boolean;
} {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > limits.maximumMessages
  ) {
    failInvalidRequest();
  }

  const messages: ValidatedMessage[] = [];
  const assistantToolCalls = new Map<string, string>();
  const completedToolCallIds = new Set<string>();
  const contactSources: string[] = [];
  const contactNames: string[] = [];
  const systemPrompts: string[] = [];
  let nonSystemMessages = 0;
  let finalizationAccepted = false;
  let latestUserMessage = "";

  for (const rawMessage of value) {
    if (!isRecord(rawMessage)) failInvalidRequest();
    const role = rawMessage.role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      failInvalidRequest();
    }

    const allowed = new Set(["role", "content", "name"]);
    if (role === "assistant") allowed.add("tool_calls");
    if (role === "tool") allowed.add("tool_call_id");
    assertAllowedKeys(rawMessage, allowed);

    const content = rawMessage.content;
    if (
      content !== null &&
      (typeof content !== "string" ||
        encodedLength(content) > limits.maximumContentBytes)
    ) {
      failInvalidRequest();
    }
    if (
      (role === "system" || role === "user" || role === "tool") &&
      (typeof content !== "string" || !content.trim())
    ) {
      failInvalidRequest();
    }
    if (
      rawMessage.name !== undefined &&
      (typeof rawMessage.name !== "string" ||
        !TOOL_NAME_PATTERN.test(rawMessage.name))
    ) {
      failInvalidRequest();
    }

    const message: ValidatedMessage = { role, content };
    if (typeof rawMessage.name === "string") message.name = rawMessage.name;

    if (role === "assistant") {
      const rawToolCalls = rawMessage.tool_calls;
      if (rawToolCalls !== undefined) {
        if (!Array.isArray(rawToolCalls) || rawToolCalls.length !== 1) {
          failInvalidRequest();
        }
        const call = validateHistoricalToolCall(
          rawToolCalls[0],
          limits.maximumToolArgumentsBytes,
        );
        if (assistantToolCalls.has(call.id)) failInvalidRequest();
        assistantToolCalls.set(call.id, call.function.name);
        message.tool_calls = [call];
        if (call.function.name === "capture_contact") {
          contactSources.push(call.function.arguments);
          const argumentsRecord = validateToolArguments(
            call.function.arguments,
            limits.maximumToolArgumentsBytes,
          );
          if (typeof argumentsRecord.name === "string") {
            contactNames.push(argumentsRecord.name);
          }
        }
      }
      if ((content === null || !content.trim()) && !message.tool_calls) {
        failInvalidRequest();
      }
    } else if (role === "tool") {
      if (
        typeof rawMessage.tool_call_id !== "string" ||
        !TOOL_CALL_ID_PATTERN.test(rawMessage.tool_call_id) ||
        !assistantToolCalls.has(rawMessage.tool_call_id) ||
        completedToolCallIds.has(rawMessage.tool_call_id)
      ) {
        failInvalidRequest();
      }
      completedToolCallIds.add(rawMessage.tool_call_id);
      message.tool_call_id = rawMessage.tool_call_id;
      if (
        assistantToolCalls.get(rawMessage.tool_call_id) ===
        "finalize_requirements"
      ) {
        finalizationAccepted =
          typeof content === "string" &&
          strictlyAcceptedFinalizationResult(content);
      }
    } else if (rawMessage.tool_call_id !== undefined) {
      failInvalidRequest();
    }

    if (role === "system" && typeof content === "string") {
      systemPrompts.push(content);
    } else {
      nonSystemMessages += 1;
      if (typeof content === "string") contactSources.push(content);
    }
    if (role === "user" && typeof content === "string") {
      if (finalizationAccepted) finalizationAccepted = false;
      latestUserMessage = content;
      contactNames.push(...explicitlyIntroducedNames(content));
    }
    messages.push(message);
  }
  if (nonSystemMessages === 0) failInvalidRequest();

  return {
    messages,
    contactEvidence: collectContactEvidence(
      contactSources.join("\n"),
      contactNames,
    ),
    systemPrompts,
    endCallAuthorized:
      finalizationAccepted || exactEndConversationRequest(latestUserMessage),
  };
}

function strictlyAcceptedFinalizationResult(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const keys = Object.keys(parsed).sort();
  return (
    keys.length === 3 &&
    keys[0] === "accepted" &&
    keys[1] === "code" &&
    keys[2] === "receipt_digest" &&
    parsed.accepted === true &&
    parsed.code === "finalize_accepted" &&
    typeof parsed.receipt_digest === "string" &&
    /^[a-f0-9]{64}$/u.test(parsed.receipt_digest)
  );
}

function exactEndConversationRequest(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /^(?:(?:i (?:want|would like|'d like) to|please) )?(?:end|stop|close) (?:this|the) (?:conversation|call)(?: now)?[.!]?$/u.test(
      normalized,
    ) ||
    /^(?:let's|let us) (?:end|stop|close) (?:this|the) (?:conversation|call)(?: now)?[.!]?$/u.test(
      normalized,
    ) ||
    /^(?:can|could|would|will) you (?:please )?(?:end|stop|close) (?:this|the) (?:conversation|call)(?: now)?[?!.]?$/u.test(
      normalized,
    ) ||
    /^(?:please )?hang up(?: now)?[.!]?$/u.test(normalized) ||
    /^(?:thanks?(?:,| and) )?(?:goodbye|bye)[.!]?$/u.test(normalized)
  );
}

function validateTools(
  value: unknown,
  limits: CustomLlmLimits,
): ValidatedTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limits.maximumTools) {
    failInvalidRequest();
  }

  const tools: ValidatedTool[] = [];
  const names = new Set<string>();
  for (const rawTool of value) {
    if (!isRecord(rawTool)) failInvalidRequest();
    assertAllowedKeys(rawTool, new Set(["type", "function"]));
    if (rawTool.type !== "function" || !isRecord(rawTool.function)) {
      failInvalidRequest();
    }
    assertAllowedKeys(
      rawTool.function,
      new Set(["name", "description", "parameters", "strict"]),
    );
    const name = rawTool.function.name;
    if (
      typeof name !== "string" ||
      !TOOL_NAME_PATTERN.test(name) ||
      !ALLOWED_VOICE_TOOL_NAMES.has(name) ||
      names.has(name)
    ) {
      failInvalidRequest();
    }
    names.add(name);
    const description = rawTool.function.description;
    if (
      description !== undefined &&
      (typeof description !== "string" ||
        !description.trim() ||
        description.length > 4_000)
    ) {
      failInvalidRequest();
    }
    if (!isRecord(rawTool.function.parameters)) failInvalidRequest();
    validateJsonTree(rawTool.function.parameters, { nodes: 0 });
    if (
      rawTool.function.strict !== undefined &&
      typeof rawTool.function.strict !== "boolean"
    ) {
      failInvalidRequest();
    }

    tools.push({
      type: "function",
      function: {
        name,
        ...(typeof description === "string" ? { description } : {}),
        parameters: rawTool.function.parameters,
        ...(typeof rawTool.function.strict === "boolean"
          ? { strict: rawTool.function.strict }
          : {}),
      },
    });
  }
  return tools;
}

function validateToolChoice(
  value: unknown,
  toolNames: ReadonlySet<string>,
): ValidatedRequest["toolChoice"] {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none" || value === "required") {
    if (toolNames.size === 0 && value !== "none") failInvalidRequest();
    return value;
  }
  if (!isRecord(value)) failInvalidRequest();
  assertAllowedKeys(value, new Set(["type", "function"]));
  if (value.type !== "function" || !isRecord(value.function)) {
    failInvalidRequest();
  }
  assertAllowedKeys(value.function, new Set(["name"]));
  const name = value.function.name;
  if (
    typeof name !== "string" ||
    !TOOL_NAME_PATTERN.test(name) ||
    !toolNames.has(name)
  ) {
    failInvalidRequest();
  }
  return { type: "function", function: { name } };
}

function parseFiniteRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    failInvalidRequest();
  }
  return value;
}

function validateRequestBody(
  rawBody: string,
  limits: CustomLlmLimits,
  configuration: RuntimeConfiguration,
): ValidatedRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    failInvalidRequest();
  }
  if (!isRecord(parsed)) failInvalidRequest();
  assertAllowedKeys(
    parsed,
    new Set([
      "model",
      "messages",
      "stream",
      "max_tokens",
      "max_completion_tokens",
      "temperature",
      "top_p",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "user",
      "user_id",
      "elevenlabs_extra_body",
    ]),
  );
  if (parsed.model !== PUBLIC_MODEL_ID || parsed.stream !== true) {
    failInvalidRequest();
  }
  if (
    parsed.max_tokens !== undefined &&
    parsed.max_completion_tokens !== undefined
  ) {
    failInvalidRequest();
  }
  const requestedMaximum =
    parsed.max_tokens ??
    parsed.max_completion_tokens ??
    limits.maximumOutputTokens;
  if (
    typeof requestedMaximum !== "number" ||
    !Number.isInteger(requestedMaximum) ||
    requestedMaximum < 1 ||
    requestedMaximum > limits.maximumOutputTokens
  ) {
    failInvalidRequest();
  }
  if (
    parsed.parallel_tool_calls !== undefined &&
    parsed.parallel_tool_calls !== false
  ) {
    failInvalidRequest();
  }
  for (const userField of ["user", "user_id"] as const) {
    const value = parsed[userField];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.length < 1 ||
        value.length > 160 ||
        /[@\s]/u.test(value))
    ) {
      failInvalidRequest();
    }
  }
  if (parsed.elevenlabs_extra_body !== undefined) {
    if (!isRecord(parsed.elevenlabs_extra_body)) failInvalidRequest();
    validateJsonTree(parsed.elevenlabs_extra_body, { nodes: 0 });
  }

  const messageResult = validateMessages(parsed.messages, limits);
  const tools = validateTools(parsed.tools, limits);
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  for (const message of messageResult.messages) {
    const call = message.tool_calls?.[0];
    if (call && !toolNames.has(call.function.name)) failInvalidRequest();
    if (
      message.role === "tool" &&
      message.name &&
      !toolNames.has(message.name)
    ) {
      failInvalidRequest();
    }
  }
  const toolChoice = validateToolChoice(parsed.tool_choice, toolNames);

  const promptText = messageResult.messages
    .map((message) => message.content ?? "")
    .join("\n");
  if (
    promptText.includes(configuration.fireworksApiKey) ||
    promptText.includes(configuration.customLlmSecret)
  ) {
    failInvalidRequest();
  }

  return {
    messages: messageResult.messages,
    tools,
    ...(toolChoice ? { toolChoice } : {}),
    maximumOutputTokens: requestedMaximum,
    temperature: parseFiniteRange(parsed.temperature, 0.2, 0, 1),
    topP: parseFiniteRange(parsed.top_p, 1, 0.1, 1),
    contactEvidence: messageResult.contactEvidence,
    systemPrompts: messageResult.systemPrompts,
    endCallAuthorized: messageResult.endCallAuthorized,
  };
}

function buildFireworksRequest(
  validated: ValidatedRequest,
  configuration: RuntimeConfiguration,
): JsonRecord {
  return {
    model: configuration.fireworksModel,
    messages: validated.messages,
    ...(validated.tools.length > 0 ? { tools: validated.tools } : {}),
    ...(validated.toolChoice
      ? { tool_choice: validated.toolChoice }
      : validated.tools.length > 0
        ? { tool_choice: "auto" }
        : {}),
    parallel_tool_calls: false,
    temperature: validated.temperature,
    top_p: validated.topP,
    max_tokens: validated.maximumOutputTokens,
    reasoning_effort: "none",
    stream: true,
    stream_options: { include_usage: true },
    safe_tokenization: true,
  };
}

function waitFor<T>(
  promise: Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<T> {
  if (milliseconds <= 0) {
    onTimeout();
    return Promise.reject(new Error("timeout"));
  }
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new Error("timeout"));
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function fetchProviderAttempt(input: {
  fetchImpl: typeof fetch;
  configuration: RuntimeConfiguration;
  body: string;
  overallDeadline: number;
  firstByteTimeoutMs: number;
  maximumResponseBytes: number;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  const firstByteDeadline = Math.min(
    input.overallDeadline,
    Date.now() + input.firstByteTimeoutMs,
  );
  let streamed = false;
  let timeoutExpired = false;

  try {
    const response = await waitFor(
      input.fetchImpl(input.configuration.fireworksEndpoint, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${input.configuration.fireworksApiKey}`,
          "content-type": "application/json",
        },
        body: input.body,
        cache: "no-store",
        signal: controller.signal,
      }),
      firstByteDeadline - Date.now(),
      () => {
        timeoutExpired = true;
        controller.abort();
      },
    );

    if (!response.ok) {
      const retryable = new Set([408, 409, 425, 429, 500, 502, 503, 504]).has(
        response.status,
      );
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAttemptError({ streamed: false, retryable });
    }
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("text/event-stream") ||
      !response.body
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderAttemptError({
        streamed: false,
        retryable: false,
      });
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const deadline = streamed ? input.overallDeadline : firstByteDeadline;
        const result = await waitFor(
          reader.read(),
          deadline - Date.now(),
          () => {
            timeoutExpired = true;
            controller.abort();
          },
        );
        if (result.done) break;
        if (result.value.byteLength === 0) continue;
        streamed = true;
        bytes += result.value.byteLength;
        if (bytes > input.maximumResponseBytes) {
          await reader.cancel();
          throw new ProviderAttemptError({
            streamed: true,
            retryable: false,
          });
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!streamed) {
      throw new ProviderAttemptError({ streamed: false, retryable: true });
    }

    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderAttemptError) throw error;
    throw new ProviderAttemptError({
      streamed,
      retryable: !streamed,
      timedOut: timeoutExpired || Date.now() >= input.overallDeadline,
    });
  }
}

async function fetchProviderStream(input: {
  fetchImpl: typeof fetch;
  configuration: RuntimeConfiguration;
  requestBody: JsonRecord;
  limits: CustomLlmLimits;
}): Promise<Uint8Array> {
  const overallDeadline = Date.now() + input.limits.overallTimeoutMs;
  const body = JSON.stringify(input.requestBody);
  let lastError: ProviderAttemptError | undefined;

  for (
    let attempt = 0;
    attempt <= input.limits.retriesBeforeStreaming;
    attempt += 1
  ) {
    try {
      return await fetchProviderAttempt({
        fetchImpl: input.fetchImpl,
        configuration: input.configuration,
        body,
        overallDeadline,
        firstByteTimeoutMs: input.limits.firstByteTimeoutMs,
        maximumResponseBytes: input.limits.maximumResponseBytes,
      });
    } catch (error) {
      if (!(error instanceof ProviderAttemptError)) throw error;
      lastError = error;
      if (
        error.streamed ||
        !error.retryable ||
        attempt >= input.limits.retriesBeforeStreaming ||
        Date.now() >= overallDeadline
      ) {
        break;
      }
    }
  }

  throw new BridgeError(
    lastError?.timedOut || Date.now() >= overallDeadline ? 504 : 502,
    lastError?.timedOut || Date.now() >= overallDeadline
      ? "provider_timeout"
      : "provider_unavailable",
  );
}

function parseSseEvents(bytes: Uint8Array, maximumEvents: number): unknown[] {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  source = source.replace(/\r\n/gu, "\n");
  if (source.includes("\r") || !source.endsWith("\n\n")) {
    throw new BridgeError(502, "invalid_provider_stream");
  }

  const parsedEvents: unknown[] = [];
  let done = false;
  for (const block of source.split("\n\n")) {
    if (!block) continue;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (!line.startsWith("data:")) {
        throw new BridgeError(502, "invalid_provider_stream");
      }
      dataLines.push(line.slice(5).replace(/^ /u, ""));
    }
    if (dataLines.length === 0) continue;
    if (dataLines.length !== 1 || done) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    const payload = dataLines[0]!;
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    if (parsedEvents.length >= maximumEvents) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    try {
      parsedEvents.push(JSON.parse(payload) as unknown);
    } catch {
      throw new BridgeError(502, "invalid_provider_stream");
    }
  }
  if (!done || parsedEvents.length === 0) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  return parsedEvents;
}

function validateUsage(value: unknown, maximumOutputTokens: number) {
  if (!isRecord(value)) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  const promptTokens = value.prompt_tokens;
  const completionTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;
  for (const count of [promptTokens, completionTokens, totalTokens]) {
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > 1_000_000
    ) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
  }
  if ((completionTokens as number) > maximumOutputTokens) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  return {
    prompt_tokens: promptTokens as number,
    completion_tokens: completionTokens as number,
    total_tokens: totalTokens as number,
  };
}

function validateProviderEvents(input: {
  rawEvents: unknown[];
  publicModel: string;
  expectedProviderModel: string;
  declaredToolNames: ReadonlySet<string>;
  maximumOutputTokens: number;
  maximumContentBytes: number;
  maximumToolArgumentsBytes: number;
  endCallAuthorized: boolean;
}): ParsedProviderStream {
  const sanitizedEvents: JsonRecord[] = [];
  let completionId = "";
  let created: number | undefined;
  let spokenContent = "";
  let contentBytes = 0;
  let toolId = "";
  let toolName = "";
  let toolArguments = "";
  let finishReason: string | null = null;
  let emittedOutput = false;
  let usageSeen = false;
  let capturedContactEvidence = collectContactEvidence("");

  for (const rawEvent of input.rawEvents) {
    if (!isRecord(rawEvent) || !Array.isArray(rawEvent.choices)) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    if (
      typeof rawEvent.id !== "string" ||
      !TOOL_CALL_ID_PATTERN.test(rawEvent.id) ||
      rawEvent.object !== "chat.completion.chunk" ||
      typeof rawEvent.created !== "number" ||
      !Number.isInteger(rawEvent.created) ||
      rawEvent.created < 0 ||
      rawEvent.model !== input.expectedProviderModel ||
      rawEvent.choices.length > 1
    ) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    if (
      (completionId && completionId !== rawEvent.id) ||
      (created !== undefined && created !== rawEvent.created)
    ) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    completionId = rawEvent.id;
    created = rawEvent.created;

    const sanitized: JsonRecord = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: input.publicModel,
      choices: [],
    };
    if (rawEvent.usage !== undefined && rawEvent.usage !== null) {
      sanitized.usage = validateUsage(
        rawEvent.usage,
        input.maximumOutputTokens,
      );
      usageSeen = true;
    }
    if (
      rawEvent.choices.length === 0 &&
      (rawEvent.usage === undefined || rawEvent.usage === null)
    ) {
      throw new BridgeError(502, "invalid_provider_stream");
    }

    if (rawEvent.choices.length === 1) {
      const choice = rawEvent.choices[0];
      if (!isRecord(choice) || !isRecord(choice.delta)) {
        throw new BridgeError(502, "invalid_provider_stream");
      }
      assertProviderKeys(
        choice,
        new Set(["index", "delta", "finish_reason", "logprobs", "raw_output"]),
      );
      assertProviderKeys(
        choice.delta,
        new Set([
          "role",
          "content",
          "tool_calls",
          "reasoning_content",
          "reasoning",
        ]),
      );
      if (
        choice.index !== 0 ||
        (choice.logprobs !== undefined && choice.logprobs !== null) ||
        (choice.raw_output !== undefined && choice.raw_output !== null)
      ) {
        throw new BridgeError(502, "invalid_provider_stream");
      }
      if (finishReason !== null) {
        throw new BridgeError(502, "invalid_provider_stream");
      }

      const sanitizedDelta: JsonRecord = {};
      if (choice.delta.role !== undefined) {
        if (choice.delta.role !== "assistant") {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        sanitizedDelta.role = "assistant";
      }
      if (choice.delta.content !== undefined) {
        if (
          choice.delta.content !== null &&
          typeof choice.delta.content !== "string"
        ) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        if (typeof choice.delta.content === "string") {
          contentBytes += encodedLength(choice.delta.content);
          if (contentBytes > input.maximumContentBytes) {
            throw new BridgeError(502, "invalid_provider_stream");
          }
          spokenContent += choice.delta.content;
          if (choice.delta.content) emittedOutput = true;
        }
        sanitizedDelta.content = choice.delta.content;
      }
      if (
        choice.delta.reasoning_content !== undefined &&
        typeof choice.delta.reasoning_content !== "string"
      ) {
        throw new BridgeError(502, "invalid_provider_stream");
      }
      if (
        choice.delta.reasoning !== undefined &&
        typeof choice.delta.reasoning !== "string"
      ) {
        throw new BridgeError(502, "invalid_provider_stream");
      }

      if (choice.delta.tool_calls !== undefined) {
        if (
          !Array.isArray(choice.delta.tool_calls) ||
          choice.delta.tool_calls.length !== 1
        ) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        const piece = choice.delta.tool_calls[0];
        if (!isRecord(piece) || piece.index !== 0) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        assertProviderKeys(
          piece,
          new Set(["index", "id", "type", "function", "name"]),
        );
        if (piece.name !== undefined && piece.name !== null) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        if (
          piece.id !== undefined &&
          piece.id !== null &&
          (typeof piece.id !== "string" ||
            !TOOL_CALL_ID_PATTERN.test(piece.id) ||
            (toolId && toolId !== piece.id))
        ) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        if (typeof piece.id === "string") toolId = piece.id;
        if (
          piece.type !== undefined &&
          piece.type !== null &&
          piece.type !== "function"
        ) {
          throw new BridgeError(502, "invalid_provider_stream");
        }
        const sanitizedPiece: JsonRecord = { index: 0 };
        if (typeof piece.id === "string") sanitizedPiece.id = piece.id;
        if (piece.type === "function") sanitizedPiece.type = "function";
        if (piece.function !== undefined) {
          if (!isRecord(piece.function)) {
            throw new BridgeError(502, "invalid_provider_stream");
          }
          assertProviderKeys(piece.function, new Set(["name", "arguments"]));
          const sanitizedFunction: JsonRecord = {};
          if (
            piece.function.name !== undefined &&
            piece.function.name !== null
          ) {
            if (typeof piece.function.name !== "string") {
              throw new BridgeError(502, "invalid_provider_stream");
            }
            toolName += piece.function.name;
            if (toolName.length > 64) {
              throw new BridgeError(502, "invalid_provider_stream");
            }
            sanitizedFunction.name = piece.function.name;
          }
          if (piece.function.arguments !== undefined) {
            if (typeof piece.function.arguments !== "string") {
              throw new BridgeError(502, "invalid_provider_stream");
            }
            toolArguments += piece.function.arguments;
            if (
              encodedLength(toolArguments) > input.maximumToolArgumentsBytes
            ) {
              throw new BridgeError(502, "invalid_provider_stream");
            }
            sanitizedFunction.arguments = piece.function.arguments;
          }
          sanitizedPiece.function = sanitizedFunction;
        }
        sanitizedDelta.tool_calls = [sanitizedPiece];
        emittedOutput = true;
      }

      if (
        choice.finish_reason !== null &&
        choice.finish_reason !== "stop" &&
        choice.finish_reason !== "length" &&
        choice.finish_reason !== "content_filter" &&
        choice.finish_reason !== "tool_calls"
      ) {
        throw new BridgeError(502, "invalid_provider_stream");
      }
      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      (sanitized.choices as unknown[]).push({
        index: 0,
        delta: sanitizedDelta,
        finish_reason: choice.finish_reason,
      });
    }
    sanitizedEvents.push(sanitized);
  }

  if (!emittedOutput || finishReason === null) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  if (toolId || toolName || toolArguments) {
    if (
      finishReason !== "tool_calls" ||
      !toolId ||
      !TOOL_NAME_PATTERN.test(toolName) ||
      !input.declaredToolNames.has(toolName)
    ) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
    const parsedArguments = validateProviderToolArguments(
      toolArguments,
      input.maximumToolArgumentsBytes,
    );
    if (toolName === "capture_contact") {
      capturedContactEvidence = collectContactEvidence(
        toolArguments,
        typeof parsedArguments.name === "string" ? [parsedArguments.name] : [],
      );
    }
    if (toolName === "end_call" && !input.endCallAuthorized) {
      throw new BridgeError(502, "unsafe_model_output");
    }
  } else if (finishReason === "tool_calls") {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  if (!usageSeen) {
    throw new BridgeError(502, "invalid_provider_stream");
  }

  return { events: sanitizedEvents, spokenContent, capturedContactEvidence };
}

function assertProviderKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new BridgeError(502, "invalid_provider_stream");
    }
  }
}

function validateProviderToolArguments(
  value: string,
  maximumBytes: number,
): JsonRecord {
  if (!value || encodedLength(value) > maximumBytes) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  if (!isRecord(parsed)) {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  try {
    validateJsonTree(parsed, { nodes: 0 });
  } catch {
    throw new BridgeError(502, "invalid_provider_stream");
  }
  return parsed;
}

function normalizeEmail(value: string): string {
  return value.toLowerCase().replace(/[),.;:!?]+$/u, "");
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D/gu, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeContactName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function explicitlyIntroducedNames(value: string): string[] {
  const names: string[] = [];
  const introduction =
    /\b(?:my name (?:is|'s)|(?:you can )?call me|i go by)\s+([^,.!?;\n]{1,160})/giu;
  for (const match of value.matchAll(introduction)) {
    const candidate = (match[1] ?? "")
      .split(/\s+(?:and|but|because|calling|from|with)\b/iu, 1)[0]!
      .trim()
      .split(/\s+/u)
      .slice(0, 4)
      .join(" ");
    if (
      candidate &&
      /^[\p{L}\p{M}][\p{L}\p{M}'’-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’-]*){0,3}$/u.test(
        candidate,
      )
    ) {
      names.push(candidate);
    }
  }
  const capitalizedIntroduction =
    /\b(?:I am|I'm|This is)\s+([\p{Lu}][\p{L}\p{M}'’-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’-]*){0,2})\b/gu;
  for (const match of value.matchAll(capitalizedIntroduction)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function collectContactEvidence(
  value: string,
  names: readonly string[] = [],
): ContactEvidence {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const match of value.matchAll(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu,
  )) {
    emails.add(normalizeEmail(match[0]));
  }
  for (const match of value.matchAll(
    /\b([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)\s+(?:at|@)\s+([a-z0-9-]+(?:\s+(?:dot|\.)\s+[a-z0-9-]+)+)\b/giu,
  )) {
    const local = match[1]!;
    const domain = match[2]!.replace(/\s+(?:dot|\.)\s+/giu, ".");
    emails.add(normalizeEmail(`${local}@${domain}`));
  }
  for (const match of value.matchAll(/(?:\+?\d[\d ().-]{5,}\d)/gu)) {
    const digits = match[0].replace(/\D/gu, "");
    if (digits.length >= 7 && digits.length <= 15) {
      phones.add(normalizePhone(match[0]));
    }
  }
  const spokenDigit =
    "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)";
  const spokenPhonePattern = new RegExp(
    `\\b${spokenDigit}(?:[\\s,.-]+${spokenDigit}){6,14}\\b`,
    "giu",
  );
  const digitWords: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  for (const match of value.matchAll(spokenPhonePattern)) {
    const digits = match[0]
      .toLowerCase()
      .split(/[\s,.-]+/u)
      .map((word) => digitWords[word] ?? "")
      .join("");
    if (digits.length >= 7 && digits.length <= 15) {
      phones.add(normalizePhone(digits));
    }
  }
  const normalizedNames = new Set(
    names.map(normalizeContactName).filter(Boolean),
  );
  return { emails, phones, names: normalizedNames };
}

function mergeContactEvidence(
  left: ContactEvidence,
  right: ContactEvidence,
): ContactEvidence {
  return {
    emails: new Set([...left.emails, ...right.emails]),
    phones: new Set([...left.phones, ...right.phones]),
    names: new Set([...left.names, ...right.names]),
  };
}

function normalizedPromptText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function repeatsSystemPrompt(
  spokenContent: string,
  systemPrompts: readonly string[],
): boolean {
  const spoken = normalizedPromptText(spokenContent);
  if (spoken.length < 64) return false;
  for (const prompt of systemPrompts) {
    const normalizedPrompt = normalizedPromptText(prompt);
    for (let index = 0; index <= spoken.length - 64; index += 1) {
      if (normalizedPrompt.includes(spoken.slice(index, index + 64))) {
        return true;
      }
    }
  }
  return false;
}

function containsUnauthorizedTransitionClaim(value: string): boolean {
  const clauses = value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[.!?;\n,]+|\b(?:and|but|however)\b/gu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const negation =
    /\b(?:no|not|nothing|neither|never|cannot|can't|won't|isn't|aren't|wasn't|hasn't|haven't|unverified|pending|unable|failed|without)\b/u;
  const affirmativePatterns = [
    /\b(?:your )?email(?: ownership)?(?: (?:is|was|has been))? (?:already )?(?:verified|confirmed|authenticated)\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:already )?(?:verify|verified|confirm|confirmed|authenticate|authenticated) (?:your )?email(?: ownership)?\b/u,
    /\b(?:your |the )?(?:payment|checkout|charge)(?: (?:is|was|has been))? (?:already |successfully )?(?:paid|verified|completed|complete|authorized|approved|received|processed|settled|successful)\b/u,
    /\b(?:payment|checkout|charge) (?:went|has gone) through\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:successfully )?(?:verify|verified|complete|completed|authorize|authorized|approve|approved|receive|received|process|processed|settle|settled) (?:your |the )?(?:payment|checkout|charge)\b/u,
    /\b(?:you are|you're) (?:fully )?paid\b/u,
    /\b(?:the )?(?:proof|proof gate|build proof|candidate proof)(?: (?:is|was|has been))? (?:already )?(?:passed|complete|completed|authorized|approved|verified|successful)\b/u,
    /\b(?:the )?(?:build|candidate|project)(?: (?:is|was|has been))? (?:already )?proven\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:verify|verified|authorize|authorized|approve|approved) (?:the )?(?:proof|proof gate|build proof|candidate proof)\b/u,
    /\b(?:your |the )?(?:project|build|engagement)(?: (?:is|was|has been))? (?:already )?(?:cancelled|canceled)\b/u,
    /\b(?:project )?cancellation(?: (?:is|was|has been))? (?:complete|completed|authorized|approved|successful)\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:already )?(?:cancel|cancelled|canceled) (?:your |the )?(?:project|build|engagement)\b/u,
    /\b(?:your |the )?(?:deployment|app|application|site|website|build|product)(?: (?:is|was|has been))? (?:already |now )?(?:deployed|live|in production)\b/u,
    /\bdeployment(?: (?:is|was|has been))? (?:complete|completed|authorized|approved|successful)\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:already |successfully )?(?:deploy|deployed) (?:your |the )?(?:app|application|site|website|build|product)\b/u,
    /\b(?:your |the )?(?:delivery|app|application|site|website|build|product)(?: (?:is|was|has been))? (?:already )?(?:delivered|shipped)\b/u,
    /\bdelivery(?: (?:is|was|has been))? (?:complete|completed|authorized|approved|successful)\b/u,
    /\b(?:i|we|buildlabs)(?: can| will|'ll| have| has|'ve)? (?:already |successfully )?(?:deliver|delivered) (?:your |the )?(?:app|application|site|website|build|product)\b/u,
  ];
  return clauses.some(
    (clause) =>
      !negation.test(clause) &&
      affirmativePatterns.some((pattern) => pattern.test(clause)),
  );
}

function validateSafeSpokenOutput(input: {
  spokenContent: string;
  contactEvidence: ContactEvidence;
  systemPrompts: readonly string[];
  secrets: readonly string[];
}): void {
  const outputContacts = collectContactEvidence(input.spokenContent);
  for (const email of outputContacts.emails) {
    if (input.contactEvidence.emails.has(email)) {
      throw new BridgeError(502, "unsafe_model_output");
    }
  }
  for (const phone of outputContacts.phones) {
    if (input.contactEvidence.phones.has(phone)) {
      throw new BridgeError(502, "unsafe_model_output");
    }
  }
  const normalizedSpoken = ` ${normalizeContactName(input.spokenContent)} `;
  for (const name of input.contactEvidence.names) {
    if (normalizedSpoken.includes(` ${name} `)) {
      throw new BridgeError(502, "unsafe_model_output");
    }
  }

  const forbiddenMarker =
    /\b(?:FIREWORKS_API_KEY|ELEVENLABS_CUSTOM_LLM_SECRET|secret__buildlabs_capability|system__conversation_history|prompt_cache_isolation_key)\b/iu;
  const credentialPattern =
    /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|(?:fw|xi|sk)[_-][A-Za-z0-9_-]{16,})\b/iu;
  if (
    forbiddenMarker.test(input.spokenContent) ||
    credentialPattern.test(input.spokenContent) ||
    input.secrets.some(
      (secret) => secret.length >= 8 && input.spokenContent.includes(secret),
    ) ||
    repeatsSystemPrompt(input.spokenContent, input.systemPrompts) ||
    containsUnauthorizedTransitionClaim(input.spokenContent)
  ) {
    throw new BridgeError(502, "unsafe_model_output");
  }
}

function encodeSse(events: readonly JsonRecord[]): string {
  return `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

function errorResponse(error: BridgeError): Response {
  return Response.json(
    { error: { code: error.code } },
    {
      status: error.status,
      headers: {
        "cache-control": "private, no-store",
        ...(error.status === 401 ? { "www-authenticate": "Bearer" } : {}),
      },
    },
  );
}

function resolvedLimits(
  overrides: Partial<CustomLlmLimits> | undefined,
): CustomLlmLimits {
  return { ...CUSTOM_LLM_LIMITS, ...overrides };
}

export async function handleCustomLlmRequest(
  request: Request,
  dependencies: CustomLlmDependencies = {},
): Promise<Response> {
  try {
    const customLlmSecret = loadAuthenticationSecret(process.env);
    await authenticateRequest(request, customLlmSecret);
    const configuration = loadConfiguration(process.env, customLlmSecret);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      throw new BridgeError(415, "invalid_content_type");
    }

    const limits = resolvedLimits(dependencies.limits);
    const rawBody = await readBoundedRequestBody(
      request,
      limits.maximumRequestBytes,
    );
    const validated = validateRequestBody(rawBody, limits, configuration);
    const fireworksRequest = buildFireworksRequest(validated, configuration);
    const providerBytes = await fetchProviderStream({
      fetchImpl: dependencies.fetchImpl ?? fetch,
      configuration,
      requestBody: fireworksRequest,
      limits,
    });
    const rawEvents = parseSseEvents(providerBytes, limits.maximumSseEvents);
    const parsedStream = validateProviderEvents({
      rawEvents,
      publicModel: PUBLIC_MODEL_ID,
      expectedProviderModel: configuration.fireworksModel,
      declaredToolNames: new Set(
        validated.tools.map((tool) => tool.function.name),
      ),
      maximumOutputTokens: validated.maximumOutputTokens,
      maximumContentBytes: limits.maximumContentBytes,
      maximumToolArgumentsBytes: limits.maximumToolArgumentsBytes,
      endCallAuthorized: validated.endCallAuthorized,
    });
    validateSafeSpokenOutput({
      spokenContent: parsedStream.spokenContent,
      contactEvidence: mergeContactEvidence(
        validated.contactEvidence,
        parsedStream.capturedContactEvidence,
      ),
      systemPrompts: validated.systemPrompts,
      secrets: [configuration.customLlmSecret, configuration.fireworksApiKey],
    });

    return new Response(encodeSse(parsedStream.events), {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof BridgeError) return errorResponse(error);
    return errorResponse(new BridgeError(502, "provider_unavailable"));
  }
}
