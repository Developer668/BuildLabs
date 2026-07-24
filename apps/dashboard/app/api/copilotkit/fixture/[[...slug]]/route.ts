import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

import { dashboardFixturesEnabled } from "../../../../../lib/fixture-mode";

const basePath = "/api/copilotkit/fixture";

const runtime = new CopilotRuntime({
  agents: {},
  a2ui: { enabled: false },
  openGenerativeUI: false,
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath,
  activateChannels: false,
});

export async function GET(request: Request): Promise<Response> {
  return fixtureOnly(request);
}

export async function POST(request: Request): Promise<Response> {
  return fixtureOnly(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return fixtureOnly(request);
}

function fixtureOnly(request: Request): Promise<Response> | Response {
  if (!dashboardFixturesEnabled()) {
    return Response.json(
      { error: "not_found" },
      {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  return handler(request);
}
