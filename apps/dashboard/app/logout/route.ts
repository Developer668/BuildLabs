import { handleCustomerLogout } from "../../lib/server/logout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Response {
  return handleCustomerLogout(request);
}
