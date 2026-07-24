import { mintIntakeToolCapability } from "./tool-capability";

const BODY_LIMIT = 8_192;
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{8,160}$/u;
const AGENT_ID = /^agent_[A-Za-z0-9_-]{8,180}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/u;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{7,255}$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const REQUIRED_REQUEST_KEYS = [
  "agent_id",
  "called_number",
  "conversation_id",
] as const;
const OPTIONAL_REQUEST_KEYS = ["caller_id", "call_id", "call_sid"] as const;

export class TelephonyInitializationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function environmentValue(name: string) {
  return process.env[name]?.trim() || "";
}

function configuration() {
  const secret = environmentValue("ELEVENLABS_PRECALL_SECRET");
  const agentId = environmentValue("ELEVENLABS_AGENT_ID");
  const agentVersion = environmentValue("ELEVENLABS_AGENT_VERSION_ID");
  const branchId = environmentValue("ELEVENLABS_BRANCH_ID");
  const calledNumber = environmentValue("PLIVO_BUILDLABS_NUMBER");
  if (
    secret.length < 32 ||
    !AGENT_ID.test(agentId) ||
    !RESOURCE_ID.test(agentVersion) ||
    !RESOURCE_ID.test(branchId) ||
    !E164.test(calledNumber)
  ) {
    throw new TelephonyInitializationError(503, "telephony_unconfigured");
  }
  return { secret, agentId, agentVersion, branchId, calledNumber };
}

function stringField(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TelephonyInitializationError(400, "invalid_request");
  }
  return value;
}

async function readBody(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) {
    throw new TelephonyInitializationError(415, "unsupported_media_type");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (
    !Number.isFinite(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > BODY_LIMIT
  ) {
    throw new TelephonyInitializationError(413, "payload_too_large");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > BODY_LIMIT) {
    throw new TelephonyInitializationError(413, "payload_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TelephonyInitializationError(400, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TelephonyInitializationError(400, "invalid_request");
  }
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body);
  const allowedKeys = [
    ...REQUIRED_REQUEST_KEYS,
    ...OPTIONAL_REQUEST_KEYS,
  ] as readonly string[];
  if (
    REQUIRED_REQUEST_KEYS.some((key) => !Object.hasOwn(body, key)) ||
    keys.some((key) => !allowedKeys.includes(key))
  ) {
    throw new TelephonyInitializationError(400, "invalid_request");
  }
  return body;
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function stableProjectId(conversationId: string) {
  const secret = environmentValue("ELEVENLABS_CAPABILITY_SECRET");
  if (secret.length < 32) {
    throw new TelephonyInitializationError(503, "telephony_unconfigured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `buildlabs:plivo-intake-project:v1:${conversationId}`,
      ),
    ),
  );
  return `intake_tel_${encodeBase64Url(digest.slice(0, 18))}`;
}

export async function createTelephonyConversationInitialization(
  request: Request,
) {
  const configured = configuration();
  const authorization = request.headers.get("authorization") || "";
  if (!constantTimeEqual(authorization, `Bearer ${configured.secret}`)) {
    throw new TelephonyInitializationError(401, "unauthorized");
  }

  const body = await readBody(request);
  const agentId = stringField(body.agent_id, 16, 200);
  const calledNumber = stringField(body.called_number, 8, 16);
  const conversationId = stringField(body.conversation_id, 13, 165);
  const callId =
    body.call_id === undefined
      ? stringField(body.call_sid, 8, 256)
      : stringField(body.call_id, 8, 256);
  if (
    body.call_id !== undefined &&
    body.call_sid !== undefined &&
    body.call_id !== body.call_sid
  ) {
    throw new TelephonyInitializationError(400, "invalid_request");
  }
  if (body.caller_id !== undefined) stringField(body.caller_id, 1, 64);
  if (
    agentId !== configured.agentId ||
    calledNumber !== configured.calledNumber ||
    !CONVERSATION_ID.test(conversationId) ||
    !CALL_ID.test(callId)
  ) {
    throw new TelephonyInitializationError(
      403,
      "telephony_resource_fence_mismatch",
    );
  }

  const projectId = await stableProjectId(conversationId);
  const capability = await mintIntakeToolCapability({
    agentId,
    conversationId,
    projectId,
    agentVersion: configured.agentVersion,
    ttlSeconds: 900,
  });

  return {
    type: "conversation_initiation_client_data" as const,
    dynamic_variables: {
      secret__buildlabs_capability: capability.token,
      buildlabs_project_id: projectId,
      buildlabs_contract_version: 0,
      buildlabs_agent_version: configured.agentVersion,
    },
    branch_id: configured.branchId,
    environment: "testing" as const,
  };
}
