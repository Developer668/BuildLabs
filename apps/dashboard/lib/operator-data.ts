export type OperatorCandidateStatus =
  "running" | "waiting" | "failed" | "passed";

export interface OperatorCandidate {
  candidateId: string;
  runId: string;
  displayName: string;
  status: OperatorCandidateStatus;
  stage: string;
  currentAction: string;
  activityDetail: string;
  activityAt: string;
  frameState: "fixture" | "awaiting" | "unavailable";
  metrics: {
    toolCalls: number;
    failedTools: number;
    receipts: number;
    repairRound: number;
  };
  score: {
    quality: number | null;
    hardRequirementsPassed: number;
    hardRequirementsTotal: number;
    recorded: boolean;
  };
  diff: Array<{
    path: string;
    added: number;
    removed: number;
    state: "added" | "modified" | "deleted";
  }>;
  componentTree: string[];
  findings: Array<{
    code: string;
    severity: "critical" | "major" | "minor";
    state: "open" | "repaired" | "verified";
    summary: string;
  }>;
  receipts: Array<{
    kind: string;
    state: "pass" | "fail" | "pending";
    label: string;
    digest: string | null;
  }>;
}

export interface OperatorProject {
  fixture: boolean;
  projectId: string;
  title: string;
  lifecycle: string;
  lifecycleTone: "active" | "waiting" | "failed" | "proven";
  stream: {
    cursor: number;
    eventId: string;
    state: "live" | "delayed" | "offline";
  };
  versions: {
    contract: number;
    proposal: number;
    paid: number;
    proven: number;
    production: number;
  };
  contract: {
    summary: string;
    createdAt: string;
    hash: string;
    hardRequirements: string[];
    preferences: string[];
    approvedFacts: string[];
  };
  commercial: {
    amount: string;
    currency: string;
    proposalState: "paid" | "awaiting_payment" | "superseded";
    paymentState: "verified" | "unverified" | "failed";
    evidenceSource: "signed_webhook" | "provider_reconciliation";
    matchedFields: string[];
    verifiedAt: string | null;
  };
  currentAction: {
    label: string;
    detail: string;
    owner: "orchestrator" | "provider" | "customer" | "operator";
  };
  candidates: OperatorCandidate[];
  providers: Array<{
    name: string;
    responsibility: string;
    state: "healthy" | "configured" | "unavailable" | "unverified";
    observedAt: string | null;
    detail: string;
  }>;
  frozenPreview: {
    state: "ready" | "unavailable";
    contractVersion: number;
    artifactDigest: string;
    revisionHash: string;
    verifiedAt: string;
    url: string;
  };
  deployment: {
    state: "healthy" | "failed" | "unavailable";
    contractVersion: number;
    releaseVersion: number;
    artifactDigest: string;
    imageDigest: string;
    url: string;
    verifiedAt: string;
  };
  delivery: {
    state: "settled" | "pending" | "failed";
    effectId: string;
    attempts: number;
    settledAt: string | null;
    detail: string;
  };
}

const digest = (character: string) => character.repeat(64);

function candidate(
  index: number,
  input: Omit<OperatorCandidate, "candidateId" | "runId" | "displayName">,
): OperatorCandidate {
  return {
    candidateId: `cand_fixture_0${index}`,
    runId: `run_fixture_0${index}`,
    displayName: `Candidate ${String(index).padStart(2, "0")}`,
    ...input,
  };
}

