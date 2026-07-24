import { randomUUID } from "node:crypto";

import {
  artifactDownloadPath,
  type ProvenArtifact,
} from "../src/domain/artifact.js";
import {
  CODERABBIT_CONFIG_SCHEMA_DIGEST,
  CODERABBIT_CONTROLLER_CONFIG_DIGEST,
  CODERABBIT_CONTROLLER_RULES_DIGEST,
  CODERABBIT_DOCTOR_DIGEST,
  CODERABBIT_EVENT_SCHEMA_DIGEST,
  CODERABBIT_POLICY_PACK_DIGEST,
  CODERABBIT_POLICY_PACK_VERSION,
  CODERABBIT_REQUIRED_REVIEW_FLAGS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
  CODERABBIT_TOOL_POLICY,
  CODERABBIT_TOOL_POLICY_DIGEST,
} from "../src/adapters/coderabbit/policy-pack.js";
import { CODERABBIT_HANDSHAKE_REVIEW_FLAGS } from "../src/adapters/coderabbit/capability.js";
import {
  BuildAssignmentSchema,
  type BuildAssignment,
} from "../src/domain/contract.js";
import type {
  CommandReceipt,
  EvaluationReceipt,
  EvidenceReceipt,
  PreviewReceipt,
  RasterClaimReceipt,
  ReviewReceipt,
} from "../src/domain/evidence.js";
import { DEPENDENCY_BOOTSTRAP_COMMAND } from "../src/application/dependency-bootstrap.js";
import {
  canonicalJson,
  digestJson,
  sha256,
} from "../src/lib/canonical-json.js";
import {
  CONTAINER_BUILD_COMMAND,
  DOCKERFILE_VERIFICATION_COMMAND,
  forbiddenClaimsCommand,
} from "../src/application/verification.js";
import { previewInputDigest } from "../src/application/preview-inspector.js";

const NOW = "2026-07-23T12:00:00.000Z";
const TRANSCRIPT = "Mission Peak Electric serves Fremont.";
const TRANSCRIPT_HASH = sha256(TRANSCRIPT);

export function assignment(
  suffix = "one",
  mutate?: (value: BuildAssignment) => void,
): BuildAssignment {
  const value = BuildAssignmentSchema.parse({
    assignmentId: `assignment-${suffix}`,
    projectId: "project-mission-peak",
    candidateId: `candidate-${suffix}`,
    requestedAt: NOW,
    strategyLabel: "clear service-business website",
    buildPrompt:
      "Build an accessible site for Mission Peak Electric with an estimate form.",
    transcript: {
      content: TRANSCRIPT,
      sha256: TRANSCRIPT_HASH,
    },
    contract: {
      version: 1,
      contractId: "contract-mission-peak-v1",
      projectId: "project-mission-peak",
      transcriptSha256: TRANSCRIPT_HASH,
      approvedAt: NOW,
      approvedFacts: [
        {
          id: "fact-name",
          statement: "The business is named Mission Peak Electric.",
          sources: [
            {
              type: "transcript",
              transcriptSha256: TRANSCRIPT_HASH,
              startOffset: 0,
              endOffset: 21,
              excerpt: "Mission Peak Electric",
              excerptSha256: sha256("Mission Peak Electric"),
            },
          ],
        },
      ],
      forbiddenClaims: ["24/7 emergency service"],
      requirements: [
        {
          id: "homepage",
          description: "Homepage names Mission Peak Electric.",
          priority: "hard",
          verifiers: [
            {
              kind: "http",
              path: "/",
              expectedStatus: 200,
              bodyIncludes: ["Mission Peak Electric"],
            },
          ],
        },
        {
          id: "visual-polish",
          description: "Use a restrained visual hierarchy.",
          priority: "preference",
          verifiers: [
            {
              kind: "semantic",
              criterion: "The page has a restrained visual hierarchy.",
            },
          ],
        },
      ],
      verification: {
        buildCommand: "npm run build",
        testCommands: ["npm test"],
        previewCommand: "npm run start",
        previewPort: 3000,
      },
    },
    sandbox: {
      language: "typescript",
      autoStopMinutes: 60,
      autoArchiveMinutes: 1_440,
    },
    limits: {
      maxAgentSteps: 20,
      maxRepairRounds: 1,
      wallClockSeconds: 1_800,
      maxToolOutputBytes: 65_536,
    },
  });
  mutate?.(value);
  return BuildAssignmentSchema.parse(value);
}

