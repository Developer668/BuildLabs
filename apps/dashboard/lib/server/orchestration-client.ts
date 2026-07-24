import { customerUpstreamCookieHeader } from "./cookies";
import { DashboardBffError, asRecord, safeInteger } from "./http";

const MAX_UPSTREAM_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_ORCHESTRATION_URL = "http://127.0.0.1:3100";

export type DashboardFetch = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>;

export interface UpstreamEventWindow {
  items: unknown[];
  nextAfterSequence: number;
  hasMore: boolean;
}

export interface UpstreamAccessExchange {
  response: Response;
  value: unknown;
}

export function orchestrationBaseUrl(): URL {
  const configured =
    process.env.BUILDLABS_ORCHESTRATION_URL?.trim() ||
    DEFAULT_ORCHESTRATION_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw unconfigured();
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "localhost";
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw unconfigured();
  }
  return url;
}

export function orchestrationUrl(
  path: string,
  base = orchestrationBaseUrl(),
): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new DashboardBffError(
      500,
      "invalid_upstream_path",
      "The dashboard request could not be routed",
    );
  }
  return new URL(path, base);
}

export async function fetchCustomerSnapshot(input: {
  request: Request;
  internalProjectId: string;
  fetcher?: DashboardFetch;
}): Promise<unknown> {
  return fetchUpstreamJson({
    path: `/v1/orchestration/customer-dashboard/projects/${encodeURIComponent(input.internalProjectId)}`,
    request: input.request,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function fetchCustomerEventWindow(input: {
  request: Request;
  internalProjectId: string;
  afterSequence: number;
  limit?: number;
  fetcher?: DashboardFetch;
}): Promise<UpstreamEventWindow> {
  const limit = input.limit ?? 250;
  const value = await fetchUpstreamJson({
    path:
      `/v1/orchestration/customer-dashboard/projects/${encodeURIComponent(input.internalProjectId)}` +
      `/events?afterSequence=${input.afterSequence}&limit=${limit}`,
    request: input.request,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
  const record = asRecord(value);
  const items = Array.isArray(record?.items) ? record.items : undefined;
  const nextAfterSequence = safeInteger(record?.nextAfterSequence);
  if (
    items === undefined ||
    items.length > limit ||
    nextAfterSequence === undefined ||
    typeof record?.hasMore !== "boolean"
  ) {
    throw invalidProjection();
  }
  return {
    items,
    nextAfterSequence,
    hasMore: record.hasMore,
  };
}

export async function postCustomerSteering(input: {
  request: Request;
  internalProjectId: string;
  body: unknown;
  csrf: string;
  idempotencyKey: string;
  fetcher?: DashboardFetch;
}): Promise<{ status: number; value: unknown }> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    orchestrationUrl(
      `/v1/orchestration/customer-dashboard/projects/${encodeURIComponent(input.internalProjectId)}/steering`,
    ),
    {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: input.request.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: customerUpstreamCookieHeader(input.request),
        "idempotency-key": input.idempotencyKey,
        "x-buildlabs-csrf": input.csrf,
      },
      body: JSON.stringify(input.body),
    },
  );
  const value = await readUpstreamJson(response);
  return { status: response.status, value };
}

export async function exchangeCustomerAccess(input: {
  request: Request;
  token: string;
  fetcher?: DashboardFetch;
}): Promise<UpstreamAccessExchange> {
  return postAccessJson({
    request: input.request,
    path: "/v1/orchestration/customer-dashboard/access",
    body: { token: input.token },
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function requestCustomerAccessReissue(input: {
  request: Request;
  token: string;
  fetcher?: DashboardFetch;
}): Promise<void> {
  await postAccessJson({
    request: input.request,
    path: "/v1/orchestration/customer-dashboard/access/requests",
    body: { token: input.token },
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
}

export async function fetchUpstreamJson(input: {
  path: string;
  request: Request;
  fetcher?: DashboardFetch;
}): Promise<unknown> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(orchestrationUrl(input.path), {
    method: "GET",
    redirect: "manual",
    cache: "no-store",
    signal: input.request.signal,
    headers: {
      accept: "application/json",
      cookie: customerUpstreamCookieHeader(input.request),
    },
  });
  const value = await readUpstreamJson(response);
  if (!response.ok) {
    throw translateUpstreamFailure(response.status, value);
  }
  return value;
}

export async function readUpstreamJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw invalidProjection();
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_UPSTREAM_JSON_BYTES) {
    throw invalidProjection();
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw invalidProjection();
  }
}

async function postAccessJson(input: {
  request: Request;
  path: string;
  body: unknown;
  fetcher?: DashboardFetch;
}): Promise<UpstreamAccessExchange> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(orchestrationUrl(input.path), {
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    signal: input.request.signal,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  const value = await readUpstreamJson(response);
  if (!response.ok) {
    throw translateUpstreamFailure(response.status, value);
  }
  return { response, value };
}

export function translateUpstreamFailure(
  status: number,
  value: unknown,
): DashboardBffError {
  const upstream = asRecord(value);
  const upstreamCode =
    typeof upstream?.error === "string" ? upstream.error : undefined;
  if (status === 401 || status === 403) {
    return new DashboardBffError(
      401,
      "customer_session_invalid",
      "A valid customer session is required",
    );
  }
  if (status === 409) {
    return new DashboardBffError(
      409,
      upstreamCode === "orchestration_conflict"
        ? "project_changed"
        : "request_conflict",
      "The project changed before the request could be applied",
    );
  }
  if (status === 429) {
    return new DashboardBffError(
      429,
      "dashboard_rate_limited",
      "Too many dashboard requests are active",
    );
  }
  if (status >= 400 && status < 500) {
    return new DashboardBffError(
      status,
      "dashboard_request_rejected",
      "The dashboard request could not be accepted",
    );
  }
  return new DashboardBffError(
    503,
    "orchestration_unavailable",
    "Project state is temporarily unavailable",
  );
}

function invalidProjection(): DashboardBffError {
  return new DashboardBffError(
    502,
    "invalid_customer_projection",
    "The project service returned an invalid customer projection",
  );
}

function unconfigured(): DashboardBffError {
  return new DashboardBffError(
    503,
    "orchestration_unconfigured",
    "The project service is unavailable",
  );
}
