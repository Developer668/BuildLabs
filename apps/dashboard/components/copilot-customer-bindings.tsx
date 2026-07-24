"use client";

import {
  useAgentContext,
  useHumanInTheLoop,
  useRenderTool,
} from "@copilotkit/react-core/v2";
import { MessageSquareText } from "lucide-react";
import { z } from "zod";

import {
  GenerativeUiNodeSchema,
  type CustomerProjectSnapshot,
} from "../lib/contracts";
import { CustomerGenerativeUi } from "./customer-generative-ui";

export function CopilotCustomerBindings({
  onSteeringRequested,
  snapshot,
}: {
  onSteeringRequested: (input: {
    subject: string;
    content: string;
  }) => Promise<void>;
  snapshot: CustomerProjectSnapshot;
}) {
  useAgentContext({
    description:
      "Customer-safe BuildLabs project projection. It omits internal identifiers, raw logs, provider metadata, reasoning, scores, tokens, and mutable preview URLs.",
    value: {
      projectId: snapshot.projectId,
      lifecycle: snapshot.lifecycle,
      requestedVersion: snapshot.requestedVersion,
      paidCommercialVersion: snapshot.paidCommercialVersion,
      currentProvenVersion: snapshot.currentProvenVersion,
      currentProductionVersion: snapshot.currentProductionVersion,
      pendingAction: snapshot.pendingAction,
      builders:
        snapshot.activeBatch?.builders.map((builder) => ({
          builderId: builder.builderId,
          allocation: builder.allocation,
          status: builder.status,
          stage: builder.stage,
          workspace: builder.workspace.state,
        })) ?? [],
    },
  });

  useRenderTool(
    {
      name: "render_project_component",
      parameters: GenerativeUiNodeSchema,
      render: ({ parameters, status }) =>
        status === "inProgress" ? (
          <div className="loading-state generated-loading" role="status">
            <span className="skeleton" />
            <strong>Waiting for a typed project component</strong>
          </div>
        ) : (
          <CustomerGenerativeUi node={parameters} />
        ),
    },
    [],
  );

  useHumanInTheLoop(
    {
      name: "request_customer_input",
      description:
        "Request a bounded clarification or steering message. This cannot approve shipping, override proof, or directly invoke a provider.",
      parameters: z.object({
        kind: z.enum(["clarification", "steering"]),
        question: z.string().min(1).max(800),
        subject: z.string().min(1).max(160),
      }),
      render: ({ args, respond, status }) => (
        <div className="copilot-interrupt" role="status">
          <MessageSquareText aria-hidden="true" />
          <div>
            <strong>
              {args.kind === "clarification"
                ? "Clarification requested"
                : "Steering requested"}
            </strong>
            <p>{args.question ?? "Waiting for a bounded question."}</p>
          </div>
          {status === "executing" && respond ? (
            <button
              className="secondary-button"
              onClick={() =>
                void onSteeringRequested({
                  subject: args.subject,
                  content: args.question,
                }).then(() =>
                  respond({
                    received: true,
                    meaning:
                      "received_only_pending_orchestrator_classification",
                  }),
                )
              }
              type="button"
            >
              Send request
            </button>
          ) : null}
        </div>
      ),
    },
    [onSteeringRequested],
  );

  return null;
}
