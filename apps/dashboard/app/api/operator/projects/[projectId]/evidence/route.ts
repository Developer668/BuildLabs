import { handleOperatorProjectEvidence } from "../../../../../../lib/operator-server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const { projectId } = await context.params;
  return handleOperatorProjectEvidence(request, projectId);
}
