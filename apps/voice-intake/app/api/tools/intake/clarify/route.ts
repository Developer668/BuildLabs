import { handleIntakeTool } from "../../../../../lib/intake-tools";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleIntakeTool(request, "clarify");
}
