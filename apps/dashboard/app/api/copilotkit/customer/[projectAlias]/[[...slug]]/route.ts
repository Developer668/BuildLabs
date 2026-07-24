import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

import { resolveCustomerAliasContext } from "../../../../../../lib/server/aliases";
import { bffErrorResponse } from "../../../../../../lib/server/http";

type RouteContext = {
  params: Promise<{ projectAlias: string; slug?: string[] }>;
};

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handle(request, context);
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handle(request, context);
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  return handle(request, context);
}

async function handle(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { projectAlias } = await context.params;
    resolveCustomerAliasContext(request, projectAlias);

    const basePath = `/api/copilotkit/customer/${encodeURIComponent(projectAlias)}`;
    const runtime = new CopilotRuntime({
      agents: ({ request: runtimeRequest }) => {
        resolveCustomerAliasContext(runtimeRequest, projectAlias);
        return {};
      },
      a2ui: { enabled: false },
      openGenerativeUI: false,
    });
    const handler = createCopilotRuntimeHandler({
      runtime,
      basePath,
      activateChannels: false,
      hooks: {
        onRequest: ({ request: runtimeRequest }) => {
          resolveCustomerAliasContext(runtimeRequest, projectAlias);
        },
      },
    });
    return handler(request);
  } catch (error) {
    return bffErrorResponse(error);
  }
}
