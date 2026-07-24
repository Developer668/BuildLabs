export const INTAKE_TOOL_CAPABILITY_AUDIENCE =
  "buildlabs-elevenlabs-intake-tools";

export const INTAKE_TOOL_SCOPES = [
  "intake:clarify",
  "intake:contact",
  "intake:research_consent",
  "intake:finalize",
] as const;

export type IntakeToolScope = (typeof INTAKE_TOOL_SCOPES)[number];

export type IntakeToolCapability = {
  v: 1;
  aud: typeof INTAKE_TOOL_CAPABILITY_AUDIENCE;
  agentId: string;
  conversationId: string;
  projectId: string;
  contractVersion: 0;
  agentVersion: string;
  scopes: IntakeToolScope[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

type MintCapabilityInput = {
  agentId: string;
  conversationId: string;
  projectId: string;
  agentVersion: string;
  scopes?: IntakeToolScope[];
  ttlSeconds?: number;
  nowSeconds?: number;
};

type VerifyCapabilityInput = {
  agentId: string;
  conversationId: string;
  projectId: string;
  contractVersion: number;
  agentVersion: string;
  scope: IntakeToolScope;
  nowSeconds?: number;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/u;
const CONVERSATION_ID = /^conv_[A-Za-z0-9_-]{8,160}$/u;
const MAX_CAPABILITY_SECONDS = 900;

function configuredSecret() {
  const secret = process.env.ELEVENLABS_CAPABILITY_SECRET?.trim() || "";
  if (secret.length < 32) {
    throw new Error(
      "The ElevenLabs controller capability key is not configured.",
    );
  }
  return secret;
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
    throw new Error("Invalid capability encoding");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`;
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== value) {
    throw new Error("Invalid capability encoding");
  }
  return decoded;
}

async function sign(message: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
}

function validIdentifier(value: unknown) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function parsePayload(encoded: string): IntakeToolCapability {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeBase64Url(encoded),
  );
  const value = JSON.parse(decoded) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid capability payload");
  }
  const payload = value as Record<string, unknown>;
  const scopes = payload.scopes;
  if (
    payload.v !== 1 ||
    payload.aud !== INTAKE_TOOL_CAPABILITY_AUDIENCE ||
    !validIdentifier(payload.agentId) ||
    typeof payload.conversationId !== "string" ||
    !CONVERSATION_ID.test(payload.conversationId) ||
    !validIdentifier(payload.projectId) ||
    payload.contractVersion !== 0 ||
    !validIdentifier(payload.agentVersion) ||
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > INTAKE_TOOL_SCOPES.length ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !INTAKE_TOOL_SCOPES.includes(scope as IntakeToolScope),
    ) ||
    new Set(scopes).size !== scopes.length ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    !validIdentifier(payload.nonce)
  ) {
    throw new Error("Invalid capability payload");
  }
  return payload as IntakeToolCapability;
}

export async function mintIntakeToolCapability(
  input: MintCapabilityInput,
): Promise<{ token: string; payload: IntakeToolCapability }> {
  if (
    !validIdentifier(input.agentId) ||
    !CONVERSATION_ID.test(input.conversationId) ||
    !validIdentifier(input.projectId) ||
    !validIdentifier(input.agentVersion)
  ) {
    throw new Error(
      "Cannot mint a capability for invalid resource identifiers.",
    );
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const ttl = input.ttlSeconds ?? MAX_CAPABILITY_SECONDS;
  if (
    !Number.isInteger(now) ||
    !Number.isInteger(ttl) ||
    ttl < 60 ||
    ttl > 900
  ) {
    throw new Error("The ElevenLabs capability lifetime is invalid.");
  }
  const scopes = [...(input.scopes ?? INTAKE_TOOL_SCOPES)].sort();
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !INTAKE_TOOL_SCOPES.includes(scope))
  ) {
    throw new Error("The ElevenLabs capability scopes are invalid.");
  }
  const random = new Uint8Array(18);
  crypto.getRandomValues(random);
  const payload: IntakeToolCapability = {
    v: 1,
    aud: INTAKE_TOOL_CAPABILITY_AUDIENCE,
    agentId: input.agentId,
    conversationId: input.conversationId,
    projectId: input.projectId,
    contractVersion: 0,
    agentVersion: input.agentVersion,
    scopes,
    issuedAt: now,
    expiresAt: now + ttl,
    nonce: `nonce_${encodeBase64Url(random)}`,
  };
  const encoded = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = encodeBase64Url(await sign(encoded, configuredSecret()));
  return { token: `${encoded}.${signature}`, payload };
}

export async function verifyIntakeToolCapability(
  token: string,
  expected: VerifyCapabilityInput,
): Promise<IntakeToolCapability> {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw new Error("Invalid ElevenLabs capability");
  }
  let actual: Uint8Array;
  try {
    actual = decodeBase64Url(suppliedSignature);
  } catch {
    throw new Error("Invalid ElevenLabs capability");
  }
  const wanted = await sign(encoded, configuredSecret());
  if (actual.length !== wanted.length) {
    throw new Error("Invalid ElevenLabs capability");
  }
  let difference = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= wanted[index]! ^ actual[index]!;
  }
  if (difference !== 0) throw new Error("Invalid ElevenLabs capability");

  let payload: IntakeToolCapability;
  try {
    payload = parsePayload(encoded);
  } catch {
    throw new Error("Invalid ElevenLabs capability");
  }
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isInteger(now) ||
    payload.issuedAt > now + 30 ||
    payload.expiresAt <= now ||
    payload.expiresAt - payload.issuedAt > MAX_CAPABILITY_SECONDS ||
    payload.agentId !== expected.agentId ||
    payload.conversationId !== expected.conversationId ||
    payload.projectId !== expected.projectId ||
    payload.contractVersion !== expected.contractVersion ||
    payload.agentVersion !== expected.agentVersion ||
    !payload.scopes.includes(expected.scope)
  ) {
    throw new Error("Invalid ElevenLabs capability");
  }
  return payload;
}
