import {
  createTelephonyConversationInitialization,
  TelephonyInitializationError,
} from "../../../../../lib/telephony-session";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

export async function POST(request: Request) {
  try {
    return Response.json(
      await createTelephonyConversationInitialization(request),
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    const failure =
      error instanceof TelephonyInitializationError
        ? error
        : new TelephonyInitializationError(503, "telephony_unavailable");
    return Response.json(
      { error: failure.code },
      { status: failure.status, headers: PRIVATE_HEADERS },
    );
  }
}
