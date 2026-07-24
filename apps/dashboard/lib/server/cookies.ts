import { timingSafeEqual } from "node:crypto";

import { DashboardBffError } from "./http";

export const DASHBOARD_SESSION_COOKIE = "buildlabs_dashboard_session";
export const DASHBOARD_CSRF_COOKIE = "buildlabs_dashboard_csrf";
export const DASHBOARD_ALIAS_COOKIE = "buildlabs_dashboard_aliases";

const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_.-]{1,8192}$/;

export interface RewrittenDashboardCookies {
  cookies: string[];
  sessionToken: string;
  maxAgeSeconds: number;
}

export function parseCookieHeader(header: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (header === null) {
    return result;
  }
  if (Buffer.byteLength(header, "utf8") > 16 * 1024) {
    throw new DashboardBffError(
      401,
      "customer_session_invalid",
      "A valid customer session is required",
    );
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (result.has(name)) {
      throw new DashboardBffError(
        401,
        "customer_session_invalid",
        "A valid customer session is required",
      );
    }
    result.set(name, value);
  }
  return result;
}

export function customerUpstreamCookieHeader(request: Request): string {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const session = cookies.get(DASHBOARD_SESSION_COOKIE);
  if (session === undefined || !COOKIE_VALUE_PATTERN.test(session)) {
    throw new DashboardBffError(
      401,
      "customer_session_required",
      "A valid customer session is required",
    );
  }
  const csrf = cookies.get(DASHBOARD_CSRF_COOKIE);
  const parts = [`${DASHBOARD_SESSION_COOKIE}=${session}`];
  if (csrf !== undefined && COOKIE_VALUE_PATTERN.test(csrf)) {
    parts.push(`${DASHBOARD_CSRF_COOKIE}=${csrf}`);
  }
  return parts.join("; ");
}

export function customerSessionToken(request: Request): string {
  const session = parseCookieHeader(request.headers.get("cookie")).get(
    DASHBOARD_SESSION_COOKIE,
  );
  if (session === undefined || !COOKIE_VALUE_PATTERN.test(session)) {
    throw new DashboardBffError(
      401,
      "customer_session_required",
      "A valid customer session is required",
    );
  }
  return session;
}

export function aliasCookieValue(request: Request): string {
  const value = parseCookieHeader(request.headers.get("cookie")).get(
    DASHBOARD_ALIAS_COOKIE,
  );
  if (value === undefined || !COOKIE_VALUE_PATTERN.test(value)) {
    throw new DashboardBffError(
      401,
      "customer_session_required",
      "A valid customer session is required",
    );
  }
  return value;
}

export function getSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === "function") {
    return extended.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined === null ? [] : splitCombinedSetCookie(combined);
}

export function rewriteDashboardCookies(
  setCookies: readonly string[],
): RewrittenDashboardCookies {
  const parsed = new Map<
    string,
    { value: string; attributes: Map<string, string | true> }
  >();
  for (const setCookie of setCookies) {
    const parts = setCookie.split(";").map((part) => part.trim());
    const first = parts.shift();
    if (first === undefined) {
      continue;
    }
    const separator = first.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = first.slice(0, separator);
    if (name !== DASHBOARD_SESSION_COOKIE && name !== DASHBOARD_CSRF_COOKIE) {
      continue;
    }
    const value = first.slice(separator + 1);
    if (!COOKIE_VALUE_PATTERN.test(value) || parsed.has(name)) {
      throw new DashboardBffError(
        502,
        "invalid_upstream_session",
        "The authentication service returned an invalid session",
      );
    }
    const attributes = new Map<string, string | true>();
    for (const attribute of parts) {
      const attributeSeparator = attribute.indexOf("=");
      if (attributeSeparator === -1) {
        attributes.set(attribute.toLowerCase(), true);
      } else {
        attributes.set(
          attribute.slice(0, attributeSeparator).toLowerCase(),
          attribute.slice(attributeSeparator + 1),
        );
      }
    }
    if (attributes.has("domain")) {
      throw new DashboardBffError(
        502,
        "invalid_upstream_session",
        "The authentication service returned an invalid session",
      );
    }
    parsed.set(name, { value, attributes });
  }

  const session = parsed.get(DASHBOARD_SESSION_COOKIE);
  const csrf = parsed.get(DASHBOARD_CSRF_COOKIE);
  if (session === undefined || csrf === undefined) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_session",
      "The authentication service did not return a complete session",
    );
  }
  const maxAge = parseMaxAge(session.attributes.get("max-age"));
  const csrfMaxAge = parseMaxAge(csrf.attributes.get("max-age"));
  if (maxAge !== csrfMaxAge) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_session",
      "The authentication service returned mismatched session cookies",
    );
  }
  return {
    sessionToken: session.value,
    maxAgeSeconds: maxAge,
    cookies: [
      serializeCookie(DASHBOARD_SESSION_COOKIE, session.value, maxAge, true),
      serializeCookie(DASHBOARD_CSRF_COOKIE, csrf.value, maxAge, false),
    ],
  };
}

export function serializeAliasCookie(
  value: string,
  maxAgeSeconds: number,
): string {
  if (
    !COOKIE_VALUE_PATTERN.test(value) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0
  ) {
    throw new DashboardBffError(
      500,
      "alias_cookie_invalid",
      "The customer alias session could not be created",
    );
  }
  return serializeCookie(DASHBOARD_ALIAS_COOKIE, value, maxAgeSeconds, true);
}

export function requireCustomerCsrf(request: Request): string {
  const header = request.headers.get("x-buildlabs-csrf");
  const cookie = parseCookieHeader(request.headers.get("cookie")).get(
    DASHBOARD_CSRF_COOKIE,
  );
  if (
    header === null ||
    cookie === undefined ||
    !COOKIE_VALUE_PATTERN.test(header) ||
    !COOKIE_VALUE_PATTERN.test(cookie) ||
    !constantTimeTextEqual(header, cookie)
  ) {
    throw new DashboardBffError(
      403,
      "customer_csrf_rejected",
      "The customer dashboard request could not be verified",
    );
  }
  return header;
}

export function clearDashboardCookies(): string[] {
  return [
    serializeCookie(DASHBOARD_SESSION_COOKIE, "", 0, true),
    serializeCookie(DASHBOARD_CSRF_COOKIE, "", 0, false),
    serializeCookie(DASHBOARD_ALIAS_COOKIE, "", 0, true),
  ];
}

function serializeCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  httpOnly: boolean,
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(maxAgeSeconds === 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(httpOnly ? ["HttpOnly"] : []),
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function parseMaxAge(value: string | true | undefined): number {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    Number(value) > 30 * 24 * 60 * 60
  ) {
    throw new DashboardBffError(
      502,
      "invalid_upstream_session",
      "The authentication service returned an invalid session lifetime",
    );
  }
  return Number(value);
}

function splitCombinedSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map((item) => item.trim());
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
