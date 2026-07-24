import { z } from "zod";

import type { Sha256Schema } from "./contract.js";

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "rejected",
  "failed",
  "cancelled",
]);

export const RunStageSchema = z.enum([
  "queued",
  "provisioning",
  "generating",
  "verifying",
  "reviewing",
  "evaluating",
  "finalizing",
  "complete",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunStage = z.infer<typeof RunStageSchema>;

export interface BuildRun {
  id: string;
  assignmentId: string;
  assignmentHash: string;
  projectId: string;
  candidateId: string;
  contractHash: string;
  status: RunStatus;
  stage: RunStage;
  slotId?: number;
  fencingToken?: number;
  sandboxId?: string;
  builderSandboxId?: string;
  verificationSandboxId?: string;
  verificationSandboxPurpose?: "commands" | "delivery";
  revisionHash?: string;
  previewPort?: number;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SlotLease {
  slotId: number;
  runId: string;
  fencingToken: number;
  leaseExpiresAt: string;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: string;
  stage: RunStage;
  payload: unknown;
  createdAt: string;
}

export const AgentToolNameSchema = z.enum([
  "finish",
  "list_files",
  "read_file",
  "run_command",
  "start_preview",
  "unknown",
  "write_file",
  "write_files",
]);

export const AgentProgressSchema = z
  .object({
    step: z.number().int().min(1).max(200),
    repairRound: z.number().int().min(0).max(10),
    toolName: AgentToolNameSchema,
    ok: z.boolean(),
  })
  .strict();

export type AgentProgress = z.infer<typeof AgentProgressSchema>;

export interface RecoveredRun {
  runId: string;
  sandboxIds: string[];
  newlyRecovered: boolean;
}

export interface FrozenRevision {
  sourceDigest: z.infer<typeof Sha256Schema>;
  commitSha: string;
  frozenAt: string;
}

const TERMINAL_STATUSES = new Set<RunStatus>([
  "passed",
  "rejected",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
