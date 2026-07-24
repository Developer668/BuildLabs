import { handleCustomLlmRequest } from "../../../../../../lib/custom-llm";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleCustomLlmRequest(request);
}
