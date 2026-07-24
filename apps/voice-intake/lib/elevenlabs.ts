export type TranscriptTurn = {
  role: "agent" | "user";
  message: string;
  timeInCallSecs?: number;
};

export type VoiceConversation = {
  id: string;
  contactName: string;
  businessName: string;
  projectGoal: string;
  status: "successful" | "failed";
  provider: "ElevenLabs";
  conversationId: string;
  transcript: TranscriptTurn[];
  summary: string;
  error: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type ElevenLabsConversationFence = {
  agentId: string;
  branchId: string;
  versionId: string;
  environment: "testing";
};

export type CompletedElevenLabsConversation = {
  conversationId: string;
  receivedAt: string;
  transcript: TranscriptTurn[];
  researchConsent: boolean;
};

const MAX_INTAKE_BYTES = 1_000_000;
const RECEIPT_DIGEST = /^[a-f0-9]{64}$/u;
const TOOL_REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@.]{1,190}\.[A-Za-z]{2,24}$/u;
const PHONE = /^\+?[0-9][0-9 ()-]{6,38}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const MANAGED_INTAKE_TOOLS = [
  "capture_contact",
  "record_research_consent",
  "finalize_requirements",
] as const;

type ManagedIntakeTool = (typeof MANAGED_INTAKE_TOOLS)[number];

type ManagedToolCall = {
  requestId: string;
  toolName: ManagedIntakeTool;
  turnIndex: number;
  callIndex: number;
  params: Record<string, unknown>;
};

type ManagedToolResult = {
  requestId: string;
  toolName: ManagedIntakeTool;
  turnIndex: number;
  result: Record<string, unknown>;
};

type ProviderCompleteIntakeEvidence = {
  contact: {
    name: string;
    email: string;
    phone: string;
  };
  researchConsent: boolean;
};

function envValue(name: string) {
  return process.env[name]?.trim() || "";
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function cleanProviderText(value: unknown, maximum: number) {
  return typeof value === "string"
    ? Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
      })
        .join("")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum)
    : "";
}

export function firstProviderText(maximum: number, ...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanProviderText(value, maximum);
    if (cleaned) return cleaned;
  }
  return "";
}

export function collectedProviderValue(
  data: Record<string, unknown>,
  ...keys: string[]
) {
  const results = record(record(data.analysis).data_collection_results);
  for (const key of keys) {
    const item = results[key];
    const cleaned = cleanProviderText(record(item).value ?? item, 1_200);
    if (cleaned) return cleaned;
  }
  return "";
}

export function cleanConversationId(value: unknown) {
  const conversationId = cleanProviderText(value, 160);
  return /^conv_[A-Za-z0-9_-]{8,160}$/.test(conversationId)
    ? conversationId
    : "";
}

export function cleanTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: TranscriptTurn[] = [];
  for (const turn of value.slice(0, 1_000)) {
    const row = record(turn);
    const role: TranscriptTurn["role"] | null =
      row.role === "agent" ? "agent" : row.role === "user" ? "user" : null;
    const message = cleanProviderText(row.message, 12_000);
    const seconds = Math.max(0, Math.round(Number(row.time_in_call_secs) || 0));
    if (role && message) {
      turns.push({ role, message, timeInCallSecs: seconds });
    }
  }
  return turns;
}

export function formatVoiceTranscript(turns: TranscriptTurn[]) {
  const encoder = new TextEncoder();
  const entries: string[] = [];
  let bytes = 0;
  for (const turn of turns) {
    const entry = `${turn.role === "user" ? "Customer" : "BuildLabs"}: ${turn.message}`;
    const entryBytes =
      encoder.encode(entry).byteLength + (entries.length ? 2 : 0);
    if (bytes + entryBytes > MAX_INTAKE_BYTES) break;
    entries.push(entry);
    bytes += entryBytes;
  }
  return entries.join("\n\n");
}

export function intakeEvaluationSucceeded(data: Record<string, unknown>) {
  const analysis = record(data.analysis);
  const keyed = Object.entries(record(analysis.evaluation_criteria_results));
  const listed = Array.isArray(analysis.evaluation_criteria_results_list)
    ? analysis.evaluation_criteria_results_list.map(
        (value) => ["", value] as const,
      )
    : [];

  return [...keyed, ...listed].some(([key, value]) => {
    const result = record(value);
    const criterion = cleanProviderText(result.criteria_id, 160) || key;
    return criterion === "intake_complete" && result.result === "success";
  });
}

