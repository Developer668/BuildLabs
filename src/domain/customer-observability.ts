import { z } from "zod";

import { AgentProgressSchema, RunStageSchema, RunStatusSchema } from "./run.js";

export const CUSTOMER_BUILD_TIMELINE_LIMIT = 250;

export const CustomerBuildTimelineEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    category: z.enum(["workspace", "stage", "tool", "evidence", "lifecycle"]),
    stage: RunStageSchema,
    occurredAt: z.iso.datetime(),
    tool: AgentProgressSchema.shape.toolName.optional(),
    succeeded: z.boolean().optional(),
    evidenceKind: z.string().min(1).max(128).optional(),
    evidenceStatus: z.enum(["PASS", "FAIL", "ERROR"]).optional(),
  })
  .strict();

export const CustomerBuildObservationSchema = z
  .object({
    version: z.literal(1),
    runId: z.uuid(),
    projectId: z.string().min(1).max(128),
    candidateId: z.string().min(1).max(128),
    status: RunStatusSchema,
    stage: RunStageSchema,
    slot: z
      .object({
        state: z.enum(["waiting", "active", "released"]),
        number: z.number().int().positive().nullable(),
      })
      .strict(),
    workspace: z
      .object({
        state: z.enum(["unavailable", "starting", "live_unverified"]),
        customerRenderable: z.literal(false),
      })
      .strict(),
    progress: z
      .object({
        completedToolCalls: z.number().int().nonnegative(),
        failedToolCalls: z.number().int().nonnegative(),
        lastTool: AgentProgressSchema.shape.toolName.nullable(),
        repairRound: z.number().int().nonnegative(),
      })
      .strict(),
    proof: z
      .object({
        receiptCount: z.number().int().nonnegative(),
        passCount: z.number().int().nonnegative(),
        failCount: z.number().int().nonnegative(),
        errorCount: z.number().int().nonnegative(),
        byKind: z.record(z.string(), z.number().int().nonnegative()),
        provenArtifactAvailable: z.boolean(),
      })
      .strict(),
    timeline: z
      .object({
        items: z
          .array(CustomerBuildTimelineEventSchema)
          .max(CUSTOMER_BUILD_TIMELINE_LIMIT),
        nextAfterSequence: z.number().int().nonnegative(),
        hasMore: z.boolean(),
      })
      .strict(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export type CustomerBuildTimelineEvent = z.infer<
  typeof CustomerBuildTimelineEventSchema
>;
export type CustomerBuildObservation = z.infer<
  typeof CustomerBuildObservationSchema
>;

export interface CustomerBuildObservationQuery {
  afterSequence?: number;
  limit?: number;
}
