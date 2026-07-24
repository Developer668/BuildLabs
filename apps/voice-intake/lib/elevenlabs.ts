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

const MAX_INTAKE_BYTES = 1_000_000;

function envValue(name: string) {
  return process.env[name]?.trim() || "";
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
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
  if (analysis.call_successful === "success") return true;

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

export function safeWebhookSummary(data: Record<string, unknown>) {
  return cleanProviderText(record(data.analysis).transcript_summary, 4_000);
}

export function conversationReceivedAt(data: Record<string, unknown>) {
  const startedAt = Number(record(data.metadata).start_time_unix_secs);
  const startedAtDate = new Date(startedAt * 1_000);
  return Number.isFinite(startedAt) &&
    startedAt > 0 &&
    Number.isFinite(startedAtDate.getTime())
    ? startedAtDate.toISOString()
    : new Date().toISOString();
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
