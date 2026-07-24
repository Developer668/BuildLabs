import { z } from "zod";

import {
  operatorCookieFromHeader,
  verifyOperatorSession,
} from "../operator-auth";

const UuidSchema = z.uuid();

export class OperatorBffError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OperatorBffError";
    this.status = status;
    this.code = code;
  }
}

export function requireOperatorRequest(request: Request): void {
  const session = operatorCookieFromHeader(request.headers.get("cookie"));
  if (!verifyOperatorSession(session)) {
    throw new OperatorBffError(
      401,
      "operator_unauthorized",
      "A valid operator session is required.",
    );
  }
}

export function requireUuid(value: string, label: string): string {
  if (!UuidSchema.safeParse(value).success) {
    throw new OperatorBffError(
      400,
      "invalid_operator_request",
      `A valid ${label} is required.`,
    );
  }
  return value;
}

export function optionalUuidQuery(
  searchParams: URLSearchParams,
  name: string,
  label: string,
): string | undefined {
  const values = searchParams.getAll(name);
  if (values.length === 0) {
    return undefined;
  }
  if (values.length !== 1 || values[0] === undefined) {
    throw invalidQuery();
  }
  return requireUuid(values[0], label);
}

export function parseBoundedInteger(
  searchParams: URLSearchParams,
  name: string,
  bounds: {
    defaultValue: number;
    minimum: number;
    maximum: number;
  },
): number {
  const values = searchParams.getAll(name);
  if (values.length === 0) {
    return bounds.defaultValue;
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !/^(0|[1-9]\d*)$/.test(value)
  ) {
    throw invalidQuery();
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < bounds.minimum ||
    parsed > bounds.maximum
  ) {
    throw invalidQuery();
  }
  return parsed;
}

export function requireAllowedQuery(
  searchParams: URLSearchParams,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw invalidQuery();
    }
  }
}

export function operatorJson(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function operatorErrorResponse(error: unknown): Response {
  if (error instanceof OperatorBffError) {
    return operatorJson(
      {
        error: error.code,
        message: error.message,
      },
      { status: error.status },
    );
  }
  return operatorJson(
    {
      error: "operator_backend_unavailable",
      message: "The operator data service is temporarily unavailable.",
    },
    { status: 503 },
  );
}

function invalidQuery(): OperatorBffError {
  return new OperatorBffError(
    400,
    "invalid_operator_request",
    "The operator request parameters are invalid.",
  );
}
