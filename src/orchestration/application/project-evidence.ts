import { z } from "zod";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import { redactText } from "../../lib/redaction.js";
import {
  OrchestrationIdSchema,
  OrchestrationSha256Schema,
} from "../domain/project.js";
import type {
  ProofSummarySnapshot,
  ProofSummarySnapshotInput,
} from "../domain/store.js";
import { identifyAndMinimizePii, type PiiFinding } from "./pii.js";

export const MAX_PUBLISHED_PROOF_SUMMARY_BYTES = 64 * 1_024;
export const MAX_PUBLISHED_HARD_REQUIREMENTS = 50;
export const MAX_PUBLISHED_VERIFIERS_PER_REQUIREMENT = 5;
export const MAX_PROOF_PROTECTED_INPUT_VALUES = 256;
export const MAX_PROOF_PROTECTED_VALUES = 128;
export const MAX_PROOF_PROTECTED_VALUE_CHARS = 512;
export const MAX_PROOF_PROTECTED_VALUE_BYTES = 2_048;
export const MAX_PROOF_PROTECTED_TOTAL_BYTES = 32 * 1_024;
export const MAX_PROOF_PII_SPANS = 128;
export const MAX_PROOF_PERSON_NAME_SPANS = 32;
export const MAX_PROOF_PERSON_NAME_SPAN_CHARS = 200;
export const MAX_PROOF_PERSON_NAME_TOKENS = 64;

const ProofVerifierSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: z.string().min(1).max(512),
      timeoutSeconds: z.number().int().min(1).max(900),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http"),
      path: z.string().min(1).max(512),
      expectedStatus: z.number().int().min(100).max(599),
      bodyIncludes: z.array(z.string().min(1).max(300)).max(10),
    })
    .strict(),
  z
    .object({
      kind: z.literal("semantic"),
      criterion: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export const RecordedProofSummarySchema = z
  .object({
    schemaVersion: z.literal("buildlapse-proof-summary-v1"),
    evidenceBoundary: z.string().min(1).max(500),
    project: z
      .object({
        projectId: OrchestrationIdSchema,
        title: z.string().min(1).max(240),
        traceCorrelation: OrchestrationSha256Schema,
      })
      .strict(),
    contract: z
      .object({
        version: z.number().int().positive(),
        digest: OrchestrationSha256Schema,
        proposalDigest: OrchestrationSha256Schema,
        verificationPolicy: z.literal("buildlapse-proof-gate-v1"),
        configuredChecks: z
          .object({
            buildCommand: z.string().min(1).max(512),
            testCommands: z.array(z.string().min(1).max(512)).min(1).max(10),
            previewCommand: z.string().min(1).max(512),
          })
          .strict(),
        hardRequirements: z
          .array(
            z
              .object({
                requirementId: OrchestrationIdSchema,
                description: z.string().min(1).max(1_000),
                verifiers: z
                  .array(ProofVerifierSchema)
                  .min(1)
                  .max(MAX_PUBLISHED_VERIFIERS_PER_REQUIREMENT),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PUBLISHED_HARD_REQUIREMENTS),
      })
      .strict(),
    proofReceipt: z
      .object({
        eventType: z.literal("candidate.proven"),
        eventId: z.uuid(),
        recordedAt: z.iso.datetime(),
        runId: OrchestrationIdSchema,
        candidateId: OrchestrationIdSchema,
        traceId: z.string().min(1).max(512),
        contractHash: OrchestrationSha256Schema,
        revisionHash: OrchestrationSha256Schema,
        artifactDigest: OrchestrationSha256Schema,
        rankingPolicy: z.literal("braintrust-preference-v1"),
        preferenceSatisfaction: z.number().min(0).max(1),
      })
      .strict(),
    deployment: z
      .object({
        receiptId: OrchestrationIdSchema,
        provider: z.literal("fly"),
        productionUrl: z.url(),
        releaseId: OrchestrationIdSchema,
        releaseVersion: z.number().int().positive(),
        imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        workspaceDigest: OrchestrationSha256Schema,
        httpsHealthy: z.literal(true),
        deployedAt: z.iso.datetime(),
        releaseVerifiedAt: z.iso.datetime(),
        healthVerifiedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();

export type RecordedProofSummary = z.infer<typeof RecordedProofSummarySchema>;

interface RecordedContractVerifier {
  kind: "command" | "http" | "semantic";
  command?: string;
  timeoutSeconds?: number;
  path?: string;
  expectedStatus?: number;
  bodyIncludes?: string[];
  criterion?: string;
}

export interface RecordedProofEvidenceSource {
  projectId: string;
  proposals: Array<{
    version: number;
    digest: string;
    projectTitle: string;
    contract: {
      version: number;
      digest: string;
      requirements: Array<{
        requirementId: string;
        description: string;
        priority: "hard" | "preference";
        verifiers: RecordedContractVerifier[];
      }>;
      verification: {
        policyId: "buildlapse-proof-gate-v1";
        buildCommand: string;
        testCommands: string[];
        previewCommand: string;
      };
    };
  }>;
  buildBatches: Array<{
    batchId: string;
    proposalVersion: number;
    proposalDigest: string;
    contractVersion: number;
    contractDigest: string;
    buildContractHash: string;
  }>;
  provenCandidates: Array<{
    batchId: string;
    proposalVersion: number;
    proposalDigest: string;
    event: {
      eventId: string;
      type: "candidate.proven";
      runId: string;
      revisionHash: string;
      traceId: string;
      createdAt: string;
      payload: {
        runId: string;
        projectId: string;
        candidateId: string;
        contractHash: string;
        revisionHash: string;
        artifact: { sha256: string };
        traceId: string;
        ranking: {
          policyVersion: "braintrust-preference-v1";
          preferenceSatisfaction: number;
        };
      };
    };
  }>;
  deployments: Array<{
    receiptId: string;
    provider: "fly";
    projectId: string;
    batchId: string;
    runId: string;
    candidateId: string;
    proposalVersion: number;
    proposalDigest: string;
    revisionHash: string;
    artifactDigest: string;
    releaseId: string;
    releaseVersion: number;
    imageDigest: string;
    workspaceDigest: string;
    url: string;
    httpsHealthy: true;
    deployedAt: string;
    releaseVerifiedAt: string;
    verifiedAt: string;
  }>;
}

export interface RecordedProofBinding {
  projectId: string;
  deploymentReceiptId: string;
  revisionHash: string;
}

export type ProtectedPublicationValueKind =
  "exact" | "person_name_full" | "person_name_token";

export interface ProtectedPublicationValue {
  value: string;
  kind: ProtectedPublicationValueKind;
}

export type ProtectedPublicationInput = string | ProtectedPublicationValue;

export class ProofSummaryEvidenceNotFoundError extends Error {
  constructor() {
    super("The proof-summary evidence binding was not found");
    this.name = "ProofSummaryEvidenceNotFoundError";
  }
}

export class ProofSummaryPublicationRejectedError extends Error {
  constructor() {
    super(
      "The recorded proof summary is unsafe or exceeds its publication budget",
    );
    this.name = "ProofSummaryPublicationRejectedError";
  }
}

/**
 * Resolves exact deployment evidence before it crosses the publication
 * boundary. No fallback or "closest" deployment is permitted.
 */
export function buildRecordedProofSummary(
  source: RecordedProofEvidenceSource,
  binding: RecordedProofBinding,
): RecordedProofSummary {
  const deployment = source.deployments.find(
    (candidate) =>
      candidate.receiptId === binding.deploymentReceiptId &&
      candidate.projectId === binding.projectId &&
      candidate.revisionHash === binding.revisionHash,
  );
  const batch = deployment
    ? source.buildBatches.find(
        (candidate) =>
          candidate.batchId === deployment.batchId &&
          candidate.proposalVersion === deployment.proposalVersion &&
          candidate.proposalDigest === deployment.proposalDigest,
      )
    : undefined;
  const proposal = batch
    ? source.proposals.find(
        (candidate) =>
          candidate.version === batch.proposalVersion &&
          candidate.digest === batch.proposalDigest &&
          candidate.contract.version === batch.contractVersion &&
          candidate.contract.digest === batch.contractDigest,
      )
    : undefined;
  const proven = deployment
    ? source.provenCandidates.find(
        (candidate) =>
          candidate.batchId === deployment.batchId &&
          candidate.proposalVersion === deployment.proposalVersion &&
          candidate.proposalDigest === deployment.proposalDigest &&
          candidate.event.runId === deployment.runId &&
          candidate.event.payload.candidateId === deployment.candidateId &&
          candidate.event.revisionHash === deployment.revisionHash &&
          candidate.event.payload.artifact.sha256 === deployment.artifactDigest,
      )
    : undefined;
  const productionUrl = deployment
    ? safelyParseHttpsUrl(deployment.url)
    : undefined;
  const hardRequirements = proposal?.contract.requirements.filter(
    (requirement) => requirement.priority === "hard",
  );

  if (
    source.projectId !== binding.projectId ||
    !deployment ||
    !batch ||
    !proposal ||
    !proven ||
    !productionUrl ||
    deployment.httpsHealthy !== true ||
    proven.event.type !== "candidate.proven" ||
    proven.event.payload.projectId !== source.projectId ||
    proven.event.payload.runId !== proven.event.runId ||
    proven.event.payload.revisionHash !== proven.event.revisionHash ||
    proven.event.payload.traceId !== proven.event.traceId ||
    proven.event.payload.contractHash !== batch.buildContractHash ||
    hardRequirements === undefined ||
    hardRequirements.length === 0 ||
    hardRequirements.some((requirement) => requirement.verifiers.length === 0)
  ) {
    throw new ProofSummaryEvidenceNotFoundError();
  }
  if (
    hardRequirements.length > MAX_PUBLISHED_HARD_REQUIREMENTS ||
    hardRequirements.some(
      (requirement) =>
        requirement.verifiers.length > MAX_PUBLISHED_VERIFIERS_PER_REQUIREMENT,
    ) ||
    proposal.contract.verification.testCommands.length > 10
  ) {
    throw new ProofSummaryPublicationRejectedError();
  }

  let summary: RecordedProofSummary;
  try {
    summary = RecordedProofSummarySchema.parse({
      schemaVersion: "buildlapse-proof-summary-v1",
      evidenceBoundary:
        "This page reports the exact recorded candidate.proven receipt, configured contract checks, and verified Fly deployment receipt. It does not claim checks outside that recorded evidence.",
      project: {
        projectId: source.projectId,
        title: proposal.projectTitle,
        traceCorrelation: sha256(source.projectId),
      },
      contract: {
        version: proposal.contract.version,
        digest: proposal.contract.digest,
        proposalDigest: proposal.digest,
        verificationPolicy: proposal.contract.verification.policyId,
        configuredChecks: {
          buildCommand: proposal.contract.verification.buildCommand,
          testCommands: proposal.contract.verification.testCommands,
          previewCommand: proposal.contract.verification.previewCommand,
        },
        hardRequirements: hardRequirements.map((requirement) => ({
          requirementId: requirement.requirementId,
          description: requirement.description,
          verifiers: requirement.verifiers,
        })),
      },
      proofReceipt: {
        eventType: proven.event.type,
        eventId: proven.event.eventId,
        recordedAt: proven.event.createdAt,
        runId: proven.event.runId,
        candidateId: proven.event.payload.candidateId,
        traceId: proven.event.traceId,
        contractHash: proven.event.payload.contractHash,
        revisionHash: proven.event.revisionHash,
        artifactDigest: proven.event.payload.artifact.sha256,
        rankingPolicy: proven.event.payload.ranking.policyVersion,
        preferenceSatisfaction:
          proven.event.payload.ranking.preferenceSatisfaction,
      },
      deployment: {
        receiptId: deployment.receiptId,
        provider: deployment.provider,
        productionUrl: productionUrl.href,
        releaseId: deployment.releaseId,
        releaseVersion: deployment.releaseVersion,
        imageDigest: deployment.imageDigest,
        workspaceDigest: deployment.workspaceDigest,
        httpsHealthy: deployment.httpsHealthy,
        deployedAt: deployment.deployedAt,
        releaseVerifiedAt: deployment.releaseVerifiedAt,
        healthVerifiedAt: deployment.verifiedAt,
      },
    });
  } catch {
    throw new ProofSummaryPublicationRejectedError();
  }
  assertPublicationSafe(summary, []);
  return summary;
}

export function createRecordedProofSnapshot(
  source: RecordedProofEvidenceSource,
  binding: RecordedProofBinding,
  protectedValues: readonly ProtectedPublicationInput[],
): ProofSummarySnapshotInput {
  const summary = buildRecordedProofSummary(source, binding);
  assertPublicationSafe(summary, protectedValues);
  const canonicalSnapshot = canonicalJson(summary);
  if (
    Buffer.byteLength(canonicalSnapshot) > MAX_PUBLISHED_PROOF_SUMMARY_BYTES
  ) {
    throw new ProofSummaryPublicationRejectedError();
  }
  return {
    snapshotId: proofSummarySnapshotId(binding),
    projectId: binding.projectId,
    deploymentReceiptId: binding.deploymentReceiptId,
    revisionHash: binding.revisionHash,
    snapshotDigest: sha256(canonicalSnapshot),
    canonicalSnapshot,
  };
}

export function parseRecordedProofSnapshot(
  snapshot: ProofSummarySnapshot,
): RecordedProofSummary {
  if (
    snapshot.revokedAt ||
    Buffer.byteLength(snapshot.canonicalSnapshot) >
      MAX_PUBLISHED_PROOF_SUMMARY_BYTES ||
    sha256(snapshot.canonicalSnapshot) !== snapshot.snapshotDigest
  ) {
    throw new ProofSummaryEvidenceNotFoundError();
  }
  try {
    const parsedJson = JSON.parse(snapshot.canonicalSnapshot) as unknown;
    if (canonicalJson(parsedJson) !== snapshot.canonicalSnapshot) {
      throw new ProofSummaryEvidenceNotFoundError();
    }
    const summary = RecordedProofSummarySchema.parse(parsedJson);
    const binding = {
      projectId: summary.project.projectId,
      deploymentReceiptId: summary.deployment.receiptId,
      revisionHash: summary.proofReceipt.revisionHash,
    };
    if (
      snapshot.projectId !== binding.projectId ||
      snapshot.deploymentReceiptId !== binding.deploymentReceiptId ||
      snapshot.revisionHash !== binding.revisionHash ||
      snapshot.snapshotId !== proofSummarySnapshotId(binding)
    ) {
      throw new ProofSummaryEvidenceNotFoundError();
    }
    assertPublicationSafe(summary, []);
    return summary;
  } catch (error) {
    if (error instanceof ProofSummaryEvidenceNotFoundError) {
      throw error;
    }
    throw new ProofSummaryEvidenceNotFoundError();
  }
}

function proofSummarySnapshotId(binding: RecordedProofBinding): string {
  return `proof-summary:${sha256(canonicalJson(binding)).slice(0, 32)}`;
}

function assertPublicationSafe(
  summary: RecordedProofSummary,
  protectedValues: readonly ProtectedPublicationInput[],
): void {
  const values = collectPublishedStrings(summary);
  const protectedNeedles = boundProtectedPublicationValues(protectedValues);
  for (const { value, path } of values) {
    const schemaValidatedOpaque = isSchemaValidatedOpaqueField(path, value);
    if (
      protectedNeedles.some((needle) =>
        containsWholeProtectedValue(value, needle),
      ) ||
      redactText(value) !== value ||
      (!schemaValidatedOpaque &&
        (identifyAndMinimizePii(value, []).findings.some(
          isPublishablePiiFinding,
        ) ||
          containsUntrustedOpaqueSecret(value))) ||
      containsCredential(value)
    ) {
      throw new ProofSummaryPublicationRejectedError();
    }
  }
}

export function boundProtectedPublicationValues(
  inputs: readonly ProtectedPublicationInput[],
): ProtectedPublicationValue[] {
  const untrustedInputs: readonly unknown[] = inputs;
  if (
    !Array.isArray(untrustedInputs) ||
    untrustedInputs.length > MAX_PROOF_PROTECTED_INPUT_VALUES
  ) {
    throw new ProofSummaryPublicationRejectedError();
  }
  const bounded: ProtectedPublicationValue[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const input of untrustedInputs) {
    const parsed = parseProtectedPublicationInput(input);
    if (!parsed) {
      continue;
    }
    const bytes = Buffer.byteLength(parsed.value);
    if (
      parsed.value.length > MAX_PROOF_PROTECTED_VALUE_CHARS ||
      bytes > MAX_PROOF_PROTECTED_VALUE_BYTES
    ) {
      throw new ProofSummaryPublicationRejectedError();
    }
    const dedupeKey = `${parsed.kind}\0${parsed.value.toLocaleLowerCase(
      "en-US",
    )}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    totalBytes += bytes;
    if (
      bounded.length >= MAX_PROOF_PROTECTED_VALUES ||
      totalBytes > MAX_PROOF_PROTECTED_TOTAL_BYTES
    ) {
      throw new ProofSummaryPublicationRejectedError();
    }
    bounded.push(parsed);
  }
  return bounded;
}

function parseProtectedPublicationInput(
  input: unknown,
): ProtectedPublicationValue | undefined {
  if (typeof input === "string") {
    assertProtectedValueWidth(input);
    const value = input.trim();
    return value.length > 0 ? { value, kind: "exact" } : undefined;
  }
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((key) => key !== "value" && key !== "kind") ||
    !("value" in input) ||
    !("kind" in input) ||
    typeof input.value !== "string" ||
    (input.kind !== "exact" &&
      input.kind !== "person_name_full" &&
      input.kind !== "person_name_token")
  ) {
    throw new ProofSummaryPublicationRejectedError();
  }
  assertProtectedValueWidth(input.value);
  const value = input.value.trim();
  return value.length > 0 ? { value, kind: input.kind } : undefined;
}

function assertProtectedValueWidth(value: string): void {
  if (
    value.length > MAX_PROOF_PROTECTED_VALUE_CHARS ||
    Buffer.byteLength(value) > MAX_PROOF_PROTECTED_VALUE_BYTES
  ) {
    throw new ProofSummaryPublicationRejectedError();
  }
}

interface PublishedString {
  value: string;
  path: string;
}

function collectPublishedStrings(
  value: unknown,
  path: string[] = [],
  output: PublishedString[] = [],
): PublishedString[] {
  if (typeof value === "string") {
    output.push({ value, path: path.join(".") });
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectPublishedStrings(item, [...path, String(index)], output);
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectPublishedStrings(item, [...path, key], output);
    }
  }
  return output;
}

function containsWholeProtectedValue(
  value: string,
  protectedValue: ProtectedPublicationValue,
): boolean {
  const caseSensitive =
    protectedValue.kind !== "exact" &&
    isShortSinglePersonName(protectedValue.value);
  const haystack = caseSensitive ? value : value.toLocaleLowerCase("en-US");
  const needle = caseSensitive
    ? protectedValue.value
    : protectedValue.value.toLocaleLowerCase("en-US");
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) {
      return false;
    }
    const before = index > 0 ? haystack[index - 1] : undefined;
    const after =
      index + needle.length < haystack.length
        ? haystack[index + needle.length]
        : undefined;
    if (!isLetterOrNumber(before) && !isLetterOrNumber(after)) {
      return true;
    }
    offset = index + Math.max(needle.length, 1);
  }
  return false;
}

function isShortSinglePersonName(value: string): boolean {
  // Short given names frequently overlap ordinary words (Will, May, Mark).
  // Preserve their exact capitalization; longer/unambiguous names remain
  // case-insensitive so a casing change cannot bypass partial-name protection.
  const tokens = value.match(/\p{L}[\p{L}'’-]*/gu) ?? [];
  return tokens.length === 1 && Array.from(tokens[0]).length <= 4;
}

function isLetterOrNumber(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function isPublishablePiiFinding(finding: PiiFinding): boolean {
  if (finding.type !== "financial") {
    return true;
  }
  const digits = finding.value.replace(/\D/gu, "");
  return (
    digits.length >= 6 ||
    /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/iu.test(finding.value.replace(/\s/gu, ""))
  );
}

function isSchemaValidatedOpaqueField(path: string, value: string): boolean {
  const shaPaths = new Set([
    "project.traceCorrelation",
    "contract.digest",
    "contract.proposalDigest",
    "proofReceipt.contractHash",
    "proofReceipt.revisionHash",
    "proofReceipt.artifactDigest",
    "deployment.imageDigest",
    "deployment.workspaceDigest",
  ]);
  const uuidOrOpaqueIdPaths = new Set([
    "project.projectId",
    "proofReceipt.eventId",
    "proofReceipt.runId",
    "proofReceipt.candidateId",
    "proofReceipt.traceId",
    "deployment.receiptId",
    "deployment.releaseId",
  ]);
  const timestampPaths = new Set([
    "proofReceipt.recordedAt",
    "deployment.deployedAt",
    "deployment.releaseVerifiedAt",
    "deployment.healthVerifiedAt",
  ]);
  return (
    (shaPaths.has(path) && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value)) ||
    (uuidOrOpaqueIdPaths.has(path) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      )) ||
    (timestampPaths.has(path) &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ))
  );
}

function containsUntrustedOpaqueSecret(value: string): boolean {
  return (
    /\b[a-f0-9]{48,}\b/iu.test(value) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(
      value,
    ) ||
    containsHighEntropyBase64Token(value)
  );
}

function containsHighEntropyBase64Token(value: string): boolean {
  for (const match of value.matchAll(/[A-Za-z0-9+/_-]{32,512}={0,2}/gu)) {
    const token = match[0].replace(/=+$/u, "");
    const characterClasses = [
      /[a-z]/u.test(token),
      /[A-Z]/u.test(token),
      /\d/u.test(token),
      /[+/_-]/u.test(token),
    ].filter(Boolean).length;
    const entropy = shannonEntropy(token);
    if (
      (characterClasses >= 3 && entropy >= 4) ||
      (characterClasses >= 2 && entropy >= 4.5)
    ) {
      return true;
    }
  }
  return false;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function containsCredential(value: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(value) ||
    /\bFlyV1\s+[A-Za-z0-9._-]{8,}\b/u.test(value) ||
    /\b(?:dtn_|fw_|re_|ck_|cr-|sk-)[A-Za-z0-9._-]{8,}\b/u.test(value) ||
    /\b(?:Bearer\s+)?(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{6,}\b/u.test(
      value,
    ) ||
    /\b(?:whsec|github_pat|ghp|gho|ghu|ghs|ghr|flyv1)_[A-Za-z0-9_-]{6,}\b/iu.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(
      value,
    ) ||
    /\b(?:authorization|api[_ -]?key|secret|password|credential|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]{8,}/iu.test(
      value,
    ) ||
    /https:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(value)
  );
}

function safelyParseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
