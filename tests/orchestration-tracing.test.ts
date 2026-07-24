import { describe, expect, it, vi } from "vitest";

import { sha256 } from "../src/lib/canonical-json.js";
import {
  BraintrustOrchestrationTrace,
  type BraintrustOrchestrationLogger,
  type BraintrustOrchestrationSdkSpan,
} from "../src/orchestration/adapters/braintrust/braintrust-orchestration-trace.js";
import { TracedOrchestrationReasoner } from "../src/orchestration/application/traced-orchestration-reasoner.js";
import type {
  OrchestrationTraceEvent,
  OrchestrationTracePort,
  OrchestrationTraceSpan,
} from "../src/orchestration/ports/trace.js";
import type {
  AgentMessage,
  AgentToolDefinition,
  ModelPort,
  ModelTurn,
} from "../src/ports/index.js";
import { FireworksOrchestrationReasoner } from "../src/orchestration/application/fireworks-orchestration-reasoner.js";

describe("TracedOrchestrationReasoner", () => {
  it("traces intake analysis with digests and counts, never raw customer content", async () => {
    const conversation =
      "I am Alice Doe. Email alice@example.com or call 415-555-1212.";
    const nameStart = conversation.indexOf("Alice Doe");
    const emailStart = conversation.indexOf("alice@example.com");
    const phoneStart = conversation.indexOf("415-555-1212");
    const model = new StaticModel({
      content: null,
      toolCalls: [
        {
          id: "analysis-call",
          name: "submit_intake_analysis",
          argumentsJson: JSON.stringify({
            customer: {
              name: "Alice Doe",
              email: "alice@example.com",
              phone: "415-555-1212",
            },
            piiSpans: [
              {
                type: "person_name",
                startOffset: nameStart,
                endOffset: nameStart + "Alice Doe".length,
                confidence: 1,
              },
              {
                type: "email",
                startOffset: emailStart,
                endOffset: emailStart + "alice@example.com".length,
                confidence: 1,
              },
              {
                type: "phone",
                startOffset: phoneStart,
                endOffset: phoneStart + "415-555-1212".length,
                confidence: 1,
              },
            ],
            quote: null,
            researchTargets: [],
            clarificationQuestions: [],
          }),
        },
      ],
    });
    const trace = new RecordingTrace();
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(model),
      trace,
    );

    await expect(
      reasoner.analyzeConversation({
        channel: "email",
        conversation,
        researchConsent: false,
        trustedSenderEmail: "alice@example.com",
        traceContext: {
          projectId: "project-trace-correlation-001",
          proposalVersion: 3,
        },
      }),
    ).resolves.toMatchObject({
      customer: {
        name: "Alice Doe",
        email: "alice@example.com",
      },
    });

    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({
      operation: "intake_analysis",
      input: {
        channel: "email",
        conversationBytes: Buffer.byteLength(conversation),
        researchConsent: false,
        trustedSenderEmailPresent: true,
        projectCorrelation: sha256("project-trace-correlation-001"),
        proposalVersion: 3,
      },
    });
    expect(trace.flushes).toBe(1);
    const serializedTrace = JSON.stringify(trace.events);
    expect(serializedTrace).not.toContain(conversation);
    expect(serializedTrace).not.toContain("Alice Doe");
    expect(serializedTrace).not.toContain("alice@example.com");
    expect(serializedTrace).not.toContain("415-555-1212");
    expect(serializedTrace).not.toContain("project-trace-correlation-001");
  });

  it("traces proposal planning with bounded metadata instead of plan content", async () => {
    const evidence = "Build a private client portal.";
    const modelBuildPrompt =
      "Build a private client portal for alice@example.com using secret details.";
    const plan = {
      title: "Private client portal",
      summary: evidence,
      scopeItems: [
        {
          id: "scope-portal",
          text: evidence,
          citation: { kind: "conversation" as const, excerpt: evidence },
        },
      ],
      buildPrompt: modelBuildPrompt,
      strategyLabels: ["requirements-first"],
      contractDraft: {
        approvedFacts: [],
        forbiddenClaims: [],
        requirements: [
          {
            id: "requirement-portal",
            description: evidence,
            priority: "hard" as const,
            citation: { kind: "conversation" as const, excerpt: evidence },
            verifiers: [{ kind: "semantic" as const, criterion: evidence }],
          },
        ],
        verification: {
          origin: "system_policy" as const,
          policyId: "buildlabs-proof-gate-v1" as const,
          buildCommand: "npm run build",
          testCommands: ["npm test"],
          previewCommand: "npm start",
          previewPort: 3_000,
        },
      },
      assets: [],
      clarificationQuestions: [],
    };
    const trace = new RecordingTrace();
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(
        new StaticModel({
          content: null,
          toolCalls: [
            {
              id: "proposal-call",
              name: "submit_proposal_plan",
              argumentsJson: JSON.stringify(plan),
            },
          ],
        }),
      ),
      trace,
    );

    await expect(
      reasoner.draftProposal({
        minimizedConversation: evidence,
        analysis: {
          customer: { email: "alice@example.com" },
          piiSpans: [],
          quote: null,
          researchTargets: [],
          clarificationQuestions: [],
        },
        research: [],
        customerChange: "Please include secret details.",
      }),
    ).resolves.toEqual(plan);

    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({
      operation: "proposal_planning",
      input: {
        minimizedConversationBytes: Buffer.byteLength(evidence),
        researchEvidenceCount: 0,
        priorPlanPresent: false,
        customerChangePresent: true,
        customerChangeBytes: Buffer.byteLength(
          "Please include secret details.",
        ),
      },
      logs: [
        {
          output: {
            scopeItemCount: 1,
            requirementCount: 1,
            approvedFactCount: 0,
          },
        },
      ],
    });
    expect(trace.flushes).toBe(1);
    const serializedTrace = JSON.stringify(trace.events);
    expect(serializedTrace).not.toContain(evidence);
    expect(serializedTrace).not.toContain(modelBuildPrompt);
    expect(serializedTrace).not.toContain("alice@example.com");
    expect(serializedTrace).not.toContain("Please include secret details.");
  });

  it("traces change classification without recording the customer email", async () => {
    const evidence = "Build a private client portal.";
    const paidPlan = {
      title: "Private client portal",
      summary: evidence,
      scopeItems: [
        {
          id: "scope-portal",
          text: evidence,
          citation: { kind: "conversation" as const, excerpt: evidence },
        },
      ],
      buildPrompt: evidence,
      strategyLabels: ["requirements-first"],
      contractDraft: {
        approvedFacts: [],
        forbiddenClaims: [],
        requirements: [
          {
            id: "requirement-portal",
            description: evidence,
            priority: "hard" as const,
            citation: { kind: "conversation" as const, excerpt: evidence },
            verifiers: [{ kind: "semantic" as const, criterion: evidence }],
          },
        ],
        verification: {
          origin: "system_policy" as const,
          policyId: "buildlabs-proof-gate-v1" as const,
          buildCommand: "npm run build",
          testCommands: ["npm test"],
          previewCommand: "npm start",
          previewPort: 3_000,
        },
      },
      assets: [],
      clarificationQuestions: [],
    };
    const customerMessage =
      "Alice at alice@example.com wants the portal navigation changed.";
    const classification = {
      kind: "within_paid_scope",
      explanation: customerMessage,
      supersededScopeItems: [],
      supersededRequirementIds: [],
      supersededFactIds: [],
    };
    const trace = new RecordingTrace();
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(
        new StaticModel({
          content: null,
          toolCalls: [
            {
              id: "classification-call",
              name: "submit_change_classification",
              argumentsJson: JSON.stringify(classification),
            },
          ],
        }),
      ),
      trace,
    );

    await expect(
      reasoner.classifyChange({ paidPlan, customerMessage }),
    ).resolves.toEqual(classification);

    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({
      operation: "change_classification",
      input: {
        paidScopeItemCount: 1,
        paidRequirementCount: 1,
        customerMessageBytes: Buffer.byteLength(customerMessage),
      },
      logs: [
        {
          output: {
            kind: "within_paid_scope",
            supersededScopeItemCount: 0,
            supersededRequirementCount: 0,
            supersededFactCount: 0,
          },
        },
      ],
    });
    expect(trace.flushes).toBe(1);
    const serializedTrace = JSON.stringify(trace.events);
    expect(serializedTrace).not.toContain(customerMessage);
    expect(serializedTrace).not.toContain("Alice");
    expect(serializedTrace).not.toContain("alice@example.com");
  });

  it("fails closed instead of returning Fireworks output when trace flush fails", async () => {
    const trace = new RecordingTrace();
    trace.flushError = new Error("sensitive upstream flush detail");
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(
        new StaticModel({
          content: null,
          toolCalls: [
            {
              id: "analysis-call",
              name: "submit_intake_analysis",
              argumentsJson: JSON.stringify({
                customer: {},
                piiSpans: [],
                quote: null,
                researchTargets: [],
                clarificationQuestions: [],
              }),
            },
          ],
        }),
      ),
      trace,
    );

    await expect(
      reasoner.analyzeConversation({
        channel: "text",
        conversation: "Build a small website.",
        researchConsent: false,
      }),
    ).rejects.toMatchObject({
      name: "OrchestrationTraceError",
      message: "Could not durably flush intake_analysis trace",
    });
    expect(trace.flushes).toBe(1);
  });

  it("fails within a bounded deadline when the trace flush never settles", async () => {
    const trace = new RecordingTrace();
    trace.hangFlush = true;
    const reasoner = new TracedOrchestrationReasoner(
      new FireworksOrchestrationReasoner(
        new StaticModel({
          content: null,
          toolCalls: [
            {
              id: "analysis-call",
              name: "submit_intake_analysis",
              argumentsJson: JSON.stringify({
                customer: {},
                piiSpans: [],
                quote: null,
                researchTargets: [],
                clarificationQuestions: [],
              }),
            },
          ],
        }),
      ),
      trace,
      { flushTimeoutMs: 10 },
    );

    const outcome = await Promise.race([
      reasoner
        .analyzeConversation({
          channel: "text",
          conversation: "Build a small website.",
          researchConsent: false,
        })
        .then(
          () => "unexpected-success" as const,
          (error: unknown) => error,
        ),
      new Promise<"test-deadline">((resolve) => {
        setTimeout(() => resolve("test-deadline"), 250);
      }),
    ]);

    expect(outcome).toMatchObject({
      name: "OrchestrationTraceError",
      message: "Could not durably flush intake_analysis trace",
    });
    expect(trace.flushes).toBe(1);
  });
});

