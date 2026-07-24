import { handleCustomerSteering } from "../../../../../../lib/server/customer-steering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectAlias: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectAlias } = await context.params;
  return handleCustomerSteering({ request, projectAlias });
}
