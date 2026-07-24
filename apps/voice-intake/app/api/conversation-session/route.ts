import {
  assertBrowserOrigin,
  browserSessionCorsHeaders,
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
    const corsHeaders = browserSessionCorsHeaders(request);
    return Response.json(await createBrowserConversationSession(request), {
      headers: { ...PRIVATE_HEADERS, ...corsHeaders },
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

export function OPTIONS(request: Request) {
  try {
    return new Response(null, {
      status: 204,
      headers: { ...PRIVATE_HEADERS, ...browserSessionCorsHeaders(request) },
    });
  } catch (error) {
    const failure =
      error instanceof BrowserSessionError
        ? error
        : new BrowserSessionError(403, "origin_not_allowed");
    return Response.json(
      { error: failure.code },
      { status: failure.status, headers: PRIVATE_HEADERS },
    );
  }
}
