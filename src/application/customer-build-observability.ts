import { z } from "zod";

import {
  CUSTOMER_BUILD_TIMELINE_LIMIT,
  CustomerBuildObservationSchema,
  CustomerBuildTimelineEventSchema,
  type CustomerBuildObservation,
  type CustomerBuildObservationQuery,
  type CustomerBuildTimelineEvent,
} from "../domain/customer-observability.js";
import {
  AgentProgressSchema,
  type BuildRun,
  type RunEvent,
} from "../domain/run.js";
import type { RunStore } from "../ports/index.js";

const MAX_RECONSTRUCTION_PAGES = 100;
const RECONSTRUCTION_PAGE_SIZE = 1_000;

const EvidenceProgressSchema = z
  .object({
    kind: z.string().min(1).max(128),
    status: z.enum(["PASS", "FAIL", "ERROR"]),
  })
  .strip();

/**
 * Produces a customer-safe view of a build run.
 *
 * This function deliberately has no fields for sandbox identities, command
 * output, prompts, reasoning, mutable preview endpoints, or artifact details.
 * `live_unverified` means only that an isolated workspace is active; it never
 * authorizes the workspace as a customer-deliverable preview.
 */
export function observeBuildRunForCustomer(
  store: RunStore,
  run: BuildRun,
  query: CustomerBuildObservationQuery = {},
): CustomerBuildObservation {
  const afterSequence = boundedAfterSequence(query.afterSequence);
  const limit = boundedTimelineLimit(query.limit);
  const allEvents = reconstructRunEvents(store, run.id);
  const visibleWindow = allEvents
    .filter((event) => event.sequence > afterSequence)
    .map(toCustomerTimelineEvent)
    .filter(
      (event): event is CustomerBuildTimelineEvent => event !== undefined,
    );
  const items = visibleWindow.slice(0, limit);
  const latestSequence = store.getLatestEventSequence(run.id);
  const hasMore = visibleWindow.length > limit;
  const nextAfterSequence = hasMore
    ? items.at(-1)!.sequence
    : Math.max(afterSequence, latestSequence);
  const progress = summarizeProgress(allEvents);
  const receipts = store.listEvidence(run.id);
  const proof = {
    receiptCount: receipts.length,
    passCount: receipts.filter((receipt) => receipt.status === "PASS").length,
    failCount: receipts.filter((receipt) => receipt.status === "FAIL").length,
    errorCount: receipts.filter((receipt) => receipt.status === "ERROR").length,
    byKind: receipts.reduce<Record<string, number>>((counts, receipt) => {
      counts[receipt.kind] = (counts[receipt.kind] ?? 0) + 1;
      return counts;
    }, {}),
    provenArtifactAvailable: store.getArtifact(run.id) !== undefined,
  };

  return CustomerBuildObservationSchema.parse({
    version: 1,
    runId: run.id,
    projectId: run.projectId,
    candidateId: run.candidateId,
    status: run.status,
    stage: run.stage,
    slot: customerSlot(run),
    workspace: {
      state: customerWorkspaceState(run),
      customerRenderable: false,
    },
    progress,
    proof,
    timeline: {
      items,
      nextAfterSequence,
      hasMore,
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
  });
}

function reconstructRunEvents(store: RunStore, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  let cursor = 0;
  for (let page = 0; page < MAX_RECONSTRUCTION_PAGES; page += 1) {
    const next = store.listEvents(runId, cursor, RECONSTRUCTION_PAGE_SIZE);
    if (next.length === 0) {
      return events;
    }
    for (const event of next) {
      if (event.runId !== runId || event.sequence <= cursor) {
        throw new Error(
          "RunStore returned an invalid customer-observability event sequence",
        );
      }
      events.push(event);
      cursor = event.sequence;
    }
    if (next.length < RECONSTRUCTION_PAGE_SIZE) {
      return events;
    }
  }
  throw new Error(
    "Customer-observability reconstruction exceeded its bounded event limit",
  );
}

function summarizeProgress(events: readonly RunEvent[]): {
  completedToolCalls: number;
  failedToolCalls: number;
  lastTool: z.infer<typeof AgentProgressSchema>["toolName"] | null;
  repairRound: number;
} {
  let completedToolCalls = 0;
  let failedToolCalls = 0;
  let lastTool: z.infer<typeof AgentProgressSchema>["toolName"] | null = null;
  let repairRound = 0;
  for (const event of events) {
    if (event.type !== "agent.tool_completed") {
      continue;
    }
    const parsed = AgentProgressSchema.safeParse(event.payload);
    if (!parsed.success) {
      continue;
    }
    completedToolCalls += 1;
    if (!parsed.data.ok) {
      failedToolCalls += 1;
    }
    lastTool = parsed.data.toolName;
    repairRound = parsed.data.repairRound;
  }
  return {
    completedToolCalls,
    failedToolCalls,
    lastTool,
    repairRound,
  };
}

function toCustomerTimelineEvent(
  event: RunEvent,
): CustomerBuildTimelineEvent | undefined {
  const common = {
    sequence: event.sequence,
    stage: event.stage,
    occurredAt: event.createdAt,
  };
  if (event.type.startsWith("stage.")) {
    return CustomerBuildTimelineEventSchema.parse({
      ...common,
      category: "stage",
    });
  }
  if (event.type === "agent.tool_completed") {
    const parsed = AgentProgressSchema.safeParse(event.payload);
    if (!parsed.success) {
      return undefined;
    }
    return CustomerBuildTimelineEventSchema.parse({
      ...common,
      category: "tool",
      tool: parsed.data.toolName,
      succeeded: parsed.data.ok,
    });
  }
  if (event.type === "evidence.recorded") {
    const parsed = EvidenceProgressSchema.safeParse(event.payload);
    if (!parsed.success) {
      return undefined;
    }
    return CustomerBuildTimelineEventSchema.parse({
      ...common,
      category: "evidence",
      evidenceKind: parsed.data.kind,
      evidenceStatus: parsed.data.status,
    });
  }
  if (
    event.type === "sandbox.builder_attached" ||
    event.type === "sandbox.verification_attached" ||
    event.type === "sandbox.verification_promoted"
  ) {
    return CustomerBuildTimelineEventSchema.parse({
      ...common,
      category: "workspace",
    });
  }
  if (
    event.type.startsWith("run.") ||
    event.type === "artifact.recorded" ||
    event.type === "revision.frozen"
  ) {
    return CustomerBuildTimelineEventSchema.parse({
      ...common,
      category: "lifecycle",
    });
  }
  return undefined;
}

function customerSlot(run: BuildRun): CustomerBuildObservation["slot"] {
  if (run.slotId !== undefined && run.status === "running") {
    return { state: "active", number: run.slotId };
  }
  if (run.status === "queued") {
    return { state: "waiting", number: null };
  }
  return { state: "released", number: null };
}

function customerWorkspaceState(
  run: BuildRun,
): CustomerBuildObservation["workspace"]["state"] {
  if (run.status === "running" && run.sandboxId !== undefined) {
    return "live_unverified";
  }
  if (
    run.status === "queued" ||
    (run.status === "running" && run.sandboxId === undefined)
  ) {
    return "starting";
  }
  return "unavailable";
}

function boundedAfterSequence(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "Customer-observability cursor must be a non-negative safe integer",
    );
  }
  return value;
}

function boundedTimelineLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      "Customer-observability limit must be a positive safe integer",
    );
  }
  return Math.min(CUSTOMER_BUILD_TIMELINE_LIMIT, value);
}
