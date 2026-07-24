import { handleInternalWipFrameIngest } from "../../../../../lib/server/wip-raster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleInternalWipFrameIngest(request);
}
