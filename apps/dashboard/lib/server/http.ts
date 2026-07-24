const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;

export class DashboardBffError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DashboardBffError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function customerJson(
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

export function bffErrorResponse(error: unknown): Response {
  if (error instanceof DashboardBffError) {
    return customerJson(
      {
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
      { status: error.status },
    );
  }
  return customerJson(
    {
      error: "dashboard_unavailable",
      message: "The customer dashboard is temporarily unavailable",
    },
    { status: 503 },
  );
}

export async function readBoundedJson(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new DashboardBffError(
      415,
      "unsupported_media_type",
      "The request must use application/json",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
  ) {
    throw new DashboardBffError(
      413,
      "request_too_large",
      "The request body is too large",
    );
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new DashboardBffError(
      413,
      "request_too_large",
      "The request body is too large",
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DashboardBffError(
      400,
      "invalid_json",
      "The request body must be valid JSON",
    );
  }
}

export function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (
    value === null ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_HEADER_BYTES ||
    hasControlCharacters(value)
  ) {
    throw new DashboardBffError(
      400,
      "invalid_header",
      `A valid ${name} header is required`,
    );
  }
  return value;
}

export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function safeInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

export function safeString(
  value: unknown,
  maximumLength = 1_000,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !hasControlCharacters(value)
    ? value
    : undefined;
}

export function safeTimestamp(value: unknown): string | undefined {
  const candidate = safeString(value, 64);
  if (candidate === undefined || !Number.isFinite(Date.parse(candidate))) {
    return undefined;
  }
  return candidate;
}