describe("BraintrustOrchestrationTrace", () => {
  it("uses a read-only authenticated project lookup for readiness", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        objects: [{ id: "project-id", name: "BuildLabs" }],
      }),
    );
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      apiUrl: "https://api.braintrust.dev/tenant",
      appUrl: "https://www.braintrust.dev",
      projectName: "BuildLabs",
      logger: new RecordingBraintrustLogger(),
      fetch: fetchImplementation,
    });

    await expect(trace.health()).resolves.toBeUndefined();
    const [requestUrl, request] = fetchImplementation.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    if (!(requestUrl instanceof URL)) {
      throw new Error("Expected Braintrust readiness to use a URL");
    }
    expect(requestUrl.href).toBe(
      "https://api.braintrust.dev/tenant/v1/project?limit=1&project_name=BuildLabs",
    );
    expect(request).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "Bearer braintrust-key-with-enough-characters",
      },
      redirect: "error",
    });
  });

  it("applies the shared recursive redactor before logging trace data", async () => {
    const logger = new RecordingBraintrustLogger();
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      projectName: "BuildLabs",
      logger,
    });

    await expect(
      trace.run(
        {
          operation: "intake_analysis",
          input: {
            contact: "alice@example.com",
            authorization: "Bearer this-is-a-secret-bearer-token",
          },
        },
        (span) => {
          span.log({
            output: {
              callback: "Call 415-555-1212",
              apiKey: "sk-live-secret-value",
            },
          });
          return Promise.resolve("completed");
        },
      ),
    ).resolves.toBe("completed");
    await trace.flush();

    const serialized = JSON.stringify({
      events: logger.events,
      logs: logger.logs,
    });
    expect(serialized).toContain("[EMAIL]");
    expect(serialized).toContain("[PHONE]");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("415-555-1212");
    expect(serialized).not.toContain("this-is-a-secret-bearer-token");
    expect(serialized).not.toContain("sk-live-secret-value");
  });

  it("indexes a one-way project correlation and proposal version in Braintrust metadata", async () => {
    const logger = new RecordingBraintrustLogger();
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      projectName: "BuildLabs",
      logger,
    });
    const projectCorrelation = sha256("project-correlation-metadata-001");

    await trace.run(
      {
        operation: "proposal_planning",
        input: { projectCorrelation, proposalVersion: 4 },
      },
      () => Promise.resolve(undefined),
    );

    expect(logger.events[0]).toMatchObject({
      metadata: {
        component: "general-orchestrator",
        operation: "proposal_planning",
        projectCorrelation,
        proposalVersion: 4,
      },
    });
    expect(JSON.stringify(logger.events)).not.toContain(
      "project-correlation-metadata-001",
    );
  });

  it("never exposes a raw reasoner error to Braintrust automatic error capture", async () => {
    const logger = new RecordingBraintrustLogger();
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      projectName: "BuildLabs",
      logger,
    });
    const sensitiveFailure = new Error(
      "Fireworks rejected alice@example.com and 415-555-1212",
    );

    await expect(
      trace.run(
        {
          operation: "intake_analysis",
          input: { privateContentPresent: true },
        },
        () => Promise.reject(sensitiveFailure),
      ),
    ).rejects.toBe(sensitiveFailure);

    const providerVisibleErrors = JSON.stringify(logger.callbackErrors);
    expect(providerVisibleErrors).not.toContain("alice@example.com");
    expect(providerVisibleErrors).not.toContain("415-555-1212");
  });

  it("surfaces Braintrust trace-write failures with a sanitized fail-closed error", async () => {
    const logger = new RecordingBraintrustLogger();
    logger.traceError = new Error("alice@example.com provider failure");
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      projectName: "BuildLabs",
      logger,
    });

    const failure = trace.run(
      {
        operation: "change_classification",
        input: { privateContentPresent: true },
      },
      () => Promise.resolve("must-not-return"),
    );

    await expect(failure).rejects.toMatchObject({
      name: "OrchestrationTraceError",
      message: "Could not record change_classification trace",
    });
    await expect(failure).rejects.not.toThrow("alice@example.com");
  });

  it("surfaces Braintrust flush failures instead of acknowledging an unflushed trace", async () => {
    const logger = new RecordingBraintrustLogger();
    logger.flushError = new Error("private provider detail");
    const trace = new BraintrustOrchestrationTrace({
      apiKey: "braintrust-key-with-enough-characters",
      projectName: "BuildLabs",
      logger,
    });

    await expect(trace.flush()).rejects.toMatchObject({
      name: "OrchestrationTraceError",
      message: "Could not durably flush orchestration traces",
    });
  });
});

