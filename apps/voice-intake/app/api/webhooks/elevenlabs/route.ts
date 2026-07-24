import {
  cleanProviderText,
  cleanTranscript,
  conversationReceivedAt,
  intakeEvaluationSucceeded,
  record,
  verifyElevenLabsWebhook,
} from "../../../../lib/elevenlabs";
import { forwardVoiceIntake } from "../../../../lib/orchestration";

export const dynamic = "force-dynamic";

async function readBoundedBody(request: Request, maximumBytes: number) {
  if (!request.body) return "";
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
        return null;
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
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 1_000_000) {
    return new Response("Payload too large", { status: 413 });
  }

  let rawBody: string | null;
  try {
    rawBody = await readBoundedBody(request, 1_000_000);
  } catch {
    return new Response("Invalid body", { status: 400 });
  }
  if (rawBody === null) {
    return new Response("Payload too large", { status: 413 });
  }
  const signature = request.headers.get("elevenlabs-signature") || "";
  if (!(await verifyElevenLabsWebhook(rawBody, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Response("Invalid JSON", { status: 400 });
    }
    event = parsed as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "post_call_transcription") {
    return Response.json({ received: true, ignored: true });
  }

  const data = record(event.data);
  const configuredAgent = process.env.ELEVENLABS_AGENT_ID?.trim() || "";
  if (
    !configuredAgent ||
    cleanProviderText(data.agent_id, 160) !== configuredAgent
  ) {
    return new Response("Unknown agent", { status: 403 });
  }
  if (!intakeEvaluationSucceeded(data)) {
    return Response.json({ received: true, ignored: true });
  }

  try {
    await forwardVoiceIntake({
      conversationId: cleanProviderText(data.conversation_id, 160),
      receivedAt: conversationReceivedAt(data),
      transcript: cleanTranscript(data.transcript),
    });
  } catch {
    return Response.json(
      { error: "The completed voice intake could not be accepted." },
      { status: 503 },
    );
  }

  return Response.json({ received: true, accepted: true }, { status: 202 });
}
