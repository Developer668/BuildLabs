import { NextResponse } from "next/server";
import { z } from "zod";

import {
  clearOperatorSessionCookie,
  createOperatorSession,
  operatorCookieFromHeader,
  operatorSessionCookie,
  verifyOperatorSession,
  verifyOperatorToken,
} from "../../../../lib/operator-auth";

const SignInSchema = z
  .object({
    token: z.string().min(1).max(4_096),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  const authenticated = verifyOperatorSession(
    operatorCookieFromHeader(request.headers.get("cookie")),
  );
  return NextResponse.json(
    { authenticated },
    {
      status: authenticated ? 200 : 401,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  let token: string;
  try {
    token = SignInSchema.parse(await request.json()).token;
  } catch {
    return rejection();
  }
  if (!verifyOperatorToken(token)) {
    await boundedFailureDelay();
    return rejection();
  }
  const session = createOperatorSession();
  return NextResponse.json(
    { authenticated: true, redirectTo: "/operator" },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": operatorSessionCookie(session.token, session.maxAge),
      },
    },
  );
}

export function DELETE(): Response {
  return NextResponse.json(
    { authenticated: false },
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": clearOperatorSessionCookie(),
      },
    },
  );
}

function rejection(): Response {
  return NextResponse.json(
    {
      error: "operator_unauthorized",
      message: "The operator session could not be established.",
    },
    {
      status: 401,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

async function boundedFailureDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}
