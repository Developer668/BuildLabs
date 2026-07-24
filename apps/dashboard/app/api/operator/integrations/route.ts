import { handleOperatorIntegrations } from "../../../../lib/operator-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOperatorIntegrations(request);
}