class RecordingTrace implements OrchestrationTracePort {
  readonly events: Array<OrchestrationTraceEvent & { logs: unknown[] }> = [];
  flushes = 0;
  flushError: Error | undefined;
  hangFlush = false;

  health(): Promise<void> {
    return Promise.resolve();
  }

  async run<T>(
    event: OrchestrationTraceEvent,
    operation: (span: OrchestrationTraceSpan) => Promise<T>,
  ): Promise<T> {
    const recorded = { ...event, logs: [] as unknown[] };
    this.events.push(recorded);
    return operation({
      log: (entry) => {
        recorded.logs.push(entry);
      },
    });
  }

  flush(): Promise<void> {
    this.flushes += 1;
    if (this.hangFlush) {
      return new Promise(() => undefined);
    }
    return this.flushError
      ? Promise.reject(this.flushError)
      : Promise.resolve();
  }
}

class RecordingBraintrustLogger implements BraintrustOrchestrationLogger {
  readonly events: unknown[] = [];
  readonly logs: unknown[] = [];
  readonly callbackErrors: unknown[] = [];
  traceError: Error | undefined;
  flushError: Error | undefined;

  async traced<T>(
    operation: (span: BraintrustOrchestrationSdkSpan) => Promise<T>,
    options: {
      name: string;
      type: "task";
      event: {
        input: unknown;
        metadata: Readonly<Record<string, unknown>>;
      };
    },
  ): Promise<T> {
    this.events.push(options.event);
    if (this.traceError) {
      throw this.traceError;
    }
    try {
      return await operation({
        rootSpanId: "trace-identifier",
        log: (event) => {
          this.logs.push(event);
        },
      });
    } catch (error) {
      this.callbackErrors.push(
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
      );
      throw error;
    }
  }

  flush(): Promise<void> {
    return this.flushError
      ? Promise.reject(this.flushError)
      : Promise.resolve();
  }
}

class StaticModel implements ModelPort {
  constructor(private readonly turn: ModelTurn) {}

  complete(
    _messages: AgentMessage[],
    _tools: AgentToolDefinition[],
  ): Promise<ModelTurn> {
    return Promise.resolve(this.turn);
  }

  evaluateContract(): never {
    throw new Error("not used");
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}
