import { describe, expect, it } from "vitest";

import {
  buildRecordedProofSummary,
  createRecordedProofSnapshot,
  parseRecordedProofSnapshot,
  ProofSummaryEvidenceNotFoundError,
  ProofSummaryPublicationRejectedError,
  type RecordedProofEvidenceSource,
} from "../src/orchestration/application/project-evidence.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const proposalDigest = "1".repeat(64);
const contractDigest = "2".repeat(64);
const buildContractHash = "3".repeat(64);
const revisionHash = "4".repeat(64);
const artifactDigest = "5".repeat(64);
const imageDigest = `sha256:${"6".repeat(64)}`;

describe("recorded project proof evidence", () => {
  it("reports only checks and identities bound to the exact proven deployment", () => {
    const summary = buildRecordedProofSummary(evidenceSource(), {
      projectId,
      deploymentReceiptId: "deployment:receipt-one",
      revisionHash,
    });

    expect(summary).toMatchObject({
      schemaVersion: "buildlapse-proof-summary-v1",
      project: {
        projectId,
        title: "Customer booking application",
      },
      contract: {
        version: 2,
        digest: contractDigest,
        verificationPolicy: "buildlapse-proof-gate-v1",
        configuredChecks: {
          buildCommand: "npm run build",
          testCommands: ["npm test"],
          previewCommand: "npm run preview",
        },
        hardRequirements: [
          {
            requirementId: "booking-flow",
            description: "The booking flow must submit.",
            verifiers: [
              {
                kind: "http",
                path: "/booking",
                expectedStatus: 200,
                bodyIncludes: ["Book"],
              },
            ],
          },
        ],
      },
      proofReceipt: {
        eventType: "candidate.proven",
        eventId: "88888888-8888-4888-8888-888888888888",
        traceId: "braintrust-trace-one",
        contractHash: buildContractHash,
        revisionHash,
        artifactDigest,
        rankingPolicy: "braintrust-preference-v1",
        preferenceSatisfaction: 0.91,
      },
      deployment: {
        receiptId: "deployment:receipt-one",
        provider: "fly",
        productionUrl: "https://customer-booking.fly.dev/",
        releaseId: "release-one",
        imageDigest,
        httpsHealthy: true,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("customer@example.com");
    expect(summary.evidenceBoundary).toContain("recorded");
    expect(summary.evidenceBoundary).not.toContain("correct");
  });

  it("fails closed when the capability revision is not the deployed revision", () => {
    expect(() =>
      buildRecordedProofSummary(evidenceSource(), {
        projectId,
        deploymentReceiptId: "deployment:receipt-one",
        revisionHash: "f".repeat(64),
      }),
    ).toThrow(ProofSummaryEvidenceNotFoundError);
  });

  it("creates one canonical bounded snapshot and verifies its digest on read", () => {
    const first = createRecordedProofSnapshot(
      evidenceSource(),
      {
        projectId,
        deploymentReceiptId: "deployment:receipt-one",
        revisionHash,
      },
      ["Jordan Lee", "jordan@example.com", "+1 510 555 0100"],
    );
    const replay = createRecordedProofSnapshot(
      evidenceSource(),
      {
        projectId,
        deploymentReceiptId: "deployment:receipt-one",
        revisionHash,
      },
      ["Jordan Lee", "jordan@example.com", "+1 510 555 0100"],
    );

    expect(first).toEqual(replay);
    expect(first.snapshotId).toMatch(/^proof-summary:[a-f0-9]{32}$/u);
    expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(Buffer.byteLength(first.canonicalSnapshot)).toBeLessThanOrEqual(
      64 * 1_024,
    );
    expect(
      parseRecordedProofSnapshot({
        ...first,
        createdAt: "2026-07-23T12:15:00.000Z",
      }),
    ).toEqual(
      buildRecordedProofSummary(evidenceSource(), {
        projectId,
        deploymentReceiptId: "deployment:receipt-one",
        revisionHash,
      }),
    );
    expect(() =>
      parseRecordedProofSnapshot({
        ...first,
        snapshotDigest: "f".repeat(64),
        createdAt: "2026-07-23T12:15:00.000Z",
      }),
    ).toThrow(ProofSummaryEvidenceNotFoundError);
  });

  it("rejects customer PII and credential-like text at the publication boundary", () => {
    const pii = evidenceSource();
    pii.proposals[0]!.projectTitle =
      "Jordan Lee — contact jordan@example.com or +1 (510) 555-0100";
    expect(() =>
      createRecordedProofSnapshot(
        pii,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        ["Jordan Lee", "jordan@example.com", "+1 (510) 555-0100"],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);

    const secret = evidenceSource();
    secret.proposals[0]!.contract.requirements[0]!.verifiers = [
      {
        kind: "semantic",
        criterion: "Use Authorization: Bearer sk_live_do-not-publish",
      },
    ];
    expect(() =>
      createRecordedProofSnapshot(
        secret,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
  });

  it("scans every rendered string and rejects provider credentials", () => {
    const credentials = [
      "fw_1234567890abcdef",
      "dtn_1234567890abcdef",
      "sk-1234567890abcdef",
      "re_1234567890abcdef",
      "cr-1234567890abcdef",
      "ck_1234567890abcdef",
      "AKIA1234567890ABCDEF",
      "ASIA1234567890ABCDEF",
      "FlyV1 fm2_lJPECAAAAAAACfHgMx5tH",
    ];

    for (const credential of credentials) {
      const unsafe = evidenceSource();
      unsafe.provenCandidates[0]!.event.traceId = credential;
      unsafe.provenCandidates[0]!.event.payload.traceId = credential;
      expect(
        () =>
          createRecordedProofSnapshot(
            unsafe,
            {
              projectId,
              deploymentReceiptId: "deployment:receipt-one",
              revisionHash,
            },
            [],
          ),
        credential,
      ).toThrow(ProofSummaryPublicationRejectedError);
    }
  });

  it("rejects short protected names without matching them inside other words", () => {
    const unsafe = evidenceSource();
    unsafe.proposals[0]!.projectTitle = "Booking portal for Li";
    expect(() =>
      createRecordedProofSnapshot(
        unsafe,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        ["Li"],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);

    const safe = evidenceSource();
    safe.proposals[0]!.projectTitle = "Simplified booking portal";
    expect(() =>
      createRecordedProofSnapshot(
        safe,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        ["Li"],
      ),
    ).not.toThrow();

    const partialName = evidenceSource();
    partialName.proposals[0]!.projectTitle = "Booking portal for Jordan";
    expect(() =>
      createRecordedProofSnapshot(
        partialName,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        ["Jordan Lee", "Jordan", "Lee"],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
  });

  it("uses conservative case-aware matching for short person names", () => {
    const ordinaryLanguage = evidenceSource();
    ordinaryLanguage.proposals[0]!.projectTitle =
      "The form will validate, may retry, and mark completed rows.";
    expect(() =>
      createRecordedProofSnapshot(
        ordinaryLanguage,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [
          { value: "Will", kind: "person_name_full" },
          { value: "May", kind: "person_name_full" },
          { value: "Mark", kind: "person_name_full" },
        ],
      ),
    ).not.toThrow();

    const capitalizedLeak = evidenceSource();
    capitalizedLeak.proposals[0]!.projectTitle = "Booking portal for Will";
    expect(() =>
      createRecordedProofSnapshot(
        capitalizedLeak,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [{ value: "Will", kind: "person_name_full" }],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);

    const unambiguousLeak = evidenceSource();
    unambiguousLeak.proposals[0]!.projectTitle = "Booking portal for jordan";
    expect(() =>
      createRecordedProofSnapshot(
        unambiguousLeak,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [{ value: "Jordan", kind: "person_name_full" }],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
  });

  it("bounds protected inputs before publication matching", () => {
    const binding = {
      projectId,
      deploymentReceiptId: "deployment:receipt-one",
      revisionHash,
    };
    expect(() =>
      createRecordedProofSnapshot(
        evidenceSource(),
        binding,
        Array.from({ length: 257 }, (_, index) => `protected-${index}`),
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
    expect(() =>
      createRecordedProofSnapshot(evidenceSource(), binding, ["x".repeat(513)]),
    ).toThrow(ProofSummaryPublicationRejectedError);
    expect(() =>
      createRecordedProofSnapshot(
        evidenceSource(),
        binding,
        Array.from(
          { length: 100 },
          (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(397)}`,
        ),
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
  });

  it("rejects credential-bearing production URLs", () => {
    const unsafe = evidenceSource();
    unsafe.deployments[0]!.url =
      "https://customer-booking.fly.dev/?token=do-not-publish";
    expect(() =>
      createRecordedProofSnapshot(
        unsafe,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).toThrow(ProofSummaryEvidenceNotFoundError);
  });

  it("rejects broad PII while allowing schema-validated opaque identifiers", () => {
    const piiValues = [
      "Ship notices to 123 Main St, Oakland, CA 94607",
      "Record SSN 123-45-6789 in the page",
      "Use account number 123456789012",
      "Use card 4242 4242 4242 4242",
      "Call customer at 5105550100",
      `Never publish secret ${"a".repeat(64)}`,
      "Never publish identifier 12345678-1234-4234-8234-123456789012",
      "Never publish opaque token Ab3dEf5hIj7lMn9pQr2tUv4xYz6_Bc8D",
      "Never publish opaque token ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr",
    ];
    for (const piiValue of piiValues) {
      const unsafe = evidenceSource();
      unsafe.proposals[0]!.contract.requirements[0]!.description = piiValue;
      expect(
        () =>
          createRecordedProofSnapshot(
            unsafe,
            {
              projectId,
              deploymentReceiptId: "deployment:receipt-one",
              revisionHash,
            },
            [],
          ),
        piiValue,
      ).toThrow(ProofSummaryPublicationRejectedError);
    }

    const tracePhone = evidenceSource();
    tracePhone.provenCandidates[0]!.event.traceId = "trace-5105550100";
    tracePhone.provenCandidates[0]!.event.payload.traceId = "trace-5105550100";
    expect(() =>
      createRecordedProofSnapshot(
        tracePhone,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);

    expect(() =>
      createRecordedProofSnapshot(
        evidenceSource(),
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).not.toThrow();

    const genericAccountRequirement = evidenceSource();
    genericAccountRequirement.proposals[0]!.contract.requirements[0]!.description =
      "The account number field accepts 8 digits and validates input.";
    expect(() =>
      createRecordedProofSnapshot(
        genericAccountRequirement,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).not.toThrow();
  });

  it("rejects a proof page whose item count exceeds the publication budget", () => {
    const oversized = evidenceSource();
    oversized.proposals[0]!.contract.requirements = Array.from(
      { length: 51 },
      (_, index) => ({
        requirementId: `requirement-${index}`,
        description: `Bounded requirement ${index}`,
        priority: "hard" as const,
        verifiers: [
          {
            kind: "semantic" as const,
            criterion: `Verify bounded requirement ${index}`,
          },
        ],
      }),
    );
    expect(() =>
      createRecordedProofSnapshot(
        oversized,
        {
          projectId,
          deploymentReceiptId: "deployment:receipt-one",
          revisionHash,
        },
        [],
      ),
    ).toThrow(ProofSummaryPublicationRejectedError);
  });
});

function evidenceSource(): RecordedProofEvidenceSource {
  return {
    projectId,
    proposals: [
      {
        version: 2,
        digest: proposalDigest,
        projectTitle: "Customer booking application",
        contract: {
          version: 2,
          digest: contractDigest,
          requirements: [
            {
              requirementId: "booking-flow",
              description: "The booking flow must submit.",
              priority: "hard",
              verifiers: [
                {
                  kind: "http",
                  path: "/booking",
                  expectedStatus: 200,
                  bodyIncludes: ["Book"],
                },
              ],
            },
            {
              requirementId: "visual-direction",
              description: "Prefer the requested visual direction.",
              priority: "preference",
              verifiers: [],
            },
          ],
          verification: {
            policyId: "buildlapse-proof-gate-v1",
            buildCommand: "npm run build",
            testCommands: ["npm test"],
            previewCommand: "npm run preview",
          },
        },
      },
    ],
    buildBatches: [
      {
        batchId: "batch-one",
        proposalVersion: 2,
        proposalDigest,
        contractVersion: 2,
        contractDigest,
        buildContractHash,
      },
    ],
    provenCandidates: [
      {
        batchId: "batch-one",
        proposalVersion: 2,
        proposalDigest,
        event: {
          eventId: "88888888-8888-4888-8888-888888888888",
          type: "candidate.proven",
          runId: "77777777-7777-4777-8777-777777777777",
          revisionHash,
          traceId: "braintrust-trace-one",
          createdAt: "2026-07-23T12:10:00.000Z",
          payload: {
            runId: "77777777-7777-4777-8777-777777777777",
            projectId,
            candidateId: "candidate-one",
            contractHash: buildContractHash,
            revisionHash,
            artifact: {
              sha256: artifactDigest,
            },
            traceId: "braintrust-trace-one",
            ranking: {
              policyVersion: "braintrust-preference-v1",
              preferenceSatisfaction: 0.91,
            },
          },
        },
      },
    ],
    deployments: [
      {
        receiptId: "deployment:receipt-one",
        provider: "fly",
        projectId,
        batchId: "batch-one",
        runId: "77777777-7777-4777-8777-777777777777",
        candidateId: "candidate-one",
        proposalVersion: 2,
        proposalDigest,
        revisionHash,
        artifactDigest,
        releaseId: "release-one",
        releaseVersion: 7,
        imageDigest,
        workspaceDigest: "7".repeat(64),
        url: "https://customer-booking.fly.dev/",
        httpsHealthy: true,
        deployedAt: "2026-07-23T12:12:00.000Z",
        releaseVerifiedAt: "2026-07-23T12:13:00.000Z",
        verifiedAt: "2026-07-23T12:14:00.000Z",
      },
    ],
  };
}
