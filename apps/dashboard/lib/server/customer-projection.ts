import { type CustomerAliasContext, opaqueAlias } from "./aliases";
import {
  DashboardBffError,
  asRecord,
  safeInteger,
  safeString,
  safeTimestamp,
} from "./http";
import type { CustomerBuilderFence } from "./projection-registry";

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

const SAFE_HTTPS_URL = /^https:\/\/[^\s<>{}\\^`|"]{1,2000}$/;

export interface ProjectedCustomerSnapshot {
  snapshot: Record<string, unknown>;
  fences: CustomerBuilderFence[];
}

export function projectCustomerSnapshot(input: {
  upstream: unknown;
  aliases: CustomerAliasContext;
  eventCursor: number;
  secret: string;
}): ProjectedCustomerSnapshot {
  const root = asRecord(input.upstream);
  const internalProjectId = safeString(root?.projectId, 64);
  const revision = safeInteger(root?.revision);
  const status = safeString(root?.status, 64);
  const createdAt = safeTimestamp(root?.createdAt);
  const updatedAt = safeTimestamp(root?.updatedAt);
  if (
    root?.version !== 1 ||
    internalProjectId !== input.aliases.internalProjectId ||
    revision === undefined ||
    status === undefined ||
    !LIFECYCLE_STATUSES.has(status) ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    throw invalidProjection();
  }

  const plan = projectPlan(root.plan);
  const payment = asRecord(root.payment);
  const paymentVerified = payment?.state === "verified";
  const paymentVerifiedAt = paymentVerified
    ? safeTimestamp(payment?.verifiedAt)
    : null;
  if (paymentVerified && paymentVerifiedAt === undefined) {
    throw invalidProjection();
  }
  const activeBuild = projectActiveBuild({
    value: root.activeBuild,
    aliases: input.aliases,
    secret: input.secret,
    fallbackUpdatedAt: updatedAt,
  });
  const deliverables = projectDeliverables(root.deliverables);
  const requestedVersion = plan?.version ?? null;
  const paidVersion = paymentVerified
    ? (activeBuild.batch?.contractVersion ?? requestedVersion)
    : null;

  const snapshot: Record<string, unknown> = {
    schemaVersion: 1,
    projectId: input.aliases.projectAlias,
    aggregateRevision: revision,
    eventCursor: input.eventCursor,
    title: plan?.title ?? "BuildLabs project",
    lifecycle: {
      canonical: status,
      label: lifecycleLabel(status),
      changedAt: updatedAt,
    },
    requestedVersion,
    paidCommercialVersion: paidVersion,
    currentProvenVersion: deliverables.preview?.contractVersion ?? null,
    currentProductionVersion: deliverables.production?.contractVersion ?? null,
    milestoneStates: buildMilestones({
      status,
      paymentVerified,
      paymentVerifiedAt: paymentVerifiedAt ?? null,
      hasBuild: activeBuild.batch !== null,
      hasPreview: deliverables.preview !== null,
      hasProduction: deliverables.production !== null,
      createdAt,
      updatedAt,
    }),
    activeBatch: activeBuild.batch,
    contract: plan,
    proof: activeBuild.proof,
    preview: deliverables.preview,
    production: deliverables.production,
    pendingAction: pendingAction(status, deliverables),
    createdAt,
    updatedAt,
  };
  assertNoInternalIds(snapshot, [
    input.aliases.internalProjectId,
    ...activeBuild.fences.flatMap((fence) => [fence.runId, fence.candidateId]),
  ]);
  return { snapshot, fences: activeBuild.fences };
}

export function projectCustomerEvent(input: {
  value: unknown;
  aliases: CustomerAliasContext;
  aggregateRevision: number;
  contractVersion: number | null;
  secret: string;
  publicSequence?: number;
}): Record<string, unknown> {
  const event = asRecord(input.value);
  const upstreamSequence = safeInteger(event?.sequence, 1);
  const sequence =
    input.publicSequence === undefined
      ? upstreamSequence
      : safeInteger(input.publicSequence, 1);
  const sourceType = safeString(event?.type, 128);
  const occurredAt = safeTimestamp(event?.occurredAt);
  if (
    upstreamSequence === undefined ||
    sequence === undefined ||
    sourceType === undefined ||
    occurredAt === undefined
  ) {
    throw invalidProjection();
  }
  const status =
    typeof event?.status === "string" && LIFECYCLE_STATUSES.has(event.status)
      ? event.status
      : null;
  const runId = safeString(event?.runId, 256);
  const candidateId = safeString(event?.candidateId, 256);
  const builderId =
    runId !== undefined && candidateId !== undefined
      ? opaqueAlias("bld", `${runId}\0${candidateId}`, input.secret)
      : null;
  return {
    schemaVersion: 1,
    eventId: opaqueAlias(
      "evt",
      `${input.aliases.internalProjectId}\0${upstreamSequence}`,
      input.secret,
    ),
    sequence,
    aggregateRevision: input.aggregateRevision,
    projectId: input.aliases.projectAlias,
    contractVersion: input.contractVersion,
    type: customerEventType(sourceType, status),
    occurredAt,
    data: {
      ...(status === null ? {} : { status }),
      ...(builderId === null ? {} : { builderId }),
      actor:
        event?.actor === "customer" || event?.actor === "operator"
          ? event.actor
          : "system",
    },
  };
}

function projectPlan(value: unknown): {
  version: number;
  title: string;
  summary: string;
  deliverables: Array<{ id: string; text: string }>;
  requirements: Array<{
    id: string;
    text: string;
    priority: "hard" | "preference";
  }>;
  unknowns: string[];
} | null {
  if (value === null || value === undefined) {
    return null;
  }
  const plan = asRecord(value);
  const version = safeInteger(plan?.version, 1);
  const title = safeString(plan?.title, 500);
  const summary = safeString(plan?.summary, 10_000);
  if (version === undefined || title === undefined || summary === undefined) {
    throw invalidProjection();
  }
  return {
    version,
    title,
    summary,
    deliverables: projectTextItems(plan?.deliverables, false),
    requirements: projectTextItems(plan?.requirements, true).map((item) => ({
      id: item.id,
      text: item.text,
      priority: item.priority!,
    })),
    unknowns: projectUnknowns(plan?.unknowns),
  };
}

function projectTextItems(
  value: unknown,
  includePriority: boolean,
): Array<{
  id: string;
  text: string;
  priority?: "hard" | "preference";
}> {
  if (!Array.isArray(value) || value.length > 500) {
    throw invalidProjection();
  }
  return value.map((item) => {
    const record = asRecord(item);
    const id = safeString(record?.id, 256);
    const text = safeString(record?.text, 5_000);
    const priority =
      record?.priority === "hard" || record?.priority === "preference"
        ? record.priority
        : undefined;
    if (
      id === undefined ||
      text === undefined ||
      (includePriority && priority === undefined)
    ) {
      throw invalidProjection();
    }
    return { id, text, ...(priority === undefined ? {} : { priority }) };
  });
}

function projectUnknowns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw invalidProjection();
  }
  return value.map((item) => {
    const text = safeString(item, 2_000);
    if (text === undefined) {
      throw invalidProjection();
    }
    return text;
  });
}

function projectActiveBuild(input: {
  value: unknown;
  aliases: CustomerAliasContext;
  secret: string;
  fallbackUpdatedAt: string;
}): {
  batch: Record<string, unknown> | null;
  fences: CustomerBuilderFence[];
  proof: Record<string, unknown> | null;
} {
  if (input.value === null || input.value === undefined) {
    return { batch: null, fences: [], proof: null };
  }
  const build = asRecord(input.value);
  const internalBatchId = safeString(build?.batchId, 256);
  const proposalVersion = safeInteger(build?.proposalVersion, 1);
  const requested = safeInteger(build?.requestedCandidateCount, 1, 4);
  const createdAt = safeTimestamp(build?.createdAt);
  const completedAt =
    build?.completedAt === null ? null : safeTimestamp(build?.completedAt);
  const sourceRuns = Array.isArray(build?.runs) ? build.runs.slice(0, 4) : [];
  if (
    internalBatchId === undefined ||
    proposalVersion === undefined ||
    requested === undefined ||
    createdAt === undefined ||
    (build?.completedAt !== null && completedAt === undefined)
  ) {
    throw invalidProjection();
  }
  const batchAlias = opaqueAlias("bat", internalBatchId, input.secret);
  const fences: CustomerBuilderFence[] = [];
  const allocatedBuilders = sourceRuns.map((value, index) => {
    const run = asRecord(value);
    const runId = safeString(run?.runId, 256);
    const candidateId = safeString(run?.candidateId, 256);
    if (run === undefined || runId === undefined || candidateId === undefined) {
      throw invalidProjection();
    }
    const builderAlias = opaqueAlias(
      "bld",
      `${runId}\0${candidateId}`,
      input.secret,
    );
    fences.push({
      projectAlias: input.aliases.projectAlias,
      internalProjectId: input.aliases.internalProjectId,
      builderAlias,
      runId,
      candidateId,
      contractVersion: proposalVersion,
      sessionBinding: input.aliases.sessionBinding,
      registeredAt: Date.now(),
    });
    return projectBuilder({
      run,
      index,
      builderAlias,
      fallbackUpdatedAt: input.fallbackUpdatedAt,
    });
  });
  const builders = Array.from({ length: 4 }, (_, index) => {
    return (
      allocatedBuilders[index] ?? {
        builderId: opaqueAlias(
          "bld",
          `${internalBatchId}\0unallocated\0${index + 1}`,
          input.secret,
        ),
        displayName: `Builder ${index + 1}`,
        allocation: "not_allocated",
        status: "queued",
        stage: null,
        progress: {
          completedToolCalls: 0,
          failedToolCalls: 0,
          repairRound: 0,
          proofReceiptCount: 0,
        },
        workspace: {
          state: "unavailable",
          customerRenderable: false,
          latestFrameId: null,
          capturedAt: null,
        },
        currentActivity: null,
        updatedAt: null,
        completedAt: null,
      }
    );
  });
  const proofCounts = allocatedBuilders.reduce<{ receipts: number }>(
    (accumulator, builder) => {
      const progress = asRecord(builder.progress);
      accumulator.receipts += safeInteger(progress?.proofReceiptCount) ?? 0;
      return accumulator;
    },
    { receipts: 0 },
  );
  return {
    batch: {
      batchId: batchAlias,
      contractVersion: proposalVersion,
      state: buildState(build?.status),
      requestedBuilderCount: requested,
      builders,
      startedAt: createdAt,
      completedAt,
    },
    fences,
    proof: {
      contractVersion: proposalVersion,
      receiptCount: proofCounts.receipts,
      state:
        build?.status === "completed"
          ? "recorded"
          : build?.status === "failed" || build?.status === "cancelled"
            ? "blocked"
            : "in_progress",
    },
  };
}

function projectBuilder(input: {
  run: Record<string, unknown>;
  index: number;
  builderAlias: string;
  fallbackUpdatedAt: string;
}): Record<string, unknown> {
  const progress = asRecord(input.run.progress);
  const proof = asRecord(input.run.proof);
  const timeline = asRecord(input.run.timeline);
  const items = Array.isArray(timeline?.items) ? timeline.items : [];
  const lastActivity = items.at(-1);
  const updatedAt =
    safeTimestamp(input.run.updatedAt) ?? input.fallbackUpdatedAt;
  const completedAt =
    input.run.completedAt === null
      ? null
      : (safeTimestamp(input.run.completedAt) ?? null);
  return {
    builderId: input.builderAlias,
    displayName: `Builder ${input.index + 1}`,
    allocation: "allocated",
    status: builderStatus(input.run.status),
    stage: builderStage(input.run.stage),
    progress: {
      completedToolCalls: safeInteger(progress?.completedToolCalls) ?? 0,
      failedToolCalls: safeInteger(progress?.failedToolCalls) ?? 0,
      repairRound: safeInteger(progress?.repairRound, 0, 100) ?? 0,
      proofReceiptCount: safeInteger(proof?.receiptCount) ?? 0,
    },
    workspace: {
      state:
        asRecord(input.run.workspace)?.state === "starting"
          ? "starting"
          : "unavailable",
      customerRenderable: false,
      latestFrameId: null,
      capturedAt: null,
    },
    currentActivity: projectActivity(
      lastActivity,
      input.builderAlias,
      input.index,
    ),
    updatedAt,
    completedAt,
  };
}

function projectActivity(
  value: unknown,
  builderAlias: string,
  index: number,
): Record<string, unknown> | null {
  const activity = asRecord(value);
  const sequence = safeInteger(activity?.sequence, 1);
  const occurredAt = safeTimestamp(activity?.occurredAt);
  if (
    activity === undefined ||
    sequence === undefined ||
    occurredAt === undefined
  ) {
    return null;
  }
  const action = activityAction(activity);
  return {
    activityId: `activity_${index + 1}_${sequence}`,
    builderId: builderAlias,
    step: null,
    repairRound: 0,
    action,
    outcome:
      activity?.succeeded === true
        ? "succeeded"
        : activity?.succeeded === false
          ? "failed"
          : "started",
    fileCount: null,
    safeRelativePaths: [],
    diffStats: null,
    commandLabel: null,
    occurredAt,
  };
}

function activityAction(activity: Record<string, unknown>): string {
  const tool = activity.tool;
  if (tool === "list_files") return "files_listing";
  if (tool === "read_file") return "file_reading";
  if (tool === "write_file" || tool === "write_files") return "file_writing";
  if (tool === "run_command") return "command_running";
  if (tool === "start_preview") return "operator_preview_starting";
  if (tool === "finish") return "finalizing";
  const category = activity.category;
  if (category === "workspace") return "sandbox_provisioning";
  if (category === "evidence") return "command_verification";
  return "waiting";
}

function projectDeliverables(value: unknown): {
  preview: Record<string, unknown> | null;
  production: Record<string, unknown> | null;
} {
  const deliverables = asRecord(value);
  return {
    preview: projectPreview(deliverables?.frozenProvenPreview),
    production: projectProduction(deliverables?.production),
  };
}

function projectPreview(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const preview = asRecord(value);
  const contractVersion = safeInteger(preview?.contractVersion, 1);
  const artifactDigest = safeDigest(preview?.artifactDigest);
  const revisionHash = safeDigest(preview?.revisionHash);
  const url = safeUrl(preview?.url);
  const expiresAt = safeTimestamp(preview?.expiresAt);
  const verifiedAt = safeTimestamp(preview?.verifiedAt);
  if (
    contractVersion === undefined ||
    artifactDigest === undefined ||
    revisionHash === undefined ||
    url === undefined ||
    expiresAt === undefined ||
    verifiedAt === undefined
  ) {
    return null;
  }
  return {
    state: "ready",
    contractVersion,
    artifactDigest,
    revisionHash,
    url,
    expiresAt,
    verifiedAt,
    frozen: true,
  };
}

function projectProduction(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const production = asRecord(value);
  const contractVersion = safeInteger(production?.contractVersion, 1);
  const artifactDigest = safeDigest(production?.artifactDigest);
  const imageDigest = safeImageDigest(production?.imageDigest);
  const url = safeUrl(production?.url);
  const verifiedAt = safeTimestamp(production?.verifiedAt);
  const releaseVersion = safeInteger(production?.releaseVersion, 1);
  if (
    contractVersion === undefined ||
    artifactDigest === undefined ||
    imageDigest === undefined ||
    url === undefined ||
    verifiedAt === undefined ||
    releaseVersion === undefined
  ) {
    return null;
  }
  return {
    state: "ready",
    contractVersion,
    artifactDigest,
    imageDigest,
    releaseVersion,
    url,
    verifiedAt,
  };
}

function safeDigest(value: unknown): string | undefined {
  const digest = safeString(value, 128);
  return digest !== undefined && /^[a-f0-9]{64}$/i.test(digest)
    ? digest
    : undefined;
}

function safeImageDigest(value: unknown): string | undefined {
  const digest = safeString(value, 135);
  const match =
    digest === undefined ? null : /^sha256:([a-f0-9]{64})$/i.exec(digest);
  return match?.[1]?.toLowerCase();
}

function safeUrl(value: unknown): string | undefined {
  const url = safeString(value, 2_000);
  if (url === undefined || !SAFE_HTTPS_URL.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.username === "" &&
      parsed.password === "" &&
      parsed.protocol === "https:" &&
      parsed.hash === ""
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function buildMilestones(input: {
  status: string;
  paymentVerified: boolean;
  paymentVerifiedAt: string | null;
  hasBuild: boolean;
  hasPreview: boolean;
  hasProduction: boolean;
  createdAt: string;
  updatedAt: string;
}): Array<Record<string, unknown>> {
  const blocked =
    input.status.includes("failed") ||
    input.status === "no_proven_candidate" ||
    input.status === "needs_operator_attention";
  const buildComplete =
    input.hasBuild &&
    input.status !== "building" &&
    input.status !== "paid" &&
    input.status !== "awaiting_payment";
  return [
    milestone("scope", true, false, input.createdAt),
    milestone(
      "payment",
      input.paymentVerified,
      !input.paymentVerified,
      input.paymentVerifiedAt,
    ),
    milestone(
      "build",
      buildComplete && !blocked,
      input.hasBuild && !buildComplete,
      buildComplete ? input.updatedAt : null,
      blocked && !buildComplete,
    ),
    milestone(
      "proof",
      input.hasPreview || input.hasProduction,
      input.status === "verifying",
      input.hasPreview || input.hasProduction ? input.updatedAt : null,
      input.status === "no_proven_candidate",
    ),
    milestone(
      "preview",
      input.hasPreview,
      false,
      input.hasPreview ? input.updatedAt : null,
    ),
    milestone(
      "production",
      input.hasProduction,
      false,
      input.hasProduction ? input.updatedAt : null,
      blocked,
    ),
  ];
}

function milestone(
  id: string,
  complete: boolean,
  active: boolean,
  receiptAt: string | null,
  blocked = false,
): Record<string, unknown> {
  return {
    id,
    state: complete
      ? "complete"
      : blocked
        ? "blocked"
        : active
          ? "active"
          : "not_started",
    receiptAt: complete ? receiptAt : null,
  };
}

function pendingAction(
  status: string,
  deliverables: {
    preview: Record<string, unknown> | null;
    production: Record<string, unknown> | null;
  },
): string {
  if (status === "needs_clarification") return "answer_clarification";
  if (status === "awaiting_payment") return "pay";
  if (deliverables.production !== null) return "open_production";
  if (deliverables.preview !== null) return "review_preview";
  if (status === "building" || status === "verifying") return "watch";
  return "none";
}

function lifecycleLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildState(value: unknown): string {
  if (value === "pending") return "pending";
  if (value === "queued") return "pending";
  if (value === "dispatched") return "dispatched";
  if (value === "building") return "building";
  if (value === "verifying") return "verifying";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "cancelled") return "cancelled";
  if (value === "superseded") return "superseded";
  throw invalidProjection();
}

function builderStatus(value: unknown): string {
  return value === "queued" ||
    value === "running" ||
    value === "passed" ||
    value === "rejected" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : throwInvalidProjection();
}

function builderStage(value: unknown): string | null {
  if (value === null) return null;
  return value === "queued" ||
    value === "provisioning" ||
    value === "generating" ||
    value === "verifying" ||
    value === "reviewing" ||
    value === "evaluating" ||
    value === "finalizing" ||
    value === "complete"
    ? value
    : throwInvalidProjection();
}

function throwInvalidProjection(): never {
  throw invalidProjection();
}

function customerEventType(sourceType: string, status: string | null): string {
  if (sourceType.includes("proposal")) return "contract.version_created";
  if (sourceType.includes("payment") && status === "paid")
    return "payment.verified";
  if (sourceType === "build.batch_superseded") return "build.batch_superseded";
  if (sourceType.includes("build.batch")) return "build.batch_started";
  if (sourceType.includes("assignment") || sourceType.includes("run"))
    return "builder.state_changed";
  if (sourceType.includes("candidate") || sourceType.includes("proven"))
    return "candidate.outcome_recorded";
  if (sourceType.includes("preview")) return "preview.ready";
  if (sourceType.includes("deployment") && status === "completed")
    return "production.ready";
  if (sourceType.includes("deployment")) return "deployment.state_changed";
  if (sourceType.includes("clarification")) return "clarification.requested";
  if (sourceType.includes("revision") || sourceType.includes("steering"))
    return "steering.received";
  if (sourceType.includes("email")) return "notification.state_changed";
  return "project.state_changed";
}

function assertNoInternalIds(
  value: unknown,
  internalIds: readonly string[],
): void {
  const encoded = JSON.stringify(value);
  if (internalIds.some((id) => id.length > 0 && encoded.includes(id))) {
    throw new DashboardBffError(
      500,
      "customer_projection_leak_blocked",
      "The customer projection could not be safely rendered",
    );
  }
}

function invalidProjection(): DashboardBffError {
  return new DashboardBffError(
    502,
    "invalid_customer_projection",
    "The project service returned an invalid customer projection",
  );
}
