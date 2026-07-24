import { describe, expect, it } from "vitest";

import { buildCustomerDashboardProjectView } from "../src/orchestration/application/customer-dashboard-projection.js";
import type { ProjectAggregate } from "../src/orchestration/domain/project.js";

describe("customer dashboard projection", () => {
  it("keeps the last proven release visible while a paid in-scope revision builds", () => {
    const project = {
      projectId: "11111111-1111-4111-8111-111111111111",
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
          proposalVersion: 1,
          status: "completed",
          requestedCandidateCount: 1,
          runs: [],
          createdAt: "2026-07-24T10:01:00.000Z",
          completedAt: "2026-07-24T10:20:00.000Z",
        },
        {
          batchId: "batch-v2",
          proposalVersion: 2,
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
          batchId: "batch-v1",
          proposalVersion: 1,
          url: "https://preview.buildlabs.example/v1",
          immutable: true,
          httpsHealthy: true,
          expiresAt: "2026-07-25T12:00:00.000Z",
          verifiedAt: "2026-07-24T10:20:00.000Z",
        },
      ],
      deployments: [
        {
          batchId: "batch-v1",
          proposalVersion: 1,
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
        url: "https://preview.buildlabs.example/v1",
        expiresAt: "2026-07-25T12:00:00.000Z",
        verifiedAt: "2026-07-24T10:20:00.000Z",
      },
      production: {
        url: "https://customer-booking.fly.dev/",
        verifiedAt: "2026-07-24T10:30:00.000Z",
      },
    });
  });
});
