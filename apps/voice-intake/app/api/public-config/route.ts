export const dynamic = "force-dynamic";

export async function GET() {
  const accessCodeConfigured = Boolean(
    process.env.CALL_LAB_ACCESS_CODE?.trim(),
  );
  const browserConfigured = Boolean(
    process.env.ELEVENLABS_API_KEY?.trim() &&
    process.env.ELEVENLABS_AGENT_ID?.trim() &&
    process.env.ELEVENLABS_BRANCH_ID?.trim() &&
    process.env.ELEVENLABS_AGENT_VERSION_ID?.trim() &&
    (process.env.ELEVENLABS_CAPABILITY_SECRET?.trim().length ?? 0) >= 32 &&
    (process.env.ELEVENLABS_TOOL_SECRET?.trim().length ?? 0) >= 32 &&
    (process.env.ELEVENLABS_CUSTOM_LLM_SECRET?.trim().length ?? 0) >= 32 &&
    (process.env.VOICE_SESSION_SECRET?.trim().length ?? 0) >= 32 &&
    (process.env.FIREWORKS_API_KEY?.trim().length ?? 0) >= 20 &&
    process.env.FIREWORKS_VOICE_MODEL?.trim() &&
    (process.env.NODE_ENV !== "production" ||
      process.env.VOICE_INTAKE_ALLOWED_ORIGINS?.trim()),
  );
  return Response.json(
    {
      agentConfigured: Boolean(
        process.env.ELEVENLABS_API_KEY?.trim() &&
        process.env.ELEVENLABS_AGENT_ID?.trim(),
      ),
      browserConfigured,
      accessConfigured:
        process.env.NODE_ENV !== "production" || accessCodeConfigured,
      accessRequired:
        process.env.NODE_ENV === "production" || accessCodeConfigured,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
