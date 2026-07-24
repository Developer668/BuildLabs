import type { TranscriptTurn } from "../db/calls";

function envValue(name: string) {
  return process.env[name]?.trim() || "";
}

export function cleanProviderText(value: unknown, maximum: number) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum)
    : "";
}

export function cleanTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: TranscriptTurn[] = [];
  for (const turn of value.slice(0, 1000)) {
    const row =
      turn && typeof turn === "object" ? (turn as Record<string, unknown>) : {};
    const role: TranscriptTurn["role"] | null =
      row.role === "agent" ? "agent" : row.role === "user" ? "user" : null;
    const message = cleanProviderText(row.message, 12000);
    const seconds = Math.max(0, Math.round(Number(row.time_in_call_secs) || 0));
    if (role && message) turns.push({ role, message, timeInCallSecs: seconds });
  }
  return turns;
}

export function intakeEvaluationSucceeded(data: Record<string, unknown>) {
  const analysis =
    data.analysis && typeof data.analysis === "object"
      ? (data.analysis as Record<string, unknown>)
      : {};
  if (analysis.call_successful === "success") return true;

  const keyed = Object.entries(
    analysis.evaluation_criteria_results &&
      typeof analysis.evaluation_criteria_results === "object"
      ? (analysis.evaluation_criteria_results as Record<string, unknown>)
      : {},
  );
  const listed = Array.isArray(analysis.evaluation_criteria_results_list)
    ? analysis.evaluation_criteria_results_list.map((value) => ["", value] as const)
    : [];

  return [...keyed, ...listed].some(([key, value]) => {
    const result =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const criterion = cleanProviderText(result.criteria_id, 160) || key;
    return criterion === "intake_complete" && result.result === "success";
  });
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
  const timestampMillis = Number(timestamp) * 1000;
  const now = Date.now();
  if (!timestamp || !signature || !Number.isFinite(timestampMillis)) return false;
  if (
    timestampMillis < now - 30 * 60 * 1000 ||
    timestampMillis > now + 5 * 60 * 1000
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

export function safeWebhookSummary(data: Record<string, unknown>) {
  const analysis =
    data.analysis && typeof data.analysis === "object"
      ? (data.analysis as Record<string, unknown>)
      : {};
  return cleanProviderText(analysis.transcript_summary, 4000);
}
