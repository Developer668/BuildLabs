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
import type { EvidenceReceipt, ReviewReceipt } from "../src/domain/evidence.js";
import type { PatchTrainingSource } from "../src/domain/patch-model.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";

export function integrateCodeRabbitReviewFixture(
  receipts: EvidenceReceipt[],
  contract: PatchTrainingSource["contract"],
  runId: string,
  revisionHash: string,
): void {
  const review = receipts.find(
    (receipt): receipt is ReviewReceipt => receipt.kind === "coderabbit",
  );
  if (!review || !review.policyDigest || !review.expectedPolicyDigest) {
    throw new Error("Missing CodeRabbit fixture");
  }
  const executableDigest = sha256("coderabbit-cli-0.7.0");
  const reviewContext = {
    reviewType: "committed" as const,
    currentBranch: "candidate",
    baseBranch: "main" as const,
    baseCommit: "a".repeat(40),
    workingDirectoryDigest: sha256("patch-model review directory"),
  };
  const scope = {
    reviewKind: "authoritative_full" as const,
    ...reviewContext,
    reviewedFileCount: 1,
    reviewedFilesDigest: digestJson(["patch-model-source"]),
  };
  const capability = {
    state: "healthy" as const,
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    cliVersion: "0.7.0",
    cliExecutableDigest: executableDigest,
    rootHelpDigest: sha256("patch-model root help"),
    reviewHelpDigest: sha256("patch-model review help"),
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
  const attestation = {
    schemaVersion: 1 as const,
    reviewKind: "authoritative_full" as const,
    capabilityState: "proof-integrated" as const,
    authorityKey: digestJson({
      schemaVersion: 1,
      runId,
      sourceDigest: revisionHash,
    }),
    sourceDigest: revisionHash,
    contractDigest: digestJson(contract),
    reviewDigest: sha256("coderabbit-review"),
    findingSetDigest: digestJson(review.findings),
    reviewContext,
    reviewContextDigest: digestJson(reviewContext),
    scope,
    scopeDigest: digestJson(scope),
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    configSchemaDigest: CODERABBIT_CONFIG_SCHEMA_DIGEST,
    configDigest: CODERABBIT_CONTROLLER_CONFIG_DIGEST,
    rulesDigest: CODERABBIT_CONTROLLER_RULES_DIGEST,
    policyDigest: review.policyDigest,
    toolPolicyDigest: CODERABBIT_TOOL_POLICY_DIGEST,
    eventSchemaDigest: CODERABBIT_EVENT_SCHEMA_DIGEST,
    capability,
    capabilityDigest: digestJson(capability),
    cliVersion: "0.7.0",
    cliExecutableDigestBefore: executableDigest,
    cliExecutableDigestAfter: executableDigest,
    reviewFlagsDigest: digestJson(CODERABBIT_REQUIRED_REVIEW_FLAGS),
    updatePolicy: "disabled-and-digest-pinned" as const,
    authentication: "authenticated" as const,
    doctor: {
      passed: 8,
      warnings: 1,
      failed: 0,
      digest: CODERABBIT_DOCTOR_DIGEST,
    },
    serviceConnectivity: "healthy" as const,
    agentJsonl: true as const,
    terminalState: "review_completed" as const,
    eventCounts: {
      reviewContext: 1,
      status: 1,
      heartbeat: 1,
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
    toolCoverage: "disabled-controller-policy" as const,
  };
  review.attestation = attestation;
  review.expectedAttestationDigest = digestJson(attestation);
}
