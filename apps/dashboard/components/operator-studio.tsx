"use client";
import {
  Activity,
  ArrowUpRight,
  Box,
  Boxes,
  Check,
  CheckCircle2,
  CircleDashed,
  Code2,
  ExternalLink,
  FileDiff,
  Gauge,
  GitBranch,
  ImageOff,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  PackageCheck,
  Radio,
  ReceiptText,
  RotateCw,
  ShieldAlert,
  SquareDashed,
  TestTube2,
  Timer,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { OperatorCandidate, OperatorProject } from "../lib/operator-data";
import { WorkspaceShell } from "./workspace-shell";

export function OperatorStudio({ project }: { project: OperatorProject }) {
  return <OperatorStudioContent project={project} />;
}

function OperatorStudioContent({ project }: { project: OperatorProject }) {
  const [selectedId, setSelectedId] = useState(
    project.candidates[0]?.candidateId ?? "",
  );
  const selected = useMemo(
    () =>
      project.candidates.find(
        (candidate) => candidate.candidateId === selectedId,
      ) ?? project.candidates[0],
    [project.candidates, selectedId],
  );

  return (
    <WorkspaceShell
      fixture={project.fixture}
      projectTitle={project.title}
      role="Operator studio"
      status={project.lifecycle}
      statusTone={project.lifecycleTone}
      transport={project.stream.state}
    >
      <div className="workspace">
        <div className="notice-banner info" role="status">
          <ShieldAlert aria-hidden="true" />
          <span>
            Revision {project.versions.contract} is unverified work. Release{" "}
            {project.versions.production} remains the only production-bound
            artifact.
          </span>
          <span
            aria-label="CopilotKit observer inactive for deterministic fixture"
            className="status-pill waiting"
          >
            <span className="status-dot" aria-hidden="true" />
            Copilot fixture inactive
          </span>
        </div>

        <section
          aria-labelledby="operator-overview-title"
          className="workspace-section"
          id="overview"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">DURABLE LIFECYCLE</span>
              <h2 id="operator-overview-title">Run control</h2>
              <p>
                Immutable commercial, contract, build, proof, and delivery
                boundaries for the selected project.
              </p>
            </div>
            <span className="tiny-tag mono">
              cursor {project.stream.cursor}
            </span>
          </div>
          <Milestones project={project} />
          <div className="summary-strip operator-summary">
            <div className="summary-cell">
              <span className="metric-label">BOUNDED CURRENT ACTION</span>
              <strong>{project.currentAction.label}</strong>
              <p>{project.currentAction.detail}</p>
            </div>
            <div className="summary-cell">
              <span className="metric-label">ACCEPTANCE CONTRACT</span>
              <span className="metric-value">v{project.versions.contract}</span>
              <p>Immutable · {shortDigest(project.contract.hash)}</p>
            </div>
            <div className="summary-cell">
              <span className="metric-label">PAYMENT EVIDENCE</span>
              <span className="metric-value">
                {project.commercial.paymentState}
              </span>
              <p>
                proposal v{project.versions.paid} ·{" "}
                {project.commercial.evidenceSource.replace("_", " ")}
              </p>
            </div>
            <div className="summary-cell">
              <span className="metric-label">PRODUCTION</span>
              <span className="metric-value">
                release {project.versions.production}
              </span>
              <p>
                Contract v{project.deployment.contractVersion} ·{" "}
                {project.deployment.state}
              </p>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="candidate-cockpit-title"
          className="workspace-section"
          id="build"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">FOUR DURABLE LANES</span>
              <h2 id="candidate-cockpit-title">Candidate cockpit</h2>
              <p>
                Activity is sanitized and event-backed. A frame is observation
                only and never proof, preview, approval, or delivery.
              </p>
            </div>
            <span className="status-pill running">
              <Radio aria-hidden="true" />4 allocated
            </span>
          </div>
          <div className="candidate-grid">
            {project.candidates.map((candidate, index) => (
              <CandidateLane
                candidate={candidate}
                index={index}
                key={candidate.candidateId}
                onSelect={setSelectedId}
                selected={candidate.candidateId === selected?.candidateId}
              />
            ))}
          </div>
        </section>

        <section
          aria-labelledby="candidate-evidence-title"
          className="workspace-section"
          id="proof"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">SELECTED CANDIDATE</span>
              <h2 id="candidate-evidence-title">
                Evidence · {selected?.displayName ?? "Unavailable"}
              </h2>
              <p>
                Candidate details stay bound to the selected run and current
                contract version.
              </p>
            </div>
            {selected ? (
              <span className={`status-pill ${selected.status}`}>
                <span className="status-dot" aria-hidden="true" />
                {selected.stage}
              </span>
            ) : null}
          </div>
          {selected ? (
            <CandidateEvidence candidate={selected} />
          ) : (
            <UnavailableState
              detail="No candidate was allocated to this batch."
              title="Candidate evidence unavailable"
            />
          )}
        </section>

        <section
          aria-labelledby="contract-payment-title"
          className="workspace-section"
          id="requirements"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">IMMUTABLE INPUTS</span>
              <h2 id="contract-payment-title">Contract and payment</h2>
              <p>
                The active build is fenced to proposal, contract, and verified
                payment version {project.versions.paid}.
              </p>
            </div>
            <span className="status-pill pass">
              <LockKeyhole aria-hidden="true" />
              version matched
            </span>
          </div>
          <ContractPayment project={project} />
        </section>

        <section
          aria-labelledby="operations-title"
          className="workspace-section"
          id="operations"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">PROVIDER BOUNDARIES</span>
              <h2 id="operations-title">Operations</h2>
              <p>
                Provider state is reported only at the scope and time of a
                controller observation.
              </p>
            </div>
          </div>
          <Operations project={project} />
        </section>

        <section
          aria-labelledby="delivery-title"
          className="workspace-section"
          id="updates"
        >
          <div className="section-heading">
            <div>
              <span className="section-kicker">VERSION-BOUND EFFECTS</span>
              <h2 id="delivery-title">Preview, deployment, and delivery</h2>
              <p>
                These receipts belong to the prior proven release and cannot
                authorize the active revision.
              </p>
            </div>
          </div>
          <ReleaseEffects project={project} />
        </section>
      </div>
    </WorkspaceShell>
  );
}

function Milestones({ project }: { project: OperatorProject }) {
  const milestones = [
    [`Contract v${project.versions.contract}`, "complete", "immutable"],
    [`Payment v${project.versions.paid}`, "complete", "verified"],
    [`Build v${project.versions.contract}`, "complete", "4 dispatched"],
    [`Proof v${project.versions.contract}`, "active", "in progress"],
    [
      `Preview v${project.versions.contract}`,
      project.versions.proven === project.versions.contract
        ? "complete"
        : "pending",
      project.versions.proven === project.versions.contract
        ? "proven"
        : "not available",
    ],
    [
      `Production v${project.versions.contract}`,
      project.versions.production === project.versions.contract
        ? "complete"
        : "pending",
      project.versions.production === project.versions.contract
        ? "deployed"
        : "not deployed",
    ],
  ] as const;
  return (
    <div className="milestone-rail">
      {milestones.map(([label, state, detail], index) => (
        <div className={`milestone ${state}`} key={label}>
          <span className="milestone-index">
            {state === "complete" ? <Check aria-hidden="true" /> : index + 1}
          </span>
          <strong>{label}</strong>
          <small>{detail}</small>
        </div>
      ))}
      <span className="sr-only">
        Project {project.projectId} is currently in proof.
      </span>
    </div>
  );
}

function CandidateLane({
  candidate,
  index,
  onSelect,
  selected,
}: {
  candidate: OperatorCandidate;
  index: number;
  onSelect: (id: string) => void;
  selected: boolean;
}) {
  return (
    <article
      aria-label={`${candidate.displayName}: ${candidate.stage}`}
      className="candidate-lane"
      data-selected={selected}
    >
      <button
        aria-pressed={selected}
        className="candidate-header candidate-select"
        onClick={() => onSelect(candidate.candidateId)}
        type="button"
      >
        <span className="candidate-identity">
          <span className="candidate-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span>
            <strong>{candidate.displayName}</strong>
            <small className="mono">{candidate.candidateId}</small>
          </span>
        </span>
        <span className={`status-pill ${candidate.status}`}>
          <span className="status-dot" aria-hidden="true" />
          {candidate.status}
        </span>
      </button>
      <WipViewport candidate={candidate} />
      <div className="activity-strip">
        <span className="activity-icon">
          {candidate.status === "failed" ? (
            <XCircle aria-hidden="true" />
          ) : candidate.status === "waiting" ? (
            <Timer aria-hidden="true" />
          ) : (
            <Activity aria-hidden="true" />
          )}
        </span>
        <span className="activity-copy">
          <strong>{candidate.currentAction}</strong>
          <small>{candidate.activityDetail}</small>
        </span>
        <time className="activity-time" dateTime={candidate.activityAt}>
          {formatTime(candidate.activityAt)}
        </time>
      </div>
      <div className="candidate-metrics">
        <CandidateMetric
          label="tool calls"
          value={candidate.metrics.toolCalls}
        />
        <CandidateMetric
          label="failures"
          value={candidate.metrics.failedTools}
        />
        <CandidateMetric label="receipts" value={candidate.metrics.receipts} />
        <CandidateMetric
          label="repair round"
          value={candidate.metrics.repairRound}
        />
      </div>
    </article>
  );
}

function WipViewport({ candidate }: { candidate: OperatorCandidate }) {
  return (
    <div className="wip-viewport">
      <span className="wip-watermark">
        <ShieldAlert aria-hidden="true" />
        UNVERIFIED WIP
      </span>
      {candidate.frameState === "fixture" ? (
        <>
          <div aria-hidden="true" className="fixture-app-frame">
            <div className="fixture-app-nav">
              <i className="fixture-app-line accent" />
              <i className="fixture-app-line" />
              <i className="fixture-app-line" />
              <i className="fixture-app-line" />
            </div>
            <div className="fixture-app-body">
              <i className="fixture-app-title" />
              <div className="fixture-app-cards">
                <i />
                <i />
                <i />
              </div>
              <i className="fixture-app-chart" />
            </div>
          </div>
          <span className="wip-fixture-stamp">FIXTURE RASTER PROJECTION</span>
        </>
      ) : (
        <div className="wip-empty">
          {candidate.frameState === "awaiting" ? (
            <LoaderCircle aria-hidden="true" />
          ) : (
            <ImageOff aria-hidden="true" />
          )}
          <strong>
            {candidate.frameState === "awaiting"
              ? "Awaiting a sanitized frame"
              : "Observation unavailable"}
          </strong>
          <span>
            No browser liveness or visual progress is inferred from this state.
          </span>
        </div>
      )}
    </div>
  );
}

function CandidateMetric({ label, value }: { label: string; value: number }) {
  return (
    <span className="candidate-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
}

function CandidateEvidence({ candidate }: { candidate: OperatorCandidate }) {
  return (
    <div className="evidence-layout">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Verifier receipts</h3>
          <span className="tiny-tag">adaptive proof gate</span>
        </div>
        {candidate.receipts.length === 0 ? (
          <UnavailableState
            compact
            detail="No verifier receipt details are present in this projection."
            title="Verifier receipts unavailable"
          />
        ) : (
          <div className="receipt-list">
            {candidate.receipts.map((receipt) => (
              <div
                className="receipt-row"
                key={`${receipt.kind}-${receipt.label}`}
              >
                {receipt.state === "pass" ? (
                  <CheckCircle2 aria-hidden="true" color="var(--green)" />
                ) : receipt.state === "fail" ? (
                  <XCircle aria-hidden="true" color="var(--red)" />
                ) : (
                  <CircleDashed aria-hidden="true" color="var(--amber)" />
                )}
                <div>
                  <strong>{receipt.label}</strong>
                  <p>
                    {receipt.kind.replace("_", " ")}
                    {receipt.digest ? ` · ${shortDigest(receipt.digest)}` : ""}
                  </p>
                </div>
                <span className={`status-pill ${receipt.state}`}>
                  {receipt.state}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Braintrust score record</h3>
          <Gauge aria-hidden="true" size={16} />
        </div>
        <div className="score-panel">
          <span className="score-value">
            {candidate.score.recorded && candidate.score.quality !== null
              ? candidate.score.quality.toFixed(2)
              : "—"}
          </span>
          <div>
            <strong>
              {candidate.score.recorded ? "Recorded" : "Not recorded"}
            </strong>
            <p>
              Hard requirements {candidate.score.hardRequirementsPassed}/
              {candidate.score.hardRequirementsTotal}. A quality score cannot
              override a hard failure.
            </p>
          </div>
        </div>
      </div>
      <div className="data-panel evidence-wide">
        <div className="data-panel-header">
          <h3>Candidate diff</h3>
          <FileDiff aria-hidden="true" size={16} />
        </div>
        {candidate.diff.length === 0 ? (
          <UnavailableState
            compact
            detail="No controller-recorded diff summary is present in this projection."
            title="Candidate diff unavailable"
          />
        ) : (
          <div
            aria-label="Candidate diff table"
            className="table-wrap"
            role="region"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">PATH</th>
                  <th scope="col">STATE</th>
                  <th scope="col">ADDED</th>
                  <th scope="col">REMOVED</th>
                </tr>
              </thead>
              <tbody>
                {candidate.diff.map((file) => (
                  <tr key={file.path}>
                    <td className="mono">{file.path}</td>
                    <td>{file.state}</td>
                    <td className="mono diff-add">+{file.added}</td>
                    <td className="mono diff-remove">-{file.removed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Component tree</h3>
          <Boxes aria-hidden="true" size={16} />
        </div>
        {candidate.componentTree.length === 0 ? (
          <UnavailableState
            compact
            detail="No controller-recorded component tree is present in this projection."
            title="Component tree unavailable"
          />
        ) : (
          <ol className="component-tree">
            {candidate.componentTree.map((component, index) => (
              <li
                key={component}
                style={{ paddingLeft: `${13 + index * 13}px` }}
              >
                <GitBranch aria-hidden="true" />
                <code>{component}</code>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>CodeRabbit findings</h3>
          <Code2 aria-hidden="true" size={16} />
        </div>
        {candidate.findings.length === 0 ? (
          <UnavailableState
            compact
            detail="No terminal findings have been recorded for this candidate."
            title="Findings unavailable"
          />
        ) : (
          <div className="receipt-list">
            {candidate.findings.map((finding) => (
              <div className="receipt-row" key={finding.code}>
                <TriangleAlert aria-hidden="true" color="var(--amber)" />
                <div>
                  <strong>{finding.summary}</strong>
                  <p className="mono">
                    {finding.code} · {finding.severity}
                  </p>
                </div>
                <span className={`status-pill ${finding.state}`}>
                  {finding.state}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ContractPayment({ project }: { project: OperatorProject }) {
  return (
    <div className="split-view">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Acceptance Contract v{project.versions.contract}</h3>
          <span className="tiny-tag mono">
            {shortDigest(project.contract.hash)}
          </span>
        </div>
        <div className="contract-summary">
          <p>{project.contract.summary}</p>
          <span>
            Created {formatDate(project.contract.createdAt)} · immutable
          </span>
        </div>
        <div className="requirement-list">
          {project.contract.hardRequirements.map((requirement, index) => (
            <div className="requirement-row" key={requirement}>
              <span className="requirement-index">{index + 1}</span>
              <div>
                <strong>{requirement}</strong>
                <p>Deterministic evidence required</p>
              </div>
              <span className="tiny-tag">hard</span>
            </div>
          ))}
          {project.contract.preferences.map((requirement, index) => (
            <div className="requirement-row" key={requirement}>
              <span className="requirement-index">P{index + 1}</span>
              <div>
                <strong>{requirement}</strong>
                <p>Preference-ranking signal</p>
              </div>
              <span className="tiny-tag">preference</span>
            </div>
          ))}
        </div>
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Proposal and payment</h3>
          <ReceiptText aria-hidden="true" size={16} />
        </div>
        <dl className="definition-list">
          <Definition
            label="Proposal"
            value={`v${project.versions.proposal}`}
          />
          <Definition label="Amount" value={project.commercial.amount} />
          <Definition label="Currency" value={project.commercial.currency} />
          <Definition
            label="Evidence"
            value={project.commercial.evidenceSource.replace("_", " ")}
          />
          <Definition
            label="Verified"
            value={
              project.commercial.verifiedAt
                ? formatDate(project.commercial.verifiedAt)
                : "not verified"
            }
          />
        </dl>
        <div className="match-grid">
          {project.commercial.matchedFields.map((field) => (
            <span key={field}>
              <CheckCircle2 aria-hidden="true" />
              {field}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Operations({ project }: { project: OperatorProject }) {
  return (
    <div className="split-view">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Provider observations</h3>
          <Radio aria-hidden="true" size={16} />
        </div>
        <div className="provider-list">
          {project.providers.map((provider) => (
            <div className="provider-row" key={provider.name}>
              <div>
                <strong>{provider.name}</strong>
                <p>
                  {provider.responsibility} · {provider.detail}
                </p>
              </div>
              <div className="provider-state">
                <span className={`status-pill ${provider.state}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {provider.state}
                </span>
                <time dateTime={provider.observedAt ?? undefined}>
                  {provider.observedAt
                    ? formatTime(provider.observedAt)
                    : "no observation"}
                </time>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Operator commands</h3>
          <ListChecks aria-hidden="true" size={16} />
        </div>
        <div className="command-list">
          <button
            className="command-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            <RotateCw aria-hidden="true" />
            Refresh durable snapshot
          </button>
          <button
            className="command-button"
            data-tooltip="No authenticated clarification mutation route is configured"
            disabled
            type="button"
          >
            <MessageSquareText aria-hidden="true" />
            Clarification unavailable
          </button>
          <button
            className="command-button"
            data-tooltip="No authenticated verifier retry route is configured"
            disabled
            type="button"
          >
            <TestTube2 aria-hidden="true" />
            Verifier retry unavailable
          </button>
          <p>
            Refresh reads the authenticated projection only. No mutation route
            is wired here, and there is no manual ship, proof override, or
            failed-requirement bypass.
          </p>
        </div>
      </div>
    </div>
  );
}

function ReleaseEffects({ project }: { project: OperatorProject }) {
  return (
    <div className="release-grid">
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Frozen review preview</h3>
          <PackageCheck aria-hidden="true" size={16} />
        </div>
        <dl className="definition-list">
          <Definition
            label="Contract"
            value={`v${project.frozenPreview.contractVersion}`}
          />
          <Definition
            label="Artifact"
            value={shortDigest(project.frozenPreview.artifactDigest)}
          />
          <Definition
            label="Revision"
            value={shortDigest(project.frozenPreview.revisionHash)}
          />
          <Definition
            label="Verified"
            value={formatDate(project.frozenPreview.verifiedAt)}
          />
        </dl>
        <div className="panel-action">
          <a
            className="secondary-button"
            href={project.frozenPreview.url}
            rel="noreferrer"
            target="_blank"
          >
            Exact frozen artifact
            <ExternalLink aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Production deployment</h3>
          <Box aria-hidden="true" size={16} />
        </div>
        <dl className="definition-list">
          <Definition
            label="Release"
            value={`v${project.deployment.releaseVersion}`}
          />
          <Definition
            label="Contract"
            value={`v${project.deployment.contractVersion}`}
          />
          <Definition
            label="Image"
            value={shortDigest(project.deployment.imageDigest)}
          />
          <Definition label="Health" value={project.deployment.state} />
        </dl>
        <div className="panel-action">
          <a
            className="secondary-button"
            href={project.deployment.url}
            rel="noreferrer"
            target="_blank"
          >
            Production release
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="data-panel">
        <div className="data-panel-header">
          <h3>Delivery effect</h3>
          <CheckCircle2 aria-hidden="true" size={16} />
        </div>
        <dl className="definition-list">
          <Definition label="State" value={project.delivery.state} />
          <Definition
            label="Attempts"
            value={String(project.delivery.attempts)}
          />
          <Definition
            label="Settled"
            value={
              project.delivery.settledAt
                ? formatDate(project.delivery.settledAt)
                : "not settled"
            }
          />
          <Definition label="Effect" value={project.delivery.effectId} />
        </dl>
        <p className="effect-detail">{project.delivery.detail}</p>
      </div>
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

function UnavailableState({
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