export function intakeFinalizationSucceeded(data: Record<string, unknown>) {
  const fence = fenceFromConversation(data);
  const conversationId = cleanConversationId(data.conversation_id);
  return Boolean(
    fence &&
    conversationId &&
    providerCompleteIntakeEvidence(data, fence, conversationId),
  );
}

export function safeWebhookSummary(data: Record<string, unknown>) {
  return cleanProviderText(record(data.analysis).transcript_summary, 4_000);
}

export function conversationReceivedAt(data: Record<string, unknown>) {
  const startedAt = record(data.metadata).start_time_unix_secs;
  if (
    typeof startedAt !== "number" ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0
  ) {
    throw new Error("ElevenLabs returned an invalid conversation start time.");
  }
  const startedAtDate = new Date(startedAt * 1_000);
  if (!Number.isFinite(startedAtDate.getTime())) {
    throw new Error("ElevenLabs returned an invalid conversation start time.");
  }
  return startedAtDate.toISOString();
}

export function requireCompletedElevenLabsConversation(
  data: Record<string, unknown>,
  fence: ElevenLabsConversationFence,
  expectedConversationId?: string,
): CompletedElevenLabsConversation {
  const conversationId = cleanConversationId(data.conversation_id);
  const transcript = cleanTranscript(data.transcript);
  const evidence = conversationId
    ? providerCompleteIntakeEvidence(data, fence, conversationId)
    : null;
  if (
    data.status !== "done" ||
    data.agent_id !== fence.agentId ||
    data.branch_id !== fence.branchId ||
    data.version_id !== fence.versionId ||
    data.environment !== fence.environment ||
    !conversationId ||
    (expectedConversationId !== undefined &&
      conversationId !== expectedConversationId) ||
    transcript.length === 0 ||
    !intakeEvaluationSucceeded(data) ||
    !evidence ||
    transcriptReadsBackContact(transcript, evidence.contact)
  ) {
    throw new Error(
      "ElevenLabs conversation is incomplete or outside the configured test deployment.",
    );
  }

  return {
    conversationId,
    receivedAt: conversationReceivedAt(data),
    transcript,
    researchConsent: evidence.researchConsent,
  };
}

function conversationFailureReason(data: Record<string, unknown>) {
  const analysis = record(data.analysis);
  const metadata = record(data.metadata);
  const providerError = record(metadata.error);
  const listed = Array.isArray(analysis.evaluation_criteria_results_list)
    ? analysis.evaluation_criteria_results_list
    : [];
  const keyed = Object.values(record(analysis.evaluation_criteria_results));
  for (const value of [...listed, ...keyed]) {
    const result = record(value);
    if (result.result === "failure") {
      const rationale = cleanProviderText(result.rationale, 1_000);
      if (rationale) return rationale;
    }
  }
  return firstProviderText(
    1_000,
    data.failure_reason,
    providerError.reason,
    providerError.message,
    metadata.termination_reason,
  );
}

export function toVoiceConversation(
  data: Record<string, unknown>,
): VoiceConversation | null {
  const conversationId = cleanConversationId(data.conversation_id);
  if (!conversationId) return null;

  const transcript = cleanTranscript(data.transcript);
  const metadata = record(data.metadata);
  const durationSeconds = Math.max(
    0,
    Math.min(86_400, Math.round(Number(metadata.call_duration_secs) || 0)),
  );
  const createdAt = conversationReceivedAt(data);
  const updatedAt = new Date(
    Date.parse(createdAt) + durationSeconds * 1_000,
  ).toISOString();
  const successful = intakeEvaluationSucceeded(data);
  const providerFailed =
    data.status === "failed" ||
    record(data.analysis).call_successful === "failure";
  const providerIssue = conversationFailureReason(data);

  return {
    id: conversationId,
    contactName: collectedProviderValue(
      data,
      "contact_name",
      "caller_name",
      "name",
    ),
    businessName: collectedProviderValue(
      data,
      "business_name",
      "company_name",
      "organization_name",
    ),
    projectGoal: collectedProviderValue(
      data,
      "project_goal",
      "website_goal",
      "website_requirements",
      "website_brief",
    ),
    status: successful ? "successful" : "failed",
    provider: "ElevenLabs",
    conversationId,
    transcript,
    summary: safeWebhookSummary(data),
    error:
      successful && providerFailed
        ? `The intake completed, but the voice session reported a technical ending${providerIssue ? `: ${providerIssue}` : "."}`
        : successful
          ? ""
          : providerIssue || "The voice intake did not complete successfully.",
    durationSeconds,
    createdAt,
    updatedAt,
  };
}

