import { listCalls } from "../../../db/calls";
import { callLabAuthorized, unauthorizedResponse } from "../../../lib/call-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!callLabAuthorized(request)) return unauthorizedResponse();
  try {
    return Response.json(
      { calls: await listCalls() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "The call archive is unavailable." }, { status: 503 });
  }
}
