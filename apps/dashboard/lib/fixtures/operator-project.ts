import {
  type OperatorProject,
  OperatorProjectSchema,
} from "../contracts/operator";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const D = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

export const operatorProjectFixture: OperatorProject =
  OperatorProjectSchema.parse({
    schemaVersion: 1,
    fixture: true,
    projectId: "38db6ae2-e155-4fc0-9cdf-c907b876d619",
    title: "Northstar appointment workspace",
    lifecycle: "verifying",
    aggregateRevision: 27,
    contract: {
      version: 2,
      digest: D,
      lockedAt: "2026-07-24T15:09:00.000Z",
      summary:
        "Responsive appointment request flow with accessible feedback and a bounded confirmation state.",
      requirements: [
        {
          id: "hard-mobile",
          priority: "hard",
          text: "Appointment form is the first primary action on mobile",
        },
        {
          id: "hard-keyboard",
          priority: "hard",
          text: "All form controls are keyboard accessible",
        },
        {
          id: "preference-tone",
          priority: "preference",
          text: "Calm clinical visual treatment",
        },
      ],
    },
    proposal: {
      version: 2,
      state: "paid",
      amountMinor: 480000,
      currency: "USD",
    },
    payment: {
      state: "verified",
      evidenceSource: "signed_webhook",
      verifiedAt: "2026-07-24T15:08:00.000Z",
    },
    candidates: [
      {
        runId: "fd8571de-0222-4f7a-955d-147de4d44d93",
        candidateId: "candidate-northstar-1",
        displayName: "Candidate 1",
        status: "running",
        stage: "finalizing",
        boundedAction: "Finalizing controller evidence",
        revisionHash: A,
        artifactDigest: null,
        preview: {
          state: "live",
          url: "https://operator-preview.example.invalid/candidate-1",
        },
        diff: {
          state: "recorded",
          files: 14,
          additions: 892,
          deletions: 117,
          paths: [
            "app/appointments/page.tsx",
            "components/booking-form.tsx",
            "styles/forms.css",
          ],
        },
        componentTree: [
          {
            path: "app/appointments/page.tsx",
            kind: "route",
            label: "Appointments",
          },
          {
            path: "components/booking-form.tsx",
            kind: "component",
            label: "Booking form",
          },
        ],
        receipts: [
          {
            receiptId: "receipt-source-1",
            kind: "source_integrity",
            status: "pass",
            scope: "Controller source digest matched the frozen revision",
            evidenceDigest: A,
            completedAt: "2026-07-24T16:11:00.000Z",
          },
          {
            receiptId: "receipt-build-1",
            kind: "build",
            status: "pass",
            scope: "Application build completed in a clean verifier",
            evidenceDigest: B,
            completedAt: "2026-07-24T16:14:00.000Z",
          },
          {
            receiptId: "receipt-gate-1",
            kind: "proof_gate",
            status: "running",
            scope: "Complete proof decision is still pending",
            evidenceDigest: null,
            completedAt: null,
          },
        ],
        codeRabbit: {
          state: "clean",
          policyDigest: C,
          findings: [],
        },
        braintrust: {
          state: "recorded",
          hardRequirementsPassed: null,
          preferenceScore: null,
          designScore: null,
          unsupportedClaimsPassed: true,
        },
        updatedAt: "2026-07-24T16:18:42.000Z",
        completedAt: null,
      },
      {
        runId: "d4859144-6182-42c0-b2eb-8a79ba017832",
        candidateId: "candidate-northstar-2",
        displayName: "Candidate 2",
        status: "passed",
        stage: "complete",
        boundedAction: null,
        revisionHash: B,
        artifactDigest: C,
        preview: {
          state: "live",
          url: "https://operator-preview.example.invalid/candidate-2",
        },
        diff: {
          state: "recorded",
          files: 12,
          additions: 740,
          deletions: 91,
          paths: ["app/appointments/page.tsx", "components/booking-panel.tsx"],
        },
        componentTree: [
          {
            path: "app/appointments/page.tsx",
            kind: "route",
            label: "Appointment flow",
          },
          {
            path: "components/booking-panel.tsx",
            kind: "component",
            label: "Booking panel",
          },
        ],
        receipts: [
          {
            receiptId: "receipt-source-2",
            kind: "source_integrity",
            status: "pass",
            scope: "Controller source digest matched the frozen revision",
            evidenceDigest: A,
            completedAt: "2026-07-24T16:04:00.000Z",
          },
          {
            receiptId: "receipt-review-2",
            kind: "code_review",
            status: "pass",
            scope: "Independent review completed with no critical findings",
            evidenceDigest: B,
            completedAt: "2026-07-24T16:12:00.000Z",
          },
          {
            receiptId: "receipt-gate-2",
            kind: "proof_gate",
            status: "pass",
            scope: "All hard requirements passed for contract version 2",
            evidenceDigest: C,
            completedAt: "2026-07-24T16:17:00.000Z",
          },
        ],
        codeRabbit: {
          state: "clean",
          policyDigest: C,
          findings: [],
        },
        braintrust: {
          state: "recorded",
          hardRequirementsPassed: true,
          preferenceScore: 0.91,
          designScore: 0.88,
          unsupportedClaimsPassed: true,
        },
        updatedAt: "2026-07-24T16:17:00.000Z",
        completedAt: "2026-07-24T16:17:00.000Z",
      },
      {
        runId: "2fd88e8d-7793-4e14-8ae5-e03f4880773b",
        candidateId: "candidate-northstar-3",
        displayName: "Candidate 3",
        status: "rejected",
        stage: "complete",
        boundedAction: null,
        revisionHash: C,
        artifactDigest: null,
        preview: {
          state: "unavailable",
          url: null,
        },
        diff: {
          state: "recorded",
          files: 10,
          additions: 623,
          deletions: 80,
          paths: ["app/page.tsx", "components/request-form.tsx"],
        },
        componentTree: [
          { path: "app/page.tsx", kind: "route", label: "Home" },
          {
            path: "components/request-form.tsx",
            kind: "component",
            label: "Request form",
          },
        ],
        receipts: [
          {
            receiptId: "receipt-http-3",
            kind: "rendered_http",
            status: "fail",
            scope: "The mobile primary action requirement did not pass",
            evidenceDigest: D,
            completedAt: "2026-07-24T16:13:00.000Z",
          },
        ],
        codeRabbit: {
          state: "findings",
          policyDigest: C,
          findings: [
            {
              findingId: "finding-3-a",
              severity: "high",
              state: "open",
              path: "components/request-form.tsx",
              line: 84,
              summary:
                "Form failure feedback is not programmatically associated",
            },
          ],
        },
        braintrust: {
          state: "recorded",
          hardRequirementsPassed: false,
          preferenceScore: null,
          designScore: null,
          unsupportedClaimsPassed: true,
        },
        updatedAt: "2026-07-24T16:13:00.000Z",
        completedAt: "2026-07-24T16:13:00.000Z",
      },
      {
        runId: "3bcd3e55-10db-4b2f-98d8-c314ad972861",
        candidateId: "candidate-northstar-4",
        displayName: "Candidate 4",
        status: "failed",
        stage: "complete",
        boundedAction: null,
        revisionHash: D,
        artifactDigest: null,
        preview: {
          state: "unavailable",
          url: null,
        },
        diff: {
          state: "unavailable",
          files: 0,
          additions: 0,
          deletions: 0,
          paths: [],
        },
        componentTree: [],
        receipts: [
          {
            receiptId: "receipt-delivery-4",
            kind: "build",
            status: "error",
            scope: "Clean delivery verification did not complete",
            evidenceDigest: null,
            completedAt: "2026-07-24T16:10:00.000Z",
          },
        ],
        codeRabbit: {
          state: "pending",
          policyDigest: C,
          findings: [],
        },
        braintrust: {
          state: "unavailable",
          hardRequirementsPassed: null,
          preferenceScore: null,
          designScore: null,
          unsupportedClaimsPassed: null,
        },
        updatedAt: "2026-07-24T16:10:00.000Z",
        completedAt: "2026-07-24T16:10:00.000Z",
      },
    ],
    providers: [
      {
        name: "Daytona",
        state: "healthy",
        checkedAt: "2026-07-24T16:18:30.000Z",
        detail: "Three verifier workspaces active",
      },
      {
        name: "Fireworks",
        state: "healthy",
        checkedAt: "2026-07-24T16:18:22.000Z",
        detail: "Bounded evaluator requests available",
      },
      {
        name: "Braintrust",
        state: "healthy",
        checkedAt: "2026-07-24T16:18:17.000Z",
        detail: "Required trace flush recorded",
      },
      {
        name: "CodeRabbit",
        state: "degraded",
        checkedAt: "2026-07-24T16:18:02.000Z",
        detail: "One review is awaiting terminal completion",
      },
      {
        name: "Fly.io",
        state: "configured",
        checkedAt: null,
        detail: "No deployment requested for this revision",
      },
      {
        name: "Resend",
        state: "healthy",
        checkedAt: "2026-07-24T16:17:48.000Z",
        detail: "Dashboard access effect settled",
      },
      {
        name: "Stripe",
        state: "healthy",
        checkedAt: "2026-07-24T15:08:00.000Z",
        detail: "Version-bound payment receipt verified",
      },
      {
        name: "ElevenLabs",
        state: "configured",
        checkedAt: null,
        detail: "Studio speech operations are not active",
      },
    ],
    deployment: {
      state: "not_started",
      contractVersion: null,
      artifactDigest: null,
      imageDigest: null,
      url: null,
    },
    deliveryEffects: [
      {
        effectId: "effect-dashboard-access-v2",
        kind: "send_dashboard_access",
        state: "settled",
        attempt: 1,
        updatedAt: "2026-07-24T15:12:00.000Z",
      },
      {
        effectId: "effect-deploy-v2",
        kind: "deploy_proven_candidate",
        state: "pending",
        attempt: 0,
        updatedAt: "2026-07-24T16:17:01.000Z",
      },
    ],
    updatedAt: "2026-07-24T16:19:00.000Z",
  });
