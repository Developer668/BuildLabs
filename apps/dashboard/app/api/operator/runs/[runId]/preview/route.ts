import { handleOperatorPreview } from "../../../../../../lib/operator-server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await context.params;
  return handleOperatorPreview(request, runId);
}
