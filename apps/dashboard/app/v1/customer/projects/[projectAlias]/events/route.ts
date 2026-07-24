import { handleCustomerEventStream } from "../../../../../../lib/server/customer-stream";

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
  return handleCustomerEventStream({ request, projectAlias });
}