export const operatorFixture: OperatorProject = {
  fixture: true,
  projectId: "01J_FIXTURE_PROJECT_OPERATOR",
  title: "Northstar scheduling workspace",
  lifecycle: "Verifying revision 3",
  lifecycleTone: "active",
  stream: {
    cursor: 184,
    eventId: "evt_fixture_184",
    state: "live",
  },
  versions: {
    contract: 3,
    proposal: 3,
    paid: 3,
    proven: 2,
    production: 2,
  },
  contract: {
    summary:
      "A responsive scheduling workspace with service selection, availability, and a compact administrative queue.",
    createdAt: "2026-07-24T16:08:12.000Z",
    hash: digest("3"),
    hardRequirements: [
      "A customer can choose a service before selecting an available time.",
      "The administrative queue remains usable at a 360px viewport.",
      "Every generated service statement comes from an approved project fact.",
      "The production image starts as a self-contained HTTP service.",
    ],
    preferences: [
      "Favor a calm, information-dense interface.",
      "Keep primary scheduling actions visible without scrolling on desktop.",
    ],
    approvedFacts: [
      "The project offers three appointment durations.",
      "The intake supplied the service labels used in the interface.",
    ],
  },
  commercial: {
    amount: "$4,800.00",
    currency: "USD",
    proposalState: "paid",
    paymentState: "verified",
    evidenceSource: "signed_webhook",
    matchedFields: [
      "Checkout",
      "PaymentIntent",
      "project",
      "proposal v3",
      "customer",
      "amount",
      "currency",
      "mode",
      "paid status",
    ],
    verifiedAt: "2026-07-24T16:11:06.000Z",
  },
  currentAction: {
    label: "Replaying deterministic verifier receipts",
    detail:
      "The orchestrator is collecting candidate v3 proof. No candidate is currently eligible for promotion.",
    owner: "orchestrator",
  },
  candidates: [
    candidate(1, {
      status: "running",
      stage: "Rendered HTTP proof",
      currentAction: "Crawling same-origin routes",
      activityDetail: "Chromium visibility verifier, page 3 of 5",
      activityAt: "2026-07-24T16:22:18.000Z",
      frameState: "fixture",
      metrics: { toolCalls: 34, failedTools: 0, receipts: 8, repairRound: 1 },
      score: {
        quality: null,
        hardRequirementsPassed: 3,
        hardRequirementsTotal: 4,
        recorded: false,
      },
      diff: [
        {
          path: "app/schedule/page.tsx",
          added: 168,
          removed: 42,
          state: "modified",
        },
        {
          path: "components/time-grid.tsx",
          added: 94,
          removed: 0,
          state: "added",
        },
        {
          path: "tests/schedule.spec.ts",
          added: 71,
          removed: 8,
          state: "modified",
        },
      ],
      componentTree: [
        "AppShell",
        "ScheduleWorkspace",
        "ServicePicker",
        "AvailabilityGrid",
        "BookingSummary",
      ],
      findings: [
        {
          code: "CR-A11Y-014",
          severity: "major",
          state: "verified",
          summary: "Restored keyboard focus after date changes.",
        },
      ],
      receipts: [
        {
          kind: "command",
          state: "pass",
          label: "Project test command",
          digest: digest("a"),
        },
        {
          kind: "delivery_image",
          state: "pass",
          label: "Clean delivery image build",
          digest: digest("b"),
        },
        {
          kind: "rendered_http",
          state: "pending",
          label: "Visible route and interaction crawl",
          digest: null,
        },
        {
          kind: "claims",
          state: "pending",
          label: "Supported-claims inspection",
          digest: null,
        },
      ],
    }),
    candidate(2, {
      status: "waiting",
      stage: "CodeRabbit review",
      currentAction: "Waiting for terminal review",
      activityDetail: "Policy digest accepted; review is still provider-side",
      activityAt: "2026-07-24T16:21:51.000Z",
      frameState: "fixture",
      metrics: { toolCalls: 29, failedTools: 1, receipts: 5, repairRound: 0 },
      score: {
        quality: null,
        hardRequirementsPassed: 2,
        hardRequirementsTotal: 4,
        recorded: false,
      },
      diff: [
        {
          path: "src/routes/schedule.tsx",
          added: 211,
          removed: 57,
          state: "modified",
        },
        {
          path: "src/styles/workspace.css",
          added: 132,
          removed: 35,
          state: "modified",
        },
      ],
      componentTree: [
        "WorkspaceLayout",
        "BookingPanel",
        "CalendarStrip",
        "SlotTable",
      ],
      findings: [],
      receipts: [
        {
          kind: "command",
          state: "pass",
          label: "Project test command",
          digest: digest("c"),
        },
        {
          kind: "coderabbit",
          state: "pending",
          label: "Controller-policy review",
          digest: null,
        },
      ],
    }),
    candidate(3, {
      status: "running",
      stage: "Repair round 2",
      currentAction: "Applying bounded repair",
      activityDetail: "Fixing one controller-attributed interaction failure",
      activityAt: "2026-07-24T16:22:09.000Z",
      frameState: "awaiting",
      metrics: { toolCalls: 41, failedTools: 2, receipts: 4, repairRound: 2 },
      score: {
        quality: null,
        hardRequirementsPassed: 2,
        hardRequirementsTotal: 4,
        recorded: false,
      },
      diff: [
        {
          path: "app/components/booking-flow.tsx",
          added: 245,
          removed: 61,
          state: "modified",
        },
        {
          path: "app/lib/availability.ts",
          added: 76,
          removed: 12,
          state: "modified",
        },
      ],
      componentTree: [
        "BookingApplication",
        "ProgressHeader",
        "ServiceStep",
        "TimeStep",
        "ReviewStep",
      ],
      findings: [
        {
          code: "CR-LOGIC-009",
          severity: "major",
          state: "repaired",
          summary: "Disabled stale availability after service changes.",
        },
      ],
      receipts: [
        {
          kind: "command",
          state: "pass",
          label: "Project test command",
          digest: digest("d"),
        },
        {
          kind: "interaction",
          state: "fail",
          label: "Fresh-state service change",
          digest: digest("e"),
        },
      ],
    }),
    candidate(4, {
      status: "failed",
      stage: "Hard requirement blocked",
      currentAction: "No action scheduled",
      activityDetail: "Responsive queue verifier failed at 360px",
      activityAt: "2026-07-24T16:20:33.000Z",
      frameState: "unavailable",
      metrics: { toolCalls: 27, failedTools: 1, receipts: 6, repairRound: 1 },
      score: {
        quality: 0.81,
        hardRequirementsPassed: 3,
        hardRequirementsTotal: 4,
        recorded: true,
      },
      diff: [
        {
          path: "src/pages/booking.tsx",
          added: 188,
          removed: 22,
          state: "modified",
        },
      ],
      componentTree: ["BookingPage", "Services", "SlotCards", "QueueTable"],
      findings: [],
      receipts: [
        {
          kind: "rendered_http",
          state: "fail",
          label: "360px administrative queue",
          digest: digest("f"),
        },
      ],
    }),
  ],
  providers: [
    {
      name: "Daytona",
      responsibility: "Builders and clean verifiers",
      state: "healthy",
      observedAt: "2026-07-24T16:22:18.000Z",
      detail: "Bounded controller probe passed for this fixture snapshot.",
    },
    {
      name: "Fireworks",
      responsibility: "Generation and claim inspection",
      state: "configured",
      observedAt: null,
      detail: "Configuration exists; no fresh provider probe is represented.",
    },
    {
      name: "CodeRabbit",
      responsibility: "Controller-policy review",
      state: "unverified",
      observedAt: null,
      detail: "One terminal review is still awaited.",
    },
    {
      name: "Braintrust",
      responsibility: "Trace and score recording",
      state: "configured",
      observedAt: null,
      detail: "The active candidate scores have not been recorded.",
    },
    {
      name: "Fly.io",
      responsibility: "Production hosting",
      state: "healthy",
      observedAt: "2026-07-23T21:44:20.000Z",
      detail: "Health applies to release 2, not the active revision.",
    },
    {
      name: "Resend",
      responsibility: "Durable delivery effects",
      state: "healthy",
      observedAt: "2026-07-23T21:45:02.000Z",
      detail: "Release 2 delivery effect settled.",
    },
  ],
  frozenPreview: {
    state: "ready",
    contractVersion: 2,
    artifactDigest: digest("2"),
    revisionHash: digest("7"),
    verifiedAt: "2026-07-23T21:43:11.000Z",
    url: "https://preview.fixture.invalid/release-2",
  },
  deployment: {
    state: "healthy",
    contractVersion: 2,
    releaseVersion: 2,
    artifactDigest: digest("2"),
    imageDigest: digest("9"),
    url: "https://northstar.fixture.invalid",
    verifiedAt: "2026-07-23T21:44:20.000Z",
  },
  delivery: {
    state: "settled",
    effectId: "effect_fixture_delivery_release_2",
    attempts: 1,
    settledAt: "2026-07-23T21:45:02.000Z",
    detail:
      "The release 2 production URL and project access link were recorded as delivered.",
  },
};
