import { describe, expect, it } from "vitest";

import {
  groupOperatorRuns,
  parseOperatorEvidenceSnapshot,
  parseOperatorIntegrationsSnapshot,
  parseOperatorRunSnapshot,
} from "../lib/operator-live-data";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);
const AT = "2026-07-24T18:00:00.000Z";

describe("operator live projections", () => {
  it("retains only allowlisted run fields and groups projects by latest update", () => {
    const parsed = parseOperatorRunSnapshot(
      runSnapshot({
        run: {
          ...run(),
          sandboxId: "must-not-enter-the-projection",
        },
        activity: {
          eventCount: 1,
          latestEvent: {
            sequence: 1,
            runId: RUN_ID,
            type: "run.created",
            stage: "queued",
            payload: { raw: "must-not-enter-the-projection" },
            createdAt: AT,
          },
        },
      }),
    );

    expect(parsed.runs[0]!.run).not.toHaveProperty("sandboxId");
    expect(parsed.runs[0]!.activity.latestEvent).not.toHaveProperty("payload");
    expect(groupOperatorRuns(parsed)).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        runs: expect.any(Array),
      }),
    ]);
  });

  it("rejects unsafe display text, impossible proof counts, and duplicate runs", () => {
    expect(() =>
      parseOperatorRunSnapshot(
        runSnapshot({
          assignment: assignment("<script>unsafe</script>"),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperatorRunSnapshot(
        runSnapshot({
          proof: {
            total: 1,
            passed: 1,
            failed: 1,
            errors: 0,
            hardRequirements: 1,
          },
        }),
      ),
    ).toThrow();
    const duplicated = runSnapshot();
    duplicated.runs.push(duplicated.runs[0]!);
    expect(() => parseOperatorRunSnapshot(duplicated)).toThrow();
  });

  it("rejects cross-project orchestration evidence and strips protected aggregate fields", () => {
    const parsed = parseOperatorEvidenceSnapshot(
      evidenceSnapshot(),
      PROJECT_ID,
    );
    expect(parsed.project).not.toHaveProperty("customer");
    expect(parsed.project).not.toHaveProperty("intake");
    expect(parsed.events.items[0]).not.toHaveProperty("payload");

    const crossed = evidenceSnapshot();
    crossed.events.items[0]!.projectId = OTHER_PROJECT_ID;
    expect(() => parseOperatorEvidenceSnapshot(crossed, PROJECT_ID)).toThrow(
      "crossed a project boundary",
    );
  });

  it("keeps configuration separate from a health probe", () => {
    const integrations = parseOperatorIntegrationsSnapshot({
      status: {
        daytona: "configured",
        fireworks: "healthy",
        braintrust: "configured",
        coderabbit: "unhealthy",
        copilotkit: "configured",
        elevenlabs: "unconfigured",
      },
      lastProbeAt: null,
      endpoint: "/internal/provider-path",
    });

    expect(integrations.status.daytona).toBe("configured");
    expect(integrations.lastProbeAt).toBeNull();
    expect(integrations).not.toHaveProperty("endpoint");
  });
});

function run() {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    candidateId: "candidate-1",
    status: "queued",
    stage: "queued",
    cancelRequested: false,
    createdAt: AT,
    updatedAt: AT,
  };
}

function assignment(strategyLabel = "bounded strategy") {
  return {
    strategyLabel,
    requestedAt: AT,
    contract: {
      contractId: "contract-1",
      contractRevision: 1,
      approvedAt: AT,
      approvedFacts: [],
      requirements: [
        {
          id: "requirement-1",
          description: "Render the requested project state.",
          priority: "hard",
          verifierKinds: ["http"],
        },
      ],
    },
  };
}

function runSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    runs: [
      {
        run: run(),
        assignment: assignment(),
        activity: {
          eventCount: 0,
          latestEvent: null,
        },
        proof: {
          total: 0,
          passed: 0,
          failed: 0,
          errors: 0,
          hardRequirements: 1,
        },
        artifactAvailable: false,
        previewAvailable: false,
        ...overrides,
      },
    ],
    generatedAt: AT,
  };
}

function evidenceSnapshot() {
  return {
    traceCorrelation: SHA,
    project: {
      projectId: PROJECT_ID,
      revision: 4,
      status: "building",
      intake: { content: "protected content" },
      customer: { email: { value: "protected@example.test" } },
      proposals: [
        {
          version: 1,
          projectTitle: "Validated project",
          digest: SHA,
          plan: {
            summary: { text: "A bounded project summary." },
          },
          quote: {
            amountMinor: 10000,
            currency: "usd",
          },
          contract: {
            projectId: PROJECT_ID,
            version: 1,
            digest: SHA,
            approvedFacts: [],
            requirements: [
              {
                requirementId: "requirement-1",
                description: "Render the requested project state.",
                priority: "hard",
                verifiers: [{ kind: "http", path: "/" }],
              },
            ],
            createdAt: AT,
          },
          createdAt: AT,
        },
      ],
      activeProposalVersion: 1,
      paidProposalVersion: 1,
      payments: [
        {
          receiptId: "payment-1",
          projectId: PROJECT_ID,
          proposalVersion: 1,
          amountMinor: 10000,
          amountReceivedMinor: 10000,
          currency: "usd",
          status: "paid",
          verificationSource: "signed_webhook",
          providerStateVerified: true,
          signatureVerified: true,
          paidAt: AT,
          verifiedAt: AT,
          livemode: false,
        },
      ],
      buildBatches: [
        {
          batchId: "batch-1",
          projectId: PROJECT_ID,
          proposalVersion: 1,
          contractVersion: 1,
          requestedCandidateCount: 4,
          runs: [
            {
              runId: RUN_ID,
              candidateId: "candidate-1",
              status: "queued",
            },
          ],
          status: "building",
          createdAt: AT,
        },
      ],
      activeBuildBatchId: "batch-1",
      previews: [],
      deployments: [],
      openClarificationQuestions: [],
      effects: [],
      errors: [],
      createdAt: AT,
      updatedAt: AT,
    },
    events: {
      items: [
        {
          eventId: EVENT_ID,
          sequence: 1,
          projectId: PROJECT_ID,
          aggregateRevision: 4,
          type: "build.dispatched",
          actor: "system",
          payload: { buildBatchId: "batch-1" },
          occurredAt: AT,
        },
      ],
    },
    operations: {
      effects: [],
      errors: [],
      deadLetters: [],
      inboundMail: [],
    },
  };
}
