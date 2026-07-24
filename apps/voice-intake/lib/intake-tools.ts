import {
  type IntakeToolScope,
  verifyIntakeToolCapability,
} from "./tool-capability";

export type IntakeToolKind =
  "clarify" | "contact" | "research_consent" | "finalize";

const BODY_LIMIT = 32_768;
const COMMON_KEYS = [
  "project_id",
  "contract_version",
  "conversation_id",
  "agent_id",
  "agent_version",
] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,190}\.[A-Za-z]{2,24}$/u;
const EMAIL_IN_TEXT =
  /(?:^|\s)[^\s@]{1,64}@[^\s@.]{1,190}\.[A-Za-z]{2,24}(?:\s|$)/u;
const PHONE = /^\+?[0-9][0-9 ()-]{6,38}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const PRIVATE_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)$/iu;

type CommonInput = {
  capability: string;
  projectId: string;
  contractVersion: number;
  conversationId: string;
  agentId: string;
  agentVersion: string;
};

type HistoryTurn = { role: "agent" | "user"; message: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(
  value: unknown,
  minimum: number,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .trim();
  return normalized.length >= minimum && normalized.length <= maximum
    ? normalized
    : null;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function authorized(request: Request) {
  const configured = process.env.ELEVENLABS_TOOL_SECRET?.trim() || "";
  const supplied = request.headers.get("authorization") || "";
  return (
    configured.length >= 32 &&
    constantTimeEqual(supplied, `Bearer ${configured}`)
  );
}

async function readJson(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > BODY_LIMIT)
    throw new IntakeToolError(413, "payload_too_large");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > BODY_LIMIT) {
    throw new IntakeToolError(413, "payload_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new IntakeToolError(400, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntakeToolError(400, "invalid_request");
  }
  return parsed as Record<string, unknown>;
}

function enforceKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new IntakeToolError(400, "invalid_request");
  }
}

function commonInput(
  body: Record<string, unknown>,
  capabilityHeader: string | null,
): CommonInput {
  const capability = stringValue(capabilityHeader, 40, 4_096);
  const projectId = stringValue(body.project_id, 8, 200);
  const conversationId = stringValue(body.conversation_id, 13, 165);
  const agentId = stringValue(body.agent_id, 8, 200);
  const agentVersion = stringValue(body.agent_version, 8, 200);
  const contractVersion = body.contract_version;
  if (
    !capability ||
    !projectId ||
    !conversationId ||
    !agentId ||
    !agentVersion ||
    contractVersion !== 0
  ) {
    throw new IntakeToolError(400, "invalid_request");
  }
  const configuredAgent = process.env.ELEVENLABS_AGENT_ID?.trim() || "";
  const configuredVersion =
    process.env.ELEVENLABS_AGENT_VERSION_ID?.trim() || "";
  if (
    !configuredAgent ||
    !configuredVersion ||
    agentId !== configuredAgent ||
    agentVersion !== configuredVersion
  ) {
    throw new IntakeToolError(403, "resource_fence_mismatch");
  }
  return {
    capability,
    projectId,
    contractVersion,
    conversationId,
    agentId,
    agentVersion,
  };
}

function parseHistory(value: unknown): HistoryTurn[] {
  const serialized = stringValue(value, 2, 16_000);
  if (!serialized) throw new IntakeToolError(400, "invalid_history");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new IntakeToolError(400, "invalid_history");
  }
  const envelope = record(parsed);
  const entries = envelope.entries;
  if (
    envelope["x-elevenlabs-history"] !== true ||
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > 80
  ) {
    throw new IntakeToolError(400, "invalid_history");
  }
  const turns: HistoryTurn[] = [];
  for (const raw of entries) {
    const turn = record(raw);
    const role = turn.role;
    const message = stringValue(turn.message, 1, 4_000);
    if ((role === "agent" || role === "user") && message) {
      turns.push({ role, message });
    }
  }
  if (!turns.length || turns.at(-1)?.role !== "user") {
    throw new IntakeToolError(400, "invalid_history");
  }
  return turns;
}

function latestUserIntent(history: HistoryTurn[]) {
  const lastIndex = history.findLastIndex((turn) => turn.role === "user");
  return {
    user: history[lastIndex]?.message ?? "",
    agent:
      history.slice(0, lastIndex).findLast((turn) => turn.role === "agent")
        ?.message ?? "",
  };
}

