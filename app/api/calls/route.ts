import { listCalls } from "../../../db/calls";
import { callLabAuthorized, unauthorizedResponse } from "../../../lib/call-access";
import { syncCompletedElevenLabsCalls } from "../../../lib/elevenlabs-sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!callLabAuthorized(request)) return unauthorizedResponse();
  let warning = "";
  let processing = 0;
  try {
    const sync = await syncCompletedElevenLabsCalls();
    processing = sync.processing;
  } catch (error) {
    warning =
      error instanceof Error
        ? `Saved calls loaded, but sync failed: ${error.message}`
        : "Saved calls loaded, but ElevenLabs sync failed.";
  }

  try {
    return Response.json(
      { calls: await listCalls(), warning, processing },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "The call archive is unavailable." }, { status: 503 });
  }
}
