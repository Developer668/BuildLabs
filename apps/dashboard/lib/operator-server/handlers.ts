import type { OperatorFetch } from "./client";
import { fetchOperatorUpstream } from "./client";
import {
  operatorErrorResponse,
  operatorJson,
  optionalUuidQuery,
  parseBoundedInteger,
  requireAllowedQuery,
  requireOperatorRequest,
  requireUuid,
} from "./http";

export async function handleOperatorRuns(
  request: Request,
  fetcher?: OperatorFetch,
): Promise<Response> {
  try {
    requireOperatorRequest(request);
    const searchParams = new URL(request.url).searchParams;
    requireAllowedQuery(searchParams, ["limit", "projectId"]);
    const limit = parseBoundedInteger(searchParams, "limit", {
      defaultValue: 24,
      minimum: 1,
      maximum: 100,
    });
    const projectId = optionalUuidQuery(
      searchParams,
      "projectId",
      "project ID",
    );
    const upstreamQuery = new URLSearchParams({ limit: String(limit) });
    if (projectId) {
      upstreamQuery.set("projectId", projectId);
    }
    const value = await fetchOperatorUpstream({
      request,
      upstream: "build",
      path: `/v1/studio/runs?${upstreamQuery.toString()}`,
      ...(fetcher ? { fetcher } : {}),
    });
    return operatorJson(value);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}

export async function handleOperatorProjectEvidence(
  request: Request,
  projectIdInput: string,
  fetcher?: OperatorFetch,
): Promise<Response> {
  try {
    requireOperatorRequest(request);
    const projectId = requireUuid(projectIdInput, "project ID");
    const searchParams = new URL(request.url).searchParams;
    requireAllowedQuery(searchParams, ["afterSequence", "limit"]);
    const afterSequence = parseBoundedInteger(searchParams, "afterSequence", {
      defaultValue: 0,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const limit = parseBoundedInteger(searchParams, "limit", {
      defaultValue: 100,
      minimum: 1,
      maximum: 500,
    });
    const upstreamQuery = new URLSearchParams({
      afterSequence: String(afterSequence),
      limit: String(limit),
    });
    const value = await fetchOperatorUpstream({
      request,
      upstream: "orchestration",
      path:
        `/v1/orchestration/projects/${encodeURIComponent(projectId)}/evidence` +
        `?${upstreamQuery.toString()}`,
      resourceStatuses: [404],
      ...(fetcher ? { fetcher } : {}),
    });
    return operatorJson(value);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}

export async function handleOperatorIntegrations(
  request: Request,
  fetcher?: OperatorFetch,
): Promise<Response> {
  try {
    requireOperatorRequest(request);
    requireAllowedQuery(new URL(request.url).searchParams, []);
    const value = await fetchOperatorUpstream({
      request,
      upstream: "build",
      path: "/v1/integrations",
      ...(fetcher ? { fetcher } : {}),
    });
    return operatorJson(value);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}

export async function handleOperatorPreview(
  request: Request,
  runIdInput: string,
  fetcher?: OperatorFetch,
): Promise<Response> {
  try {
    requireOperatorRequest(request);
    const runId = requireUuid(runIdInput, "run ID");
    requireAllowedQuery(new URL(request.url).searchParams, []);
    const value = await fetchOperatorUpstream({
      request,
      upstream: "build",
      path: `/v1/build-runs/${encodeURIComponent(runId)}/preview`,
      resourceStatuses: [404, 409],
      ...(fetcher ? { fetcher } : {}),
    });
    return operatorJson(value);
  } catch (error) {
    return operatorErrorResponse(error);
  }
}
