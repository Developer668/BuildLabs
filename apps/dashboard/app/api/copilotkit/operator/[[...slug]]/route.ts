import { HttpAgent } from "@ag-ui/client";
import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";

import {
  operatorCookieFromHeader,
  verifyOperatorSession,
} from "../../../../../lib/operator-auth";
import { operatorUpstreamUrl } from "../../../../../lib/operator-server/client";

const basePath = "/api/copilotkit/operator";

const runtime = new CopilotRuntime({
  agents: ({ request }) => {
    requireOperator(request);
    const internalToken = process.env.BUILDLABS_INTERNAL_TOKEN;
    const usableToken =
      internalToken &&
      Buffer.byteLength(internalToken, "utf8") >= 32 &&
      Buffer.byteLength(internalToken, "utf8") <= 4_096 &&
      !/[\u0000-\u001F\u007F]/.test(internalToken)
        ? internalToken
        : undefined;
    if (!usableToken) {
      return {};
    }

    const endpoint = operatorUpstreamUrl(
      "build",
      "/v1/integrations/copilotkit/agent",
    ).toString();
    return {
      "studio-observer": new HttpAgent({
        agentId: "studio-observer",
        description:
          "Read-only durable BuildLabs candidate observation for the operator studio.",
        url: endpoint,
        headers: { Authorization: `Bearer ${usableToken}` },
      }),
    };
  },
  a2ui: { enabled: false },
  openGenerativeUI: false,
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath,
  activateChannels: false,
  hooks: {
    onRequest: ({ request }) => {
      requireOperator(request);
    },
  },
});

export const GET = handler;
export const POST = handler;
export const DELETE = handler;

function requireOperator(request: Request): void {
  const session = operatorCookieFromHeader(request.headers.get("cookie"));
  if (!verifyOperatorSession(session)) {
    throw new Response(
      JSON.stringify({
        error: "operator_unauthorized",
        message: "A valid operator session is required.",
      }),
      {
        status: 401,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/json",
        },
      },
    );
  }
}
