import { handleCustomerAccess } from "../../../../lib/server/access-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleCustomerAccess(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCustomerAccess(request);
}
