"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  CreditCard,
  ExternalLink,
  FileCheck2,
  ImageOff,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  Radio,
  RefreshCw,
  Rocket,
  Send,
  ShieldAlert,
  ShieldCheck,
  SquareDashed,
  TriangleAlert,
  WifiOff,
  XCircle,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import type {
  Builder,
  CustomerEvent,
  CustomerProjectSnapshot,
} from "../lib/contracts";
import { CopilotCustomerBindings } from "./copilot-customer-bindings";
import { ProjectVoiceAgent } from "./project-voice-agent";
import { type SteeringInput, useCustomerProject } from "./use-customer-project";
import { WorkspaceShell } from "./workspace-shell";

export function CustomerWorkspace({
  fixture,
  initialEvents = [],
  initialSnapshot,
  projectAlias,
}: {
  fixture: boolean;
  initialEvents?: CustomerEvent[];
  initialSnapshot?: CustomerProjectSnapshot;
  projectAlias: string;
}) {
  const project = useCustomerProject({
    fixture,
    projectAlias,
    ...(initialSnapshot === undefined ? {} : { initialSnapshot }),
  });
  const snapshot = project.projectState?.snapshot ?? initialSnapshot;

  if (project.sessionExpired) {
    return <SessionExpired />;
  }
  if (!snapshot) {
    return (
      <ProjectLoading
        {...(project.loadError === undefined
          ? {}
          : { error: project.loadError })}
        onRetry={() => void project.refreshSnapshot()}
      />
    );
  }

  const events = [...(project.projectState?.events ?? []), ...initialEvents]
    .filter(
      (event, index, values) =>
        values.findIndex((value) => value.eventId === event.eventId) === index,
    )
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, 50);

  const workspace = (
    <WorkspaceShell
      fixture={fixture}
      projectTitle={snapshot.title}
      role="Customer workspace"
      status={snapshot.lifecycle.label}
      statusTone={lifecycleTone(snapshot.lifecycle.canonical)}
      transport={project.transport}
    >
      <CustomerWorkspaceContent
        events={events}
        fixture={fixture}
        projectAlias={projectAlias}
        snapshot={snapshot}
        steering={project.steering}
        submitSteering={project.submitSteering}
        transport={project.transport}
      />
    </WorkspaceShell>
  );
  if (fixture) {
    return workspace;
  }

  return (
    <CopilotKit
      credentials="same-origin"
      defaultThrottleMs={250}
      enableInspector={false}
      runtimeUrl={`/api/copilotkit/customer/${encodeURIComponent(projectAlias)}`}
      showDevConsole={false}
    >
      {workspace}
    </CopilotKit>
  );
}

