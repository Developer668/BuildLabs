import {
  callLabAuthorized,
  unauthorizedResponse,
} from "../../../lib/call-access";
import { listCompletedElevenLabsConversations } from "../../../lib/elevenlabs-sync";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!callLabAuthorized(request)) return unauthorizedResponse();
  try {
    const result = await listCompletedElevenLabsConversations();
    return Response.json(result, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The ElevenLabs conversation archive is unavailable.";
    return Response.json(
      { error: message },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
}
