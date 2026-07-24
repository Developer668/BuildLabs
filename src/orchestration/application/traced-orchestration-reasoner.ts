import type {
  OrchestrationTraceEvent,
  OrchestrationTraceOperation,
  OrchestrationTracePort,
} from "../ports/trace.js";
import { OrchestrationTraceError } from "../ports/trace.js";
import { sha256 } from "../../lib/canonical-json.js";
import type {
  AnalyzeConversationInput,
  ChangeClassification,
  ClassifyChangeInput,
  ConversationAnalysis,
  DraftProposalInput,
  OrchestrationReasoner,
  OrchestrationReasoningTraceContext,
  ProposalPlan,
} from "./fireworks-orchestration-reasoner.js";

export interface TracedOrchestrationReasonerOptions {
  flushTimeoutMs?: number;
}

/**
 * Keeps customer content and customer-content fingerprints outside the trace
 * boundary. A one-way project identifier correlation, proposal version,
 * bounded counts, byte lengths, field-presence flags, and policy
 * classifications cross it so an operator can retrieve the exact decision
 * trace without exposing customer content.
 */
export class TracedOrchestrationReasoner implements OrchestrationReasoner {
  readonly #flushTimeoutMs: number;

  constructor(
    private readonly reasoner: OrchestrationReasoner,
    private readonly trace: OrchestrationTracePort,
    options: TracedOrchestrationReasonerOptions = {},
  ) {
    this.#flushTimeoutMs = boundedFlushTimeout(
      options.flushTimeoutMs ?? 10_000,
    );
  }

  analyzeConversation(
    input: AnalyzeConversationInput,
    signal?: AbortSignal,
  ): Promise<ConversationAnalysis> {
    return this.#execute(
      "intake_analysis",
      intakeTraceInput(input),
      () => this.reasoner.analyzeConversation(input, signal),
      analysisTraceOutput,
    );
  }

  draftProposal(
    input: DraftProposalInput,
    signal?: AbortSignal,
  ): Promise<ProposalPlan> {
    return this.#execute(
      "proposal_planning",
      proposalTraceInput(input),
      () => this.reasoner.draftProposal(input, signal),
      proposalTraceOutput,
    );
  }

  classifyChange(
    input: ClassifyChangeInput,
    signal?: AbortSignal,
  ): Promise<ChangeClassification> {
    return this.#execute(
      "change_classification",
      changeTraceInput(input),
      () => this.reasoner.classifyChange(input, signal),
      changeTraceOutput,
    );
  }

  async #execute<T>(
    operation: OrchestrationTraceOperation,
    input: Readonly<Record<string, unknown>>,
    action: () => Promise<T>,
    summarize: (value: T) => Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const event: OrchestrationTraceEvent = { operation, input };
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await this.trace.run(event, async (span) => {
        try {
          const value = await action();
          span.log({ output: summarize(value) });
          return value;
        } catch (error) {
          span.log({ error: safeErrorName(error) });
          throw error;
        }
      });
    } catch (error) {
      operationError = error;
    }

    try {
      await flushWithinDeadline(this.trace, this.#flushTimeoutMs);
    } catch (error) {
      throw new OrchestrationTraceError(
        `Could not durably flush ${operation} trace`,
        { cause: error },
      );
    }
    if (operationError !== undefined) {
      throw normalizedOperationError(operationError);
    }
    return result as T;
  }
}

async function flushWithinDeadline(
  trace: OrchestrationTracePort,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      trace.flush(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Orchestration trace flush timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function boundedFlushTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new RangeError("flushTimeoutMs must be an integer from 1 to 60000");
  }
  return value;
}

function normalizedOperationError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new OrchestrationTraceError("Orchestration reasoning operation failed");
}

function intakeTraceInput(
  input: AnalyzeConversationInput,
): Readonly<Record<string, unknown>> {
  return {
    ...traceCorrelation(input.traceContext),
    channel: input.channel,
    conversationBytes: Buffer.byteLength(input.conversation, "utf8"),
    researchConsent: input.researchConsent,
    trustedSenderEmailPresent: input.trustedSenderEmail !== undefined,
  };
}

function analysisTraceOutput(
  output: ConversationAnalysis,
): Readonly<Record<string, unknown>> {
  return {
    customerFields: {
      name: output.customer.name !== undefined,
      email: output.customer.email !== undefined,
      phone: output.customer.phone !== undefined,
    },
    piiSpanCounts: countBy(output.piiSpans.map((span) => span.type)),
    quotePresent: output.quote !== null,
    researchTargetCount: output.researchTargets.length,
    clarificationQuestionCount: output.clarificationQuestions.length,
  };
}

function proposalTraceInput(
  input: DraftProposalInput,
): Readonly<Record<string, unknown>> {
  return {
    ...traceCorrelation(input.traceContext),
    minimizedConversationBytes: Buffer.byteLength(
      input.minimizedConversation,
      "utf8",
    ),
    researchEvidenceCount: input.research.length,
    priorPlanPresent: input.priorPlan !== undefined,
    customerChangePresent: input.customerChange !== undefined,
    customerChangeBytes: input.customerChange
      ? Buffer.byteLength(input.customerChange, "utf8")
      : 0,
  };
}

function proposalTraceOutput(
  output: ProposalPlan,
): Readonly<Record<string, unknown>> {
  return {
    scopeItemCount: output.scopeItems.length,
    requirementCount: output.contractDraft.requirements.length,
    approvedFactCount: output.contractDraft.approvedFacts.length,
    clarificationQuestionCount: output.clarificationQuestions.length,
  };
}

function changeTraceInput(
  input: ClassifyChangeInput,
): Readonly<Record<string, unknown>> {
  return {
    ...traceCorrelation(input.traceContext),
    paidScopeItemCount: input.paidPlan.scopeItems.length,
    paidRequirementCount: input.paidPlan.contractDraft.requirements.length,
    customerMessageBytes: Buffer.byteLength(input.customerMessage, "utf8"),
  };
}

function traceCorrelation(
  context: OrchestrationReasoningTraceContext | undefined,
): Readonly<Record<string, unknown>> {
  return context
    ? {
        projectCorrelation: sha256(context.projectId),
        ...(context.proposalVersion === undefined
          ? {}
          : { proposalVersion: context.proposalVersion }),
      }
    : {};
}

function changeTraceOutput(
  output: ChangeClassification,
): Readonly<Record<string, unknown>> {
  return {
    kind: output.kind,
    supersededScopeItemCount: output.supersededScopeItems.length,
    supersededRequirementCount: output.supersededRequirementIds.length,
    supersededFactCount: output.supersededFactIds.length,
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