function CustomerWorkspaceContent({
  events,
  fixture,
  projectAlias,
  snapshot,
  steering,
  submitSteering,
  transport,
}: {
  events: CustomerEvent[];
  fixture: boolean;
  projectAlias: string;
  snapshot: CustomerProjectSnapshot;
  steering: ReturnType<typeof useCustomerProject>["steering"];
  submitSteering: (
    input: SteeringInput,
    retainedIdempotencyKey?: string,
  ) => Promise<void>;
  transport: ReturnType<typeof useCustomerProject>["transport"];
}) {
  const [selectedBuilder, setSelectedBuilder] = useState<string>();
  const selected =
    snapshot.activeBatch?.builders.find(
      (builder) => builder.builderId === selectedBuilder,
    ) ?? null;

  return (
    <div className="workspace">
      {fixture ? null : (
        <CopilotCustomerBindings
          onSteeringRequested={submitSteering}
          snapshot={snapshot}
        />
      )}
      {transport !== "live" && transport !== "fixture" ? (
        <TransportNotice transport={transport} />
      ) : null}
      {fixture ? (
        <div className="notice-banner info" role="status">
          <ShieldAlert aria-hidden="true" />
          <span>
            This is a deterministic fixture snapshot for local QA. It is not a
            provider run and does not represent current browser liveness.
          </span>
          <span className="tiny-tag">FIXTURE</span>
        </div>
      ) : null}
      {snapshot.requestedVersion !== null &&
      snapshot.currentProductionVersion !== null &&
      snapshot.requestedVersion !== snapshot.currentProductionVersion ? (
        <div className="notice-banner" role="status">
          <ShieldAlert aria-hidden="true" />
          <span>
            Revision {snapshot.requestedVersion} is unverified work. Release{" "}
            {snapshot.currentProductionVersion} remains the only
            production-bound artifact.
          </span>
          <span className="tiny-tag">VERSION BOUND</span>
        </div>
      ) : null}

      <section
        aria-labelledby="customer-overview-title"
        className="workspace-section"
        id="overview"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">PROJECT TRUTH</span>
            <h2 id="customer-overview-title">Current version</h2>
            <p>
              Requested work, paid scope, active proof, and the current proven
              release stay versioned independently.
            </p>
          </div>
          <span className="tiny-tag mono">
            revision {snapshot.aggregateRevision}
          </span>
        </div>
        <CustomerMilestones snapshot={snapshot} />
        <CustomerSummary snapshot={snapshot} />
        <PrimaryAction snapshot={snapshot} />
      </section>

      <section
        aria-labelledby="customer-build-title"
        className="workspace-section"
        id="build"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">SANITIZED OBSERVATION</span>
            <h2 id="customer-build-title">Build cockpit</h2>
            <p>
              Four stable lanes show controller-recorded activity. WIP frames
              are raster-only, non-interactive, and never review approval.
            </p>
          </div>
          <span className="status-pill running">
            <Radio aria-hidden="true" />
            {snapshot.activeBatch
              ? `${snapshot.activeBatch.requestedBuilderCount} allocated`
              : "Awaiting dispatch"}
          </span>
        </div>
        {snapshot.activeBatch ? (
          <div className="candidate-grid">
            {snapshot.activeBatch.builders.map((builder, index) => (
              <CustomerBuilderLane
                builder={builder}
                contractVersion={snapshot.activeBatch!.contractVersion}
                fixture={fixture}
                index={index}
                key={builder.builderId}
                onSelect={setSelectedBuilder}
                projectAlias={projectAlias}
                selected={selectedBuilder === builder.builderId}
              />
            ))}
          </div>
        ) : (
          <Unavailable
            detail="Build dispatch has not been recorded for this contract."
            title="Builders awaiting dispatch"
          />
        )}
        {selected ? (
          <div className="selected-builder-note" role="status">
            <Activity aria-hidden="true" />
            <div>
              <strong>{selected.displayName} selected</strong>
              <p>
                {selected.currentActivity
                  ? activityLabel(selected.currentActivity.action)
                  : "No allowlisted activity has been recorded."}
              </p>
            </div>
            <button
              aria-label="Close selected builder detail"
              className="icon-button"
              data-tooltip="Close detail"
              onClick={() => setSelectedBuilder(undefined)}
              type="button"
            >
              <XCircle aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </section>

      <section
        aria-labelledby="customer-requirements-title"
        className="workspace-section"
        id="requirements"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">WHAT YOU APPROVED</span>
            <h2 id="customer-requirements-title">Acceptance Contract</h2>
            <p>
              Hard requirements need deterministic evidence. Preferences rank
              only candidates that pass the hard gate.
            </p>
          </div>
          {snapshot.contract ? (
            <span className="status-pill revision">
              <LockKeyhole aria-hidden="true" />v{snapshot.contract.version}{" "}
              immutable
            </span>
          ) : null}
        </div>
        <CustomerContract snapshot={snapshot} />
      </section>

      <section
        aria-labelledby="customer-proof-title"
        className="workspace-section"
        id="proof"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">AUTOMATED GATE</span>
            <h2 id="customer-proof-title">Proof and releases</h2>
            <p>
              Only a frozen artifact that passed the complete adaptive gate can
              become a review preview or production release.
            </p>
          </div>
        </div>
        <CustomerProof snapshot={snapshot} />
      </section>

      <section
        aria-labelledby="customer-updates-title"
        className="workspace-section"
        id="updates"
      >
        <div className="section-heading">
          <div>
            <span className="section-kicker">ORDERED HISTORY</span>
            <h2 id="customer-updates-title">Updates and steering</h2>
            <p>
              Sending a request means received only. The orchestrator still
              classifies scope, pricing, contract impact, and proof.
            </p>
          </div>
        </div>
        <div className="split-view updates-layout">
          <CustomerTimeline events={events} />
          <SteeringComposer
            snapshot={snapshot}
            state={steering}
            submit={submitSteering}
          />
        </div>
      </section>

      <ProjectVoiceAgent fixture={fixture} />
    </div>
  );
}

function CustomerMilestones({
  snapshot,
}: {
  snapshot: CustomerProjectSnapshot;
}) {
  return (
    <div className="milestone-rail">
      {snapshot.milestoneStates.map((milestone, index) => (
        <div className={`milestone ${milestone.state}`} key={milestone.id}>
          <span className="milestone-index">
            {milestone.state === "complete" ? (
              <Check aria-hidden="true" />
            ) : (
              index + 1
            )}
          </span>
          <strong>{milestoneLabel(milestone.id)}</strong>
          <small>
            {milestone.receiptAt
              ? formatDate(milestone.receiptAt)
              : milestone.state.replace("_", " ")}
          </small>
        </div>
      ))}
    </div>
  );
}

function CustomerSummary({ snapshot }: { snapshot: CustomerProjectSnapshot }) {
  return (
    <div className="summary-strip customer-summary">
      <div className="summary-cell">
        <span className="metric-label">APPROVED SCOPE</span>
        <strong>{snapshot.contract?.title ?? "Scope is being prepared"}</strong>
        <p>
          {snapshot.contract?.summary ??
            "No immutable contract summary is available yet."}
        </p>
      </div>
      <div className="summary-cell">
        <span className="metric-label">REQUESTED</span>
        <span className="metric-value">
          {versionLabel(snapshot.requestedVersion)}
        </span>
        <p>{snapshot.lifecycle.label}</p>
      </div>
      <div className="summary-cell">
        <span className="metric-label">PAID BASIS</span>
        <span className="metric-value">
          {versionLabel(snapshot.paidCommercialVersion)}
        </span>
        <p>
          {snapshot.paidCommercialVersion === snapshot.requestedVersion
            ? "Matches requested scope"
            : "Payment re-gating may be required"}
        </p>
      </div>
      <div className="summary-cell">
        <span className="metric-label">CURRENT PRODUCTION</span>
        <span className="metric-value">
          {versionLabel(snapshot.currentProductionVersion)}
        </span>
        <p>
          {snapshot.currentProductionVersion === snapshot.requestedVersion
            ? "Matches requested version"
            : "Prior proven release remains current"}
        </p>
      </div>
    </div>
  );
}

function PrimaryAction({ snapshot }: { snapshot: CustomerProjectSnapshot }) {
  const action = snapshot.pendingAction;
  if (action === "none" || action === "watch") {
    return (
      <div className="current-action-line">
        <Activity aria-hidden="true" />
        <div>
          <span className="micro-label">CURRENT ACTION</span>
          <strong>
            {action === "watch"
              ? "Watch durable build updates"
              : "No customer action required"}
          </strong>
          <p>
            The next state change will come from a recorded controller event.
          </p>
        </div>
      </div>
    );
  }
  if (action === "open_production" && snapshot.production) {
    return (
      <div className="current-action-line">
        <Rocket aria-hidden="true" />
        <div>
          <span className="micro-label">PRIMARY ACTION</span>
          <strong>Open verified production</strong>
          <p>
            Release {snapshot.production.releaseVersion} · contract v
            {snapshot.production.contractVersion}
          </p>
        </div>
        <a
          className="primary-button"
          href={snapshot.production.url}
          rel="noreferrer"
          target="_blank"
        >
          Open production
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    );
  }
  if (action === "review_preview" && snapshot.preview) {
    return (
      <div className="current-action-line">
        <PackageCheck aria-hidden="true" />
        <div>
          <span className="micro-label">PRIMARY ACTION</span>
          <strong>Review frozen proven version</strong>
          <p>
            Contract v{snapshot.preview.contractVersion} · immutable artifact
          </p>
        </div>
        <a
          className="primary-button"
          href={snapshot.preview.url}
          rel="noreferrer"
          target="_blank"
        >
          Open frozen preview
          <ExternalLink aria-hidden="true" />
        </a>
      </div>
    );
  }
  return (
    <div className="current-action-line">
      {action === "pay" ? (
        <CreditCard aria-hidden="true" />
      ) : (
        <MessageSquareText aria-hidden="true" />
      )}
      <div>
        <span className="micro-label">CUSTOMER ACTION NEEDED</span>
        <strong>
          {action === "pay"
            ? "Payment is awaiting verification"
            : "A clarification is needed"}
        </strong>
        <p>
          Use the durable proposal or updates workflow. No build is dispatched
          before exact payment verification.
        </p>
      </div>
    </div>
  );
}

function CustomerBuilderLane({
  builder,
  contractVersion,
  fixture,
  index,
  onSelect,
  projectAlias,
  selected,
}: {
  builder: Builder;
  contractVersion: number;
  fixture: boolean;
  index: number;
  onSelect: (builderId: string) => void;
  projectAlias: string;
  selected: boolean;
}) {
  return (
    <article
      aria-label={`${builder.displayName}: ${builderStatusLabel(builder)}`}
      className="candidate-lane"
      data-selected={selected}
    >
      <button
        aria-pressed={selected}
        className="candidate-header candidate-select"
        disabled={builder.allocation === "not_allocated"}
        onClick={() => onSelect(builder.builderId)}
        type="button"
      >
        <span className="candidate-identity">
          <span className="candidate-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span>
            <strong>{builder.displayName}</strong>
            <small>{builderStatusLabel(builder)}</small>
          </span>
        </span>
        <span className={`status-pill ${builderTone(builder.status)}`}>
          <span className="status-dot" aria-hidden="true" />
          {builder.status.replaceAll("_", " ")}
        </span>
      </button>
      <CustomerWip
        builder={builder}
        contractVersion={contractVersion}
        fixture={fixture}
        projectAlias={projectAlias}
      />
      <div className="activity-strip">
        <span className="activity-icon">
          {builder.currentActivity?.outcome === "failed" ? (
            <XCircle aria-hidden="true" />
          ) : builder.currentActivity ? (
            <Activity aria-hidden="true" />
          ) : (
            <Clock3 aria-hidden="true" />
          )}
        </span>
        <span className="activity-copy">
          <strong>
            {builder.currentActivity
              ? activityLabel(builder.currentActivity.action)
              : builder.allocation === "not_allocated"
                ? "Not allocated"
                : "Awaiting recorded activity"}
          </strong>
          <small>
            {builder.currentActivity
              ? outcomeLabel(builder.currentActivity.outcome)
              : "No activity is inferred"}
          </small>
        </span>
        <time
          className="activity-time"
          dateTime={builder.currentActivity?.occurredAt ?? undefined}
        >
          {builder.currentActivity
            ? formatTime(builder.currentActivity.occurredAt)
            : "—"}
        </time>
      </div>
      <div className="candidate-metrics">
        <Metric
          label="tool calls"
          value={builder.progress.completedToolCalls}
        />
        <Metric label="failures" value={builder.progress.failedToolCalls} />
        <Metric label="receipts" value={builder.progress.proofReceiptCount} />
        <Metric label="repair round" value={builder.progress.repairRound} />
      </div>
    </article>
  );
}

function CustomerWip({
  builder,
  contractVersion,
  fixture,
  projectAlias,
}: {
  builder: Builder;
  contractVersion: number;
  fixture: boolean;
  projectAlias: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const renderable =
    builder.workspace.customerRenderable &&
    builder.workspace.latestFrameId !== null &&
    !imageFailed;
  const source = fixture
    ? `/api/fixtures/wip/${encodeURIComponent(builder.builderId)}`
    : `/v1/customer/projects/${encodeURIComponent(projectAlias)}/builders/${encodeURIComponent(builder.builderId)}/wip/frames/${encodeURIComponent(builder.workspace.latestFrameId ?? "")}`;
  return (
    <div className="wip-viewport customer-wip">
      <span className="wip-watermark">
        <ShieldAlert aria-hidden="true" />
        UNVERIFIED WIP
      </span>
      {renderable ? (
        // The gateway returns server-composited PNG pixels only. This image is
        // deliberately non-interactive and cannot navigate the generated app.
        <Image
          alt={`Sanitized unverified observation for ${builder.displayName}, contract version ${contractVersion}, captured ${builder.workspace.capturedAt ?? "at an unknown time"}`}
          draggable={false}
          fill
          onError={() => setImageFailed(true)}
          sizes="(max-width: 760px) 100vw, 50vw"
          src={source}
          unoptimized
        />
      ) : (
        <div className="wip-empty">
          {builder.workspace.state === "starting" ? (
            <LoaderCircle aria-hidden="true" />
          ) : builder.workspace.state === "blocked" ? (
            <ShieldAlert aria-hidden="true" />
          ) : (
            <ImageOff aria-hidden="true" />
          )}
          <strong>{workspaceLabel(builder.workspace.state)}</strong>
          <span>
            No visual progress or browser liveness is inferred from this state.
          </span>
        </div>
      )}
      <span className="wip-capture">
        v{contractVersion} ·{" "}
        {builder.workspace.capturedAt
          ? formatTime(builder.workspace.capturedAt)
          : "no safe frame"}
      </span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="candidate-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function CustomerContract({ snapshot }: { snapshot: CustomerProjectSnapshot }) {
  if (!snapshot.contract) {
    return (
      <Unavailable
        detail="An immutable contract has not been recorded yet."
        title="Contract unavailable"
      />
    );
  }
  const requirements = snapshot.contract.requirements;
  return (
    <div className="split-view">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>{snapshot.contract.title}</h3>
          <span className="tiny-tag">
            {requirements.filter((item) => item.priority === "hard").length}{" "}
            hard
          </span>
        </div>
        <div className="contract-summary">
          <p>{snapshot.contract.summary}</p>
          <span>
            {snapshot.contract.deliverables.length} deliverables ·{" "}
            {snapshot.contract.unknowns.length} unresolved questions
          </span>
        </div>
        <div className="requirement-list">
          {requirements.map((requirement, index) => (
            <div className="requirement-row" key={requirement.id}>
              <span className="requirement-index">{index + 1}</span>
              <div>
                <strong>{requirement.text}</strong>
                <p>
                  {requirement.priority === "hard"
                    ? "Deterministic evidence required"
                    : "Preference-ranking signal"}
                </p>
              </div>
              <span className="tiny-tag">{requirement.priority}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Deliverables</h3>
          <FileCheck2 aria-hidden="true" size={16} />
        </div>
        <div className="requirement-list">
          {snapshot.contract.deliverables.map((deliverable, index) => (
            <div className="requirement-row" key={deliverable.id}>
              <span className="requirement-index">{index + 1}</span>
              <div>
                <strong>{deliverable.text}</strong>
                <p>Contract v{snapshot.contract!.version}</p>
              </div>
              <CheckCircle2 aria-hidden="true" color="var(--green)" size={16} />
            </div>
          ))}
        </div>
        {snapshot.contract.unknowns.length > 0 ? (
          <div className="unknowns-block">
            <span className="micro-label">OPEN CLARIFICATIONS</span>
            {snapshot.contract.unknowns.map((unknown) => (
              <p key={unknown}>{unknown}</p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CustomerProof({ snapshot }: { snapshot: CustomerProjectSnapshot }) {
  return (
    <div className="proof-release-layout">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Active proof</h3>
          <ShieldCheck aria-hidden="true" size={16} />
        </div>
        {snapshot.proof ? (
          <div className="proof-summary">
            <span
              className={`proof-count ${snapshot.proof.state === "blocked" ? "blocked" : ""}`}
            >
              {snapshot.proof.receiptCount}
            </span>
            <div>
              <strong>Contract v{snapshot.proof.contractVersion}</strong>
              <p>
                {snapshot.proof.state === "in_progress"
                  ? "Receipts are still being recorded. No candidate is implied proven."
                  : snapshot.proof.state === "blocked"
                    ? "The active proof gate is blocked."
                    : "The proof record is complete."}
              </p>
            </div>
          </div>
        ) : (
          <Unavailable
            compact
            detail="Proof has not started for the requested version."
            title="Awaiting proof"
          />
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Current proven preview</h3>
          <PackageCheck aria-hidden="true" size={16} />
        </div>
        {snapshot.preview ? (
          <>
            <dl className="definition-list">
              <Definition
                label="Contract"
                value={`v${snapshot.preview.contractVersion}`}
              />
              <Definition
                label="Artifact"
                value={shortDigest(snapshot.preview.artifactDigest)}
              />
              <Definition
                label="Revision"
                value={shortDigest(snapshot.preview.revisionHash)}
              />
              <Definition
                label="Expires"
                value={formatDate(snapshot.preview.expiresAt)}
              />
            </dl>
            <div className="panel-action">
              <a
                className="secondary-button"
                href={snapshot.preview.url}
                rel="noreferrer"
                target="_blank"
              >
                Frozen proven preview
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <Unavailable
            compact
            detail="No candidate has produced a frozen proven preview."
            title="Preview unavailable"
          />
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Current production</h3>
          <Rocket aria-hidden="true" size={16} />
        </div>
        {snapshot.production ? (
          <>
            <dl className="definition-list">
              <Definition
                label="Release"
                value={String(snapshot.production.releaseVersion)}
              />
              <Definition
                label="Contract"
                value={`v${snapshot.production.contractVersion}`}
              />
              <Definition
                label="Artifact"
                value={shortDigest(snapshot.production.artifactDigest)}
              />
              <Definition
                label="Verified"
                value={formatDate(snapshot.production.verifiedAt)}
              />
            </dl>
            <div className="panel-action">
              <a
                className="primary-button"
                href={snapshot.production.url}
                rel="noreferrer"
                target="_blank"
              >
                Open production
                <ArrowUpRight aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <Unavailable
            compact
            detail="A health-verified production receipt is not available."
            title="Production unavailable"
          />
        )}
      </div>
    </div>
  );
}

function CustomerTimeline({ events }: { events: CustomerEvent[] }) {
  return (
    <div className="data-panel">
      <div className="data-panel-header">
        <h3>Durable timeline</h3>
        <span className="tiny-tag">newest first</span>
      </div>
      {events.length === 0 ? (
        <Unavailable
          compact
          detail="No customer-safe event tail has been received in this browser session."
          title="Awaiting durable events"
        />
      ) : (
        <div className="update-list">
          {events.map((event) => (
            <div className="update-row timeline-row" key={event.eventId}>
              <span className="timeline-sequence mono">{event.sequence}</span>
              <div>
                <strong>{eventLabel(event.type)}</strong>
                <p>
                  {event.contractVersion
                    ? `Contract v${event.contractVersion} · `
                    : ""}
                  {event.data.actor} · {formatDate(event.occurredAt)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SteeringComposer({
  snapshot,
  state,
  submit,
}: {
  snapshot: CustomerProjectSnapshot;
  state: ReturnType<typeof useCustomerProject>["steering"];
  submit: (
    input: SteeringInput,
    retainedIdempotencyKey?: string,
  ) => Promise<void>;
}) {
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [localError, setLocalError] = useState<string>();

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(undefined);
    try {
      await submit({ subject, content });
      setSubject("");
      setContent("");
    } catch {
      setLocalError(
        "The dashboard did not confirm this request. No implementation claim has been made.",
      );
    }
  }

  return (
    <div className="data-panel steering-panel">
      <div className="data-panel-header">
        <h3>Steer this project</h3>
        <MessageSquareText aria-hidden="true" size={16} />
      </div>
      {state.state === "received" ? (
        <div className="notice-banner info" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{state.detail}</span>
          <span />
        </div>
      ) : null}
      {state.state === "conflict" ? (
        <div className="notice-banner" role="alert">
          <RefreshCw aria-hidden="true" />
          <span>{state.detail}</span>
          <span />
        </div>
      ) : null}
      {state.state === "failed" ? (
        <div className="notice-banner error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{state.detail}</span>
          <button
            className="secondary-button"
            onClick={() =>
              void submit(state.retry, state.idempotencyKey).catch(() => {})
            }
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
      <form
        className="steering-composer"
        onSubmit={(event) => void send(event)}
      >
        <label>
          <span className="sr-only">Request subject</span>
          <input
            maxLength={160}
            onChange={(event) => setSubject(event.currentTarget.value)}
            placeholder="Short request title"
            required
            value={subject}
          />
        </label>
        <label>
          <span className="sr-only">Steering request</span>
          <textarea
            maxLength={5_000}
            onChange={(event) => setContent(event.currentTarget.value)}
            placeholder="Describe the change or clarification."
            required
            value={content}
          />
        </label>
        {localError ? (
          <p className="field-error" role="alert">
            {localError}
          </p>
        ) : null}
        <div className="composer-meta">
          <span>
            Contract v{snapshot.requestedVersion ?? "—"} · received does not
            mean accepted or in scope
          </span>
          <button
            className="primary-button"
            disabled={
              state.state === "sending" ||
              subject.trim().length === 0 ||
              content.trim().length === 0
            }
            type="submit"
          >
            {state.state === "sending" ? "Sending…" : "Send request"}
            <Send aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}

function TransportNotice({
  transport,
}: {
  transport: ReturnType<typeof useCustomerProject>["transport"];
}) {
  return (
    <div
      className={`notice-banner ${transport === "offline" ? "error" : ""}`}
      role="status"
    >
      {transport === "offline" ? (
        <WifiOff aria-hidden="true" />
      ) : transport === "delayed" ? (
        <Clock3 aria-hidden="true" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      <span>
        {transport === "offline"
          ? "Browser offline. Last durable state is retained."
          : transport === "delayed"
            ? "Updates delayed. No new build state is inferred."
            : transport === "connecting"
              ? "Connecting to the durable project stream."
              : "Reconnecting from the last recorded cursor."}
      </span>
      <span />
    </div>
  );
}

function ProjectLoading({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-panel-top">
          {error ? (
            <TriangleAlert aria-hidden="true" size={24} />
          ) : (
            <LoaderCircle aria-hidden="true" size={24} />
          )}
          <h1>{error ? "Project unavailable" : "Opening project"}</h1>
          <p>
            {error ?? "Waiting for an authenticated durable project snapshot."}
          </p>
        </div>
        <div className="loading-state">
          {error ? (
            <button
              className="secondary-button"
              onClick={onRetry}
              type="button"
            >
              <RefreshCw aria-hidden="true" />
              Retry
            </button>
          ) : (
            <>
              <span className="skeleton project-skeleton" />
              <strong>Connecting</strong>
              <p>No activity is simulated while the snapshot is unavailable.</p>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function SessionExpired() {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-panel-top">
          <LockKeyhole aria-hidden="true" size={24} />
          <h1>Session expired</h1>
          <p>This project requires a fresh passwordless access link.</p>
        </div>
        <div className="empty-state">
          <CalendarClock aria-hidden="true" />
          <strong>Project access is no longer active</strong>
          <p>
            Open the latest BuildLabs project email. Link reissue is available
            only from an authentic existing capability; this screen does not
            accept an email or guess a project.
          </p>
        </div>
      </section>
    </main>
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

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function lifecycleTone(status: string): string {
  if (status === "completed" || status === "preview_ready") return "proven";
  if (
    status.includes("failed") ||
    status === "no_proven_candidate" ||
    status === "failed"
  ) {
    return "failed";
  }
  if (
    status === "awaiting_payment" ||
    status === "needs_clarification" ||
    status === "awaiting_customer_revision"
  ) {
    return "waiting";
  }
  return "active";
}

function builderTone(status: Builder["status"]): string {
  if (status === "passed") return "pass";
  if (status === "rejected" || status === "failed" || status === "cancelled") {
    return "failed";
  }
  if (
    status === "queued" ||
    status === "awaiting_proven_event" ||
    status === "superseded"
  ) {
    return "waiting";
  }
  return "running";
}

function builderStatusLabel(builder: Builder): string {
  if (builder.allocation === "not_allocated") return "Not allocated";
  if (builder.stage === null) return builder.status.replaceAll("_", " ");
  return `${builder.stage.replaceAll("_", " ")} · ${builder.status.replaceAll("_", " ")}`;
}

function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    sandbox_provisioning: "Preparing an isolated workspace",
    files_listing: "Inspecting the project structure",
    file_reading: "Reviewing project files",
    file_writing: "Updating project files",
    command_running: "Running a project command",
    dependency_bootstrap: "Restoring locked dependencies",
    build_running: "Building the application",
    test_running: "Running configured tests",
    operator_preview_starting: "Starting an internal build preview",
    revision_freezing: "Freezing this revision for independent checks",
    command_verification: "Verifying build and requirements",
    delivery_verification: "Building the delivery image",
    code_review: "Running independent code review",
    contract_evaluation: "Checking the Acceptance Contract",
    claim_inspection: "Checking rendered claims and supported facts",
    repairing: "Repairing a recorded finding",
    finalizing: "Finalizing recorded build work",
    waiting: "Awaiting the next controller event",
  };
  return labels[action] ?? "Awaiting a known activity";
}

function outcomeLabel(outcome: string): string {
  if (outcome === "succeeded") return "Recorded action completed";
  if (outcome === "failed") return "Recorded action failed";
  return "Recorded action started";
}

function workspaceLabel(state: Builder["workspace"]["state"]): string {
  switch (state) {
    case "unavailable":
      return "WIP render unavailable";
    case "starting":
      return "Awaiting a sanitized frame";
    case "live_unverified":
      return "Unverified observation available";
    case "stale":
      return "Last observation is stale";
    case "blocked":
      return "Observation blocked by safety checks";
    case "ended":
      return "Builder observation ended";
  }
}

function milestoneLabel(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function eventLabel(type: CustomerEvent["type"]): string {
  const labels: Record<CustomerEvent["type"], string> = {
    "contract.version_created": "Contract version recorded",
    "payment.verified": "Payment verified",
    "build.batch_started": "Build batch started",
    "build.batch_superseded": "Build batch superseded",
    "builder.state_changed": "Builder state changed",
    "candidate.outcome_recorded": "Candidate outcome recorded",
    "preview.ready": "Frozen preview ready",
    "deployment.state_changed": "Deployment state changed",
    "production.ready": "Production release ready",
    "clarification.requested": "Clarification requested",
    "steering.received": "Steering request received",
    "notification.state_changed": "Notification state changed",
    "project.state_changed": "Project state changed",
  };
  return labels[type];
}

function versionLabel(value: number | null): string {
  return value === null ? "Unavailable" : `v${value}`;
}

function shortDigest(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatDate(value: string): string {
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