function explicitConsent(history: HistoryTurn[], expected: boolean) {
  const { user, agent } = latestUserIntent(history);
  const agentResearchContext =
    /\b(?:research|look\s*up|search|check|review)\b/iu.test(agent) &&
    /\b(?:your|own|business|company|site|website)\b/iu.test(agent);
  const userResearchContext =
    /\b(?:research|look\s*up|search|check|review)\b/iu.test(user) &&
    /\b(?:my|our|own|business|company|site|website)\b/iu.test(user);
  const allow =
    (userResearchContext &&
      /\b(?:i\s+(?:consent|agree|authorize)|you\s+(?:may|can)|go\s+ahead|please|yes|sure|okay|ok)\b/iu.test(
        user,
      )) ||
    (agentResearchContext &&
      /^(?:yes|sure|okay|ok|go ahead|please do)[.! ]*$/iu.test(user));
  const deny =
    (userResearchContext &&
      /\b(?:i\s+(?:do\s+not|don't|decline|refuse)|do\s+not|don't|no|without)\b/iu.test(
        user,
      )) ||
    (agentResearchContext &&
      /^(?:no|nope|decline|do not|don't)[.! ]*$/iu.test(user));
  return expected ? allow && !deny : deny && !allow;
}

function explicitFinalization(history: HistoryTurn[]) {
  const { user, agent } = latestUserIntent(history);
  const confirmationContext =
    /\b(?:finalize|finish|complete|submit|requirements|scope|quote)\b/iu.test(
      agent,
    );
  const direct =
    /\b(?:finalize|finish|complete|submit)\s+(?:the\s+)?(?:intake|requirements|scope|quote)\b/iu.test(
      user,
    );
  const affirmative =
    confirmationContext &&
    /^(?:yes|correct|that(?:'s| is) right|looks good|go ahead|please do)[.! ]*$/iu.test(
      user,
    );
  const negated = /\b(?:do\s+not|don't|not yet|wait|hold on|no)\b/iu.test(user);
  return (direct || affirmative) && !negated;
}

function historyContainsPiiReadback(history: HistoryTurn[]) {
  return history.some(
    (turn) =>
      turn.role === "agent" &&
      (EMAIL_IN_TEXT.test(turn.message) ||
        /\b(?:your\s+)?(?:email|phone(?:\s+number)?|name)\s+(?:is|was|as)\b/iu.test(
          turn.message,
        ) ||
        /\b(?:confirm|repeat|read|spell)\b.{0,32}\b(?:email|phone|name)\b/iu.test(
          turn.message,
        )),
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateCallerOwnedUrl(
  value: unknown,
  required: boolean,
  history: HistoryTurn[],
) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new IntakeToolError(400, "caller_owned_url_required");
    return;
  }
  const candidate = stringValue(value, 12, 2_048);
  if (!candidate) throw new IntakeToolError(400, "invalid_caller_owned_url");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new IntakeToolError(400, "invalid_caller_owned_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    PRIVATE_HOST.test(url.hostname)
  ) {
    throw new IntakeToolError(400, "invalid_caller_owned_url");
  }
  const normalizedHost = url.host.toLowerCase();
  const hostMention = new RegExp(
    `(?:^|[^a-z0-9.-])${escapeRegExp(normalizedHost)}(?=$|[^a-z0-9.-])`,
    "u",
  );
  const confirmedByCaller = history
    .filter((turn) => turn.role === "user")
    .some((turn) => {
      const normalizedUser = turn.message.normalize("NFKC").toLowerCase();
      const callerOwnership =
        /\b(?:my|our|own|business|company|site|website)\b/iu.test(
          normalizedUser,
        );
      return (
        callerOwnership &&
        (normalizedUser.includes(url.origin.toLowerCase()) ||
          hostMention.test(normalizedUser))
      );
    });
  if (!confirmedByCaller) {
    throw new IntakeToolError(409, "caller_owned_url_not_confirmed");
  }
}

async function receiptDigest(
  kind: IntakeToolKind,
  common: CommonInput,
  acceptedFields: Record<string, unknown>,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      process.env.ELEVENLABS_CAPABILITY_SECRET?.trim() || "",
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const content = JSON.stringify({
    kind,
    conversationId: common.conversationId,
    projectId: common.projectId,
    contractVersion: common.contractVersion,
    agentVersion: common.agentVersion,
    acceptedFields,
  });
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function scopeFor(kind: IntakeToolKind): IntakeToolScope {
  return `intake:${kind}` as IntakeToolScope;
}

class IntakeToolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function handleIntakeTool(
  request: Request,
  kind: IntakeToolKind,
): Promise<Response> {
  if (!authorized(request)) {
    return Response.json(
      { accepted: false, code: "unauthorized" },
      { status: 401 },
    );
  }
  try {
    const body = await readJson(request);
    const specificKeys =
      kind === "clarify"
        ? ["question", "field"]
        : kind === "contact"
          ? ["name", "email", "phone"]
          : kind === "research_consent"
            ? ["consent", "caller_owned_url", "history"]
            : [
                "scope_summary",
                "hard_requirements",
                "amount_minor",
                "currency",
                "contact_captured",
                "research_consent",
                "history",
              ];
    enforceKeys(body, [...COMMON_KEYS, ...specificKeys]);
    const common = commonInput(
      body,
      request.headers.get("x-buildlabs-capability"),
    );
    await verifyIntakeToolCapability(common.capability, {
      agentId: common.agentId,
      conversationId: common.conversationId,
      projectId: common.projectId,
      contractVersion: common.contractVersion,
      agentVersion: common.agentVersion,
      scope: scopeFor(kind),
    });

    let acceptedFields: Record<string, unknown>;
    let result: Record<string, unknown> = {};
    if (kind === "clarify") {
      const question = stringValue(body.question, 4, 500);
      const field = stringValue(body.field, 3, 40);
      if (
        !question ||
        !field ||
        ![
          "scope",
          "requirement",
          "amount",
          "currency",
          "research_consent",
          "contact",
        ].includes(field)
      ) {
        throw new IntakeToolError(400, "invalid_clarification");
      }
      acceptedFields = { field, question };
    } else if (kind === "contact") {
      const name = stringValue(body.name, 1, 160);
      const email = stringValue(body.email, 6, 320);
      const phone = stringValue(body.phone, 7, 40);
      if (
        !name ||
        !email ||
        !phone ||
        !EMAIL.test(email) ||
        !PHONE.test(phone)
      ) {
        throw new IntakeToolError(400, "invalid_contact");
      }
      acceptedFields = { name, email: email.toLowerCase(), phone };
      result = { email_verification: "unverified" };
    } else if (kind === "research_consent") {
      if (typeof body.consent !== "boolean") {
        throw new IntakeToolError(400, "invalid_research_consent");
      }
      const history = parseHistory(body.history);
      if (!explicitConsent(history, body.consent)) {
        throw new IntakeToolError(409, "explicit_research_consent_required");
      }
      validateCallerOwnedUrl(body.caller_owned_url, body.consent, history);
      acceptedFields = {
        consent: body.consent,
        ...(body.caller_owned_url
          ? { callerOwnedUrl: String(body.caller_owned_url) }
          : {}),
      };
      result = { consent: body.consent };
    } else {
      const scopeSummary = stringValue(body.scope_summary, 10, 4_000);
      const requirements = body.hard_requirements;
      const amountMinor = body.amount_minor;
      const currency = stringValue(body.currency, 3, 3);
      const history = parseHistory(body.history);
      if (
        !scopeSummary ||
        !Array.isArray(requirements) ||
        requirements.length === 0 ||
        requirements.length > 40 ||
        requirements.some((item) => !stringValue(item, 2, 600)) ||
        !Number.isSafeInteger(amountMinor) ||
        Number(amountMinor) <= 0 ||
        Number(amountMinor) > 1_000_000_000 ||
        !currency ||
        !CURRENCY.test(currency) ||
        body.contact_captured !== true ||
        typeof body.research_consent !== "boolean"
      ) {
        throw new IntakeToolError(400, "incomplete_requirements");
      }
      if (!explicitFinalization(history)) {
        throw new IntakeToolError(409, "explicit_finalization_required");
      }
      if (historyContainsPiiReadback(history)) {
        throw new IntakeToolError(409, "pii_readback_detected");
      }
      acceptedFields = {
        scopeSummary,
        requirements,
        amountMinor,
        currency,
        contactCaptured: true,
        researchConsent: body.research_consent,
      };
    }

    return Response.json(
      {
        accepted: true,
        code: `${kind}_accepted`,
        receipt_digest: await receiptDigest(kind, common, acceptedFields),
        ...result,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const status = error instanceof IntakeToolError ? error.status : 403;
    const code =
      error instanceof IntakeToolError ? error.code : "capability_rejected";
    return Response.json(
      { accepted: false, code },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
