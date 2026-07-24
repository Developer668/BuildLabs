import {
  type CustomerAliasContext,
  dashboardAliasSecret,
  opaqueAlias,
  resolveCustomerAliasContext,
} from "./aliases";
import { parseCustomerProjectSnapshot } from "../contracts/customer";
import { projectCustomerSnapshot } from "./customer-projection";
import {
  DashboardBffError,
  asRecord,
  bffErrorResponse,
  customerJson,
  safeInteger,
} from "./http";
import {
  type DashboardFetch,
  type UpstreamEventWindow,
  fetchCustomerEventWindow,
  fetchCustomerSnapshot,
} from "./orchestration-client";
import {
  type CustomerBuilderFence,
  customerProjectionRegistry,
} from "./projection-registry";
import { customerWipFrameStore } from "./wip-frame-store";

const MAX_CURSOR_SCAN_EVENTS = 8_192;

export interface LoadedCustomerSnapshot {
  aliases: CustomerAliasContext;
  snapshot: ReturnType<typeof parseCustomerProjectSnapshot>;
  fences: CustomerBuilderFence[];
  upstreamCursor: number;
}

export async function loadCustomerSnapshot(input: {
  request: Request;
  projectAlias: string;
  fetcher?: DashboardFetch;
  secret?: string;
}): Promise<LoadedCustomerSnapshot> {
  const secret = input.secret ?? dashboardAliasSecret();
  const aliases = resolveCustomerAliasContext(
    input.request,
    input.projectAlias,
    secret,
  );
  const upstream = await fetchCustomerSnapshot({
    request: input.request,
    internalProjectId: aliases.internalProjectId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
  const revision = safeInteger(asRecord(upstream)?.revision);
  if (revision === undefined) {
    throw invalidProjection();
  }
  const upstreamCursor = await upstreamCursorForPublicSequence({
    request: input.request,
    internalProjectId: aliases.internalProjectId,
    publicSequence: revision + 1,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
  const projected = projectCustomerSnapshot({
    upstream,
    aliases,
    eventCursor: revision + 1,
    secret,
  });
  hydrateWipFrames(projected.snapshot, projected.fences, secret);
  try {
    const snapshot = parseCustomerProjectSnapshot(projected.snapshot);
    customerProjectionRegistry.replaceProjectFences(
      aliases.projectAlias,
      aliases.sessionBinding,
      projected.fences,
    );
    return {
      aliases,
      snapshot,
      fences: projected.fences,
      upstreamCursor,
    };
  } catch {
    throw invalidProjection();
  }
}

export async function handleCustomerSnapshot(input: {
  request: Request;
  projectAlias: string;
  fetcher?: DashboardFetch;
}): Promise<Response> {
  try {
    const loaded = await loadCustomerSnapshot(input);
    return customerJson(loaded.snapshot);
  } catch (error) {
    return bffErrorResponse(error);
  }
}

export function validateEventWindow(
  window: UpstreamEventWindow,
  afterSequence: number,
): number[] {
  const sequences: number[] = [];
  let previous = afterSequence;
  for (const item of window.items) {
    const sequence = safeInteger(asRecord(item)?.sequence, 1);
    if (sequence === undefined || sequence <= previous) {
      throw invalidProjection();
    }
    sequences.push(sequence);
    previous = sequence;
  }
  if (
    window.nextAfterSequence !== previous ||
    (window.items.length === 0 && window.hasMore)
  ) {
    throw invalidProjection();
  }
  return sequences;
}

export async function upstreamCursorForPublicSequence(input: {
  request: Request;
  internalProjectId: string;
  publicSequence: number;
  fetcher?: DashboardFetch;
}): Promise<number> {
  const targetEventCount = input.publicSequence;
  if (targetEventCount === 0) return 0;
  if (targetEventCount > MAX_CURSOR_SCAN_EVENTS) {
    throw new DashboardBffError(
      503,
      "snapshot_cursor_unavailable",
      "A consistent project snapshot is temporarily unavailable",
    );
  }
  let afterSequence = 0;
  let observed = 0;
  while (observed < targetEventCount) {
    const remaining = targetEventCount - observed;
    const window = await fetchCustomerEventWindow({
      request: input.request,
      internalProjectId: input.internalProjectId,
      afterSequence,
      limit: Math.min(250, remaining),
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    });
    const sequences = validateEventWindow(window, afterSequence);
    if (sequences.length === 0) {
      throw invalidProjection();
    }
    observed += sequences.length;
    afterSequence = sequences.at(-1)!;
    if (observed < targetEventCount && !window.hasMore) {
      throw invalidProjection();
    }
  }
  return afterSequence;
}

function hydrateWipFrames(
  snapshot: Record<string, unknown>,
  fences: readonly CustomerBuilderFence[],
  secret: string,
): void {
  const batch = asRecord(snapshot.activeBatch);
  if (!Array.isArray(batch?.builders)) return;
  const byBuilder = new Map(fences.map((fence) => [fence.builderAlias, fence]));
  for (const value of batch.builders) {
    const builder = asRecord(value);
    const builderId =
      typeof builder?.builderId === "string" ? builder.builderId : undefined;
    const fence =
      builderId === undefined ? undefined : byBuilder.get(builderId);
    if (builder === undefined || fence === undefined) continue;
    if (builder.completedAt !== null) {
      builder.workspace = {
        state: "ended",
        customerRenderable: false,
        latestFrameId: null,
        capturedAt: null,
      };
      continue;
    }
    const frame = customerWipFrameStore.get(fence);
    if (frame === undefined) {
      if (customerWipFrameStore.isBlocked(fence)) {
        builder.workspace = {
          state: "blocked",
          customerRenderable: false,
          latestFrameId: null,
          capturedAt: null,
        };
      }
      continue;
    }
    builder.workspace = {
      state: frame.metadata.stale ? "stale" : "live_unverified",
      customerRenderable: true,
      latestFrameId: opaqueAlias(
        "frm",
        `${frame.metadata.frameId}\0${fence.sessionBinding}`,
        secret,
      ),
      capturedAt: frame.metadata.capturedAt,
    };
  }
}

function invalidProjection(): DashboardBffError {
  return new DashboardBffError(
    502,
    "invalid_customer_projection",
    "The project service returned an invalid customer projection",
  );
}
