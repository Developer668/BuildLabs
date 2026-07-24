import type { StudioRun } from "./types";

const FIXTURE_PROJECTS = [
  {
    id: "fixture-northstar-scheduling",
    label: "Northstar scheduling",
    request:
      "Build a calm appointment request flow with service selection and accessible feedback.",
  },
  {
    id: "fixture-harbor-counsel",
    label: "Harbor counsel",
    request:
      "Build a fictional intake checklist that clearly states it does not provide legal advice.",
  },
  {
    id: "fixture-cascade-home",
    label: "Cascade home",
    request:
      "Build an interactive home project planner with room filters and a local estimate summary.",
  },
  {
    id: "fixture-civic-garden",
    label: "Civic garden",
    request:
      "Build a neighborhood garden workspace with plot availability and a volunteer task board.",
  },
] as const;

const FIXTURE_TIME = "2026-07-24T20:00:00.000Z";

export const studioFixtureRuns: StudioRun[] = FIXTURE_PROJECTS.map(
  ({ id: projectId, label, request }, index) => ({
    run: {
      id: `fixture-run-${index + 1}`,
      projectId,
      candidateId: `fixture-candidate-${index + 1}`,
      status: index === 2 ? "failed" : index === 3 ? "queued" : "running",
      stage: index === 2 ? "verifying" : index === 3 ? "queued" : "generating",
      slotId: index + 1,
      cancelRequested: false,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    },
    assignment: {
      strategyLabel: `fixture ${label.toLowerCase()} website`,
      requestedAt: FIXTURE_TIME,
      limits: {
        maxAgentSteps: 0,
        maxRepairRounds: 0,
        wallClockSeconds: 0,
        maxToolOutputBytes: 0,
      },
      contract: {
        contractId: `fixture-contract-${index + 1}`,
        contractRevision: 1,
        approvedAt: FIXTURE_TIME,
        approvedFacts: [
          {
            id: "fixture-disclosure",
            statement: `${label} is fictional fixture data for local Studio development.`,
          },
          {
            id: "fixture-transcript",
            statement: `Fictional transcript excerpt: "${request}"`,
          },
        ],
        forbiddenClaims: ["Any provider, payment, or delivery claim"],
        requirements: [
          {
            id: "fixture-layout",
            description: "Fixture-only project layout",
            priority: "hard",
            verifierKinds: [],
          },
        ],
      },
    },
    activity: {
      eventCount: 1,
      latestEvent: {
        sequence: 1,
        runId: `fixture-run-${index + 1}`,
        type: "fixture.project.loaded",
        stage:
          index === 2 ? "verifying" : index === 3 ? "queued" : "generating",
        payload: { fixture: true, label },
        createdAt: FIXTURE_TIME,
      },
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
  }),
);
