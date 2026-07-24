import { dashboardAliasSecret, resolveCustomerAliasContext } from "./aliases";
import { requireCustomerCsrf } from "./cookies";
import {
  DashboardBffError,
  asRecord,
  bffErrorResponse,
  customerJson,
  readBoundedJson,
  requiredHeader,
  safeInteger,
  safeString,
} from "./http";
import {
  type DashboardFetch,
  postCustomerSteering,
  translateUpstreamFailure,
} from "./orchestration-client";

const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIFECYCLE_STATUSES = new Set([
  "intake_received",
  "needs_clarification",
  "researching",
  "proposal_drafting",
  "awaiting_customer_revision",
  "awaiting_payment",
  "payment_verification_failed",
  "paid",
  "building",
  "verifying",
  "no_proven_candidate",
  "preview_ready",
  "revision_pending",
  "deploying",
  "deployment_verification_failed",
  "delivering",
  "completed",
  "cancelled",
  "failed",
  "needs_operator_attention",
]);

export async function handleCustomerSteering(input: {
  request: Request;
  projectAlias: string;
  fetcher?: DashboardFetch;
}): Promise<Response> {
  if (input.request.method !== "POST") {
    return customerJson(
      {
        error: "method_not_allowed",
        message: "POST is required",
      },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  try {
    const aliases = resolveCustomerAliasContext(
      input.request,
      input.projectAlias,
      dashboardAliasSecret(),
    );
    const csrf = requireCustomerCsrf(input.request);
    const idempotencyKey = requiredHeader(input.request, "idempotency-key");
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new DashboardBffError(
        400,
        "invalid_idempotency_key",
        "A stable idempotency key is required",
      );
    }
    const body = parseSteeringBody(
      await readBoundedJson(input.request, 24 * 1024),
    );
    const upstream = await postCustomerSteering({
      request: input.request,
      internalProjectId: aliases.internalProjectId,
      body,
      csrf,
      idempotencyKey,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    });
    if (upstream.status !== 202) {
      throw translateUpstreamFailure(upstream.status, upstream.value);
    }
    const root = asRecord(upstream.value);
    const project = asRecord(root?.project);
    const revision = safeInteger(project?.revision);
    const status = safeString(project?.status, 64);
    if (
      root?.received !== true ||
      project?.projectId !== aliases.internalProjectId ||
      revision === undefined ||
      status === undefined ||
      !LIFECYCLE_STATUSES.has(status)
    ) {
      throw new DashboardBffError(
        502,
        "invalid_customer_projection",
        "The project service returned an invalid steering receipt",
      );
    }
    return customerJson(
      {
        received: true,
        projectId: aliases.projectAlias,
        aggregateRevision: revision,
        status,
      },
      { status: 202 },
    );
  } catch (error) {
    return bffErrorResponse(error);
  }
}

function parseSteeringBody(value: unknown): {
  expectedRevision: number;
  expectedProposalVersion: number;
  subject: string;
  content: string;
} {
  const record = asRecord(value);
  if (
    record === undefined ||
    Object.keys(record).length !== 4 ||
    ![
      "expectedRevision",
      "expectedProposalVersion",
      "subject",
      "content",
    ].every((key) => Object.hasOwn(record, key))
  ) {
    throw invalidSteering();
  }
  const expectedRevision = safeInteger(record.expectedRevision);
  const expectedProposalVersion = safeInteger(
    record.expectedProposalVersion,
    1,
  );
  const subject = safeString(record.subject, 998);
  const content =
    typeof record.content === "string" &&
    record.content.length >= 1 &&
    record.content.length <= 20_000 &&
    !containsUnsafeControl(record.content)
      ? record.content
      : undefined;
  if (
    expectedRevision === undefined ||
    expectedProposalVersion === undefined ||
    subject === undefined ||
    content === undefined
  ) {
    throw invalidSteering();
  }
  return {
    expectedRevision,
    expectedProposalVersion,
    subject,
    content,
  };
}

function containsUnsafeControl(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/.test(
    value,
  );
}

function invalidSteering(): DashboardBffError {
  return new DashboardBffError(
    400,
    "invalid_steering_request",
    "The steering request is invalid",
  );
}
