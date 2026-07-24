import {
  Boxes,
  CheckCircle2,
  CircleDashed,
  CreditCard,
  FileCheck2,
  PackageCheck,
  Rocket,
  ScanSearch,
  Send,
  TriangleAlert,
} from "lucide-react";

import type { GenerativeUiNode } from "../lib/contracts";

export function CustomerGenerativeUi({ node }: { node: GenerativeUiNode }) {
  switch (node.component) {
    case "contract":
      return (
        <GeneratedSurface
          detail={`${node.props.hardRequirements.length} hard requirements · ${node.props.preferences.length} preferences`}
          icon={<FileCheck2 aria-hidden="true" />}
          label={`Contract v${node.props.version}`}
          state="recorded"
          text={node.props.summary}
        />
      );
    case "payment":
      return (
        <GeneratedSurface
          detail={`Proposal v${node.props.proposalVersion} · ${node.props.amountLabel}`}
          icon={<CreditCard aria-hidden="true" />}
          label="Payment"
          state={node.props.state}
          text={
            node.props.state === "verified"
              ? "Payment evidence is recorded for this proposal."
              : "The commercial state is not yet verified."
          }
        />
      );
    case "candidates":
      return (
        <GeneratedSurface
          detail={`${node.props.builders.length} durable lanes · contract v${node.props.contractVersion}`}
          icon={<Boxes aria-hidden="true" />}
          label="Candidate cockpit"
          state="recorded"
          text={node.props.builders
            .map((builder) => `${builder.displayName}: ${builder.status}`)
            .join(" · ")}
        />
      );
    case "verifiers": {
      const failed = node.props.checks.filter(
        (check) => check.status === "fail" || check.status === "error",
      ).length;
      return (
        <GeneratedSurface
          detail={`${node.props.checks.length} checks · contract v${node.props.contractVersion}`}
          icon={<ScanSearch aria-hidden="true" />}
          label="Verifier evidence"
          state={failed > 0 ? "failed" : "recorded"}
          text={
            failed > 0
              ? `${failed} verifier checks are blocking proof.`
              : "Only durable verifier receipts are represented."
          }
        />
      );
    }
    case "findings":
      return (
        <GeneratedSurface
          detail={`${node.props.critical} critical · ${node.props.high} high`}
          icon={<TriangleAlert aria-hidden="true" />}
          label="Review findings"
          state={node.props.state}
          text={
            node.props.summaries.join(" · ") ||
            "No customer-safe finding summary is available."
          }
        />
      );
    case "preview":
      return (
        <GeneratedSurface
          detail={
            node.props.contractVersion === null
              ? "No contract-bound preview"
              : `Contract v${node.props.contractVersion}`
          }
          icon={<PackageCheck aria-hidden="true" />}
          label="Frozen preview"
          state={node.props.state}
          text={
            node.props.frozen
              ? "This surface is bound to an immutable proven artifact."
              : "A reviewable preview is not available."
          }
        />
      );
    case "deployment":
      return (
        <GeneratedSurface
          detail={
            node.props.releaseVersion === null
              ? "No verified release"
              : `Release ${node.props.releaseVersion}`
          }
          icon={<Rocket aria-hidden="true" />}
          label="Production"
          state={node.props.state}
          text={
            node.props.state === "current"
              ? "The current production receipt is health-verified."
              : "A verified production release is not currently represented."
          }
        />
      );
    case "delivery":
      return (
        <GeneratedSurface
          detail={`${node.props.channel} · ${node.props.state}`}
          icon={<Send aria-hidden="true" />}
          label="Delivery"
          state={node.props.state}
          text={node.props.summary}
        />
      );
  }
}

function GeneratedSurface({
  detail,
  icon,
  label,
  state,
  text,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  state: string;
  text: string;
}) {
  const StatusIcon =
    state === "failed" || state === "fail" || state === "error"
      ? TriangleAlert
      : state === "pending" ||
          state === "awaiting" ||
          state === "running" ||
          state === "processing" ||
          state === "materializing"
        ? CircleDashed
        : CheckCircle2;
  return (
    <section
      aria-label={`${label}: ${state}`}
      className="generated-surface"
      data-component="customer-generated-surface"
    >
      <span className="generated-surface-icon">{icon}</span>
      <div>
        <span className="micro-label">ALLOWLISTED PROJECT COMPONENT</span>
        <strong>{label}</strong>
        <p>{text}</p>
        <small>{detail}</small>
      </div>
      <span className={`status-pill ${state}`}>
        <StatusIcon aria-hidden="true" />
        {state}
      </span>
    </section>
  );
}
