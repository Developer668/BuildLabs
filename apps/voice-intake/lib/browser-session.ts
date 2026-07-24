import { mintIntakeToolCapability } from "./tool-capability";

const ELEVENLABS_SIGNED_URL_ENDPOINT =
  "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";
const SESSION_AUDIENCE = "buildlabs-browser-voice-reconnect";
const SESSION_TTL_SECONDS = 10 * 60;
const PROVIDER_TIMEOUT_MS = 6_000;
const MAX_RECONNECTS = 2;
const MAX_REQUEST_BYTES = 4_096;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/u;
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{8,160}$/u;

type ReconnectCapability = {
  v: 1;
  aud: typeof SESSION_AUDIENCE;
  projectId: string;
  agentId: string;
  agentVersion: string;
  branchId: string;
  previousConversationId: string;
  reconnects: number;
  issuedAt: number;
  sessionExpiresAt: number;
  nonce: string;
};

export type BrowserConversationSession = {
  signedUrl: string;
  conversationId: string;
  expiresAt: string;
  reconnectToken: string;
  reconnectAttempt: number;
  initiation: {
    type: "conversation_initiation_client_data";
    dynamic_variables: {
      secret__buildlabs_capability: string;
      buildlabs_project_id: string;
      buildlabs_contract_version: 0;
      buildlabs_agent_version: string;
    };
  };
};

export class BrowserSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "invalid_request"
      | "origin_not_allowed"
      | "session_not_configured"
      | "session_expired"
      | "reconnect_exhausted"
      | "reconnect_replayed"
      | "provider_unavailable",
  ) {
    super(code);
  }
}

const consumedReconnectNonces = new Map<string, number>();

