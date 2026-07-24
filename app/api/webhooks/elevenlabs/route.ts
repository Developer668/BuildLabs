import { upsertInboundCall } from "../../../../db/calls";
import {
  cleanProviderText,
  cleanTranscript,
  intakeEvaluationSucceeded,
  safeWebhookSummary,
  verifyElevenLabsWebhook,
} from "../../../../lib/elevenlabs";

export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function firstText(maximum: number, ...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanProviderText(value, maximum);
    if (cleaned) return cleaned;
  }
  return "";
}

function collectedValue(data: Record<string, unknown>, ...keys: string[]) {
  const results = record(record(data.analysis).data_collection_results);
  for (const key of keys) {
    const item = results[key];
    const value = record(item).value ?? item;
    const cleaned = cleanProviderText(value, 1200);
    if (cleaned) return cleaned;
  }
  return "";
}

function webhookDetails(data: Record<string, unknown>) {
  const metadata = record(data.metadata);
  const phoneCall = record(metadata.phone_call);
  const clientData = record(data.conversation_initiation_client_data);
  const dynamicVariables = record(clientData.dynamic_variables);
  const providerBody = record(metadata.body);
  const providerError = record(metadata.error);
  const sipCallId = firstText(
    160,
    dynamicVariables.system__call_sid,
    dynamicVariables.call_sid,
    phoneCall.call_sid,
    providerBody.call_sid,
    data.call_sid,
  );
  const rawConversationId = firstText(160, data.conversation_id);
  const conversationId = /^conv_[A-Za-z0-9_-]{8,160}$/.test(rawConversationId)
    ? rawConversationId
    : sipCallId
      ? `failure_${sipCallId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 140)}`
      : "";
  const startedAt = Number(metadata.start_time_unix_secs);

  return {
    conversationId,
    sipCallId,
    callerNumber: firstText(
      40,
      dynamicVariables.system__caller_id,
      dynamicVariables.caller_id,
      phoneCall.external_number,
      providerBody.from_number,
      data.caller_id,
    ),
    contactName: collectedValue(data, "contact_name", "caller_name", "name"),
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
    durationSeconds: Math.max(
      0,
      Math.round(Number(metadata.call_duration_secs) || 0),
    ),
    createdAt:
      Number.isFinite(startedAt) && startedAt > 0
        ? new Date(startedAt * 1000).toISOString()
        : undefined,
    providerError: firstText(
      1000,
      data.failure_reason,
      providerError.reason,
      providerError.message,
      metadata.termination_reason,
      providerBody.error_reason,
    ),
  };
}

function evaluationFailureReason(data: Record<string, unknown>) {
  const analysis = record(data.analysis);
  const listed = Array.isArray(analysis.evaluation_criteria_results_list)
    ? analysis.evaluation_criteria_results_list
    : [];
  const keyed = Object.values(record(analysis.evaluation_criteria_results));
  for (const result of [...listed, ...keyed]) {
    const item = record(result);
    if (item.result === "failure") {
      const rationale = cleanProviderText(item.rationale, 1000);
      if (rationale) return rationale;
    }
  }
  return "";
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 1_000_000) {
    return new Response("Payload too large", { status: 413 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("elevenlabs-signature") || "";
  if (!(await verifyElevenLabsWebhook(rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const data = record(event.data);
  const configuredAgent = process.env.ELEVENLABS_AGENT_ID?.trim() || "";
  if (
    configuredAgent &&
    cleanProviderText(data.agent_id, 160) !== configuredAgent
  ) {
    return new Response("Unknown agent", { status: 403 });
  }

  if (
    event.type !== "post_call_transcription" &&
    event.type !== "call_initiation_failure"
  ) {
    return Response.json({ received: true, ignored: true });
  }

  const details = webhookDetails(data);
  if (!details.conversationId) {
    return new Response("Missing conversation", { status: 400 });
  }

  const analysis = record(data.analysis);
  const providerFailed =
    event.type === "call_initiation_failure" ||
    data.status === "failed" ||
    analysis.call_successful === "failure";
  const successful = intakeEvaluationSucceeded(data);
  await upsertInboundCall({
    ...details,
    status: successful ? "successful" : "failed",
    transcript: cleanTranscript(data.transcript),
    summary: safeWebhookSummary(data),
    error:
      successful && providerFailed
        ? `The website intake completed successfully, but the phone connection reported a technical ending${details.providerError ? `: ${details.providerError}` : "."}`
        : details.providerError ||
          evaluationFailureReason(data) ||
          "The phone call did not complete successfully.",
  });

  return Response.json({ received: true });
}
