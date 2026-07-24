"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Box,
  Boxes,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  FileDiff,
  Gauge,
  ImageOff,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  Radio,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
  SquareDashed,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  activeBatch,
  activeProposal,
  groupOperatorRuns,
  latestDeployment,
  latestPayment,
  latestPreview,
  parseOperatorEvidenceSnapshot,
  parseOperatorIntegrationsSnapshot,
  parseOperatorRunSnapshot,
  type OperatorEvidenceSnapshot,
  type OperatorIntegrationsSnapshot,
  type OperatorProjectRunGroup,
  type OperatorProviderState,
  type OperatorRunSnapshot,
  type OperatorRunSummary,
} from "../lib/operator-live-data";
import {
  CopilotOperatorBindings,
  type CopilotOperatorProjection,
} from "./copilot-operator-bindings";
import { WorkspaceShell } from "./workspace-shell";

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "error"; sessionExpired: boolean }
  | { kind: "ready"; data: T; refreshing: boolean };

interface QueueData {
  runs: OperatorRunSnapshot;
  integrations: OperatorIntegrationsSnapshot | null;
}

interface ProjectData {
  evidence: OperatorEvidenceSnapshot;
  runs: OperatorRunSnapshot;
  integrations: OperatorIntegrationsSnapshot | null;
}

const PROVIDERS = [
  {
    key: "daytona",
    name: "Daytona",
    responsibility: "Isolated build and verification",
  },
  {
    key: "fireworks",
    name: "Fireworks",
    responsibility: "Reasoning and code generation",
  },
  {
    key: "braintrust",
    name: "Braintrust",
    responsibility: "Tracing and evaluation",
  },
  {
    key: "coderabbit",
    name: "CodeRabbit",
    responsibility: "Candidate code review",
  },
  {
    key: "copilotkit",
    name: "CopilotKit",
    responsibility: "Authenticated operator interaction",
  },
  {
    key: "elevenlabs",
    name: "ElevenLabs",
    responsibility: "Voice and studio operations",
  },
] as const;

const ORCHESTRATION_PROVIDERS = [
  {
    name: "Stripe",
    responsibility: "Payment collection and verification",
  },
  {
    name: "Fly.io",
    responsibility: "Production deployment",
  },
  {
    name: "Resend",
    responsibility: "Project and delivery email",
  },
] as const;

export function OperatorLiveQueue() {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState<QueueData>>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(controller.signal)
      .then((data) => {
        setState({ kind: "ready", data, refreshing: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          kind: "error",
          sessionExpired: error instanceof SessionExpiredError,
        });
      });
    return () => controller.abort();
  }, [reload]);

  const refresh = useCallback(() => {
    setState((current) =>
      current.kind === "ready"
        ? { ...current, refreshing: true }
        : { kind: "loading" },
    );
    setReload((value) => value + 1);
  }, []);
  return <OperatorQueueView onRefresh={refresh} state={state} />;
}

export function OperatorLiveProject({ projectId }: { projectId: string }) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState<ProjectData>>({
    kind: "loading",
  });

  useEffect(() => {
    const controller = new AbortController();
    void loadProject(projectId, controller.signal)
      .then((data) => {
        setState({ kind: "ready", data, refreshing: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          kind: "error",
          sessionExpired: error instanceof SessionExpiredError,
        });
      });
    return () => controller.abort();
  }, [projectId, reload]);

  const refresh = useCallback(() => {
    setState((current) =>
      current.kind === "ready"
        ? { ...current, refreshing: true }
        : { kind: "loading" },
    );
    setReload((value) => value + 1);
  }, []);
  if (state.kind !== "ready") {
    return (
      <OperatorProjectBoundary
        onRefresh={refresh}
        projectId={projectId}
        state={state}
      />
    );
  }

  return (
    <CopilotKit
      agent="studio-observer"
      credentials="same-origin"
      defaultThrottleMs={250}
      enableInspector={false}
      runtimeUrl="/api/copilotkit/operator"
      showDevConsole={false}
    >
      <OperatorProjectView
        data={state.data}
        onRefresh={refresh}
        refreshing={state.refreshing}
      />
    </CopilotKit>
  );
}

