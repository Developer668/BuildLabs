import { listCalls, upsertInboundCall } from "../db/calls";
import {
  cleanProviderText,
  cleanTranscript,
  intakeEvaluationSucceeded,
  safeWebhookSummary,
} from "./elevenlabs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function firstText(maximum: number, ...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanProviderText(value, maximum);
    if (cleaned) return cleaned;
  }
  return "";
}

function collectedValue(data: JsonRecord, ...keys: string[]) {
  const results = record(record(data.analysis).data_collection_results);
  for (const key of keys) {
    const item = results[key];
    const value = record(item).value ?? item;
    const cleaned = cleanProviderText(value, 1200);
    if (cleaned) return cleaned;
  }
  return "";
}

function failureReason(data: JsonRecord) {
  const analysis = record(data.analysis);
  const listed = Array.isArray(analysis.evaluation_criteria_results_list)
    ? analysis.evaluation_criteria_results_list
    : [];
  const keyed = Object.values(record(analysis.evaluation_criteria_results));
  for (const value of [...listed, ...keyed]) {
    const result = record(value);
    if (result.result === "failure") {
      const rationale = cleanProviderText(result.rationale, 1000);
      if (rationale) return rationale;
    }
  }
  return "The call ended before the website intake was fully verified.";
}

async function elevenLabs(path: string) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured.");

  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status}.`);
  }
  return (await response.json()) as JsonRecord;
}

export async function syncCompletedElevenLabsCalls() {
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is not configured.");

  const known = new Map(
    (await listCalls(100))
      .filter((call) => call.conversationId)
      .map((call) => [call.conversationId, call]),
  );
  const query = new URLSearchParams({
    agent_id: agentId,
    page_size: "30",
  });
  const page = await elevenLabs(`/v1/convai/conversations?${query}`);
  const conversations = Array.isArray(page.conversations)
    ? page.conversations
    : [];

  let saved = 0;
  let processing = 0;
  for (const value of conversations) {
    const summary = record(value);
    const conversationId = firstText(160, summary.conversation_id);
    const status = firstText(40, summary.status);
    if (conversationId && !["done", "failed"].includes(status)) {
      processing += 1;
      continue;
    }
    const existing = known.get(conversationId);
    const needsLegacyRecheck =
      existing?.status === "failed" &&
      existing.error ===
        "The call ended before the website intake was fully verified.";
    if (
      !conversationId ||
      (existing && !needsLegacyRecheck) ||
      !["done", "failed"].includes(status)
    ) {
      continue;
    }

    try {
      const data = await elevenLabs(
        `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      );
      if (firstText(160, data.agent_id) !== agentId) continue;

      const analysis = record(data.analysis);
      const metadata = record(data.metadata);
      const phoneCall = record(metadata.phone_call);
      const clientData = record(data.conversation_initiation_client_data);
      const dynamicVariables = record(clientData.dynamic_variables);
      const startedAt = Number(metadata.start_time_unix_secs);
      const successful = intakeEvaluationSucceeded(data);
      const providerFailed =
        data.status === "failed" || analysis.call_successful === "failure";
      const providerIssue = firstText(
        1000,
        metadata.termination_reason,
        record(metadata.error).message,
        record(metadata.error).reason,
      );

      await upsertInboundCall({
        conversationId,
        callerNumber: firstText(
          40,
          dynamicVariables.system__caller_id,
          dynamicVariables.caller_id,
          phoneCall.external_number,
        ),
        contactName: collectedValue(
          data,
          "contact_name",
          "caller_name",
          "name",
        ),
        businessName: collectedValue(
          data,
          "business_name",
          "company_name",
          "organization_name",
        ),
        websiteGoal: collectedValue(
          data,
          "website_goal",
          "website_requirements",
          "project_goal",
          "website_brief",
        ),
        status: successful ? "successful" : "failed",
        transcript: cleanTranscript(data.transcript),
        summary: safeWebhookSummary(data),
        error:
          successful && providerFailed
            ? `The website intake completed successfully, but the phone connection reported a technical ending${providerIssue ? `: ${providerIssue}` : "."}`
            : successful
              ? ""
              : failureReason(data),
        durationSeconds: Math.max(
          0,
          Math.round(Number(metadata.call_duration_secs) || 0),
        ),
        sipCallId: firstText(
          160,
          dynamicVariables.system__call_sid,
          dynamicVariables.call_sid,
          phoneCall.call_sid,
        ),
        createdAt:
          Number.isFinite(startedAt) && startedAt > 0
            ? new Date(startedAt * 1000).toISOString()
            : undefined,
      });
      saved += 1;
    } catch {
      // One malformed or unavailable conversation should not hide the archive.
    }
  }

  return { saved, processing };
}