export async function verifyElevenLabsWebhook(
  rawBody: string,
  signatureHeader: string,
) {
  const secret = envValue("ELEVENLABS_WEBHOOK_SECRET");
  if (!secret || !signatureHeader) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2) || "";
  const signature = parts.find((part) => part.startsWith("v0=")) || "";
  const timestampMillis = Number(timestamp) * 1_000;
  const now = Date.now();
  if (!timestamp || !signature || !Number.isFinite(timestampMillis))
    return false;
  if (
    timestampMillis < now - 30 * 60 * 1_000 ||
    timestampMillis > now + 5 * 60 * 1_000
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  const expected = `v0=${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  if (expected.length !== signature.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return difference === 0;
}

function providerToolRequestId(value: Record<string, unknown>) {
  const requestId =
    typeof value.request_id === "string" ? value.request_id : "";
  return TOOL_REQUEST_ID.test(requestId) ? requestId : "";
}

function managedToolName(value: unknown): ManagedIntakeTool | null {
  return typeof value === "string" &&
    MANAGED_INTAKE_TOOLS.includes(value as ManagedIntakeTool)
    ? (value as ManagedIntakeTool)
    : null;
}

function fenceFromConversation(
  data: Record<string, unknown>,
): ElevenLabsConversationFence | null {
  if (
    typeof data.agent_id !== "string" ||
    typeof data.branch_id !== "string" ||
    typeof data.version_id !== "string" ||
    data.environment !== "testing"
  ) {
    return null;
  }
  return {
    agentId: data.agent_id,
    branchId: data.branch_id,
    versionId: data.version_id,
    environment: data.environment,
  };
}

function parseJsonRecord(value: unknown, maximum: number) {
  if (typeof value !== "string" || value.length > maximum) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function boundedProviderString(
  value: unknown,
  minimum: number,
  maximum: number,
) {
  const normalized = cleanProviderText(value, maximum);
  return normalized.length >= minimum && normalized.length <= maximum
    ? normalized
    : "";
}

const COMMON_TOOL_PARAMETER_KEYS = [
  "project_id",
  "contract_version",
  "conversation_id",
  "agent_id",
  "agent_version",
] as const;

function commonToolResource(
  params: Record<string, unknown>,
  fence: ElevenLabsConversationFence,
  conversationId: string,
) {
  const projectId = boundedProviderString(params.project_id, 8, 200);
  const agentId = boundedProviderString(params.agent_id, 8, 200);
  const agentVersion = boundedProviderString(params.agent_version, 8, 200);
  if (
    !RESOURCE_ID.test(projectId) ||
    params.contract_version !== 0 ||
    params.conversation_id !== conversationId ||
    agentId !== fence.agentId ||
    agentVersion !== fence.versionId
  ) {
    return "";
  }
  return JSON.stringify([
    projectId,
    params.contract_version,
    conversationId,
    agentId,
    agentVersion,
  ]);
}

function parsedManagedCallsAndResults(data: Record<string, unknown>) {
  const callsByName = new Map<ManagedIntakeTool, ManagedToolCall>();
  const callsByRequest = new Map<string, ManagedToolCall>();
  const resultsByName = new Map<ManagedIntakeTool, ManagedToolResult>();
  const resultsByRequest = new Map<string, ManagedToolResult>();
  const turns = Array.isArray(data.transcript) ? data.transcript : [];

  for (const [turnIndex, value] of turns.entries()) {
    const turn = record(value);
    const toolCalls = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    for (const [callIndex, rawCall] of toolCalls.entries()) {
      const call = record(rawCall);
      const toolName = managedToolName(call.tool_name);
      if (!toolName) continue;
      const requestId = providerToolRequestId(call);
      const params = parseJsonRecord(call.params_as_json, 64_000);
      if (
        !requestId ||
        !params ||
        call.tool_has_been_called !== true ||
        callsByName.has(toolName) ||
        callsByRequest.has(requestId)
      ) {
        return null;
      }
      const parsedCall = {
        requestId,
        toolName,
        turnIndex,
        callIndex,
        params,
      };
      callsByName.set(toolName, parsedCall);
      callsByRequest.set(requestId, parsedCall);
    }

    const toolResults = Array.isArray(turn.tool_results)
      ? turn.tool_results
      : [];
    for (const rawResult of toolResults) {
      const result = record(rawResult);
      const toolName = managedToolName(result.tool_name);
      if (!toolName) continue;
      const requestId = providerToolRequestId(result);
      const parsedResult = parseJsonRecord(result.result_value, 2_000);
      if (
        !requestId ||
        !parsedResult ||
        result.tool_has_been_called !== true ||
        result.is_error !== false ||
        result.is_blocked === true ||
        resultsByName.has(toolName) ||
        resultsByRequest.has(requestId)
      ) {
        return null;
      }
      const managedResult = {
        requestId,
        toolName,
        turnIndex,
        result: parsedResult,
      };
      resultsByName.set(toolName, managedResult);
      resultsByRequest.set(requestId, managedResult);
    }
  }

  if (
    callsByName.size !== MANAGED_INTAKE_TOOLS.length ||
    resultsByName.size !== MANAGED_INTAKE_TOOLS.length
  ) {
    return null;
  }
  for (const [requestId, call] of callsByRequest) {
    const result = resultsByRequest.get(requestId);
    if (!result || result.toolName !== call.toolName) return null;
  }
  for (const requestId of resultsByRequest.keys()) {
    if (!callsByRequest.has(requestId)) return null;
  }
  return { callsByName, resultsByName };
}

function parseContactParams(params: Record<string, unknown>) {
  if (
    !exactKeys(params, [
      ...COMMON_TOOL_PARAMETER_KEYS,
      "name",
      "email",
      "phone",
    ])
  ) {
    return null;
  }
  const name = boundedProviderString(params.name, 1, 160);
  const email = boundedProviderString(params.email, 6, 320);
  const phone = boundedProviderString(params.phone, 7, 40);
  return name && EMAIL.test(email) && PHONE.test(phone)
    ? { name, email: email.toLowerCase(), phone }
    : null;
}

function parseResearchParams(params: Record<string, unknown>) {
  if (
    !exactKeys(
      params,
      [...COMMON_TOOL_PARAMETER_KEYS, "consent", "history"],
      ["caller_owned_url"],
    ) ||
    typeof params.consent !== "boolean" ||
    !boundedProviderString(params.history, 2, 16_000)
  ) {
    return null;
  }
  const callerOwnedUrl =
    params.caller_owned_url === undefined
      ? ""
      : boundedProviderString(params.caller_owned_url, 12, 2_048);
  if (params.consent && !callerOwnedUrl) return null;
  if (callerOwnedUrl) {
    try {
      const url = new URL(callerOwnedUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return { consent: params.consent };
}

function parseFinalizeParams(params: Record<string, unknown>) {
  if (
    !exactKeys(params, [
      ...COMMON_TOOL_PARAMETER_KEYS,
      "scope_summary",
      "hard_requirements",
      "amount_minor",
      "currency",
      "contact_captured",
      "research_consent",
      "history",
    ])
  ) {
    return null;
  }
  const scopeSummary = boundedProviderString(params.scope_summary, 10, 4_000);
  const currency = boundedProviderString(params.currency, 3, 3);
  const requirements = params.hard_requirements;
  if (
    !scopeSummary ||
    !Array.isArray(requirements) ||
    requirements.length === 0 ||
    requirements.length > 40 ||
    requirements.some(
      (requirement) => !boundedProviderString(requirement, 2, 600),
    ) ||
    !Number.isSafeInteger(params.amount_minor) ||
    Number(params.amount_minor) <= 0 ||
    Number(params.amount_minor) > 1_000_000_000 ||
    !CURRENCY.test(currency) ||
    params.contact_captured !== true ||
    typeof params.research_consent !== "boolean" ||
    !boundedProviderString(params.history, 2, 16_000)
  ) {
    return null;
  }
  return { researchConsent: params.research_consent };
}

function receiptDigest(value: Record<string, unknown>) {
  return typeof value.receipt_digest === "string" &&
    RECEIPT_DIGEST.test(value.receipt_digest)
    ? value.receipt_digest
    : "";
}

function strictAcceptedResult(
  result: Record<string, unknown>,
  toolName: ManagedIntakeTool,
) {
  const expected =
    toolName === "capture_contact"
      ? ["accepted", "code", "email_verification", "receipt_digest"]
      : toolName === "record_research_consent"
        ? ["accepted", "code", "consent", "receipt_digest"]
        : ["accepted", "code", "receipt_digest"];
  if (!exactKeys(result, expected) || result.accepted !== true) return "";
  if (
    toolName === "capture_contact" &&
    (result.code !== "contact_accepted" ||
      result.email_verification !== "unverified")
  ) {
    return "";
  }
  if (
    toolName === "record_research_consent" &&
    (result.code !== "research_consent_accepted" ||
      typeof result.consent !== "boolean")
  ) {
    return "";
  }
  if (
    toolName === "finalize_requirements" &&
    result.code !== "finalize_accepted"
  ) {
    return "";
  }
  return receiptDigest(result);
}

function providerCompleteIntakeEvidence(
  data: Record<string, unknown>,
  fence: ElevenLabsConversationFence,
  conversationId: string,
): ProviderCompleteIntakeEvidence | null {
  const parsed = parsedManagedCallsAndResults(data);
  if (!parsed) return null;
  const contactCall = parsed.callsByName.get("capture_contact");
  const researchCall = parsed.callsByName.get("record_research_consent");
  const finalizeCall = parsed.callsByName.get("finalize_requirements");
  if (!contactCall || !researchCall || !finalizeCall) return null;

  const callBeforeFinalize = (call: ManagedToolCall) =>
    call.turnIndex < finalizeCall.turnIndex ||
    (call.turnIndex === finalizeCall.turnIndex &&
      call.callIndex < finalizeCall.callIndex);
  if (!callBeforeFinalize(contactCall) || !callBeforeFinalize(researchCall))
    return null;

  const contactResult = parsed.resultsByName.get("capture_contact");
  const researchResult = parsed.resultsByName.get("record_research_consent");
  const finalizeResult = parsed.resultsByName.get("finalize_requirements");
  if (
    !contactResult ||
    !researchResult ||
    !finalizeResult ||
    contactResult.turnIndex < contactCall.turnIndex ||
    researchResult.turnIndex < researchCall.turnIndex ||
    finalizeResult.turnIndex < finalizeCall.turnIndex ||
    contactResult.turnIndex >= finalizeCall.turnIndex ||
    researchResult.turnIndex >= finalizeCall.turnIndex
  ) {
    return null;
  }

  const contact = parseContactParams(contactCall.params);
  const research = parseResearchParams(researchCall.params);
  const finalize = parseFinalizeParams(finalizeCall.params);
  if (!contact || !research || !finalize) return null;

  const commonResources = [contactCall, researchCall, finalizeCall].map(
    (call) => commonToolResource(call.params, fence, conversationId),
  );
  if (
    commonResources.some((resource) => !resource) ||
    new Set(commonResources).size !== 1 ||
    finalize.researchConsent !== research.consent
  ) {
    return null;
  }

  const digests = [
    strictAcceptedResult(contactResult.result, "capture_contact"),
    strictAcceptedResult(researchResult.result, "record_research_consent"),
    strictAcceptedResult(finalizeResult.result, "finalize_requirements"),
  ];
  if (
    digests.some((digest) => !digest) ||
    new Set(digests).size !== digests.length ||
    researchResult.result.consent !== research.consent
  ) {
    return null;
  }

  return { contact, researchConsent: research.consent };
}

function normalizedWords(value: string) {
  return ` ${value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

function normalizedEmailComparable(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bat\b/gu, "@")
    .replace(/\bdot\b/gu, ".")
    .replace(/[^a-z0-9]/gu, "");
}

function transcriptReadsBackContact(
  transcript: TranscriptTurn[],
  contact: ProviderCompleteIntakeEvidence["contact"],
) {
  const contactName = normalizedWords(contact.name);
  const email = normalizedEmailComparable(contact.email);
  const phone = contact.phone.replace(/\D/gu, "");
  return transcript.some((turn) => {
    if (turn.role !== "agent") return false;
    const agentWords = normalizedWords(turn.message);
    const agentEmail = normalizedEmailComparable(turn.message);
    const agentPhone = turn.message.replace(/\D/gu, "");
    return (
      (contactName.trim() && agentWords.includes(contactName)) ||
      (email && agentEmail.includes(email)) ||
      (phone.length >= 7 && agentPhone.includes(phone))
    );
  });
}
