import {
  cleanConversationId,
  cleanProviderText,
  record,
  requireCompletedElevenLabsConversation,
  toVoiceConversation,
  type CompletedElevenLabsConversation,
  type ElevenLabsConversationFence,
  type VoiceConversation,
} from "./elevenlabs";

type ConversationList = {
  calls: VoiceConversation[];
  processing: number;
};

function configuration() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || "";
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim() || "";
  const branchId = process.env.ELEVENLABS_BRANCH_ID?.trim() || "";
  const versionId = process.env.ELEVENLABS_AGENT_VERSION_ID?.trim() || "";
  if (!apiKey || !agentId || !branchId || !versionId) {
    throw new Error("ElevenLabs voice archive access is not configured.");
  }
  return {
    apiKey,
    agentId,
    branchId,
    versionId,
    environment: "testing" as const,
  };
}

async function elevenLabs(path: string, apiKey: string) {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    headers: { "xi-api-key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status}.`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function authoritativeConversation(
  conversationId: string,
  configured: ReturnType<typeof configuration>,
) {
  const data = await elevenLabs(
    `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
    configured.apiKey,
  );
  const fence: ElevenLabsConversationFence = configured;
  const completed = requireCompletedElevenLabsConversation(
    data,
    fence,
    conversationId,
  );
  return { completed, data };
}

export async function getCompletedElevenLabsConversation(
  unsafeConversationId: string,
): Promise<CompletedElevenLabsConversation> {
  const conversationId = cleanConversationId(unsafeConversationId);
  if (!conversationId) {
    throw new Error("The ElevenLabs conversation ID is invalid.");
  }
  const configured = configuration();
  return (await authoritativeConversation(conversationId, configured))
    .completed;
}

export async function listCompletedElevenLabsConversations(): Promise<ConversationList> {
  const configured = configuration();
  const query = new URLSearchParams({
    agent_id: configured.agentId,
    page_size: "100",
  });
  const list = await elevenLabs(
    `/v1/convai/conversations?${query.toString()}`,
    configured.apiKey,
  );
  const summaries = Array.isArray(list.conversations) ? list.conversations : [];
  const completedIds: string[] = [];
  let processing = 0;

  for (const value of summaries) {
    const summary = record(value);
    const conversationId = cleanConversationId(summary.conversation_id);
    const status = cleanProviderText(summary.status, 40);
    if (!conversationId) continue;
    if (status === "done") {
      completedIds.push(conversationId);
    } else if (status !== "failed") {
      processing += 1;
    }
  }

  const calls: VoiceConversation[] = [];
  for (let index = 0; index < completedIds.length; index += 6) {
    const batch = completedIds.slice(index, index + 6);
    const results = await Promise.all(
      batch.map(async (conversationId) => {
        try {
          const { data } = await authoritativeConversation(
            conversationId,
            configured,
          );
          return toVoiceConversation(data);
        } catch {
          return null;
        }
      }),
    );
    for (const result of results) {
      if (result) calls.push(result);
    }
  }

  calls.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { calls: calls.slice(0, 100), processing };
}
