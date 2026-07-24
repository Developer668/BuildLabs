export const dynamic = "force-dynamic";

export async function GET() {
  const accessCodeConfigured = Boolean(
    process.env.CALL_LAB_ACCESS_CODE?.trim(),
  );
  return Response.json(
    {
      agentConfigured: Boolean(
        process.env.ELEVENLABS_API_KEY?.trim() &&
        process.env.ELEVENLABS_AGENT_ID?.trim(),
      ),
      accessConfigured:
        process.env.NODE_ENV !== "production" || accessCodeConfigured,
      accessRequired:
        process.env.NODE_ENV === "production" || accessCodeConfigured,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
