import type {
  AcceptanceContract,
  BuildAssignment,
  Verifier,
} from "../domain/contract.js";
import type { OutboxEvent, ProvenArtifact } from "../domain/artifact.js";
import type {
  EvaluationReceipt,
  EvidenceReceipt,
  ReviewFinding,
} from "../domain/evidence.js";
import type {
  AgentProgress,
  BuildRun,
  FrozenRevision,
  RecoveredRun,
  RunEvent,
  RunStage,
  SlotLease,
} from "../domain/run.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface SandboxFile {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
}

export interface ExportedWorkspace {
  directory: string;
  archivePath: string;
  archiveSha256: string;
  contentDigest: string;
  cleanup(): Promise<void>;
}

export interface PreviewTarget {
  url: string;
  expiresAt: string;
}

export interface RenderedPageInspection {
  path: string;
  discovered?: true;
  status: number | null;
  visibleText?: string;
  screenshotSha256s?: string[];
  screenshotBase64s?: string[];
  nonHtmlMediaType?: string;
  error?: string;
}

export interface FrozenPreviewMaterializationRequest {
  snapshotId: string;
  runId: string;
  eventId: string;
  artifactId: string;
  artifactSha256: string;
  revisionHash: string;
  port: number;
  expiresInSeconds: number;
  idempotencyKey: string;
}

