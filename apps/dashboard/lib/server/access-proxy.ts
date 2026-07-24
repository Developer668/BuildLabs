import { randomBytes } from "node:crypto";

import {
  createCustomerAliasContext,
  dashboardAliasSecret,
  sealCustomerAliasContext,
} from "./aliases";
import {
  getSetCookieHeaders,
  rewriteDashboardCookies,
  serializeAliasCookie,
} from "./cookies";
import {
  DashboardBffError,
  asRecord,
  bffErrorResponse,
  customerJson,
  readBoundedJson,
  safeString,
} from "./http";
import {
  type DashboardFetch,
  exchangeCustomerAccess,
  requestCustomerAccessReissue,
} from "./orchestration-client";

const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,1536}$/;
const INTERNAL_REDIRECT_PATTERN =
  /^\/dashboard\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export async function handleCustomerAccess(
  request: Request,
  fetcher?: DashboardFetch,
): Promise<Response> {
  if (request.method === "GET") {
    return accessExchangePage(request);
  }
  if (request.method !== "POST") {
    return methodNotAllowed(["GET", "POST"]);
  }
  try {
    rejectQuery(request);
    const token = parseAccessToken(await readBoundedJson(request, 4 * 1024));
    const exchanged = await exchangeCustomerAccess({
      request,
      token,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
    const rewritten = rewriteDashboardCookies(
      getSetCookieHeaders(exchanged.response.headers),
    );
    const internalProjectId = parseInternalRedirect(exchanged.value);
    const secret = dashboardAliasSecret();
    const aliases = createCustomerAliasContext({
      internalProjectId,
      sessionToken: rewritten.sessionToken,
      expiresAt: Math.floor(Date.now() / 1_000) + rewritten.maxAgeSeconds,
      secret,
    });
    const sealedAliases = sealCustomerAliasContext(aliases, secret);
    const headers = new Headers();
    for (const cookie of rewritten.cookies) {
      headers.append("set-cookie", cookie);
    }
    headers.append(
      "set-cookie",
      serializeAliasCookie(sealedAliases, rewritten.maxAgeSeconds),
    );
    return customerJson(
      {
        redirectTo: `/dashboard/projects/${encodeURIComponent(aliases.projectAlias)}`,
      },
      { status: 200, headers },
    );
  } catch (error) {
    return accessFailure(error);
  }
}

export async function handleCustomerAccessReissue(
  request: Request,
  fetcher?: DashboardFetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  try {
    rejectQuery(request);
    const token = parseAccessToken(await readBoundedJson(request, 4 * 1024));
    await requestCustomerAccessReissue({
      request,
      token,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch {
    // Capability reissue is intentionally non-enumerating.
  }
  return customerJson({ status: "accepted" }, { status: 202 });
}

function accessExchangePage(request: Request): Response {
  try {
    rejectQuery(request);
  } catch {
    return accessNotFound();
  }
  const nonce = randomBytes(18).toString("base64url");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BuildLabs project access</title>
</head>
<body>
  <main>
    <h1>Opening your BuildLabs project</h1>
    <p id="status" role="status">Verifying your private sign-in link.</p>
  </main>
  <script nonce="${nonce}">
  (() => {
    const status = document.getElementById("status");
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get("token");
    history.replaceState(null, "", location.pathname);
    if (!token) {
      status.textContent = "This sign-in link is unavailable.";
      return;
    }
    fetch(location.pathname, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || typeof body.redirectTo !== "string") throw new Error();
      location.replace(body.redirectTo);
    }).catch(() => {
      return fetch(location.pathname + "/requests", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token })
      }).catch(() => undefined).finally(() => {
        status.textContent = "This sign-in link is unavailable.";
      });
    });
  })();
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseAccessToken(value: unknown): string {
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).length !== 1 ||
    !ACCESS_TOKEN_PATTERN.test(safeString(record.token, 1_536) ?? "")
  ) {
    throw invalidAccess();
  }
  return record.token as string;
}

function parseInternalRedirect(value: unknown): string {
  const redirectTo = safeString(asRecord(value)?.redirectTo, 128);
  const match =
    redirectTo === undefined
      ? null
      : INTERNAL_REDIRECT_PATTERN.exec(redirectTo);
  if (match?.[1] === undefined) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_session",
      "The authentication service returned an invalid project",
    );
  }
  return match[1];
}

function rejectQuery(request: Request): void {
  if (new URL(request.url).search !== "") {
    throw invalidAccess();
  }
}

function accessFailure(error: unknown): Response {
  if (
    error instanceof DashboardBffError &&
    (error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 413 ||
      error.status === 415)
  ) {
    return accessNotFound();
  }
  return bffErrorResponse(error);
}

function accessNotFound(): Response {
  return customerJson(
    {
      error: "customer_access_unavailable",
      message: "This sign-in link is unavailable",
    },
    { status: 404 },
  );
}

function invalidAccess(): DashboardBffError {
  return new DashboardBffError(
    404,
    "customer_access_unavailable",
    "This sign-in link is unavailable",
  );
}

function methodNotAllowed(allow: string[]): Response {
  return customerJson(
    {
      error: "method_not_allowed",
      message: "This request method is not available",
    },
    { status: 405, headers: { allow: allow.join(", ") } },
  );
}