function configuredValue(name: string) {
  return process.env[name]?.trim() || "";
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`;
  try {
    const binary = atob(padded);
    const decoded = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64Url(decoded) !== value) {
      throw new Error("non-canonical encoding");
    }
    return decoded;
  } catch {
    throw new BrowserSessionError(400, "invalid_request");
  }
}

function randomIdentifier(prefix: string, bytes = 18) {
  const random = new Uint8Array(bytes);
  crypto.getRandomValues(random);
  return `${prefix}${encodeBase64Url(random)}`;
}

async function sessionSignature(encoded: string) {
  const secret = configuredValue("VOICE_SESSION_SECRET");
  if (secret.length < 32) {
    throw new BrowserSessionError(503, "session_not_configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)),
  );
}

async function mintReconnectToken(payload: ReconnectCapability) {
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = encodeBase64Url(await sessionSignature(encoded));
  return `${encoded}.${signature}`;
}

function parseReconnectPayload(encoded: string): ReconnectCapability {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeBase64Url(encoded),
      ),
    ) as unknown;
  } catch (error) {
    if (error instanceof BrowserSessionError) throw error;
    throw new BrowserSessionError(400, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.v !== 1 ||
    value.aud !== SESSION_AUDIENCE ||
    typeof value.projectId !== "string" ||
    !IDENTIFIER.test(value.projectId) ||
    typeof value.agentId !== "string" ||
    !IDENTIFIER.test(value.agentId) ||
    typeof value.agentVersion !== "string" ||
    !IDENTIFIER.test(value.agentVersion) ||
    typeof value.branchId !== "string" ||
    !IDENTIFIER.test(value.branchId) ||
    typeof value.previousConversationId !== "string" ||
    !CONVERSATION_ID.test(value.previousConversationId) ||
    !Number.isInteger(value.reconnects) ||
    Number(value.reconnects) < 0 ||
    Number(value.reconnects) > MAX_RECONNECTS ||
    !Number.isInteger(value.issuedAt) ||
    !Number.isInteger(value.sessionExpiresAt) ||
    typeof value.nonce !== "string" ||
    !IDENTIFIER.test(value.nonce)
  ) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  return value as ReconnectCapability;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function pruneReplayGuard(nowSeconds: number) {
  for (const [nonce, expiresAt] of consumedReconnectNonces) {
    if (expiresAt <= nowSeconds) consumedReconnectNonces.delete(nonce);
  }
}

async function consumeReconnectToken(
  token: string,
  expected: {
    agentId: string;
    agentVersion: string;
    branchId: string;
  },
  nowSeconds: number,
) {
  const [encoded, encodedSignature, extra] = token.split(".");
  if (!encoded || !encodedSignature || extra) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  const supplied = decodeBase64Url(encodedSignature);
  const wanted = await sessionSignature(encoded);
  if (!constantTimeBytesEqual(supplied, wanted)) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  const payload = parseReconnectPayload(encoded);
  if (
    payload.agentId !== expected.agentId ||
    payload.agentVersion !== expected.agentVersion ||
    payload.branchId !== expected.branchId ||
    payload.issuedAt > nowSeconds + 30 ||
    payload.sessionExpiresAt <= nowSeconds ||
    payload.sessionExpiresAt - payload.issuedAt > SESSION_TTL_SECONDS
  ) {
    throw new BrowserSessionError(410, "session_expired");
  }
  if (payload.reconnects >= MAX_RECONNECTS) {
    throw new BrowserSessionError(409, "reconnect_exhausted");
  }
  pruneReplayGuard(nowSeconds);
  if (consumedReconnectNonces.has(payload.nonce)) {
    throw new BrowserSessionError(409, "reconnect_replayed");
  }
  consumedReconnectNonces.set(payload.nonce, payload.sessionExpiresAt);
  return payload;
}

function allowedOrigins(request: Request) {
  const configured = configuredValue("VOICE_INTAKE_ALLOWED_ORIGINS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) {
    return new Set(
      configured.map((value) => {
        try {
          const parsed = new URL(value);
          if (
            parsed.origin !== value ||
            parsed.username ||
            parsed.password ||
            (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          ) {
            throw new Error("invalid configured origin");
          }
          return parsed.origin;
        } catch {
          throw new BrowserSessionError(503, "session_not_configured");
        }
      }),
    );
  }
  if (process.env.NODE_ENV === "production") {
    throw new BrowserSessionError(503, "session_not_configured");
  }
  return new Set([new URL(request.url).origin]);
}

function assertOrigin(request: Request) {
  const supplied = request.headers.get("origin");
  if (!supplied) {
    throw new BrowserSessionError(403, "origin_not_allowed");
  }
  let normalized: string;
  try {
    const parsed = new URL(supplied);
    if (parsed.origin !== supplied || parsed.username || parsed.password) {
      throw new Error("invalid origin");
    }
    normalized = parsed.origin;
  } catch {
    throw new BrowserSessionError(403, "origin_not_allowed");
  }
  if (!allowedOrigins(request).has(normalized)) {
    throw new BrowserSessionError(403, "origin_not_allowed");
  }
}

async function reconnectTokenFromRequest(request: Request) {
  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (contentType !== "application/json") {
    throw new BrowserSessionError(415, "invalid_request");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new BrowserSessionError(413, "invalid_request");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new BrowserSessionError(413, "invalid_request");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BrowserSessionError(400, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "reconnectToken") ||
    (record.reconnectToken !== undefined &&
      (typeof record.reconnectToken !== "string" ||
        record.reconnectToken.length < 80 ||
        record.reconnectToken.length > 4_096))
  ) {
    throw new BrowserSessionError(400, "invalid_request");
  }
  return typeof record.reconnectToken === "string" ? record.reconnectToken : "";
}

function configuredResource() {
  const apiKey = configuredValue("ELEVENLABS_API_KEY");
  const agentId = configuredValue("ELEVENLABS_AGENT_ID");
  const branchId = configuredValue("ELEVENLABS_BRANCH_ID");
  const agentVersion = configuredValue("ELEVENLABS_AGENT_VERSION_ID");
  const capabilitySecret = configuredValue("ELEVENLABS_CAPABILITY_SECRET");
  const sessionSecret = configuredValue("VOICE_SESSION_SECRET");
  const toolSecret = configuredValue("ELEVENLABS_TOOL_SECRET");
  const customLlmSecret = configuredValue("ELEVENLABS_CUSTOM_LLM_SECRET");
  const fireworksApiKey = configuredValue("FIREWORKS_API_KEY");
  const fireworksVoiceModel = configuredValue("FIREWORKS_VOICE_MODEL");
  if (
    !apiKey ||
    !IDENTIFIER.test(agentId) ||
    !IDENTIFIER.test(branchId) ||
    !IDENTIFIER.test(agentVersion) ||
    capabilitySecret.length < 32 ||
    sessionSecret.length < 32 ||
    toolSecret.length < 32 ||
    customLlmSecret.length < 32 ||
    fireworksApiKey.length < 20 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(fireworksVoiceModel)
  ) {
    throw new BrowserSessionError(503, "session_not_configured");
  }
  return { apiKey, agentId, branchId, agentVersion };
}

async function getProviderSignedUrl(
  resource: ReturnType<typeof configuredResource>,
  fetcher: typeof fetch,
) {
  const url = new URL(ELEVENLABS_SIGNED_URL_ENDPOINT);
  url.searchParams.set("agent_id", resource.agentId);
  url.searchParams.set("include_conversation_id", "true");
  url.searchParams.set("branch_id", resource.branchId);
  url.searchParams.set("environment", "testing");

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "xi-api-key": resource.apiKey,
      },
      cache: "no-store",
      signal: abort.signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.toLowerCase().includes("json")
    ) {
      throw new BrowserSessionError(503, "provider_unavailable");
    }
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new BrowserSessionError(503, "provider_unavailable");
    }
    const record = body as Record<string, unknown>;
    const signedUrl =
      typeof record.signed_url === "string" ? record.signed_url : "";
    const conversationId =
      typeof record.conversation_id === "string" ? record.conversation_id : "";
    let parsedSignedUrl: URL;
    try {
      parsedSignedUrl = new URL(signedUrl);
    } catch {
      throw new BrowserSessionError(503, "provider_unavailable");
    }
    const hasSignature =
      parsedSignedUrl.searchParams.has("token") ||
      parsedSignedUrl.searchParams.has("conversation_signature");
    const signedAgent = parsedSignedUrl.searchParams.get("agent_id");
    if (
      parsedSignedUrl.protocol !== "wss:" ||
      parsedSignedUrl.hostname !== "api.elevenlabs.io" ||
      parsedSignedUrl.port ||
      parsedSignedUrl.username ||
      parsedSignedUrl.password ||
      parsedSignedUrl.hash ||
      parsedSignedUrl.pathname !== "/v1/convai/conversation" ||
      !hasSignature ||
      (signedAgent !== null && signedAgent !== resource.agentId) ||
      !CONVERSATION_ID.test(conversationId)
    ) {
      throw new BrowserSessionError(503, "provider_unavailable");
    }
    return { signedUrl: parsedSignedUrl.toString(), conversationId };
  } catch (error) {
    if (error instanceof BrowserSessionError) throw error;
    throw new BrowserSessionError(503, "provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export async function createBrowserConversationSession(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<BrowserConversationSession> {
  assertOrigin(request);
  const reconnectToken = await reconnectTokenFromRequest(request);
  const resource = configuredResource();
  const nowSeconds = Math.floor(Date.now() / 1_000);

  const previous = reconnectToken
    ? await consumeReconnectToken(reconnectToken, resource, nowSeconds)
    : null;
  const projectId = previous?.projectId ?? randomIdentifier("intake_");
  const sessionExpiresAt =
    previous?.sessionExpiresAt ?? nowSeconds + SESSION_TTL_SECONDS;
  const reconnectAttempt = (previous?.reconnects ?? -1) + 1;
  const remainingSeconds = sessionExpiresAt - nowSeconds;
  if (remainingSeconds < 60) {
    throw new BrowserSessionError(410, "session_expired");
  }

  const provider = await getProviderSignedUrl(resource, fetcher);
  const capability = await mintIntakeToolCapability({
    agentId: resource.agentId,
    conversationId: provider.conversationId,
    projectId,
    agentVersion: resource.agentVersion,
    ttlSeconds: Math.min(remainingSeconds, SESSION_TTL_SECONDS),
    nowSeconds,
  });
  const nextReconnectToken = await mintReconnectToken({
    v: 1,
    aud: SESSION_AUDIENCE,
    projectId,
    agentId: resource.agentId,
    agentVersion: resource.agentVersion,
    branchId: resource.branchId,
    previousConversationId: provider.conversationId,
    reconnects: reconnectAttempt,
    issuedAt: nowSeconds,
    sessionExpiresAt,
    nonce: randomIdentifier("resume_"),
  });

  return {
    signedUrl: provider.signedUrl,
    conversationId: provider.conversationId,
    expiresAt: new Date(sessionExpiresAt * 1_000).toISOString(),
    reconnectToken: nextReconnectToken,
    reconnectAttempt,
    initiation: {
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        secret__buildlabs_capability: capability.token,
        buildlabs_project_id: projectId,
        buildlabs_contract_version: 0,
        buildlabs_agent_version: resource.agentVersion,
      },
    },
  };
}

export const browserSessionPolicy = {
  maxReconnects: MAX_RECONNECTS,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
} as const;
