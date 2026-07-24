import type { CustomerBuildObservation } from "../../domain/customer-observability.js";
import type {
  BuildBatch,
  ProjectAggregate,
  ProjectEvent,
} from "../domain/project.js";

export interface CustomerDashboardRunView {
  runId: string;
  candidateId: string;
  status: BuildBatch["runs"][number]["status"];
  telemetrySource: "build_backend" | "orchestration_index";
  stage: CustomerBuildObservation["stage"] | null;
  slot: CustomerBuildObservation["slot"] | null;
  workspace: CustomerBuildObservation["workspace"];
  progress: CustomerBuildObservation["progress"] | null;
  proof: CustomerBuildObservation["proof"] | null;
  timeline: CustomerBuildObservation["timeline"];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CustomerDashboardProjectView {
  version: 1;
  projectId: string;
  status: ProjectAggregate["status"];
  revision: number;
  plan: {
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
  } | null;
  payment: {
    state: "awaiting" | "verified";
    verifiedAt: string | null;
  };
  activeBuild: {
    batchId: string;
    status: BuildBatch["status"];
    proposalVersion: number;
    requestedCandidateCount: number;
    runs: CustomerDashboardRunView[];
    createdAt: string;
    completedAt: string | null;
  } | null;
  observation: {
    state: "unavailable" | "partial" | "live";
    note:
      | "No build batch has started."
      | "Live build telemetry is available."
      | "Some build telemetry is temporarily unavailable."
      | "The build backend does not expose customer-safe telemetry.";
  };
  deliverables: {
    frozenProvenPreview: {
      url: string;
      expiresAt: string;
      verifiedAt: string;
    } | null;
    production: {
      url: string;
      verifiedAt: string;
    } | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CustomerBuildObservationResult {
  runId: string;
  observation?: CustomerBuildObservation;
}

export function buildCustomerDashboardProjectView(
  project: ProjectAggregate,
  observationResults: readonly CustomerBuildObservationResult[],
  now: Date = new Date(),
): CustomerDashboardProjectView {
  const proposal = project.proposals.find(
    (candidate) => candidate.version === project.activeProposalVersion,
  );
  const activeBatch = project.activeBuildBatchId
    ? project.buildBatches.find(
        (candidate) => candidate.batchId === project.activeBuildBatchId,
      )
    : undefined;
  const observations = new Map(
    observationResults.map((result) => [result.runId, result.observation]),
  );
  const runs =
    activeBatch?.runs.map((run) => {
      const observation = observations.get(run.runId);
      if (
        !observation ||
        observation.projectId !== project.projectId ||
        observation.candidateId !== run.candidateId
      ) {
        return unavailableRunView(project, activeBatch, run);
      }
      return {
        runId: run.runId,
        candidateId: run.candidateId,
        status: observation.status,
        telemetrySource: "build_backend",
        stage: observation.stage,
        slot: observation.slot,
        workspace: observation.workspace,
        progress: observation.progress,
        proof: observation.proof,
        timeline: observation.timeline,
        createdAt: observation.createdAt,
        updatedAt: observation.updatedAt,
        completedAt: observation.completedAt,
      } satisfies CustomerDashboardRunView;
    }) ?? [];
  const availableObservationCount = runs.filter(
    (run) => run.telemetrySource === "build_backend",
  ).length;
  const observation: CustomerDashboardProjectView["observation"] = !activeBatch
    ? {
        state: "unavailable",
        note: "No build batch has started.",
      }
    : availableObservationCount === runs.length && runs.length > 0
      ? {
          state: "live",
          note: "Live build telemetry is available.",
        }
      : availableObservationCount > 0
        ? {
            state: "partial",
            note: "Some build telemetry is temporarily unavailable.",
          }
        : {
            state: "unavailable",
            note: "The build backend does not expose customer-safe telemetry.",
          };
  const frozenPreview = latestFrozenPreview(project, now);
  const production = latestProductionDeployment(project);
  const paymentProposalVersion =
    proposal?.commercialBasisVersion ?? proposal?.version;
  const payment = project.payments
    .filter(
      (receipt) =>
        paymentProposalVersion === undefined ||
        receipt.proposalVersion === paymentProposalVersion,
    )
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0];

  return {
    version: 1,
    projectId: project.projectId,
    status: project.status,
    revision: project.revision,
    plan: proposal
      ? {
          version: proposal.version,
          title: proposal.projectTitle,
          summary: proposal.plan.summary.text,
          deliverables: proposal.plan.deliverables.map((item) => ({
            id: item.itemId,
            text: item.text,
          })),
          requirements: proposal.plan.requirements.map((item) => ({
            id: item.itemId,
            text: item.text,
            priority: item.priority,
          })),
          unknowns: [...proposal.plan.unknowns],
        }
      : null,
    payment: {
      state: payment ? "verified" : "awaiting",
      verifiedAt: payment?.verifiedAt ?? null,
    },
    activeBuild: activeBatch
      ? {
          batchId: activeBatch.batchId,
          status: activeBatch.status,
          proposalVersion: activeBatch.proposalVersion,
          requestedCandidateCount: activeBatch.requestedCandidateCount,
          runs,
          createdAt: activeBatch.createdAt,
          completedAt: activeBatch.completedAt ?? null,
        }
      : null,
    observation,
    deliverables: {
      frozenProvenPreview: frozenPreview
        ? {
            url: frozenPreview.url,
            expiresAt: frozenPreview.expiresAt,
            verifiedAt: frozenPreview.verifiedAt,
          }
        : null,
      production: production
        ? {
            url: production.url,
            verifiedAt: production.verifiedAt,
          }
        : null,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function buildCustomerDashboardEventView(event: ProjectEvent): {
  sequence: number;
  type: string;
  actor: ProjectEvent["actor"];
  status: ProjectAggregate["status"] | null;
  runId: string | null;
  candidateId: string | null;
  occurredAt: string;
} {
  return {
    sequence: event.sequence,
    type: event.type,
    actor: event.actor,
    status: event.payload.status ?? null,
    runId: event.payload.runId ?? null,
    candidateId: event.payload.candidateId ?? null,
    occurredAt: event.occurredAt,
  };
}

function unavailableRunView(
  project: ProjectAggregate,
  batch: BuildBatch,
  run: BuildBatch["runs"][number],
): CustomerDashboardRunView {
  return {
    runId: run.runId,
    candidateId: run.candidateId,
    status: run.status,
    telemetrySource: "orchestration_index",
    stage: null,
    slot: null,
    workspace: {
      state:
        run.status === "queued" || run.status === "running"
          ? "starting"
          : "unavailable",
      customerRenderable: false,
    },
    progress: null,
    proof: null,
    timeline: {
      items: [],
      nextAfterSequence: 0,
      hasMore: false,
    },
    createdAt: batch.createdAt,
    updatedAt: project.updatedAt,
    completedAt:
      run.status === "queued" || run.status === "running"
        ? null
        : (batch.completedAt ?? project.updatedAt),
  };
}

function latestFrozenPreview(
  project: ProjectAggregate,
  now: Date,
): ProjectAggregate["previews"][number] | undefined {
  if (!Number.isFinite(now.getTime())) {
    return undefined;
  }
  return project.previews
    .filter(
      (preview) =>
        preview.immutable &&
        preview.httpsHealthy &&
        Date.parse(preview.expiresAt) > now.getTime(),
    )
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0];
}

function latestProductionDeployment(
  project: ProjectAggregate,
): ProjectAggregate["deployments"][number] | undefined {
  return project.deployments
    .filter((deployment) => deployment.httpsHealthy)
    .sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0];
}
