import { OperatorBffError } from "./http";

const MAX_UPSTREAM_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUILD_BACKEND_URL = "http://127.0.0.1:3000";
const DEFAULT_ORCHESTRATION_URL = "http://127.0.0.1:3100";
const UPSTREAM_TIMEOUT_MS = 15_000;

export type OperatorFetch = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export type OperatorUpstream = "build" | "orchestration";

export async function fetchOperatorUpstream(input: {
  request: Request;
  upstream: OperatorUpstream;
  path: string;
  fetcher?: OperatorFetch;
  resourceStatuses?: readonly number[];
}): Promise<unknown> {
  const token = internalToken();
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(operatorUpstreamUrl(input.upstream, input.path), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.any([
        input.request.signal,
        AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ]),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    if (error instanceof OperatorBffError) {
      throw error;
    }
    throw unavailable();
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (input.resourceStatuses?.includes(response.status)) {
      throw resourceFailure(response.status);
    }
    throw unavailable();
  }

  const value = await readBoundedUpstreamJson(response);
  if (JSON.stringify(value).includes(token)) {
    throw invalidUpstream();
  }
  return value;
}

export function operatorUpstreamUrl(
  upstream: OperatorUpstream,
  path: string,
): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw invalidConfiguration();
  }
  const environmentName =
    upstream === "build"
      ? "BUILDLABS_BUILD_BACKEND_URL"
      : "BUILDLABS_ORCHESTRATION_URL";
  const fallback =
    upstream === "build"
      ? DEFAULT_BUILD_BACKEND_URL
      : DEFAULT_ORCHESTRATION_URL;
  const configured = process.env[environmentName]?.trim() || fallback;
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    throw invalidConfiguration();
  }
  const isLoopback =
    base.hostname === "127.0.0.1" ||
    base.hostname === "localhost" ||
    base.hostname === "[::1]" ||
    base.hostname === "::1";
  if (
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== "" ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback))
  ) {
    throw invalidConfiguration();
  }
  return new URL(path, base);
}

export async function readBoundedUpstreamJson(
  response: Response,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw invalidUpstream();
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_UPSTREAM_JSON_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidUpstream();
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw invalidUpstream();
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_UPSTREAM_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw invalidUpstream();
    }
    chunks.push(chunk.value);
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ) as unknown;
  } catch {
    throw invalidUpstream();
  }
}

function internalToken(): string {
  const token = process.env.BUILDLABS_INTERNAL_TOKEN;
  if (
    !token ||
    Buffer.byteLength(token, "utf8") < 32 ||
    Buffer.byteLength(token, "utf8") > 4_096 ||
    /[\u0000-\u001F\u007F]/.test(token)
  ) {
    throw invalidConfiguration();
  }
  return token;
}

function invalidConfiguration(): OperatorBffError {
  return new OperatorBffError(
    503,
    "operator_backend_unavailable",
    "The operator data service is not configured.",
  );
}

function unavailable(): OperatorBffError {
  return new OperatorBffError(
    503,
    "operator_upstream_unavailable",
    "The operator data service is temporarily unavailable.",
  );
}

function invalidUpstream(): OperatorBffError {
  return new OperatorBffError(
    502,
    "operator_upstream_invalid",
    "The operator data service returned an invalid response.",
  );
}

function resourceFailure(status: number): OperatorBffError {
  if (status === 404) {
    return new OperatorBffError(
      404,
      "operator_resource_not_found",
      "The requested operator resource was not found.",
    );
  }
  return new OperatorBffError(
    409,
    "operator_resource_unavailable",
    "The requested operator resource is not available in its current state.",
  );
}
