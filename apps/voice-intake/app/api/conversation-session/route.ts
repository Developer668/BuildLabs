import {
  BrowserSessionError,
  createBrowserConversationSession,
} from "../../../lib/browser-session";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  vary: "origin",
} as const;

export async function POST(request: Request) {
  try {
    return Response.json(await createBrowserConversationSession(request), {
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    const failure =
      error instanceof BrowserSessionError
        ? error
        : new BrowserSessionError(503, "provider_unavailable");
    return Response.json(
      { error: failure.code },
      { status: failure.status, headers: PRIVATE_HEADERS },
    );
  }
}
