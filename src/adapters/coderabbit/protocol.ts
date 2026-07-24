import { posix } from "node:path";

import { z } from "zod";

import type { ReviewFinding } from "../../domain/evidence.js";
import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import { boundText } from "../../lib/redaction.js";
import {
  classifyCodeRabbitFinding,
  CODERABBIT_RETRY_DELAYS_MILLISECONDS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
} from "./policy-pack.js";

const MAX_REVIEW_OUTPUT_BYTES = 20 * 1_024 * 1_024;
const MAX_JSONL_LINE_BYTES = 256 * 1_024;
const MAX_EVENTS = 10_000;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 20_000;
const MAX_OBJECT_KEYS = 200;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_JSON_STRING_BYTES = 128 * 1_024;
const MAX_FINDINGS = 500;
const MAX_FINDING_PATH_CHARACTERS = 2_000;
const MAX_FINDING_TEXT_CHARACTERS = 20_000;
const MAX_SUGGESTIONS = 20;
const MAX_SUGGESTION_CHARACTERS = 4_000;
const MAX_CODERABBIT_RETRIES = CODERABBIT_RETRY_DELAYS_MILLISECONDS.length;
const MAX_CODERABBIT_RETRY_DELAY_MILLISECONDS = 60_000;

export type CodeRabbitRetryReason =
  "structured_rate_limit" | "missing_terminal_completion";

export interface ExpectedCodeRabbitReviewContext {
  reviewKind: "authoritative_full" | "advisory_light";
  reviewType: "committed";
  currentBranch: string;
  baseCommit: string;
  workingDirectory: string;
  expectedFiles: readonly string[];
}

export interface ParsedCodeRabbitEvents {
  complete: true;
  findings: ReviewFinding[];
  rawDigest: string;
  reviewContext: CodeRabbitReviewContextEvidence;
  reviewContextDigest: string;
  scope: CodeRabbitReviewScopeEvidence;
  scopeDigest: string;
  terminalState: "review_completed";
  eventCounts: {
    reviewContext: number;
    status: number;
    heartbeat: number;
    finding: number;
    complete: number;
    error: number;
  };
}

export interface CodeRabbitReviewContextEvidence {
  reviewType: "committed";
  currentBranch: string;
  baseBranch: "main";
  baseCommit: string;
  workingDirectoryDigest: string;
}

export interface CodeRabbitReviewScopeEvidence {
  reviewKind: "authoritative_full" | "advisory_light";
  reviewType: "committed";
  currentBranch: string;
  baseBranch: "main";
  baseCommit: string;
  workingDirectoryDigest: string;
  reviewedFileCount: number;
  reviewedFilesDigest: string;
}

const FindingPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_FINDING_PATH_CHARACTERS)
  .refine(
    (path) => !containsControlCharacter(path),
    "Finding path contains control characters",
  )
  .refine(
    (path) => !path.includes("\\") && !posix.isAbsolute(path),
    "Finding path must be workspace-relative",
  )
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "Finding path contains an unsafe segment",
  )
  .transform((path) => posix.normalize(path))
  .refine(
    (path) =>
      path !== "." &&
      path !== ".." &&
      !path.startsWith("../") &&
      !path.startsWith("/"),
    "Finding path escapes the review workspace",
  );

const FindingTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_FINDING_TEXT_CHARACTERS);
const OptionalFindingTextSchema = z
  .string()
  .trim()
  .max(MAX_FINDING_TEXT_CHARACTERS);

const ReviewContextEventSchema = z
  .object({
    type: z.literal("review_context"),
    reviewType: z.literal("committed"),
    currentBranch: z.string().min(1).max(512),
    baseBranch: z.string().min(1).max(512),
    baseCommit: z.string().min(1).max(128),
    workingDirectory: z.string().min(1).max(4_096),
  })
  .strict();

const HeartbeatEventSchema = z
  .object({
    type: z.literal("heartbeat"),
    status: z.literal("reviewing"),
  })
  .strict();

const ReviewStatusSchema = z.enum([
  "analyzing_files",
  "connecting_to_review_service",
  "setting_up",
  "preparing_sandbox",
  "building_code_graph",
  "tools_completed",
  "review_started",
  "review_completed",
  "review_skipped",
  "summarizing",
  "reviewing",
  "other",
  "analyzing",
]);
const ReviewPhaseSchema = z.enum(["connecting", "setup", "analyzing"]);
const ReviewErrorTypeSchema = z.enum([
  "connection",
  "auth",
  "rate_limit",
  "review",
  "payload_too_large",
  "timeout",
  "unknown",
]);

