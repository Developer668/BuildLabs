import { handleCustomerWipMetadata } from "../../../../../../../../lib/server/wip-raster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    projectAlias: string;
    builderAlias: string;
  }>;
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const params = await context.params;
  return handleCustomerWipMetadata({ request, ...params });
}
