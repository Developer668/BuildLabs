import { describe, expect, it } from "vitest";

import { buildCustomerDashboardProjectView } from "../src/orchestration/application/customer-dashboard-projection.js";
import type { ProjectAggregate } from "../src/orchestration/domain/project.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const PROPOSAL_V1_DIGEST = "a".repeat(64);
const PROPOSAL_V2_DIGEST = "b".repeat(64);
const REVISION_HASH = "c".repeat(64);
const ARTIFACT_DIGEST = "d".repeat(64);
const IMAGE_DIGEST = `sha256:${"e".repeat(64)}`;

describe("customer dashboard projection", () => {
  it("keeps the last proven release visible while a paid in-scope revision builds", () => {
    const project = {
      projectId: PROJECT_ID,
      status: "building",
      revision: 12,
      activeProposalVersion: 2,
      proposals: [
        {
          version: 1,
          projectTitle: "Customer booking application",
          plan: {
            summary: { text: "Initial proven booking application." },
            deliverables: [{ itemId: "site", text: "Booking application" }],
            requirements: [
              {
                itemId: "booking",
                text: "Booking flow works.",
                priority: "hard",
              },
            ],
            unknowns: [],
          },
        },
        {
          version: 2,
          commercialBasisVersion: 1,
          projectTitle: "Customer booking application",
          plan: {
            summary: { text: "Refine the proven booking application." },
            deliverables: [{ itemId: "site", text: "Booking application" }],
            requirements: [
              {
                itemId: "booking",
                text: "Booking flow works.",
                priority: "hard",
              },
            ],
            unknowns: [],
          },
        },
      ],
      payments: [
        {
          proposalVersion: 1,
          verifiedAt: "2026-07-24T10:00:00.000Z",
        },
      ],
      activeBuildBatchId: "batch-v2",
      buildBatches: [
        {
          batchId: "batch-v1",
          projectId: PROJECT_ID,
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          contractVersion: 1,
          status: "completed",
          requestedCandidateCount: 1,
          runs: [],
          createdAt: "2026-07-24T10:01:00.000Z",
          completedAt: "2026-07-24T10:20:00.000Z",
        },
        {
          batchId: "batch-v2",
          projectId: PROJECT_ID,
          proposalVersion: 2,
          proposalDigest: PROPOSAL_V2_DIGEST,
          contractVersion: 2,
          status: "building",
          requestedCandidateCount: 1,
          runs: [
            {
              runId: "22222222-2222-4222-8222-222222222222",
              candidateId: "candidate-v2",
              assignmentId: "assignment-v2",
              status: "running",
            },
          ],
          createdAt: "2026-07-24T11:00:00.000Z",
        },
      ],
      previews: [
        {
          receiptId: "preview-receipt-v1",
          provider: "daytona",
          projectId: PROJECT_ID,
          batchId: "batch-v1",
          runId: "preview-run-v1",
          candidateId: "preview-candidate-v1",
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          revisionHash: REVISION_HASH,
          artifactDigest: ARTIFACT_DIGEST,
          snapshotId: "preview-snapshot-v1",
          url: "https://preview.buildlabs.example/v1",
          immutable: true,
          httpsHealthy: true,
          expiresAt: "2026-07-25T12:00:00.000Z",
          createdAt: "2026-07-24T10:19:00.000Z",
          verifiedAt: "2026-07-24T10:20:00.000Z",
        },
      ],
      deployments: [
        {
          receiptId: "deployment-receipt-v1",
          provider: "fly",
          projectId: PROJECT_ID,
          batchId: "batch-v1",
          runId: "preview-run-v1",
          candidateId: "preview-candidate-v1",
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          revisionHash: REVISION_HASH,
          artifactDigest: ARTIFACT_DIGEST,
          releaseId: "release-v1",
          releaseVersion: 7,
          imageDigest: IMAGE_DIGEST,
          url: "https://customer-booking.fly.dev/",
          httpsHealthy: true,
          verifiedAt: "2026-07-24T10:30:00.000Z",
        },
      ],
      createdAt: "2026-07-24T09:00:00.000Z",
      updatedAt: "2026-07-24T11:05:00.000Z",
    } as unknown as ProjectAggregate;

    const view = buildCustomerDashboardProjectView(
      project,
      [],
      new Date("2026-07-24T12:00:00.000Z"),
    );

    expect(view.payment).toEqual({
      state: "verified",
      verifiedAt: "2026-07-24T10:00:00.000Z",
    });
    expect(view.activeBuild).toMatchObject({
      batchId: "batch-v2",
      proposalVersion: 2,
      runs: [
        {
          workspace: {
            state: "starting",
            customerRenderable: false,
          },
        },
      ],
    });
    expect(view.deliverables).toEqual({
      frozenProvenPreview: {
        contractVersion: 1,
        proposalVersion: 1,
        revisionHash: REVISION_HASH,
        artifactDigest: ARTIFACT_DIGEST,
        url: "https://preview.buildlabs.example/v1",
        expiresAt: "2026-07-25T12:00:00.000Z",
        verifiedAt: "2026-07-24T10:20:00.000Z",
      },
      production: {
        contractVersion: 1,
        proposalVersion: 1,
        revisionHash: REVISION_HASH,
        artifactDigest: ARTIFACT_DIGEST,
        releaseVersion: 7,
        imageDigest: IMAGE_DIGEST,
        url: "https://customer-booking.fly.dev/",
        verifiedAt: "2026-07-24T10:30:00.000Z",
      },
    });
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty(
      "receiptId",
    );
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty(
      "provider",
    );
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty("batchId");
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty("runId");
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty(
      "candidateId",
    );
    expect(view.deliverables.frozenProvenPreview).not.toHaveProperty(
      "snapshotId",
    );
    expect(view.deliverables.production).not.toHaveProperty("receiptId");
    expect(view.deliverables.production).not.toHaveProperty("provider");
    expect(view.deliverables.production).not.toHaveProperty("batchId");
    expect(view.deliverables.production).not.toHaveProperty("runId");
    expect(view.deliverables.production).not.toHaveProperty("candidateId");
    expect(view.deliverables.production).not.toHaveProperty("releaseId");
  });

  it("suppresses receipts whose project or proposal binding does not match the batch", () => {
    const baseProject = {
      projectId: PROJECT_ID,
      status: "completed",
      revision: 3,
      proposals: [],
      payments: [],
      buildBatches: [
        {
          batchId: "batch-v1",
          projectId: PROJECT_ID,
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          contractVersion: 1,
          status: "completed",
          requestedCandidateCount: 1,
          runs: [],
          createdAt: "2026-07-24T10:00:00.000Z",
          completedAt: "2026-07-24T10:20:00.000Z",
        },
      ],
      previews: [
        {
          projectId: PROJECT_ID,
          batchId: "batch-v1",
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          revisionHash: REVISION_HASH,
          artifactDigest: ARTIFACT_DIGEST,
          immutable: true,
          httpsHealthy: true,
          url: "https://preview.buildlabs.example/v1",
          expiresAt: "2026-07-25T12:00:00.000Z",
          verifiedAt: "2026-07-24T10:20:00.000Z",
        },
      ],
      deployments: [
        {
          projectId: PROJECT_ID,
          batchId: "batch-v1",
          proposalVersion: 1,
          proposalDigest: PROPOSAL_V1_DIGEST,
          revisionHash: REVISION_HASH,
          artifactDigest: ARTIFACT_DIGEST,
          releaseVersion: 7,
          imageDigest: IMAGE_DIGEST,
          httpsHealthy: true,
          url: "https://customer-booking.fly.dev/",
          verifiedAt: "2026-07-24T10:30:00.000Z",
        },
      ],
      createdAt: "2026-07-24T09:00:00.000Z",
      updatedAt: "2026-07-24T10:30:00.000Z",
    };
    const mismatches: Array<{
      mutate(project: typeof baseProject): void;
    }> = [
      {
        mutate(project) {
          project.previews[0]!.projectId = OTHER_PROJECT_ID;
          project.deployments[0]!.projectId = OTHER_PROJECT_ID;
        },
      },
      {
        mutate(project) {
          project.buildBatches[0]!.projectId = OTHER_PROJECT_ID;
        },
      },
      {
        mutate(project) {
          project.previews[0]!.proposalVersion = 2;
          project.deployments[0]!.proposalVersion = 2;
        },
      },
      {
        mutate(project) {
          project.previews[0]!.proposalDigest = PROPOSAL_V2_DIGEST;
          project.deployments[0]!.proposalDigest = PROPOSAL_V2_DIGEST;
        },
      },
    ];

    for (const mismatch of mismatches) {
      const project = structuredClone(baseProject);
      mismatch.mutate(project);
      const view = buildCustomerDashboardProjectView(
        project as unknown as ProjectAggregate,
        [],
        new Date("2026-07-24T12:00:00.000Z"),
      );

      expect(view.deliverables).toEqual({
        frozenProvenPreview: null,
        production: null,
      });
    }
  });
});
