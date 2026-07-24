import type {
  EvidenceReceipt,
  RunEvent,
  StudioRun,
  StudioSelection,
} from "./types";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const candidateDefinitions = [
  {
    id: "5de4d5da-f80f-4ce5-8157-dca72a5dc001",
    candidateId: "candidate-structure",
    label: "Structure",
    status: "running" as const,
    stage: "generating" as const,
    updated: 6,
    eventCount: 68,
  },
  {
    id: "5de4d5da-f80f-4ce5-8157-dca72a5dc002",
    candidateId: "candidate-visual",
    label: "Visual",
    status: "running" as const,
    stage: "reviewing" as const,
    updated: 2,
    eventCount: 91,
  },
  {
    id: "5de4d5da-f80f-4ce5-8157-dca72a5dc003",
    candidateId: "candidate-conversion",
    label: "Conversion",
    status: "running" as const,
    stage: "verifying" as const,
    updated: 4,
    eventCount: 83,
  },
  {
    id: "5de4d5da-f80f-4ce5-8157-dca72a5dc004",
    candidateId: "candidate-repair",
    label: "Repair",
    status: "running" as const,
    stage: "reviewing" as const,
    updated: 1,
    eventCount: 57,
  },
];

export const demoRuns: StudioRun[] = candidateDefinitions.map(
  (candidate, index) => ({
    run: {
      id: candidate.id,
      projectId: "project-mission-peak",
      candidateId: candidate.candidateId,
      status: candidate.status,
      stage: candidate.stage,
      slotId: index + 1,
      sandboxId: `demo-sandbox-${index + 1}`,
      previewPort: 3000,
      cancelRequested: false,
      createdAt: ago(18),
      updatedAt: ago(candidate.updated),
    },
    assignment: {
      strategyLabel: `${candidate.label.toLowerCase()}-first service website`,
      requestedAt: ago(18),
      limits: {
        maxAgentSteps: 60,
        maxRepairRounds: 2,
        wallClockSeconds: 1800,
        maxToolOutputBytes: 65536,
      },
      contract: {
        contractId: "contract-mission-peak-v2",
        contractRevision: 2,
        approvedAt: ago(20),
        approvedFacts: [
          {
            id: "business-name",
            statement: "The business is named Mission Peak Electric.",
          },
          {
            id: "service-area",
            statement:
              "The service area includes Fremont, Newark, and Union City.",
          },
          {
            id: "services",
            statement:
              "The business installs EV chargers and electrical panels.",
          },
        ],
        forbiddenClaims: [
          "Unverified emergency availability",
          "Unverified license or certification claims",
        ],
        requirements: [
          {
            id: "homepage",
            description:
              "Create a clear, responsive service-business homepage.",
            priority: "hard",
            verifierKinds: ["http", "command"],
          },
          {
            id: "estimate",
            description: "Provide an accessible estimate request flow.",
            priority: "hard",
            verifierKinds: ["http", "command"],
          },
          {
            id: "content",
            description: "Use only approved business facts and service areas.",
            priority: "hard",
            verifierKinds: ["command"],
          },
          {
            id: "visual-polish",
            description:
              "Use a restrained hierarchy appropriate for a local electrician.",
            priority: "preference",
            verifierKinds: ["semantic"],
          },
        ],
      },
    },
    activity: {
      eventCount: candidate.eventCount,
      latestEvent: {
        sequence: candidate.eventCount,
        runId: candidate.id,
        type:
          index === 0
            ? "agent.tool.completed"
            : index === 1
              ? "review.completed"
              : index === 2
                ? "verification.completed"
                : "repair.started",
        stage: candidate.stage,
        payload:
          index === 0
            ? { toolName: "write_files", ok: true, step: 37 }
            : index === 1
              ? { findings: 0, reviewer: "coderabbit" }
              : index === 2
                ? { command: "npm test", status: "PASS" }
                : { repairRound: 2, finding: "form validation state" },
        createdAt: ago(candidate.updated),
      },
    },
    proof: {
      total: index === 1 ? 7 : index === 2 ? 6 : 4,
      passed: index === 1 ? 7 : index === 2 ? 5 : 3,
      failed: index === 2 ? 1 : 0,
      errors: 0,
      hardRequirements: 3,
    },
    artifactAvailable: false,
    previewAvailable: true,
  }),
);

const eventLabels = [
  ["run.started", "provisioning", { slotId: 2, sandbox: "isolated" }],
  ["sandbox.ready", "generating", { runtime: "typescript", port: 3000 }],
  [
    "agent.tool.completed",
    "generating",
    { toolName: "write_files", filesChanged: 7, ok: true },
  ],
  [
    "preview.ready",
    "verifying",
    { routes: ["/", "/services", "/estimate"], status: 200 },
  ],
  [
    "verification.completed",
    "verifying",
    { command: "npm test", passed: 4, failed: 0 },
  ],
  [
    "review.completed",
    "reviewing",
    { provider: "coderabbit", repairedFindings: 2 },
  ],
] as const;

export function demoSelection(run: StudioRun): StudioSelection {
  const events: RunEvent[] = eventLabels.map(
    ([type, stage, payload], index) => ({
      sequence: index + 1,
      runId: run.run.id,
      type,
      stage,
      payload,
      createdAt: ago(17 - index * 2),
    }),
  );
  const evidence: EvidenceReceipt[] = [
    {
      receiptId: "demo-evidence-build",
      status: "PASS",
      kind: "build",
      provider: "daytona",
      completedAt: ago(8),
      durationMs: 12400,
    },
    {
      receiptId: "demo-evidence-test",
      status: "PASS",
      kind: "test",
      provider: "daytona",
      completedAt: ago(7),
      durationMs: 3420,
    },
    {
      receiptId: "demo-evidence-preview",
      status: "PASS",
      kind: "preview",
      provider: "daytona",
      completedAt: ago(6),
      durationMs: 2700,
    },
    {
      receiptId: "demo-evidence-review",
      status: "PASS",
      kind: "coderabbit",
      provider: "coderabbit",
      completedAt: ago(3),
      findings: [],
    },
    {
      receiptId: "demo-evidence-contract",
      status: "PASS",
      kind: "contract-evaluation",
      provider: "fireworks",
      completedAt: ago(2),
      summary:
        "All hard requirements are currently supported by durable evidence.",
      requirements:
        run.assignment?.contract.requirements.map((requirement) => ({
          requirementId: requirement.id,
          status: "PASS" as const,
          explanation: "Matched by the configured verifier.",
        })) ?? [],
    },
  ];
  return { run, events, evidence, preview: null };
}