const FindingEventSchema = z
  .object({
    type: z.literal("finding"),
    severity: z.enum(["critical", "major", "minor", "trivial", "info"]),
    fileName: FindingPathSchema,
    codegenInstructions: OptionalFindingTextSchema,
    comment: FindingTextSchema.optional(),
    suggestions: z
      .array(z.string().trim().min(1).max(MAX_SUGGESTION_CHARACTERS))
      .max(MAX_SUGGESTIONS),
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      finding.codegenInstructions.trim().length === 0 &&
      !finding.comment &&
      finding.suggestions.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Finding must contain bounded review text",
      });
    }
  });

const CompleteEventSchema = z
  .object({
    type: z.literal("complete"),
    status: z.literal("review_completed"),
    findings: z.number().int().nonnegative().max(MAX_FINDINGS),
    reviewedFiles: z.array(FindingPathSchema).max(10_000),
  })
  .strict();

const StatusEventSchema = z
  .object({
    type: z.literal("status"),
    phase: ReviewPhaseSchema,
    status: ReviewStatusSchema,
    message: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();

const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    errorType: ReviewErrorTypeSchema,
    code: z.union([z.string().max(256), z.number().int()]).optional(),
    message: z.string().trim().min(1).max(4_096),
    recoverable: z.boolean(),
    retryable: z.boolean().optional(),
    actionRequired: z.boolean().optional(),
    actualFiles: z.number().int().nonnegative().max(1_000_000).optional(),
    maxFiles: z.number().int().positive().max(1_000_000).optional(),
    candidatesNote: z.string().trim().min(1).max(4_096).optional(),
    candidates: z.array(z.unknown()).max(20).optional(),
    details: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

export class CodeRabbitProtocolError extends Error {
  override readonly name = "CodeRabbitProtocolError";

  constructor(
    message: string,
    readonly retryReason?: CodeRabbitRetryReason,
  ) {
    super(message);
  }
}

export function isValidCodeRabbitJsonlEvent(line: string): boolean {
  if (
    line.length === 0 ||
    Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES
  ) {
    return false;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
    assertBoundedJson(event);
  } catch {
    return false;
  }
  const envelope = z
    .object({ type: z.string().min(1).max(256) })
    .safeParse(event);
  if (!envelope.success) {
    return false;
  }
  switch (envelope.data.type) {
    case "review_context":
      return ReviewContextEventSchema.safeParse(event).success;
    case "status":
      return StatusEventSchema.safeParse(event).success;
    case "heartbeat":
      return HeartbeatEventSchema.safeParse(event).success;
    case "finding":
      return FindingEventSchema.safeParse(event).success;
    case "complete":
      return CompleteEventSchema.safeParse(event).success;
    case "error":
      return ErrorEventSchema.safeParse(event).success;
    default:
      return false;
  }
}

export function parseCodeRabbitEvents(
  stdout: string,
  expected?: ExpectedCodeRabbitReviewContext,
): ParsedCodeRabbitEvents {
  if (Buffer.byteLength(stdout, "utf8") > MAX_REVIEW_OUTPUT_BYTES) {
    throw new CodeRabbitProtocolError(
      "CodeRabbit review output exceeded its limit",
    );
  }

  const findings: ReviewFinding[] = [];
  const errors: string[] = [];
  const eventCounts = {
    reviewContext: 0,
    status: 0,
    heartbeat: 0,
    finding: 0,
    complete: 0,
    error: 0,
  };
  let eventCount = 0;
  let terminalSeen = false;
  let completionStatus: string | undefined;
  let contextEvent: z.infer<typeof ReviewContextEventSchema> | undefined;
  let completedReviewedFiles: string[] | undefined;
  let structuredRateLimit = false;
  let structuredRateLimitDiagnostic: string | undefined;
  let findingLimitReported = false;

  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    eventCount += 1;
    if (eventCount > MAX_EVENTS) {
      errors.push(`CodeRabbit emitted more than ${MAX_EVENTS} events`);
      break;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES) {
      errors.push(`CodeRabbit emitted an oversized event at line ${index + 1}`);
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
      assertBoundedJson(event);
    } catch {
      errors.push(`CodeRabbit emitted malformed JSONL at line ${index + 1}`);
      continue;
    }

    const envelope = z
      .object({ type: z.string().min(1).max(256) })
      .safeParse(event);
    if (!envelope.success) {
      errors.push(`CodeRabbit emitted an invalid event at line ${index + 1}`);
      continue;
    }
    if (
      !CODERABBIT_SUPPORTED_EVENT_KINDS.includes(
        envelope.data.type as (typeof CODERABBIT_SUPPORTED_EVENT_KINDS)[number],
      )
    ) {
      errors.push(
        `CodeRabbit emitted unsupported event type at line ${index + 1}`,
      );
      continue;
    }
    if (terminalSeen) {
      errors.push("CodeRabbit emitted data after its terminal event");
      continue;
    }

    if (envelope.data.type === "review_context") {
      const parsed = ReviewContextEventSchema.safeParse(event);
      if (!parsed.success) {
        errors.push(
          `CodeRabbit emitted an invalid review context at line ${index + 1}`,
        );
        continue;
      }
      eventCounts.reviewContext += 1;
      contextEvent = parsed.data;
      if (eventCounts.reviewContext > 1) {
        errors.push("CodeRabbit emitted multiple review context events");
      }
      if (eventCount !== 1) {
        errors.push("CodeRabbit review context was not the first event");
      }
      continue;
    }

    if (eventCounts.reviewContext !== 1) {
      errors.push("CodeRabbit emitted review data before its review context");
    }

    if (envelope.data.type === "heartbeat") {
      const parsed = HeartbeatEventSchema.safeParse(event);
      if (!parsed.success) {
        errors.push(
          `CodeRabbit emitted an invalid heartbeat at line ${index + 1}`,
        );
        continue;
      }
      eventCounts.heartbeat += 1;
      continue;
    }

    if (envelope.data.type === "status") {
      const parsed = StatusEventSchema.safeParse(event);
      if (!parsed.success) {
        errors.push(
          `CodeRabbit emitted an invalid status at line ${index + 1}`,
        );
        continue;
      }
      eventCounts.status += 1;
      if (parsed.data.status === "review_skipped") {
        errors.push("CodeRabbit skipped the review");
      }
      continue;
    }

    if (envelope.data.type === "finding") {
      eventCounts.finding += 1;
      if (findings.length >= MAX_FINDINGS) {
        if (!findingLimitReported) {
          errors.push(`CodeRabbit emitted more than ${MAX_FINDINGS} findings`);
          findingLimitReported = true;
        }
        continue;
      }
      const parsed = FindingEventSchema.safeParse(event);
      if (!parsed.success) {
        errors.push(
          `CodeRabbit emitted an invalid finding at line ${index + 1}`,
        );
        continue;
      }
      if (expected && !expected.expectedFiles.includes(parsed.data.fileName)) {
        errors.push(
          "CodeRabbit finding referenced a file outside controller review scope",
        );
        continue;
      }
      const codegenInstructions =
        parsed.data.codegenInstructions?.trim() || undefined;
      const message =
        codegenInstructions ??
        parsed.data.comment ??
        parsed.data.suggestions?.[0] ??
        "CodeRabbit finding";
      const classification = classifyCodeRabbitFinding({
        severity: parsed.data.severity,
        fileName: parsed.data.fileName,
        message,
        comment: parsed.data.comment,
        codegenInstructions,
        suggestions: parsed.data.suggestions,
      });
      findings.push({
        severity: classification.severity,
        fileName: parsed.data.fileName,
        message,
        ...(codegenInstructions ? { codegenInstructions } : {}),
        ...(parsed.data.suggestions
          ? { suggestions: parsed.data.suggestions }
          : {}),
        category: classification.category,
        governingInvariant: classification.governingInvariant,
        ...(classification.ruleId
          ? { controllerRuleId: classification.ruleId }
          : {}),
      });
      continue;
    }

    if (envelope.data.type === "error") {
      const parsed = ErrorEventSchema.safeParse(event);
      if (!parsed.success) {
        errors.push(
          `CodeRabbit emitted an invalid error event at line ${index + 1}`,
        );
        continue;
      }
      eventCounts.error += 1;
      terminalSeen = true;
      structuredRateLimit =
        parsed.data.errorType === "rate_limit" &&
        parsed.data.retryable !== false &&
        parsed.data.recoverable !== false &&
        parsed.data.actionRequired !== true &&
        !parsed.data.candidates &&
        !parsed.data.candidatesNote;
      if (parsed.data.candidates || parsed.data.candidatesNote) {
        errors.push(
          "CodeRabbit rejected the authoritative scope and proposed narrower alternatives",
        );
      } else {
        structuredRateLimitDiagnostic = `CodeRabbit emitted a ${boundText(
          parsed.data.errorType ?? "provider",
          256,
        )} error event`;
        errors.push(structuredRateLimitDiagnostic);
      }
      continue;
    }

    const parsed = CompleteEventSchema.safeParse(event);
    if (!parsed.success) {
      errors.push(
        `CodeRabbit emitted an invalid completion at line ${index + 1}`,
      );
      continue;
    }
    eventCounts.complete += 1;
    terminalSeen = true;
    completionStatus = parsed.data.status;
    completedReviewedFiles = parsed.data.reviewedFiles;
    if (parsed.data.findings !== undefined) {
      if (parsed.data.findings !== findings.length) {
        errors.push("CodeRabbit completion finding count did not match events");
      }
    }
  }

  if (eventCounts.reviewContext !== 1 || !contextEvent) {
    errors.push("CodeRabbit did not emit exactly one review context event");
  }
  if (eventCounts.complete > 1) {
    errors.push("CodeRabbit emitted multiple completion events");
  }
  if (!completionStatus) {
    errors.push("CodeRabbit did not emit a completion event");
  } else if (completionStatus !== "review_completed") {
    errors.push(
      `CodeRabbit emitted non-success completion status ${completionStatus}`,
    );
  }
  if (eventCounts.error > 0 && eventCounts.complete > 0) {
    errors.push("CodeRabbit emitted both error and completion terminals");
  }

  if (expected && contextEvent) {
    validateReviewContext(contextEvent, expected, errors);
    if (eventCounts.complete > 0) {
      validateReviewedFiles(completedReviewedFiles, expected, errors);
    }
  } else if (expected) {
    errors.push("CodeRabbit full review scope could not be bound");
  }

  if (errors.length > 0) {
    const onlyMissingTerminal =
      errors.length === 1 &&
      errors[0] === "CodeRabbit did not emit a completion event";
    const onlyStructuredRateLimit =
      structuredRateLimit &&
      eventCounts.error === 1 &&
      eventCounts.complete === 0 &&
      errors.length === 2 &&
      structuredRateLimitDiagnostic !== undefined &&
      errors.includes(structuredRateLimitDiagnostic) &&
      errors.includes("CodeRabbit did not emit a completion event");
    throw new CodeRabbitProtocolError(
      boundText(errors.join("\n"), 8_192),
      onlyStructuredRateLimit
        ? "structured_rate_limit"
        : onlyMissingTerminal
          ? "missing_terminal_completion"
          : undefined,
    );
  }
  if (!contextEvent) {
    throw new CodeRabbitProtocolError(
      "CodeRabbit review context was unavailable after validation",
    );
  }

  const reviewContext = {
    reviewType: contextEvent.reviewType,
    currentBranch: contextEvent.currentBranch,
    baseBranch: "main",
    baseCommit: contextEvent.baseCommit,
    workingDirectoryDigest: sha256(
      contextEvent.workingDirectory.replaceAll("\\", "/"),
    ),
  } satisfies CodeRabbitReviewContextEvidence;
  const reviewedFiles = [...(completedReviewedFiles ?? [])].sort(compareUtf8);
  const scope = {
    reviewKind: expected?.reviewKind ?? "authoritative_full",
    reviewType: contextEvent.reviewType,
    currentBranch: contextEvent.currentBranch,
    baseBranch: "main",
    baseCommit: contextEvent.baseCommit,
    workingDirectoryDigest: reviewContext.workingDirectoryDigest,
    reviewedFileCount: reviewedFiles.length,
    reviewedFilesDigest: sha256(canonicalJson(reviewedFiles)),
  } satisfies CodeRabbitReviewScopeEvidence;

  return {
    complete: true,
    findings,
    rawDigest: sha256(stdout),
    reviewContext,
    reviewContextDigest: sha256(canonicalJson(reviewContext)),
    scope,
    scopeDigest: sha256(canonicalJson(scope)),
    terminalState: "review_completed",
    eventCounts,
  };
}

function validateReviewContext(
  actual: z.infer<typeof ReviewContextEventSchema>,
  expected: ExpectedCodeRabbitReviewContext,
  errors: string[],
): void {
  const actualDirectory = actual.workingDirectory.replaceAll("\\", "/");
  const expectedDirectory = expected.workingDirectory.replaceAll("\\", "/");
  if (
    actual.reviewType !== expected.reviewType ||
    actual.currentBranch !== expected.currentBranch ||
    actual.baseBranch !== "main" ||
    actual.baseCommit !== expected.baseCommit ||
    actualDirectory !== expectedDirectory
  ) {
    errors.push("CodeRabbit review context did not match controller scope");
  }
}

function validateReviewedFiles(
  actual: string[] | undefined,
  expected: ExpectedCodeRabbitReviewContext,
  errors: string[],
): void {
  if (!actual) {
    errors.push("CodeRabbit completion omitted reviewed file coverage");
    return;
  }
  const normalizedActual = [...actual].sort(compareUtf8);
  const normalizedExpected = [...expected.expectedFiles].sort(compareUtf8);
  if (
    new Set(normalizedActual).size !== normalizedActual.length ||
    normalizedActual.length !== normalizedExpected.length ||
    normalizedActual.some((path, index) => path !== normalizedExpected[index])
  ) {
    errors.push("CodeRabbit reviewed file coverage was partial or mismatched");
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertBoundedJson(value: unknown): void {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error("JSON structure exceeded its bound");
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > MAX_JSON_STRING_BYTES) {
        throw new Error("JSON string exceeded its bound");
      }
      return;
    }
    if (
      candidate === null ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS) {
        throw new Error("JSON array exceeded its bound");
      }
      for (const item of candidate) {
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw new Error("JSON value type is unsupported");
    }
    const entries = Object.entries(candidate);
    if (entries.length > MAX_OBJECT_KEYS) {
      throw new Error("JSON object exceeded its bound");
    }
    for (const [key, item] of entries) {
      if (Buffer.byteLength(key, "utf8") > 256) {
        throw new Error("JSON key exceeded its bound");
      }
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

export interface CodeRabbitReviewRetryOptions {
  signal?: AbortSignal | undefined;
  retryDelaysMilliseconds?: readonly number[] | undefined;
  onRetry?: (
    reason: CodeRabbitRetryReason,
    attempt: number,
    delayMilliseconds: number,
  ) => void;
}

export async function runCodeRabbitReviewWithRetry<Result>(
  operation: (attempt: number) => Promise<Result>,
  options: CodeRabbitReviewRetryOptions = {},
): Promise<Result> {
  const retryDelays =
    options.retryDelaysMilliseconds ?? CODERABBIT_RETRY_DELAYS_MILLISECONDS;
  assertValidCodeRabbitRetryDelays(retryDelays);

  for (let attempt = 1; ; attempt += 1) {
    throwIfCodeRabbitReviewAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      if (options.signal?.aborted) {
        throw codeRabbitReviewAbortError(options.signal);
      }
      const retryDelay = retryDelays[attempt - 1];
      const retryReason =
        error instanceof CodeRabbitProtocolError
          ? error.retryReason
          : undefined;
      if (retryDelay === undefined || retryReason === undefined) {
        throw error;
      }
      options.onRetry?.(retryReason, attempt, retryDelay);
      await waitForCodeRabbitRetry(retryDelay, options.signal);
    }
  }
}

function assertValidCodeRabbitRetryDelays(delays: readonly number[]): void {
  if (
    delays.length > MAX_CODERABBIT_RETRIES ||
    delays.some(
      (delay) =>
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        delay > MAX_CODERABBIT_RETRY_DELAY_MILLISECONDS,
    )
  ) {
    throw new Error("CodeRabbit retry schedule is outside controller bounds");
  }
}

function throwIfCodeRabbitReviewAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw codeRabbitReviewAbortError(signal);
  }
}

function codeRabbitReviewAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("CodeRabbit review aborted");
}

async function waitForCodeRabbitRetry(
  delayMilliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCodeRabbitReviewAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMilliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal
          ? codeRabbitReviewAbortError(signal)
          : new Error("CodeRabbit review aborted"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}
