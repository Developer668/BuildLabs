"use client";

import {
  useAgent,
  useAgentContext,
  useHumanInTheLoop,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import { AlertCircle, CheckCircle2, MessageSquareText } from "lucide-react";
import { z } from "zod";

import type { OperatorProject } from "../lib/operator-data";

export type CopilotOperatorProjection = {
  fixture: boolean;
  projectId: string;
  lifecycle: string;
  versions: Record<string, number | null>;
  currentAction: {
    label: string;
    detail: string;
    owner:
      "orchestrator" | "provider" | "customer" | "operator" | "unavailable";
  };
  candidates: Array<{
    candidateId: string;
    status: string;
    stage: string;
    hardRequirements: string;
  }>;
};

const versionSchema = z.object({
  title: z.string().max(200),
  version: z.number().int().positive(),
  state: z.enum(["active", "paid", "proven", "production", "blocked"]),
  detail: z.string().max(1_000),
});

const receiptSchema = z.object({
  label: z.string().max(200),
  kind: z.enum([
    "contract",
    "payment",
    "candidate",
    "verifier",
    "finding",
    "preview",
    "deployment",
    "delivery",
  ]),
  state: z.enum(["pass", "fail", "pending", "unavailable"]),
  detail: z.string().max(1_000),
});

const clarificationSchema = {
  name: "request_operator_clarification",
  description:
    "Ask the operator to clarify or steer a bounded project question. This cannot approve shipping or override proof.",
  parameters: z.object({
    question: z.string().min(1).max(800),
    scope: z.enum(["clarification", "steering"]),
  }),
  render: ({
    args,
    respond,
    status,
  }: {
    args: { question?: string; scope?: "clarification" | "steering" };
    respond: ((value: unknown) => Promise<void>) | undefined;
    status: string;
  }) => (
    <div className="copilot-interrupt" role="status">
      <MessageSquareText aria-hidden="true" />
      <div>
        <strong>
          {args.scope === "steering"
            ? "Steering requested"
            : "Clarification requested"}
        </strong>
        <p>{args.question ?? "Waiting for the bounded question."}</p>
      </div>
      {status === "executing" && respond ? (
        <button
          className="secondary-button"
          onClick={() =>
            void respond({
              disposition: "defer_to_authenticated_project_workflow",
            })
          }
          type="button"
        >
          Acknowledge
        </button>
      ) : null}
    </div>
  ),
};

export function CopilotOperatorBindings({
  project,
  projection,
}: {
  project?: OperatorProject;
  projection?: CopilotOperatorProjection;
}) {
  const context = projection ?? (project ? fixtureProjection(project) : null);
  const { isReady } = useAgent({
    agentId: "studio-observer",
    throttleMs: 250,
  });

  useAgentContext({
    description:
      "Durable BuildLabs operator projection. States are fixture-labeled when fixture is true; no hidden reasoning or inferred provider health is included.",
    value: context ?? {
      fixture: false,
      projectId: "unavailable",
      lifecycle: "unavailable",
      versions: {},
      currentAction: {
        label: "Unavailable",
        detail: "No validated operator projection is loaded.",
        owner: "unavailable",
      },
      candidates: [],
    },
  });

  // Every accepted renderer has a closed schema. No wildcard renderer is
  // registered, so unknown component names fail closed.
  useVersionRenderer("render_contract");
  useVersionRenderer("render_payment");
  useVersionRenderer("render_candidate");
  useVersionRenderer("render_preview");
  useVersionRenderer("render_deployment");
  useReceiptRenderer("render_verifier_receipt");
  useReceiptRenderer("render_finding");
  useReceiptRenderer("render_delivery");

  useHumanInTheLoop(clarificationSchema, []);

  return (
    <span
      aria-label={
        isReady
          ? "CopilotKit observer registered"
          : "CopilotKit observer unavailable"
      }
      className={`status-pill ${isReady ? "pass" : "waiting"}`}
      data-testid="copilot-runtime-state"
    >
      <span className="status-dot" aria-hidden="true" />
      {isReady ? "Copilot observer registered" : "Copilot observer unavailable"}
    </span>
  );
}

function fixtureProjection(
  project: OperatorProject,
): CopilotOperatorProjection {
  return {
    fixture: project.fixture,
    projectId: project.projectId,
    lifecycle: project.lifecycle,
    versions: project.versions,
    currentAction: project.currentAction,
    candidates: project.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      status: candidate.status,
      stage: candidate.stage,
      hardRequirements: candidate.score.recorded
        ? `${candidate.score.hardRequirementsPassed}/${candidate.score.hardRequirementsTotal}`
        : "not_recorded",
    })),
  };
}

function useVersionRenderer(name: string) {
  useRenderTool(
    {
      agentId: "studio-observer",
      name,
      parameters: versionSchema,
      render: ({ parameters, status }) => (
        <CopilotVersionCard
          detail={
            status === "inProgress"
              ? "Waiting for durable arguments."
              : parameters.detail
          }
          state={status === "inProgress" ? "pending" : parameters.state}
          title={
            status === "inProgress" ? "Durable projection" : parameters.title
          }
          version={status === "inProgress" ? null : parameters.version}
        />
      ),
    },
    [],
  );
}

function useReceiptRenderer(name: string) {
  useRenderTool(
    {
      agentId: "studio-observer",
      name,
      parameters: receiptSchema,
      render: ({ parameters, status }) => (
        <CopilotReceiptCard
          detail={
            status === "inProgress"
              ? "Waiting for durable arguments."
              : parameters.detail
          }
          label={
            status === "inProgress" ? "Evidence receipt" : parameters.label
          }
          state={status === "inProgress" ? "pending" : parameters.state}
        />
      ),
    },
    [],
  );
}

function CopilotVersionCard({
  detail,
  state,
  title,
  version,
}: {
  detail: string;
  state: string;
  title: string;
  version: number | null;
}) {
  return (
    <div className="generated-card" data-component="version-card">
      {state === "blocked" ? (
        <AlertCircle aria-hidden="true" />
      ) : (
        <CheckCircle2 aria-hidden="true" />
      )}
      <div>
        <strong>{title}</strong>
        <p>
          {version === null ? "Version pending" : `Version ${version}`} ·{" "}
          {state}
        </p>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function CopilotReceiptCard({
  detail,
  label,
  state,
}: {
  detail: string;
  label: string;
  state: string;
}) {
  return (
    <div className="generated-card" data-component="receipt-card">
      {state === "fail" ? (
        <AlertCircle aria-hidden="true" />
      ) : (
        <CheckCircle2 aria-hidden="true" />
      )}
      <div>
        <strong>{label}</strong>
        <p>{state}</p>
        <span>{detail}</span>
      </div>
    </div>
  );
}
