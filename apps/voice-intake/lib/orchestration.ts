import {
  cleanConversationId,
  formatVoiceTranscript,
  type TranscriptTurn,
} from "./elevenlabs";

export type VoiceIntakeRequest = {
  channel: "voice";
  intakeId: string;
  sourceId: string;
  receivedAt: string;
  content: string;
  emailVerified: false;
  researchConsent: boolean;
  provider: "elevenlabs";
};

function orchestrationIntakeEndpoint() {
  const configured =
    process.env.BUILDLABS_ORCHESTRATION_URL?.trim() || "http://127.0.0.1:3100";
  let baseUrl: URL;
  try {
    baseUrl = new URL(configured);
  } catch {
    throw new Error("The BuildLabs orchestration URL is invalid.");
  }
  const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(
    baseUrl.hostname,
  );
  if (
    (baseUrl.protocol !== "https:" &&
      !(baseUrl.protocol === "http:" && loopback)) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "The BuildLabs orchestration URL must use HTTPS, except for HTTP loopback.",
    );
  }
  return new URL("/v1/orchestration/intakes", baseUrl);
}

export function buildVoiceIntakeRequest(input: {
  conversationId: string;
  receivedAt: string;
  transcript: TranscriptTurn[];
  researchConsent: boolean;
}): VoiceIntakeRequest {
  const conversationId = cleanConversationId(input.conversationId);
  if (!conversationId) {
    throw new Error("The ElevenLabs conversation ID is invalid.");
  }
  if (!Number.isFinite(Date.parse(input.receivedAt))) {
    throw new Error("The ElevenLabs conversation timestamp is invalid.");
  }
  const content = formatVoiceTranscript(input.transcript);
  if (!content) {
    throw new Error("The ElevenLabs conversation has no usable transcript.");
  }
  return {
    channel: "voice",
    intakeId: `elevenlabs:${conversationId}`,
    sourceId: conversationId,
    receivedAt: input.receivedAt,
    content,
    emailVerified: false,
    researchConsent: input.researchConsent,
    provider: "elevenlabs",
  };
}

export async function forwardVoiceIntake(input: {
  conversationId: string;
  receivedAt: string;
  transcript: TranscriptTurn[];
  researchConsent: boolean;
}) {
  const token = process.env.ORCHESTRATION_INTERNAL_TOKEN?.trim() || "";
  if (!token) {
    throw new Error("The orchestration intake bridge is not configured.");
  }
  const endpoint = orchestrationIntakeEndpoint();
  const body = buildVoiceIntakeRequest(input);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": body.intakeId,
    },
    body: JSON.stringify(body),
    cache: "no-store",
    // The orchestrator records the intake and answers without waiting for a
    // model turn, so this only has to cover a write and the network.
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`The BuildLabs orchestrator returned ${response.status}.`);
  }
}
