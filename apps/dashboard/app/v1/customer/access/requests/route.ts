import { handleCustomerAccessReissue } from "../../../../../lib/server/access-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleCustomerAccessReissue(request);
}