export interface SandboxSession {
  readonly id: string;
  readonly workDir: string;
  runCommand(
    command: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  listFiles(path: string, depth: number): Promise<SandboxFile[]>;
  startPreview(
    command: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Blocks outbound traffic for delivery proof and preserves that policy across
   * any snapshot restart performed by this session.
   */
  sealNetworkForProof(signal?: AbortSignal): Promise<void>;
  startContainerPreview(
    imageTag: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<void>;
  inspectRenderedPages(
    paths: string[],
    port: number,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<RenderedPageInspection[]>;
  freeze(): Promise<FrozenRevision>;
  currentRevisionDigest(): Promise<string>;
  createSnapshot(name: string, signal?: AbortSignal): Promise<string>;
  exportWorkspace(revision: FrozenRevision): Promise<ExportedWorkspace>;
  getPreview(port: number, expiresInSeconds: number): Promise<PreviewTarget>;
  stop(signal?: AbortSignal): Promise<void>;
  dispose(signal?: AbortSignal): Promise<void>;
}

export type VerificationSandboxPurpose = "commands" | "delivery";

export interface SandboxProvider {
  create(
    runId: string,
    assignment: BuildAssignment,
    signal?: AbortSignal,
  ): Promise<SandboxSession>;
  createVerifier(
    runId: string,
    assignment: BuildAssignment,
    revision: FrozenRevision,
    source: ExportedWorkspace,
    purpose: VerificationSandboxPurpose,
    signal?: AbortSignal,
  ): Promise<SandboxSession>;
  getPreview(
    sandboxId: string,
    port: number,
    expiresInSeconds: number,
    signal?: AbortSignal,
  ): Promise<PreviewTarget>;
  deleteSandbox(sandboxId: string, signal?: AbortSignal): Promise<void>;
  /**
   * Creates an isolated, bounded-lifetime runtime from the exact proven
   * snapshot. Implementations must never serve or fork the mutable build
   * sandbox identified by the run.
   */
  materializeFrozenPreview(
    request: FrozenPreviewMaterializationRequest,
    signal?: AbortSignal,
  ): Promise<PreviewTarget>;
  health(signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface ArtifactStore {
  persist(
    runId: string,
    revision: FrozenRevision,
    workspace: ExportedWorkspace,
    daytonaSnapshot: string,
  ): Promise<ProvenArtifact>;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls: AgentToolCall[];
      reasoningContent?: string;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelRequestContext {
  trajectoryId: string;
  promptCacheIsolationKey: string;
  modelRole?: "builder" | "studio";
}

export interface ModelTurn {
  content: string | null;
  toolCalls: AgentToolCall[];
  reasoningContent?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
  };
  performance?: {
    serverTimeToFirstTokenMs?: number;
    serverProcessingTimeMs?: number;
  };
}

export interface ModelPort {
  complete(
    messages: AgentMessage[],
    tools: AgentToolDefinition[],
    context: ModelRequestContext,
    signal?: AbortSignal,
  ): Promise<ModelTurn>;
  evaluateContract(
    input: ContractEvaluationInput,
    signal?: AbortSignal,
  ): Promise<ContractEvaluationOutput>;
  inspectRasterClaims?(
    input: RasterClaimInspectionInput,
    signal?: AbortSignal,
  ): Promise<RasterClaimInspectionOutput>;
  health(signal?: AbortSignal): Promise<void>;
}

export interface CodeReviewRequest {
  runId: string;
  revision: FrozenRevision;
  workspaceDirectory: string;
  contract: AcceptanceContract;
  verificationContext: {
    commands: Array<{
      kind: string;
      status: "PASS" | "FAIL" | "ERROR";
      command: string;
      exitCode: number | null;
      outputDigest: string;
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      diagnostic?: string;
    }>;
    previewChecks: Array<{
      path: string;
      expectedStatus: number;
      actualStatus: number | null;
      missingText: string[];
      error?: string;
    }>;
  };
}

export interface CodeReviewResult {
  complete: boolean;
  findings: ReviewFinding[];
  rawDigest: string;
  policyDigest: string;
}

export interface CodeReviewPort {
  review(
    request: CodeReviewRequest,
    signal?: AbortSignal,
  ): Promise<CodeReviewResult>;
  health(signal?: AbortSignal): Promise<void>;
}

export interface InspectedPage {
  path: string;
  status: number;
  visibleText: string;
  screenshotBase64s?: string[];
}

export interface InspectedSourceFile {
  path: string;
  contents: string;
}

export interface ContractEvaluationInput {
  contract: AcceptanceContract;
  revision: FrozenRevision;
  pages: InspectedPage[];
  sourceFiles: InspectedSourceFile[];
  commandEvidence: EvidenceReceipt[];
  availableEvidenceRefs: string[];
  requiredEvidenceRefsByRequirement: Record<string, string[][]>;
}

export interface ContractEvaluationOutput {
  requirements: EvaluationReceipt["requirements"];
  unsupportedClaims: EvaluationReceipt["unsupportedClaims"];
  summary: string;
}

export type RasterAssetMimeType =
  | "image/bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/tiff"
  | "image/x-portable-pixmap";

export interface RasterClaimAsset {
  index: number;
  sha256: string;
  imageSha256: string;
  mimeType: RasterAssetMimeType;
  base64: string;
}

export interface RasterClaimInspectionInput {
  forbiddenClaims: string[];
  approvedFacts: string[];
  assets: RasterClaimAsset[];
}

export interface RasterClaimInspectionOutput {
  modelDigest: string;
  results: Array<{
    assetIndex: number;
    status: "CLEAR" | "MATCH" | "UNSUPPORTED" | "UNVERIFIED";
    matchedForbiddenClaimIndices: number[];
  }>;
}

export class RasterClaimInspectionError extends Error {
  override readonly name = "RasterClaimInspectionError";

  constructor(
    readonly code: "MODEL_RESPONSE_INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface TraceSpan {
  readonly traceId: string;
  log(event: {
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    scores?: Record<string, number>;
    error?: string;
  }): void;
  child<T>(
    name: string,
    type: "function" | "llm" | "review" | "score" | "task" | "tool",
    input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T>;
}

export interface StudioTraceInput {
  conversationCorrelationId: string;
  transcriptMessageCount: number;
  userMessageCount: number;
  transcriptBytes: number;
  explicitCancellationRequested: boolean;
}

export interface StudioToolTraceInput {
  conversationCorrelationId: string;
  runId: string;
  tool: "cancel_candidate" | "get_candidate" | "get_candidate_evidence";
}

export interface TracePort {
  run<T>(run: BuildRun, operation: (span: TraceSpan) => Promise<T>): Promise<T>;
  studio?<T>(
    input: StudioTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T>;
  studioTool?<T>(
    input: StudioToolTraceInput,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T>;
  flush(): Promise<void>;
  health(signal?: AbortSignal): Promise<void>;
}

export interface CreateRunResult {
  run: BuildRun;
  created: boolean;
}

export type CancellationSource =
  "elevenlabs_webhook" | "internal" | "operator_api" | "studio_speech_engine";

export type CancellationReasonCode =
  | "explicit_operator_cancellation"
  | "operator_api_cancellation"
  | "scheduler_cancellation";

export interface CancellationRequest {
  source: CancellationSource;
  reasonCode: CancellationReasonCode;
  conversationCorrelationId?: string;
  expected?: {
    status: "queued" | "running";
    updatedAt: string;
  };
}

export interface CancellationResult {
  changed: boolean;
  reason:
    | "candidate_is_terminal"
    | "candidate_state_changed"
    | "cancellation_already_requested"
    | "cancellation_requested";
  run: BuildRun;
}

export interface RunStore {
  createRun(assignment: BuildAssignment): CreateRunResult;
  getRun(runId: string): BuildRun | undefined;
  getAssignment(runId: string): BuildAssignment | undefined;
  listRecent(limit: number, projectId?: string): BuildRun[];
  listQueued(limit: number): BuildRun[];
  listEvents(runId: string, afterSequence: number, limit?: number): RunEvent[];
  getLatestEventSequence(runId: string): number;
  listEvidence(runId: string): EvidenceReceipt[];
  acquireSlot(runId: string, leaseMilliseconds: number): SlotLease | undefined;
  heartbeat(lease: SlotLease, leaseMilliseconds: number): SlotLease;
  releaseSlot(lease: SlotLease): void;
  startRun(runId: string, lease: SlotLease): BuildRun;
  updateStage(
    runId: string,
    lease: SlotLease,
    stage: RunStage,
    payload?: unknown,
  ): BuildRun;
  recordAgentProgress(
    runId: string,
    lease: SlotLease,
    progress: AgentProgress,
  ): void;
  attachSandbox(runId: string, lease: SlotLease, sandboxId: string): BuildRun;
  attachVerificationSandbox(
    runId: string,
    lease: SlotLease,
    sandboxId: string,
    purpose: VerificationSandboxPurpose,
  ): BuildRun;
  promoteVerificationSandbox(
    runId: string,
    lease: SlotLease,
    sandboxId: string,
  ): BuildRun;
  setRevision(
    runId: string,
    lease: SlotLease,
    revisionHash: string,
    previewPort: number,
  ): BuildRun;
  addEvidence(runId: string, lease: SlotLease, receipt: EvidenceReceipt): void;
  recordArtifact(
    runId: string,
    lease: SlotLease,
    artifact: ProvenArtifact,
  ): void;
  getArtifact(runId: string): ProvenArtifact | undefined;
  listOutbox(
    limit: number,
    projectId?: string,
    runIds?: readonly string[],
  ): OutboxEvent[];
  getPendingOutbox(eventId: string): OutboxEvent | undefined;
  markOutboxPublished(eventId: string): boolean;
  requestCancel(runId: string): BuildRun;
  requestCancel(
    runId: string,
    request: CancellationRequest,
  ): CancellationResult;
  markPassed(
    runId: string,
    lease: SlotLease,
    revisionHash: string,
    traceId: string,
  ): BuildRun;
  markRejected(runId: string, lease: SlotLease, reasons: string[]): BuildRun;
  markFailed(
    runId: string,
    lease: SlotLease | undefined,
    code: string,
    message: string,
  ): BuildRun;
  markCancelled(runId: string, lease: SlotLease): BuildRun;
  recoverInterruptedRuns(): RecoveredRun[];
  markRecoveryCleanupComplete(runId: string): void;
  close(): void;
}

export interface VerificationTarget {
  requirementId?: string;
  verifierIndex?: number;
  verifier: Verifier;
}
