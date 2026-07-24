export type RunStatus =
  "queued" | "running" | "passed" | "rejected" | "failed" | "cancelled";

export type RunStage =
  | "queued"
  | "provisioning"
  | "generating"
  | "verifying"
  | "reviewing"
  | "evaluating"
  | "finalizing"
  | "complete";

export interface BuildRun {
  id: string;
  projectId: string;
  candidateId: string;
  status: RunStatus;
  stage: RunStage;
  slotId?: number;
  sandboxId?: string;
  revisionHash?: string;
  previewPort?: number;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: string;
  stage: RunStage;
  payload: unknown;
  createdAt: string;
}

export interface EvidenceReceipt {
  receiptId: string;
  status: "PASS" | "FAIL" | "ERROR";
  kind: string;
  provider: string;
  completedAt: string;
  durationMs?: number;
  findings?: Array<{
    severity: string;
    fileName: string;
    message: string;
  }>;
  requirements?: Array<{
    requirementId: string;
    status: "PASS" | "FAIL" | "UNVERIFIED";
    explanation: string;
  }>;
  summary?: string;
}

export interface StudioRun {
  run: BuildRun;
  assignment: {
    strategyLabel: string;
    requestedAt: string;
    limits: {
      maxAgentSteps: number;
      maxRepairRounds: number;
      wallClockSeconds: number;
      maxToolOutputBytes: number;
    };
    contract: {
      contractId: string;
      contractRevision: number;
      approvedAt: string;
      approvedFacts: Array<{ id: string; statement: string }>;
      forbiddenClaims: string[];
      requirements: Array<{
        id: string;
        description: string;
        priority: "hard" | "preference";
        verifierKinds: string[];
      }>;
    };
  } | null;
  activity: {
    eventCount: number;
    latestEvent: RunEvent | null;
  };
  proof: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    hardRequirements: number;
  };
  artifactAvailable: boolean;
  previewAvailable: boolean;
}

export interface StudioRunsResponse {
  runs: StudioRun[];
  generatedAt: string;
}

export interface RunDetailsResponse {
  run: BuildRun;
  artifact: {
    artifactId: string;
    uri: string;
    sha256: string;
    revisionHash: string;
  } | null;
}

export interface EventsResponse {
  events: RunEvent[];
  nextAfter: number;
  hasMore: boolean;
}

export interface EvidenceResponse {
  evidence: EvidenceReceipt[];
}

export interface PreviewResponse {
  kind: "ephemeral_daytona_preview";
  url: string;
  expiresAt: string;
}

export interface StudioConnection {
  baseUrl: string;
  token: string;
}

export interface StudioSelection {
  run: StudioRun;
  events: RunEvent[];
  evidence: EvidenceReceipt[];
  preview: PreviewResponse | null;
}