function OperatorQueueView({
  onRefresh,
  state,
}: {
  onRefresh: () => void;
  state: LoadState<QueueData>;
}) {
  const groups =
    state.kind === "ready" ? groupOperatorRuns(state.data.runs) : [];
  const activeRuns =
    state.kind === "ready"
      ? state.data.runs.runs.filter(({ run }) =>
          ["queued", "running"].includes(run.status),
        ).length
      : 0;
  const receiptCount =
    state.kind === "ready"
      ? state.data.runs.runs.reduce(
          (total, summary) => total + summary.proof.total,
          0,
        )
      : 0;

  return (
    <WorkspaceShell
      fixture={false}
      projectTitle="Operator run queue"
      role="Operator studio"
      status={state.kind === "error" ? "Snapshot unavailable" : "Read-only BFF"}
      statusTone={state.kind === "error" ? "failed" : "active"}
      transport={state.kind === "ready" ? "snapshot" : "connecting"}
    >
      <div className="workspace">
        <div className="notice-banner info" role="status">
          <ShieldAlert aria-hidden="true" />
          <span>
            This queue is an authenticated, read-only snapshot. Refreshing it
            performs no build, proof, provider, deployment, or delivery action.
          </span>
          <RefreshButton
            disabled={state.kind === "ready" && state.refreshing}
            onRefresh={onRefresh}
          />
        </div>

        <section
          aria-labelledby="operator-queue-overview"
          className="workspace-section"
          id="overview"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">DURABLE RUN INDEX</span>
              <h2 id="operator-queue-overview">Run queue</h2>
              <p>
                Project groups come only from bounded build-run summaries. A
                project title is not inferred when the queue endpoint does not
                provide one.
              </p>
            </div>
            {state.kind === "ready" ? (
              <span className="tiny-tag mono">
                {formatTimestamp(state.data.runs.generatedAt)}
              </span>
            ) : null}
          </div>
          <div className="summary-strip operator-summary">
            <SummaryCell
              detail="Projects represented by this bounded window"
              label="PROJECT GROUPS"
              value={state.kind === "ready" ? String(groups.length) : "--"}
            />
            <SummaryCell
              detail="Queued or running, from durable run status"
              label="ACTIVE RUNS"
              value={state.kind === "ready" ? String(activeRuns) : "--"}
            />
            <SummaryCell
              detail="Count only; receipt bodies are not in this endpoint"
              label="PROOF RECEIPTS"
              value={state.kind === "ready" ? String(receiptCount) : "--"}
            />
            <SummaryCell
              detail="No provider health is inferred while absent"
              label="PROVIDER PROBE"
              value={
                state.kind === "ready" && state.data.integrations?.lastProbeAt
                  ? formatTimestamp(state.data.integrations.lastProbeAt)
                  : "Unavailable"
              }
            />
          </div>
        </section>

        <section
          aria-labelledby="operator-project-groups"
          className="workspace-section"
          id="build"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">RECENT PROJECTS</span>
              <h2 id="operator-project-groups">Project run groups</h2>
              <p>
                Open a project to join its run identities with the matching
                orchestration evidence projection.
              </p>
            </div>
          </div>
          {state.kind === "loading" ? (
            <LoadingState label="Loading authenticated run summaries" />
          ) : state.kind === "error" ? (
            <LoadError
              onRefresh={onRefresh}
              sessionExpired={state.sessionExpired}
            />
          ) : groups.length === 0 ? (
            <Unavailable
              detail="The build backend returned an empty recent-run window. No active work is inferred."
              title="No run groups recorded"
            />
          ) : (
            <div className="operator-project-list">
              {groups.map((group) => (
                <ProjectGroup group={group} key={group.projectId} />
              ))}
            </div>
          )}
        </section>

        <section
          aria-labelledby="operator-queue-providers"
          className="workspace-section"
          id="operations"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">PROVIDER OBSERVATIONS</span>
              <h2 id="operator-queue-providers">Integration boundary</h2>
              <p>
                Configuration and bounded probe results are different states.
                The browser calls only this dashboard BFF.
              </p>
            </div>
          </div>
          {state.kind === "ready" ? (
            <ProviderObservations integrations={state.data.integrations} />
          ) : (
            <Unavailable
              detail="No validated integration snapshot is loaded."
              title="Provider observations unavailable"
            />
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function ProjectGroup({ group }: { group: OperatorProjectRunGroup }) {
  const counts = countRunStates(group.runs);
  const newest = group.runs[0];
  return (
    <article className="operator-project-row">
      <div className="operator-project-main">
        <span className="section-kicker">PROJECT ID</span>
        <h3 className="mono">{group.projectId}</h3>
        <p>
          {newest?.assignment
            ? `Latest recorded strategy: ${newest.assignment.strategyLabel}`
            : "Project title and strategy unavailable in this run snapshot."}
        </p>
      </div>
      <div className="operator-project-counts" aria-label="Run status counts">
        <span>
          <strong>{group.runs.length}</strong> runs
        </span>
        <span>
          <strong>{counts.active}</strong> active
        </span>
        <span>
          <strong>{counts.passed}</strong> passed
        </span>
        <span>
          <strong>{counts.failed}</strong> blocked
        </span>
      </div>
      <div className="operator-project-open">
        <time dateTime={group.updatedAt}>
          {formatTimestamp(group.updatedAt)}
        </time>
        <Link
          className="secondary-button"
          href={`/operator/projects/${encodeURIComponent(group.projectId)}`}
        >
          Open project
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function OperatorProjectBoundary({
  onRefresh,
  projectId,
  state,
}: {
  onRefresh: () => void;
  projectId: string;
  state: Exclude<LoadState<ProjectData>, { kind: "ready" }>;
}) {
  return (
    <WorkspaceShell
      fixture={false}
      projectTitle={`Project ${shortId(projectId)}`}
      role="Operator studio"
      status={
        state.kind === "error" ? "Projection unavailable" : "Loading projection"
      }
      statusTone={state.kind === "error" ? "failed" : "waiting"}
      transport={state.kind === "error" ? "offline" : "connecting"}
    >
      <div className="workspace">
        <Link className="operator-back-link" href="/operator">
          <ArrowLeft aria-hidden="true" />
          Run queue
        </Link>
        <section className="workspace-section">
          {state.kind === "loading" ? (
            <LoadingState label="Joining project evidence and run summaries" />
          ) : (
            <LoadError
              onRefresh={onRefresh}
              sessionExpired={state.sessionExpired}
            />
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function OperatorProjectView({
  data,
  onRefresh,
  refreshing,
}: {
  data: ProjectData;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const proposal = activeProposal(data.evidence);
  const payment = latestPayment(data.evidence);
  const preview = latestPreview(data.evidence);
  const deployment = latestDeployment(data.evidence);
  const delivery = latestEffect(data.evidence, "send_final_delivery");
  const lanes = projectLanes(data.evidence, data.runs);
  const latestDurableEvent = findLatestDurableEvent(data);
  const title =
    proposal?.projectTitle ??
    `Project ${shortId(data.evidence.project.projectId)}`;
  const copilotProjection = liveCopilotProjection(
    data.evidence,
    lanes,
    latestDurableEvent,
  );

  return (
    <WorkspaceShell
      fixture={false}
      projectTitle={title}
      role="Operator studio"
      status={humanize(data.evidence.project.status)}
      statusTone={lifecycleTone(data.evidence.project.status)}
      transport="snapshot"
    >
      <div className="workspace">
        <Link className="operator-back-link" href="/operator">
          <ArrowLeft aria-hidden="true" />
          Run queue
        </Link>
        <div className="notice-banner info" role="status">
          <ShieldAlert aria-hidden="true" />
          <span>
            Authenticated snapshot at aggregate revision{" "}
            {data.evidence.project.revision}. Visual frames are not loaded by
            this projection, and no browser liveness or hidden reasoning is
            inferred.
          </span>
          <CopilotOperatorBindings projection={copilotProjection} />
        </div>

        <section
          aria-labelledby="live-project-overview"
          className="workspace-section"
          id="overview"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">DURABLE LIFECYCLE</span>
              <h2 id="live-project-overview">Project control</h2>
              <p>
                Commercial, contract, build, proof, preview, deployment, and
                delivery records remain version-bound.
              </p>
            </div>
            <RefreshButton disabled={refreshing} onRefresh={onRefresh} />
          </div>
          <div className="summary-strip operator-summary">
            <SummaryCell
              detail={
                latestDurableEvent
                  ? `${latestDurableEvent.actor} at ${formatTimestamp(latestDurableEvent.at)}`
                  : "No bounded activity event is present"
              }
              label="LATEST DURABLE EVENT"
              value={latestDurableEvent?.label ?? "Unavailable"}
            />
            <SummaryCell
              detail={
                proposal
                  ? `Immutable ${shortDigest(proposal.contract.digest)}`
                  : "No active proposal is recorded"
              }
              label="ACCEPTANCE CONTRACT"
              value={proposal ? `v${proposal.contract.version}` : "Unavailable"}
            />
            <SummaryCell
              detail={
                payment
                  ? `${payment.verificationSource.replace("_", " ")} at ${formatTimestamp(payment.verifiedAt)}`
                  : "No verified payment receipt is recorded"
              }
              label="PAYMENT"
              value={payment ? "Receipt verified" : "Unavailable"}
            />
            <SummaryCell
              detail={
                deployment
                  ? `Contract/proposal v${deployment.proposalVersion}`
                  : "No deployment receipt is recorded"
              }
              label="PRODUCTION"
              value={
                deployment
                  ? `Release v${deployment.releaseVersion}`
                  : "Unavailable"
              }
            />
          </div>
          <div className="current-action-line">
            <CircleDashed aria-hidden="true" />
            <div>
              <span className="metric-label">BOUNDED CURRENT ACTION</span>
              <strong>Current action unavailable in this projection</strong>
              <p>
                The latest durable event is shown above. It is not presented as
                current model, provider, or browser activity.
              </p>
            </div>
            <span className="tiny-tag">no inference</span>
          </div>
        </section>

        <section
          aria-labelledby="live-candidate-cockpit"
          className="workspace-section"
          id="build"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">FOUR DURABLE SLOTS</span>
              <h2 id="live-candidate-cockpit">Candidate cockpit</h2>
              <p>
                Assigned identities are joined to build summaries by exact run
                ID. Empty and missing summaries remain visibly unavailable.
              </p>
            </div>
            <span className="status-pill active">
              <Radio aria-hidden="true" />
              {lanes.filter((lane) => lane.identity !== null).length} assigned
            </span>
          </div>
          <div className="candidate-grid">
            {lanes.map((lane, index) => (
              <LiveCandidateLane index={index} key={index} lane={lane} />
            ))}
          </div>
        </section>

        <section
          aria-labelledby="live-contract-payment"
          className="workspace-section"
          id="requirements"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">IMMUTABLE INPUTS</span>
              <h2 id="live-contract-payment">Contract and payment</h2>
              <p>
                Only the active proposal and its separately recorded payment
                receipt are shown.
              </p>
            </div>
          </div>
          <ContractAndPayment payment={payment} proposal={proposal} />
        </section>

        <section
          aria-labelledby="live-evidence"
          className="workspace-section"
          id="proof"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">EVIDENCE AVAILABILITY</span>
              <h2 id="live-evidence">Candidate comparison and proof</h2>
              <p>
                The current build summary exposes proof counts, not detailed
                receipts or source inspection artifacts.
              </p>
            </div>
          </div>
          <ProofAvailability lanes={lanes} />
        </section>

        <section
          aria-labelledby="live-operations"
          className="workspace-section"
          id="operations"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">PROVIDER BOUNDARIES</span>
              <h2 id="live-operations">Provider metadata</h2>
              <p>
                Configuration, health probes, and historical receipts are kept
                distinct.
              </p>
            </div>
          </div>
          <ProviderObservations integrations={data.integrations} />
          <OrchestrationProviderReceipts
            delivery={delivery}
            deployment={deployment}
            payment={payment}
          />
        </section>

        <section
          aria-labelledby="live-release-effects"
          className="workspace-section"
          id="updates"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">VERSION-BOUND EFFECTS</span>
              <h2 id="live-release-effects">
                Preview, deployment, and delivery
              </h2>
              <p>
                Links are rendered only from validated HTTPS receipts. Missing
                receipts remain unavailable.
              </p>
            </div>
          </div>
          <ReleaseReceipts
            delivery={delivery}
            deployment={deployment}
            preview={preview}
          />
          <DurableTimeline evidence={data.evidence} />
        </section>
      </div>
    </WorkspaceShell>
  );
}

interface CandidateLaneData {
  identity: {
    runId: string;
    candidateId: string;
    status: OperatorRunSummary["run"]["status"];
  } | null;
  summary: OperatorRunSummary | null;
}

function LiveCandidateLane({
  index,
  lane,
}: {
  index: number;
  lane: CandidateLaneData;
}) {
  const status = lane.summary?.run.status ?? lane.identity?.status;
  const summary = lane.summary;
  return (
    <article
      aria-label={`Candidate slot ${index + 1}: ${status ?? "unallocated"}`}
      className="candidate-lane"
    >
      <div className="candidate-header">
        <span className="candidate-identity">
          <span className="candidate-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span>
            <strong>Candidate slot {String(index + 1).padStart(2, "0")}</strong>
            <small className="mono">
              {lane.identity?.candidateId ?? "unallocated"}
            </small>
          </span>
        </span>
        <span className={`status-pill ${runTone(status)}`}>
          <span className="status-dot" aria-hidden="true" />
          {status ?? "unallocated"}
        </span>
      </div>
      <div className="wip-viewport">
        <span className="wip-watermark">
          <ShieldAlert aria-hidden="true" />
          UNVERIFIED WIP
        </span>
        <div className="wip-empty">
          <ImageOff aria-hidden="true" />
          <strong>
            {summary?.previewAvailable
              ? "Preview coordinate recorded"
              : "Observation unavailable"}
          </strong>
          <span>
            {summary?.previewAvailable
              ? "No frame was requested or loaded. Browser liveness is not asserted."
              : "No sanitized frame or browser liveness is present in this snapshot."}
          </span>
        </div>
      </div>
      <div className="activity-strip">
        <span className="activity-icon">
          {status === "failed" || status === "rejected" ? (
            <XCircle aria-hidden="true" />
          ) : status === "running" ? (
            <Activity aria-hidden="true" />
          ) : (
            <CircleDashed aria-hidden="true" />
          )}
        </span>
        <span className="activity-copy">
          <strong>{summary?.run.stage ?? "Run summary unavailable"}</strong>
          <small>
            {summary?.activity.latestEvent?.type ??
              "No bounded activity event recorded"}
          </small>
        </span>
        <time
          className="activity-time"
          dateTime={summary?.activity.latestEvent?.createdAt}
        >
          {summary?.activity.latestEvent
            ? formatTime(summary.activity.latestEvent.createdAt)
            : "--:--:--"}
        </time>
      </div>
      <div className="candidate-metrics">
        <CandidateMetric
          label="events"
          value={summary ? String(summary.activity.eventCount) : "--"}
        />
        <CandidateMetric
          label="proof pass"
          value={summary ? String(summary.proof.passed) : "--"}
        />
        <CandidateMetric
          label="proof fail"
          value={
            summary ? String(summary.proof.failed + summary.proof.errors) : "--"
          }
        />
        <CandidateMetric
          label="artifact"
          value={
            summary ? (summary.artifactAvailable ? "recorded" : "none") : "--"
          }
        />
      </div>
    </article>
  );
}

function CandidateMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="candidate-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function ContractAndPayment({
  payment,
  proposal,
}: {
  payment: ReturnType<typeof latestPayment>;
  proposal: ReturnType<typeof activeProposal>;
}) {
  return (
    <div className="split-view">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>
            {proposal
              ? `Acceptance Contract v${proposal.contract.version}`
              : "Acceptance Contract"}
          </h3>
          <LockKeyhole aria-hidden="true" size={16} />
        </div>
        {proposal ? (
          <>
            <div className="contract-summary">
              <p>{proposal.plan.summary.text}</p>
              <span>
                Created {formatTimestamp(proposal.contract.createdAt)} |
                immutable {shortDigest(proposal.contract.digest)}
              </span>
            </div>
            <div className="requirement-list">
              {proposal.contract.requirements.map((requirement, index) => (
                <div
                  className="requirement-row"
                  key={requirement.requirementId}
                >
                  <span className="requirement-index">{index + 1}</span>
                  <div>
                    <strong>{requirement.description}</strong>
                    <p>
                      {requirement.verifiers.length} controller verifier
                      {requirement.verifiers.length === 1 ? "" : "s"} recorded
                    </p>
                  </div>
                  <span className="tiny-tag">{requirement.priority}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Unavailable
            compact
            detail="No active immutable proposal is present."
            title="Contract unavailable"
          />
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Proposal and payment</h3>
          <ReceiptText aria-hidden="true" size={16} />
        </div>
        {proposal ? (
          <dl className="definition-list">
            <Definition label="Proposal" value={`v${proposal.version}`} />
            <Definition
              label="Quoted amount"
              value={formatMoney(
                proposal.quote.amountMinor,
                proposal.quote.currency,
              )}
            />
            <Definition
              label="Proposal digest"
              value={shortDigest(proposal.digest)}
            />
            <Definition
              label="Payment state"
              value={payment ? "verified receipt" : "unavailable"}
            />
            <Definition
              label="Evidence source"
              value={
                payment
                  ? payment.verificationSource.replace("_", " ")
                  : "unavailable"
              }
            />
            <Definition
              label="Payment amount"
              value={
                payment
                  ? formatMoney(payment.amountReceivedMinor, payment.currency)
                  : "unavailable"
              }
            />
            <Definition
              label="Environment"
              value={
                payment ? (payment.livemode ? "live" : "test") : "unavailable"
              }
            />
          </dl>
        ) : (
          <Unavailable
            compact
            detail="No active proposal is present, so payment cannot be joined to it."
            title="Commercial state unavailable"
          />
        )}
      </div>
    </div>
  );
}

function ProofAvailability({ lanes }: { lanes: CandidateLaneData[] }) {
  return (
    <div className="evidence-layout">
      <div className="data-panel evidence-wide">
        <div className="data-panel-header">
          <h3>Verifier receipt summaries</h3>
          <ListChecks aria-hidden="true" size={16} />
        </div>
        <div
          aria-label="Verifier receipt summary table"
          className="table-wrap"
          role="region"
          tabIndex={0}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">SLOT</th>
                <th scope="col">RUN</th>
                <th scope="col">TOTAL</th>
                <th scope="col">PASS</th>
                <th scope="col">FAIL</th>
                <th scope="col">ERROR</th>
                <th scope="col">HARD REQUIREMENTS</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane, index) => (
                <tr key={index}>
                  <td>{String(index + 1).padStart(2, "0")}</td>
                  <td className="mono">
                    {lane.identity
                      ? shortId(lane.identity.runId)
                      : "unallocated"}
                  </td>
                  <td>{lane.summary?.proof.total ?? "--"}</td>
                  <td className="diff-add">
                    {lane.summary?.proof.passed ?? "--"}
                  </td>
                  <td className="diff-remove">
                    {lane.summary?.proof.failed ?? "--"}
                  </td>
                  <td className="diff-remove">
                    {lane.summary?.proof.errors ?? "--"}
                  </td>
                  <td>{lane.summary?.proof.hardRequirements ?? "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <UnavailablePanel
        detail="The bounded run summary contains counts only. Individual verifier receipts require a separate allowlisted projection."
        icon={CheckCircle2}
        title="Verifier receipts unavailable"
      />
      <UnavailablePanel
        detail="No controller-recorded file diff is included in the current run or orchestration snapshot."
        icon={FileDiff}
        title="Candidate diff unavailable"
      />
      <UnavailablePanel
        detail="No controller-recorded component tree is included in the current projection."
        icon={Boxes}
        title="Component tree unavailable"
      />
      <UnavailablePanel
        detail="CodeRabbit findings and policy digests are not included in this bounded endpoint."
        icon={TriangleAlert}
        title="CodeRabbit findings unavailable"
      />
      <UnavailablePanel
        detail="Braintrust score records and internal scoring details are not included in this bounded endpoint."
        icon={Gauge}
        title="Braintrust scores unavailable"
      />
    </div>
  );
}

function UnavailablePanel({
  detail,
  icon: Icon,
  title,
}: {
  detail: string;
  icon: typeof Gauge;
  title: string;
}) {
  return (
    <div className="data-panel">
      <div className="data-panel-header">
        <h3>{title}</h3>
        <Icon aria-hidden="true" size={16} />
      </div>
      <Unavailable compact detail={detail} title="Not in projection" />
    </div>
  );
}

function ProviderObservations({
  integrations,
}: {
  integrations: OperatorIntegrationsSnapshot | null;
}) {
  if (!integrations) {
    return (
      <Unavailable
        detail="The integration endpoint was unavailable or failed validation. No provider state is inferred."
        title="Provider observations unavailable"
      />
    );
  }
  return (
    <div className="data-panel">
      <div className="data-panel-header">
        <h3>Build-provider observations</h3>
        <Radio aria-hidden="true" size={16} />
      </div>
      <div className="provider-list">
        {PROVIDERS.map((provider) => {
          const state = integrations.status[provider.key];
          return (
            <div className="provider-row" key={provider.key}>
              <div>
                <strong>{provider.name}</strong>
                <p>
                  {provider.responsibility} |{" "}
                  {providerDetail(state, integrations.lastProbeAt)}
                </p>
              </div>
              <div className="provider-state">
                <span className={`status-pill ${providerTone(state)}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {state.replaceAll("-", " ")}
                </span>
                <time dateTime={integrations.lastProbeAt ?? undefined}>
                  {integrations.lastProbeAt
                    ? formatTimestamp(integrations.lastProbeAt)
                    : "no probe recorded"}
                </time>
              </div>
            </div>
          );
        })}
        {ORCHESTRATION_PROVIDERS.map((provider) => (
          <div className="provider-row" key={provider.name}>
            <div>
              <strong>{provider.name}</strong>
              <p>
                {provider.responsibility} | no current health observation is
                provided by the build integration endpoint
              </p>
            </div>
            <div className="provider-state">
              <span className="status-pill unavailable">
                <span className="status-dot" aria-hidden="true" />
                unavailable
              </span>
              <time>no probe recorded</time>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrchestrationProviderReceipts({
  delivery,
  deployment,
  payment,
}: {
  delivery: ReturnType<typeof latestEffect>;
  deployment: ReturnType<typeof latestDeployment>;
  payment: ReturnType<typeof latestPayment>;
}) {
  const rows = [
    {
      name: "Stripe",
      state: payment ? "receipt recorded" : "unavailable",
      detail: payment
        ? `Verified payment receipt at ${formatTimestamp(payment.verifiedAt)}. Current provider health is not asserted.`
        : "No payment receipt and no current provider-health observation.",
    },
    {
      name: "Fly.io",
      state: deployment ? "receipt recorded" : "unavailable",
      detail: deployment
        ? `HTTPS deployment receipt verified at ${formatTimestamp(deployment.verifiedAt)}. Current provider health is not asserted.`
        : "No deployment receipt and no current provider-health observation.",
    },
    {
      name: "Resend",
      state: delivery ? `effect ${delivery.status}` : "unavailable",
      detail: delivery
        ? `Final-delivery effect updated at ${formatTimestamp(delivery.updatedAt)}. This is effect state, not provider health.`
        : "No final-delivery effect and no current provider-health observation.",
    },
  ];
  return (
    <div className="data-panel operator-secondary-panel">
      <div className="data-panel-header">
        <h3>Orchestration-provider receipts</h3>
        <ReceiptText aria-hidden="true" size={16} />
      </div>
      <div className="provider-list">
        {rows.map((row) => (
          <div className="provider-row" key={row.name}>
            <div>
              <strong>{row.name}</strong>
              <p>{row.detail}</p>
            </div>
            <span
              className={`status-pill ${row.state === "unavailable" ? "unavailable" : "recorded"}`}
            >
              {row.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReleaseReceipts({
  delivery,
  deployment,
  preview,
}: {
  delivery: ReturnType<typeof latestEffect>;
  deployment: ReturnType<typeof latestDeployment>;
  preview: ReturnType<typeof latestPreview>;
}) {
  return (
    <div className="release-grid">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Frozen review preview</h3>
          <PackageCheck aria-hidden="true" size={16} />
        </div>
        {preview ? (
          <>
            <dl className="definition-list">
              <Definition
                label="Contract/proposal"
                value={`v${preview.proposalVersion}`}
              />
              <Definition
                label="Artifact"
                value={shortDigest(preview.artifactDigest)}
              />
              <Definition
                label="Revision"
                value={shortDigest(preview.revisionHash)}
              />
              <Definition
                label="Verified"
                value={formatTimestamp(preview.verifiedAt)}
              />
              <Definition
                label="Expires"
                value={formatTimestamp(preview.expiresAt)}
              />
            </dl>
            <div className="panel-action">
              <a
                className="secondary-button"
                href={preview.url}
                rel="noreferrer"
                target="_blank"
              >
                Exact frozen artifact
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <Unavailable
            compact
            detail="No immutable, HTTPS-healthy preview receipt is recorded."
            title="Frozen preview unavailable"
          />
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Production deployment</h3>
          <Box aria-hidden="true" size={16} />
        </div>
        {deployment ? (
          <>
            <dl className="definition-list">
              <Definition
                label="Release"
                value={`v${deployment.releaseVersion}`}
              />
              <Definition
                label="Contract/proposal"
                value={`v${deployment.proposalVersion}`}
              />
              <Definition
                label="Artifact"
                value={shortDigest(deployment.artifactDigest)}
              />
              <Definition
                label="Image"
                value={shortDigest(deployment.imageDigest)}
              />
              <Definition
                label="Verified"
                value={formatTimestamp(deployment.verifiedAt)}
              />
            </dl>
            <div className="panel-action">
              <a
                className="secondary-button"
                href={deployment.url}
                rel="noreferrer"
                target="_blank"
              >
                Production release
                <ArrowUpRight aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <Unavailable
            compact
            detail="No HTTPS-healthy production deployment receipt is recorded."
            title="Deployment unavailable"
          />
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Final delivery effect</h3>
          <CheckCircle2 aria-hidden="true" size={16} />
        </div>
        {delivery ? (
          <dl className="definition-list">
            <Definition label="State" value={delivery.status} />
            <Definition label="Attempts" value={String(delivery.attempts)} />
            <Definition
              label="Updated"
              value={formatTimestamp(delivery.updatedAt)}
            />
            <Definition
              label="Settled"
              value={
                delivery.completedAt
                  ? formatTimestamp(delivery.completedAt)
                  : "not settled"
              }
            />
          </dl>
        ) : (
          <Unavailable
            compact
            detail="No final-delivery effect is recorded."
            title="Delivery effect unavailable"
          />
        )}
      </div>
    </div>
  );
}

function DurableTimeline({ evidence }: { evidence: OperatorEvidenceSnapshot }) {
  const events = evidence.events.items.slice(-20).reverse();
  return (
    <div className="data-panel operator-secondary-panel">
      <div className="data-panel-header">
        <h3>Durable event tail</h3>
        <span className="tiny-tag">
          {evidence.events.nextAfterSequence
            ? `more after ${evidence.events.nextAfterSequence}`
            : "window complete"}
        </span>
      </div>
      {events.length === 0 ? (
        <Unavailable
          compact
          detail="No orchestration event is present in this bounded window."
          title="Event tail unavailable"
        />
      ) : (
        <div className="update-list">
          {events.map((event) => (
            <div className="update-row operator-event-row" key={event.eventId}>
              <span className="status-pill configured">{event.actor}</span>
              <div>
                <strong>{event.type}</strong>
                <p>
                  aggregate revision {event.aggregateRevision} | sequence{" "}
                  {event.sequence}
                </p>
              </div>
              <time dateTime={event.occurredAt}>
                {formatTimestamp(event.occurredAt)}
              </time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryCell({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: string;
}) {
  return (
    <div className="summary-cell">
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RefreshButton({
  disabled,
  onRefresh,
}: {
  disabled: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      aria-label="Refresh durable snapshot"
      className="icon-button"
      data-tooltip="Refresh durable snapshot"
      disabled={disabled}
      onClick={onRefresh}
      type="button"
    >
      {disabled ? (
        <LoaderCircle aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
    </button>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-live="polite" className="loading-state">
      <LoaderCircle aria-hidden="true" />
      <strong>{label}</strong>
      <p>
        No run, provider, proof, or browser activity is inferred while absent.
      </p>
    </div>
  );
}

function LoadError({
  onRefresh,
  sessionExpired,
}: {
  onRefresh: () => void;
  sessionExpired: boolean;
}) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert aria-hidden="true" />
      <strong>
        {sessionExpired
          ? "Operator session expired"
          : "Durable projection unavailable"}
      </strong>
      <p>
        {sessionExpired
          ? "Sign in again. No project state was disclosed."
          : "The BFF request failed or its response did not pass the allowlisted schema. No state is inferred."}
      </p>
      {sessionExpired ? (
        <Link className="secondary-button" href="/operator/sign-in">
          Operator sign in
        </Link>
      ) : (
        <button className="secondary-button" onClick={onRefresh} type="button">
          <RefreshCw aria-hidden="true" />
          Retry snapshot
        </button>
      )}
    </div>
  );
}

function Unavailable({
  compact = false,
  detail,
  title,
}: {
  compact?: boolean;
  detail: string;
  title: string;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <SquareDashed aria-hidden="true" />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

class SessionExpiredError extends Error {}

async function fetchOperatorJson(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new SessionExpiredError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Operator BFF request failed");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Operator BFF returned a non-JSON response");
  }
  return response.json() as Promise<unknown>;
}

async function loadQueue(signal: AbortSignal): Promise<QueueData> {
  const [runsValue, integrationsResult] = await Promise.all([
    fetchOperatorJson("/api/operator/runs?limit=100", signal),
    fetchOperatorJson("/api/operator/integrations", signal).catch(() => null),
  ]);
  return {
    runs: parseOperatorRunSnapshot(runsValue),
    integrations:
      integrationsResult === null
        ? null
        : parseOperatorIntegrationsSnapshot(integrationsResult),
  };
}

async function loadProject(
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectData> {
  const encodedProjectId = encodeURIComponent(projectId);
  const [runsValue, evidenceValue, integrationsResult] = await Promise.all([
    fetchOperatorJson(
      `/api/operator/runs?limit=100&projectId=${encodedProjectId}`,
      signal,
    ),
    fetchOperatorJson(
      `/api/operator/projects/${encodedProjectId}/evidence?afterSequence=0&limit=500`,
      signal,
    ),
    fetchOperatorJson("/api/operator/integrations", signal).catch(() => null),
  ]);
  const runs = parseOperatorRunSnapshot(runsValue);
  if (runs.runs.some(({ run }) => run.projectId !== projectId)) {
    throw new Error("Operator run snapshot crossed a project boundary");
  }
  return {
    runs,
    evidence: parseOperatorEvidenceSnapshot(evidenceValue, projectId),
    integrations:
      integrationsResult === null
        ? null
        : parseOperatorIntegrationsSnapshot(integrationsResult),
  };
}

function projectLanes(
  evidence: OperatorEvidenceSnapshot,
  snapshot: OperatorRunSnapshot,
): CandidateLaneData[] {
  const batch = activeBatch(evidence);
  const summaries = new Map(
    snapshot.runs.map((summary) => [summary.run.id, summary]),
  );
  const lanes: CandidateLaneData[] = [];
  const included = new Set<string>();

  for (const identity of batch?.runs ?? []) {
    included.add(identity.runId);
    lanes.push({
      identity,
      summary: summaries.get(identity.runId) ?? null,
    });
  }
  for (const summary of snapshot.runs) {
    if (lanes.length >= 4 || included.has(summary.run.id)) {
      continue;
    }
    lanes.push({
      identity: {
        runId: summary.run.id,
        candidateId: summary.run.candidateId,
        status: summary.run.status,
      },
      summary,
    });
  }
  while (lanes.length < 4) {
    lanes.push({ identity: null, summary: null });
  }
  return lanes.slice(0, 4);
}

function findLatestDurableEvent(data: ProjectData): {
  actor: string;
  at: string;
  label: string;
} | null {
  const runEvents = data.runs.runs.flatMap((summary) =>
    summary.activity.latestEvent
      ? [
          {
            actor: "build backend",
            at: summary.activity.latestEvent.createdAt,
            label: summary.activity.latestEvent.type,
          },
        ]
      : [],
  );
  const projectEvents = data.evidence.events.items.map((event) => ({
    actor: event.actor,
    at: event.occurredAt,
    label: event.type,
  }));
  return (
    [...runEvents, ...projectEvents].sort((left, right) =>
      right.at.localeCompare(left.at),
    )[0] ?? null
  );
}

function liveCopilotProjection(
  evidence: OperatorEvidenceSnapshot,
  lanes: CandidateLaneData[],
  latestEvent: ReturnType<typeof findLatestDurableEvent>,
): CopilotOperatorProjection {
  const proposal = activeProposal(evidence);
  return {
    fixture: false,
    projectId: evidence.project.projectId,
    lifecycle: evidence.project.status,
    versions: {
      activeProposal: evidence.project.activeProposalVersion ?? null,
      paidProposal: evidence.project.paidProposalVersion ?? null,
      contract: proposal?.contract.version ?? null,
      production: latestDeployment(evidence)?.proposalVersion ?? null,
    },
    currentAction: {
      label: "Current action unavailable",
      detail: latestEvent
        ? `Latest durable event: ${latestEvent.label}`
        : "No bounded durable event is present.",
      owner: "unavailable",
    },
    candidates: lanes.flatMap((lane) =>
      lane.identity
        ? [
            {
              candidateId: lane.identity.candidateId,
              status: lane.summary?.run.status ?? lane.identity.status,
              stage: lane.summary?.run.stage ?? "unavailable",
              hardRequirements: lane.summary
                ? `count_only:${lane.summary.proof.hardRequirements}`
                : "unavailable",
            },
          ]
        : [],
    ),
  };
}

function latestEffect(
  evidence: OperatorEvidenceSnapshot,
  type: OperatorEvidenceSnapshot["project"]["effects"][number]["type"],
): OperatorEvidenceSnapshot["project"]["effects"][number] | null {
  return (
    evidence.project.effects
      .filter((effect) => effect.type === type)
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0] ?? null
  );
}

function countRunStates(runs: OperatorRunSummary[]) {
  return {
    active: runs.filter(({ run }) => ["queued", "running"].includes(run.status))
      .length,
    passed: runs.filter(({ run }) => run.status === "passed").length,
    failed: runs.filter(({ run }) =>
      ["rejected", "failed", "cancelled"].includes(run.status),
    ).length,
  };
}

function providerDetail(
  state: OperatorProviderState,
  observedAt: string | null,
): string {
  if (!observedAt) {
    return state === "configured"
      ? "configuration only; health has not been probed"
      : "no bounded probe timestamp is recorded";
  }
  return `bounded probe recorded at ${formatTimestamp(observedAt)}`;
}

function providerTone(state: OperatorProviderState): string {
  if (state === "healthy" || state === "end-to-end-verified") {
    return "healthy";
  }
  if (state === "configured") {
    return "configured";
  }
  return "unavailable";
}

function lifecycleTone(status: OperatorEvidenceSnapshot["project"]["status"]) {
  if (
    [
      "failed",
      "payment_verification_failed",
      "deployment_verification_failed",
      "no_proven_candidate",
      "needs_operator_attention",
    ].includes(status)
  ) {
    return "failed";
  }
  if (
    [
      "needs_clarification",
      "awaiting_customer_revision",
      "awaiting_payment",
      "revision_pending",
    ].includes(status)
  ) {
    return "waiting";
  }
  if (status === "completed") {
    return "proven";
  }
  return "active";
}

function runTone(
  status: OperatorRunSummary["run"]["status"] | undefined,
): string {
  if (status === "passed") {
    return "pass";
  }
  if (status === "running") {
    return "running";
  }
  if (status === "queued") {
    return "waiting";
  }
  if (status) {
    return "failed";
  }
  return "unavailable";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function shortId(value: string): string {
  return value.length > 18
    ? `${value.slice(0, 8)}...${value.slice(-6)}`
    : value;
}

function shortDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice(7) : value;
  return `${digest.slice(0, 8)}...${digest.slice(-6)}`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amountMinor / 100);
}