export function passingEvidence(
  runId: string,
  revisionHash: string,
  input = assignment(),
): EvidenceReceipt[] {
  const base = {
    runId,
    revisionHash,
    status: "PASS" as const,
    startedAt: NOW,
    completedAt: NOW,
    inputDigest: sha256("input"),
    outputDigest: sha256("output"),
  };
  const command = (
    kind: CommandReceipt["kind"],
    value: string,
  ): CommandReceipt => ({
    ...base,
    receiptId: randomUUID(),
    kind,
    provider: "daytona",
    command: value,
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
  });
  const previewChecks: PreviewReceipt["checks"] = [
    {
      path: "/",
      expectedStatus: 200,
      actualStatus: 200,
      expectedText: [],
      missingText: [],
      visibleTextDigest: sha256("Mission Peak Electric"),
      screenshotSha256s: [sha256("rendered screenshot")],
    },
    {
      requirementId: "homepage",
      verifierIndex: 0,
      path: "/",
      expectedStatus: 200,
      actualStatus: 200,
      expectedText: ["Mission Peak Electric"],
      missingText: [],
      visibleTextDigest: sha256("Mission Peak Electric"),
      screenshotSha256s: [sha256("rendered screenshot")],
    },
  ];
  const preview: PreviewReceipt = {
    ...base,
    inputDigest: previewInputDigest(input.contract),
    outputDigest: digestJson(previewChecks),
    receiptId: randomUUID(),
    kind: "preview",
    provider: "daytona",
    checks: previewChecks,
  };
  const reviewContext = {
    reviewType: "committed" as const,
    currentBranch: "candidate",
    baseBranch: "main" as const,
    baseCommit: "a".repeat(40),
    workingDirectoryDigest: sha256("fixture review directory"),
  };
  const reviewScope = {
    reviewKind: "authoritative_full" as const,
    ...reviewContext,
    reviewedFileCount: 1,
    reviewedFilesDigest: digestJson(["fixture-source"]),
  };
  const cliExecutableDigest = sha256("fixture CLI executable");
  const capability = {
    state: "healthy" as const,
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    cliVersion: "0.7.0",
    cliExecutableDigest,
    rootHelpDigest: sha256("fixture root help"),
    reviewHelpDigest: sha256("fixture review help"),
    reviewFlagsDigest: digestJson(CODERABBIT_HANDSHAKE_REVIEW_FLAGS),
    agentJsonl: true as const,
    supportedEventKinds: [...CODERABBIT_SUPPORTED_EVENT_KINDS],
    reviewFlags: [...CODERABBIT_HANDSHAKE_REVIEW_FLAGS],
    authenticated: true as const,
    doctor: {
      passed: 8,
      warnings: 1,
      failed: 0,
      digest: CODERABBIT_DOCTOR_DIGEST,
    },
    updatePolicy: "disabled-and-digest-pinned" as const,
    serviceConnectivity: "healthy" as const,
    controllerConfig: "supported" as const,
    toolSupport: "disabled-controller-policy" as const,
  };
  const review: ReviewReceipt = {
    ...base,
    receiptId: randomUUID(),
    kind: "coderabbit",
    provider: "coderabbit",
    complete: true,
    findings: [],
    policyDigest: sha256("controller review policy"),
    expectedPolicyDigest: sha256("controller review policy"),
    attestation: {
      schemaVersion: 1,
      reviewKind: "authoritative_full",
      capabilityState: "proof-integrated",
      authorityKey: digestJson({
        schemaVersion: 1,
        runId,
        sourceDigest: revisionHash,
      }),
      sourceDigest: revisionHash,
      contractDigest: digestJson(input.contract),
      reviewDigest: sha256("fixture review JSONL"),
      findingSetDigest: digestJson([]),
      reviewContext,
      reviewContextDigest: digestJson(reviewContext),
      scope: reviewScope,
      scopeDigest: digestJson(reviewScope),
      policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
      policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
      configSchemaDigest: CODERABBIT_CONFIG_SCHEMA_DIGEST,
      configDigest: CODERABBIT_CONTROLLER_CONFIG_DIGEST,
      rulesDigest: CODERABBIT_CONTROLLER_RULES_DIGEST,
      policyDigest: sha256("controller review policy"),
      toolPolicyDigest: CODERABBIT_TOOL_POLICY_DIGEST,
      eventSchemaDigest: CODERABBIT_EVENT_SCHEMA_DIGEST,
      capability,
      capabilityDigest: digestJson(capability),
      cliVersion: "0.7.0",
      cliExecutableDigestBefore: cliExecutableDigest,
      cliExecutableDigestAfter: cliExecutableDigest,
      reviewFlagsDigest: digestJson(CODERABBIT_REQUIRED_REVIEW_FLAGS),
      updatePolicy: "disabled-and-digest-pinned",
      authentication: "authenticated",
      doctor: {
        passed: 8,
        warnings: 1,
        failed: 0,
        digest: CODERABBIT_DOCTOR_DIGEST,
      },
      serviceConnectivity: "healthy",
      agentJsonl: true,
      terminalState: "review_completed",
      eventCounts: {
        reviewContext: 1,
        status: 1,
        heartbeat: 0,
        finding: 0,
        complete: 1,
        error: 0,
      },
      attempts: 1,
      retryReasons: [],
      durationMs: 1,
      severityCounts: {
        critical: 0,
        major: 0,
        minor: 0,
        trivial: 0,
        info: 0,
      },
      categoryCounts: [],
      configuredTools: [...CODERABBIT_TOOL_POLICY.configuredTools],
      observedTools: [],
      toolCoverage: "disabled-controller-policy",
    },
  };
  review.expectedAttestationDigest = digestJson(review.attestation);
  const rasterClaimReceipt: RasterClaimReceipt = {
    ...base,
    receiptId: randomUUID(),
    kind: "visual-claim",
    provider: "fireworks",
    traceProvider: "braintrust",
    traceId: "trace-test",
    claimSetDigest: sha256(canonicalJson(input.contract.forbiddenClaims)),
    approvedFactSetDigest: sha256(
      canonicalJson(input.contract.approvedFacts.map((fact) => fact.statement)),
    ),
    renderedInputDigest: digestJson([
      {
        path: "/",
        screenshotSha256s: [sha256("rendered screenshot")],
      },
    ]),
    forbiddenClaimIndices: input.contract.forbiddenClaims.map(
      (_, index) => index,
    ),
    assetCount: 1,
    workspaceAssetCount: 0,
    renderedAssetCount: 1,
    aggregateBytes: 1,
    assetDigests: [sha256("rendered screenshot")],
    modelInputDigests: [sha256("rendered screenshot")],
    modelDigest: sha256("fireworks vision model"),
    matches: [],
    unsupportedAssetIndices: [],
    unverifiedAssetIndices: [],
  };
  const requirementCommands = input.contract.requirements.flatMap(
    (requirement) =>
      requirement.verifiers.flatMap((verifier, verifierIndex) =>
        verifier.kind === "command"
          ? [
              {
                ...command("requirement-command", verifier.command),
                requirementId: requirement.id,
                verifierIndex,
              },
            ]
          : [],
      ),
  );
  const evaluation: EvaluationReceipt = {
    ...base,
    receiptId: randomUUID(),
    kind: "contract-evaluation",
    provider: "fireworks",
    traceProvider: "braintrust",
    traceId: "trace-test",
    braintrustScores: {
      hardRequirements: 1,
      supportedBusinessFacts: 1,
      evidenceGrounding: 1,
      preferenceSatisfaction: 1,
    },
    requirements: input.contract.requirements.map((requirement) => {
      const evidenceRefs = requirement.verifiers.flatMap(
        (verifier, verifierIndex) => {
          if (verifier.kind === "command") {
            const receipt = requirementCommands.find(
              (candidate) =>
                candidate.requirementId === requirement.id &&
                candidate.verifierIndex === verifierIndex,
            );
            return receipt ? [`receipt:${receipt.receiptId}`] : [];
          }
          return [`page:/:${sha256("Mission Peak Electric")}`];
        },
      );
      return {
        requirementId: requirement.id,
        status: "PASS" as const,
        explanation: "Verified by test evidence.",
        evidenceRefs,
      };
    }),
    unsupportedClaims: [],
    summary: "All hard requirements are supported.",
  };

  return [
    command("artifact", DOCKERFILE_VERIFICATION_COMMAND),
    command("dependency-bootstrap", DEPENDENCY_BOOTSTRAP_COMMAND),
    command("build", input.contract.verification.buildCommand),
    ...input.contract.verification.testCommands.map((testCommand) =>
      command("test", testCommand),
    ),
    ...(input.contract.forbiddenClaims.length > 0
      ? [
          {
            ...command(
              "forbidden-claim",
              forbiddenClaimsCommand(input.contract.forbiddenClaims),
            ),
            forbiddenClaimIndices: input.contract.forbiddenClaims.map(
              (_, index) => index,
            ),
          },
        ]
      : []),
    rasterClaimReceipt,
    ...requirementCommands,
    command("container-build", CONTAINER_BUILD_COMMAND),
    preview,
    review,
    evaluation,
  ];
}

export function artifact(runId: string, revisionHash: string): ProvenArtifact {
  const artifactId = randomUUID();
  return {
    artifactId,
    runId,
    revisionHash,
    format: "tar.gz",
    uri: artifactDownloadPath(runId, artifactId),
    sha256: digestJson({ runId, revisionHash }),
    sizeBytes: 100,
    dockerfilePath: "Dockerfile",
    daytonaSnapshot: `buildlabs-${runId.slice(0, 8)}-${revisionHash.slice(0, 12)}`,
    createdAt: NOW,
  };
}
