import { handleCustomerSnapshot } from "../../../../../lib/server/customer-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ projectAlias: string }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { projectAlias } = await context.params;
  return handleCustomerSnapshot({ request, projectAlias });
}
