import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeRabbitCli } from "../src/adapters/coderabbit/coderabbit-cli.js";
import {
  CODERABBIT_POLICY_PACK_DIGEST,
  CODERABBIT_POLICY_PACK_VERSION,
} from "../src/adapters/coderabbit/policy-pack.js";
import { computeReviewWorkspaceDigest } from "../src/adapters/coderabbit/workspace-policy.js";
import { AcceptanceContractSchema } from "../src/domain/contract.js";
import { sha256 } from "../src/lib/canonical-json.js";

const gate = process.env.BUILDLABS_CODERABBIT_CONFORMANCE;

if (gate !== "1") {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      captureKind: "controller-fixture",
      state: "gated",
      policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
      policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    }),
  );
  process.exitCode = 0;
} else {
  await runConformanceCapture();
}

async function runConformanceCapture(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "buildlabs-cr-conformance-"));
  try {
    await writeFile(
      join(root, "app.js"),
      [
        "export function status() {",
        '  return { ok: true, service: "controller-fixture" };',
        "}",
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    const sourceDigest = await computeReviewWorkspaceDigest(root);
    const transcriptSha256 = sha256("controller-owned-conformance");
    const contract = AcceptanceContractSchema.parse({
      version: 1,
      contractRevision: 1,
      contractId: "coderabbit-conformance-v1",
      projectId: "controller-conformance",
      transcriptSha256,
      approvedAt: "2026-07-24T00:00:00.000Z",
      approvedFacts: [],
      forbiddenClaims: [],
      requirements: [
        {
          id: "syntax",
          description: "The controller fixture remains valid JavaScript.",
          priority: "hard",
          verifiers: [
            {
              kind: "command",
              command: "node --check app.js",
              timeoutSeconds: 30,
            },
          ],
        },
      ],
      verification: {
        buildCommand: "node --check app.js",
        testCommands: ["node --check app.js"],
        previewCommand: "node app.js",
        previewPort: 3_000,
      },
    });
    const timeoutSeconds = boundedTimeout(
      process.env.CODERABBIT_TIMEOUT_SECONDS,
    );
    const reviewer = new CodeRabbitCli({
      CODERABBIT_AUTH_MODE: "oauth",
      CODERABBIT_AUTH_HOME: undefined,
      CODERABBIT_BIN: process.env.CODERABBIT_BIN ?? "coderabbit",
      CODERABBIT_TIMEOUT_SECONDS: timeoutSeconds,
    });
    const capability = await reviewer.capabilities();
    if (capability.state !== "healthy") {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          captureKind: "controller-fixture",
          state: "capability_failed",
          capabilityState: capability.state,
          reasonCode: capability.reasonCode,
          capabilityDigest: capability.digest,
          policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
          policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
        }),
      );
      process.exitCode = 1;
      return;
    }

    try {
      const result = await reviewer.review({
        runId: "coderabbit-conformance-v1",
        revision: {
          sourceDigest,
          commitSha: sourceDigest,
          frozenAt: "2026-07-24T00:00:00.000Z",
        },
        workspaceDirectory: root,
        contract,
        verificationContext: {
          commands: [],
          previewChecks: [],
        },
      });
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          captureKind: "controller-fixture",
          state: "review_verified",
          capabilityState: result.attestation.capabilityState,
          cliVersion: result.attestation.cliVersion,
          sourceDigest,
          reviewDigest: result.attestation.reviewDigest,
          policyDigest: result.policyDigest,
          policyPackVersion: result.attestation.policyPackVersion,
          policyPackDigest: result.attestation.policyPackDigest,
          capabilityDigest: result.attestation.capabilityDigest,
          findingCount: result.findings.length,
          severityCounts: result.attestation.severityCounts,
          categoryCounts: result.attestation.categoryCounts,
          attempts: result.attestation.attempts,
          retryReasons: result.attestation.retryReasons,
          durationMs: result.attestation.durationMs,
          toolCoverage: result.attestation.toolCoverage,
          terminalState: result.attestation.terminalState,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          captureKind: "controller-fixture",
          state: "review_failed_closed",
          errorType:
            error instanceof Error ? error.constructor.name : "UnknownError",
          sourceDigest,
          capabilityDigest: capability.digest,
          policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
          policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
        }),
      );
      process.exitCode = 1;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function boundedTimeout(value: string | undefined): number {
  const parsed = Number(value ?? "600");
  if (!Number.isSafeInteger(parsed) || parsed < 30 || parsed > 900) {
    return 600;
  }
  return parsed;
}
