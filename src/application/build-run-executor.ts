import type { ProvenArtifact } from "../domain/artifact.js";
import { buildCodeRabbitPolicy } from "../adapters/coderabbit/coderabbit-cli.js";
import { CODERABBIT_HANDSHAKE_REVIEW_FLAGS } from "../adapters/coderabbit/capability.js";
import {
  classifyCodeRabbitFinding,
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
  isSupportedCodeRabbitVersion,
} from "../adapters/coderabbit/policy-pack.js";
import {
  codeRabbitSemanticReviewFiles,
  inspectReviewWorkspace,
} from "../adapters/coderabbit/workspace-policy.js";
import { contractDigest, type BuildAssignment } from "../domain/contract.js";
import type {
  CodeRabbitRepairBrief,
  CodeRabbitReviewAttestation,
  EvaluationReceipt,
  EvidenceReceipt,
  PreviewReceipt,
  RasterClaimReceipt,
  ReviewReceipt,
} from "../domain/evidence.js";
import {
  CodeRabbitRepairBriefSchema,
  CodeRabbitReviewAttestationSchema,
  ReviewFindingSchema,
} from "../domain/evidence.js";
import type { FrozenRevision, SlotLease } from "../domain/run.js";
import { canonicalJson, digestJson, sha256 } from "../lib/canonical-json.js";
import { boundText } from "../lib/redaction.js";
import type {
  ArtifactStore,
  CodeReviewPort,
  CodeReviewRequest,
  CodeReviewResult,
  ExportedWorkspace,
  ModelPort,
  RunStore,
  SandboxProvider,
  SandboxSession,
  TracePort,
  TraceSpan,
  VerificationSandboxPurpose,
} from "../ports/index.js";
import { AgentRunner } from "./agent-runner.js";
import { evaluateContract } from "./contract-evaluator.js";
import { collectWorkspaceInspection } from "./inspection-collector.js";
import { inspectPreview } from "./preview-inspector.js";
import { decideProof } from "./proof-gate.js";
import { inspectRasterClaims } from "./raster-claim-inspector.js";
import { createReceiptBase } from "./receipts.js";
import { CONTAINER_IMAGE_TAG, runCommandVerification } from "./verification.js";

export interface BuildRunExecutorDependencies {
  store: RunStore;
  sandboxProvider: SandboxProvider;
  artifactStore: ArtifactStore;
  model: ModelPort;
  reviewer: CodeReviewPort;
  trace: TracePort;
  enableCodeRabbitAdvisoryWipReview?: boolean;
}

type ExecutionOutcome =
  | {
      kind: "passed";
      revision: FrozenRevision;
      artifact: ProvenArtifact;
      verificationSandbox: SandboxSession;
      traceId: string;
    }
  | {
      kind: "rejected";
      reasons: string[];
    };

type AuthoritativeReviewLedger = Map<string, ReviewReceipt[]>;

export class BuildRunExecutor {
  readonly #agent: AgentRunner;

  constructor(private readonly dependencies: BuildRunExecutorDependencies) {
    this.#agent = new AgentRunner(dependencies.model);
  }

  async execute(
    runId: string,
    lease: SlotLease,
    signal?: AbortSignal,
  ): Promise<void> {
    const { store, trace } = this.dependencies;
    const assignment = requireAssignment(store, runId);
    const timeoutSignal = AbortSignal.timeout(
      assignment.limits.wallClockSeconds * 1_000,
    );
    const runSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const authoritativeReviews = indexAuthoritativeReviews(
      store.listEvidence(runId),
    );
    let run = store.getRun(runId);
    let builderSandbox: SandboxSession | undefined;
    let retainedVerificationSandbox: SandboxSession | undefined;
    let traceFlushed = false;

    try {
      run = store.startRun(runId, lease);
      const tracedExecution = trace.run(run, async (rootSpan) => {
        ensureActive(store, runId, runSignal);
        builderSandbox = await rootSpan.child(
          "daytona.sandbox.create",
          "tool",
          {
            runId,
            language: assignment.sandbox.language,
            snapshot:
              assignment.sandbox.snapshot ?? "configured-provider-default",
          },
          async () =>
            this.dependencies.sandboxProvider.create(
              runId,
              assignment,
              runSignal,
            ),
        );
        store.attachSandbox(runId, lease, builderSandbox.id);

        store.updateStage(runId, lease, "generating", { repairRound: 0 });
        await this.#agent.run({
          assignment,
          sandbox: builderSandbox,
          trace: rootSpan,
          signal: runSignal,
          onEvent: (event) => {
            ensureActive(store, runId, runSignal);
            store.recordAgentProgress(runId, lease, {
              ...event.payload,
              repairRound: 0,
            });
          },
        });
        await this.#reviewMutableWipAdvisory({
          runId,
          assignment,
          builderSandbox,
          trace: rootSpan,
          signal: runSignal,
        });

        for (
          let repairRound = 0;
          repairRound <= assignment.limits.maxRepairRounds;
          repairRound += 1
        ) {
          ensureActive(store, runId, runSignal);
          const outcome = await this.#verifyRevision({
            runId,
            lease,
            assignment,
            builderSandbox,
            trace: rootSpan,
            repairAdvisoryFindings:
              repairRound < assignment.limits.maxRepairRounds,
            authoritativeReviews,
            signal: runSignal,
          });

          if (outcome.passed) {
            retainedVerificationSandbox = outcome.verificationSandbox;
            store.updateStage(runId, lease, "finalizing", {
              revisionHash: outcome.revision.sourceDigest,
              artifactId: outcome.artifact.artifactId,
            });
            return {
              kind: "passed",
              revision: outcome.revision,
              artifact: outcome.artifact,
              verificationSandbox: outcome.verificationSandbox,
              traceId: rootSpan.traceId,
            } satisfies ExecutionOutcome;
          }

          if (repairRound === assignment.limits.maxRepairRounds) {
            return {
              kind: "rejected",
              reasons: outcome.reasons,
            } satisfies ExecutionOutcome;
          }

          if (
            outcome.repairFeedback.length === 0 &&
            outcome.reviewRepairBriefs.length === 0
          ) {
            return {
              kind: "rejected",
              reasons: outcome.reasons,
            } satisfies ExecutionOutcome;
          }

          store.updateStage(runId, lease, "generating", {
            repairRound: repairRound + 1,
            rejectedRevision: outcome.revision.sourceDigest,
          });
          await this.#agent.run({
            assignment,
            sandbox: builderSandbox,
            trace: rootSpan,
            repairFeedback: outcome.repairFeedback,
            reviewRepairBriefs: outcome.reviewRepairBriefs,
            signal: runSignal,
            onEvent: (event) => {
              ensureActive(store, runId, runSignal);
              store.recordAgentProgress(runId, lease, {
                ...event.payload,
                repairRound: repairRound + 1,
              });
            },
          });
          await this.#reviewMutableWipAdvisory({
            runId,
            assignment,
            builderSandbox,
            trace: rootSpan,
            signal: runSignal,
          });
        }

        throw new Error("Build run ended without a proof decision");
      });
      const outcome = await withAbort(tracedExecution, runSignal);
      await withAbort(trace.flush(), runSignal);
      traceFlushed = true;
      ensureActive(store, runId, runSignal);
      if (outcome.kind === "passed") {
        store.markPassed(
          runId,
          lease,
          outcome.revision.sourceDigest,
          outcome.traceId,
        );
      } else {
        store.markRejected(runId, lease, outcome.reasons);
      }
    } catch (error) {
      run = store.getRun(runId) ?? run;
      if (run?.status === "running") {
        try {
          if (run.cancelRequested) {
            store.markCancelled(runId, lease);
          } else {
            store.markFailed(
              runId,
              lease,
              errorCode(error),
              error instanceof Error
                ? error.message
                : "Unknown build-run failure",
            );
          }
        } catch {
          // A stale lease is already fenced from all further mutations.
        }
      }
    } finally {
      try {
        const terminal = store.getRun(runId);
        if (builderSandbox) {
          await disposeSandbox(builderSandbox).catch(() => undefined);
        }
        if (retainedVerificationSandbox && terminal?.status !== "passed") {
          await disposeSandbox(retainedVerificationSandbox).catch(
            () => undefined,
          );
        }
        if (!traceFlushed) {
          flushTraceBestEffort(trace);
        }
      } finally {
        store.releaseSlot(lease);
      }
    }
  }

  async #reviewMutableWipAdvisory(input: {
    runId: string;
    assignment: BuildAssignment;
    builderSandbox: SandboxSession;
    trace: TraceSpan;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { enableCodeRabbitAdvisoryWipReview, reviewer } = this.dependencies;
    if (
      enableCodeRabbitAdvisoryWipReview !== true ||
      reviewer.reviewAdvisory === undefined
    ) {
      return;
    }

    const revision = await input.builderSandbox.freeze();
    assertFrozenDigest(
      await input.builderSandbox.currentRevisionDigest(),
      revision,
    );
    const workspace = await input.builderSandbox.exportWorkspace(revision);
    try {
      await input.trace.child(
        "coderabbit.review.advisory",
        "review",
        {
          runId: input.runId,
          revisionHash: revision.sourceDigest,
          proofBearing: false,
        },
        async (span) => {
          try {
            const result = await reviewer.reviewAdvisory!(
              {
                runId: input.runId,
                revision,
                workspaceDirectory: workspace.directory,
                contract: input.assignment.contract,
                verificationContext: {
                  commands: [],
                  previewChecks: [],
                },
              },
              input.signal,
            );
            const attestation = CodeRabbitReviewAttestationSchema.safeParse(
              result.attestation,
            );
            const valid =
              result.complete &&
              attestation.success &&
              attestation.data.reviewKind === "advisory_light" &&
              attestation.data.capabilityState === "review-verified" &&
              attestation.data.sourceDigest === revision.sourceDigest &&
              attestation.data.reviewDigest === result.rawDigest &&
              attestation.data.findingSetDigest ===
                digestJson(result.findings) &&
              attestation.data.policyPackDigest ===
                CODERABBIT_POLICY_PACK_DIGEST &&
              attestation.data.toolPolicyDigest ===
                CODERABBIT_TOOL_POLICY_DIGEST;
            span.log({
              output: valid
                ? {
                    state: "review_verified",
                    findingCount: result.findings.length,
                    reviewDigest: result.rawDigest,
                    sourceDigest: revision.sourceDigest,
                    proofBearing: false,
                  }
                : {
                    state: "invalid_advisory_evidence",
                    proofBearing: false,
                  },
            });
          } catch (error) {
            if (input.signal?.aborted) {
              throw error;
            }
            span.log({
              output: {
                state: "failed_closed",
                errorType: "provider_failure",
                proofBearing: false,
              },
            });
          }
        },
      );
    } finally {
      await workspace.cleanup();
    }
  }

  async #verifyRevision(request: {
    runId: string;
    lease: SlotLease;
    assignment: BuildAssignment;
    builderSandbox: SandboxSession;
    trace: TraceSpan;
    repairAdvisoryFindings: boolean;
    authoritativeReviews: AuthoritativeReviewLedger;
    signal?: AbortSignal | undefined;
  }): Promise<
    | {
        passed: true;
        reasons: [];
        revision: FrozenRevision;
        artifact: ProvenArtifact;
        verificationSandbox: SandboxSession;
      }
    | {
        passed: false;
        reasons: string[];
        repairFeedback: string[];
        reviewRepairBriefs: CodeRabbitRepairBrief[];
        revision: FrozenRevision;
      }
  > {
    const { store, artifactStore, model, reviewer } = this.dependencies;
    store.updateStage(request.runId, request.lease, "verifying");
    const builderRevision = await request.builderSandbox.freeze();

    assertFrozenDigest(
      await request.builderSandbox.currentRevisionDigest(),
      builderRevision,
    );
    let source:
      Awaited<ReturnType<SandboxSession["exportWorkspace"]>> | undefined;
    let commandSandbox: SandboxSession | undefined;
    let deliverySandbox: SandboxSession | undefined;
    let retainDeliverySandbox = false;

    try {
      source = await request.builderSandbox.exportWorkspace(builderRevision);
      const revision = bindRevisionToControllerSource(builderRevision, source);
      store.setRevision(
        request.runId,
        request.lease,
        revision.sourceDigest,
        request.assignment.contract.verification.previewPort,
      );
      commandSandbox = await createVerificationSandbox({
        provider: this.dependencies.sandboxProvider,
        runId: request.runId,
        assignment: request.assignment,
        revision,
        source,
        purpose: "commands",
        trace: request.trace,
        signal: request.signal,
      });
      if (commandSandbox.id === request.builderSandbox.id) {
        commandSandbox = undefined;
        throw new Error(
          "Daytona command verifier must be isolated from the untrusted builder",
        );
      }
      store.attachVerificationSandbox(
        request.runId,
        request.lease,
        commandSandbox.id,
        "commands",
      );
      deliverySandbox = await createVerificationSandbox({
        provider: this.dependencies.sandboxProvider,
        runId: request.runId,
        assignment: request.assignment,
        revision,
        source,
        purpose: "delivery",
        trace: request.trace,
        signal: request.signal,
      });
      if (
        deliverySandbox.id === commandSandbox.id ||
        deliverySandbox.id === request.builderSandbox.id
      ) {
        deliverySandbox = undefined;
        throw new Error(
          "Daytona verification sandboxes must be isolated from every other build phase",
        );
      }
      store.attachVerificationSandbox(
        request.runId,
        request.lease,
        deliverySandbox.id,
        "delivery",
      );
      const provenSandbox = deliverySandbox;

      const commandReceipts = await runCommandVerification({
        runId: request.runId,
        revisionHash: revision.sourceDigest,
        assignment: request.assignment,
        sandbox: commandSandbox,
        phase: "commands",
        trace: request.trace,
        signal: request.signal,
      });
      await disposeSandbox(commandSandbox);
      commandSandbox = undefined;

      const deliveryReceipts = await runCommandVerification({
        runId: request.runId,
        revisionHash: revision.sourceDigest,
        assignment: request.assignment,
        sandbox: provenSandbox,
        phase: "delivery",
        trace: request.trace,
        signal: request.signal,
      });
      const allCommandReceipts = [...commandReceipts, ...deliveryReceipts];
      recordEvidence(store, request.runId, request.lease, allCommandReceipts);

      let pages: Awaited<ReturnType<typeof inspectPreview>>["pages"] = [];
      let previewReceipt: PreviewReceipt | undefined;
      if (allCommandReceipts.every((receipt) => receipt.status === "PASS")) {
        await sealDeliveryNetworkForProof({
          runId: request.runId,
          revision,
          sandbox: provenSandbox,
          trace: request.trace,
          signal: request.signal,
        });
        await provenSandbox.startContainerPreview(
          CONTAINER_IMAGE_TAG,
          request.assignment.contract.verification.previewPort,
          request.signal,
        );
        const inspection = await inspectPreview({
          runId: request.runId,
          revisionHash: revision.sourceDigest,
          contract: request.assignment.contract,
          sandbox: provenSandbox,
          previewPort: request.assignment.contract.verification.previewPort,
          trace: request.trace,
          signal: request.signal,
        });
        pages = inspection.pages;
        previewReceipt = inspection.receipt;
        store.addEvidence(request.runId, request.lease, inspection.receipt);
      }

      store.updateStage(request.runId, request.lease, "reviewing");
      const reviewWorkspace = await provenSandbox.exportWorkspace(revision);
      let reviewReceipt: ReviewReceipt;
      const priorReviews =
        request.authoritativeReviews.get(revision.sourceDigest) ?? [];
      const previousRevisionReview = latestLedgerReview(
        request.authoritativeReviews,
      );
      try {
        if (priorReviews.length > 0) {
          reviewReceipt = priorReviews.at(-1)!;
          await traceReviewReuse(
            request.trace,
            request.runId,
            revision.sourceDigest,
            priorReviews.length,
            reviewReceipt.findings.length,
          );
        } else {
          reviewReceipt = await reviewRevision({
            runId: request.runId,
            revision,
            workspaceDirectory: reviewWorkspace.directory,
            contract: request.assignment.contract,
            verificationContext: {
              commands: allCommandReceipts.map((receipt) => ({
                kind: receipt.kind,
                status: receipt.status,
                command: receipt.command,
                exitCode: receipt.exitCode,
                outputDigest: receipt.outputDigest,
                stdoutTruncated: receipt.stdoutTruncated,
                stderrTruncated: receipt.stderrTruncated,
                ...((receipt.stderr || receipt.stdout) &&
                receipt.status !== "PASS"
                  ? {
                      diagnostic: boundText(
                        receipt.stderr || receipt.stdout,
                        2_000,
                      ),
                    }
                  : {}),
              })),
              previewChecks:
                previewReceipt?.checks.map((check) => ({
                  path: check.path,
                  expectedStatus: check.expectedStatus,
                  actualStatus: check.actualStatus,
                  missingText: check.missingText,
                  ...(check.error
                    ? { error: boundText(check.error, 2_000) }
                    : {}),
                })) ?? [],
            },
            reviewer,
            trace: request.trace,
            signal: request.signal,
          });
          store.addEvidence(request.runId, request.lease, reviewReceipt);
          request.authoritativeReviews.set(revision.sourceDigest, [
            reviewReceipt,
          ]);
          if (previousRevisionReview) {
            await traceRepairYield(
              request.trace,
              request.runId,
              previousRevisionReview,
              reviewReceipt,
            );
          }
        }
      } finally {
        await reviewWorkspace.cleanup();
      }

      assertFrozenDigest(await provenSandbox.currentRevisionDigest(), revision);
      const workspace = await provenSandbox.exportWorkspace(revision);
      let artifact: ProvenArtifact | undefined;
      try {
        store.updateStage(request.runId, request.lease, "evaluating");
        const rasterClaimReceipt = await inspectRasterClaims({
          runId: request.runId,
          revisionHash: revision.sourceDigest,
          assignment: request.assignment,
          workspaceDirectory: workspace.directory,
          pages,
          model,
          trace: request.trace,
          signal: request.signal,
        });
        store.addEvidence(request.runId, request.lease, rasterClaimReceipt);
        const sourceFiles = await collectWorkspaceInspection(
          workspace.directory,
        );
        const evaluation = await evaluateContract({
          runId: request.runId,
          revision,
          assignment: request.assignment,
          pages,
          sourceFiles,
          commandEvidence: allCommandReceipts,
          model,
          trace: request.trace,
          signal: request.signal,
        });
        store.addEvidence(request.runId, request.lease, evaluation);

        const receipts = store.listEvidence(request.runId);
        const decision = decideProof(
          request.assignment.contract,
          revision.sourceDigest,
          receipts,
        );
        const reviewFindings = reviewFeedback(reviewReceipt);
        const reviewRepairBriefs =
          priorReviews.length <= 1
            ? createCodeRabbitRepairBriefs(reviewReceipt)
            : [];
        const actionableReviewFeedback =
          reviewReceipt.complete &&
          reviewReceipt.policyDigest !== undefined &&
          reviewReceipt.expectedPolicyDigest !== undefined &&
          reviewReceipt.policyDigest === reviewReceipt.expectedPolicyDigest &&
          reviewReceipt.attestation?.capabilityState === "proof-integrated" &&
          reviewReceipt.expectedAttestationDigest ===
            sha256(canonicalJson(reviewReceipt.attestation))
            ? reviewFindings
            : [];
        const rasterFeedback = classifyRasterFeedback(rasterClaimReceipt);
        const previewFeedback = previewReceipt
          ? classifyPreviewFeedback(previewReceipt, request.assignment.contract)
          : EMPTY_CLASSIFIED_FEEDBACK;
        const trustedEvaluationFeedback =
          evaluation.status === "FAIL" ? evaluationFeedback(evaluation) : [];
        const failedCommandFeedback = commandFeedback(allCommandReceipts);
        const reasons = [
          ...decision.reasons,
          ...reviewFindings,
          ...rasterFeedback.terminal,
          ...previewFeedback.terminal,
          ...trustedEvaluationFeedback,
          ...failedCommandFeedback,
        ];
        const repairFeedback = [
          ...actionableReviewFeedback,
          ...rasterFeedback.actionable,
          ...previewFeedback.actionable,
          ...trustedEvaluationFeedback,
          ...failedCommandFeedback,
        ];

        const currentDigest = await provenSandbox.currentRevisionDigest();
        if (currentDigest !== revision.sourceDigest) {
          const sourceChangedReason =
            "Candidate source changed after freezing; all proof must target one exact revision";
          reasons.push(sourceChangedReason);
          repairFeedback.push(sourceChangedReason);
        }

        const uniqueReasons = [
          ...new Set(reasons.map((reason) => boundText(reason, 4_000))),
        ];
        const uniqueRepairFeedback = [
          ...new Set(repairFeedback.map((reason) => boundText(reason, 4_000))),
        ];
        const hasAdvisoryFindings =
          reviewReceipt.complete &&
          reviewReceipt.findings.some((finding) =>
            ["major", "minor"].includes(finding.severity),
          );
        if (
          !decision.passed ||
          currentDigest !== revision.sourceDigest ||
          (request.repairAdvisoryFindings && hasAdvisoryFindings)
        ) {
          return {
            passed: false,
            reasons: uniqueReasons,
            repairFeedback: uniqueRepairFeedback,
            reviewRepairBriefs,
            revision,
          };
        }

        const snapshotName = await request.trace.child(
          "daytona.snapshot.create",
          "tool",
          {
            runId: request.runId,
            revisionHash: revision.sourceDigest,
            sandboxId: provenSandbox.id,
          },
          async () =>
            provenSandbox.createSnapshot(
              snapshotNameFor(request.runId, revision),
              request.signal,
            ),
        );
        await provenSandbox.startContainerPreview(
          CONTAINER_IMAGE_TAG,
          request.assignment.contract.verification.previewPort,
          request.signal,
        );
        artifact = await artifactStore.persist(
          request.runId,
          revision,
          workspace,
          snapshotName,
        );
        assertFrozenDigest(
          await provenSandbox.currentRevisionDigest(),
          revision,
        );
        store.recordArtifact(request.runId, request.lease, artifact);
      } finally {
        await workspace.cleanup();
      }

      if (!artifact) {
        throw new Error("Passing proof did not produce an artifact");
      }
      store.promoteVerificationSandbox(
        request.runId,
        request.lease,
        provenSandbox.id,
      );
      retainDeliverySandbox = true;
      return {
        passed: true,
        reasons: [],
        revision,
        artifact,
        verificationSandbox: provenSandbox,
      };
    } finally {
      if (source) {
        await source.cleanup().catch(() => undefined);
      }
      if (commandSandbox) {
        await disposeSandbox(commandSandbox).catch(() => undefined);
      }
      if (deliverySandbox && !retainDeliverySandbox) {
        await disposeSandbox(deliverySandbox).catch(() => undefined);
      }
    }
  }
}

async function sealDeliveryNetworkForProof(input: {
  runId: string;
  revision: FrozenRevision;
  sandbox: SandboxSession;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  await input.trace.child(
    "daytona.verifier.delivery.network-seal",
    "tool",
    {
      runId: input.runId,
      revisionHash: input.revision.sourceDigest,
      sandboxId: input.sandbox.id,
      networkBlockAll: true,
    },
    async (span) => {
      await input.sandbox.sealNetworkForProof(input.signal);
      span.log({
        output: {
          sandboxId: input.sandbox.id,
          purpose: "delivery",
          networkBlockAll: true,
        },
      });
    },
  );
}

async function createVerificationSandbox(input: {
  provider: SandboxProvider;
  runId: string;
  assignment: BuildAssignment;
  revision: FrozenRevision;
  source: ExportedWorkspace;
  purpose: VerificationSandboxPurpose;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}): Promise<SandboxSession> {
  return input.trace.child(
    `daytona.verifier.${input.purpose}.create`,
    "tool",
    {
      runId: input.runId,
      revisionHash: input.revision.sourceDigest,
      purpose: input.purpose,
    },
    async (span) => {
      const sandbox = await input.provider.createVerifier(
        input.runId,
        input.assignment,
        input.revision,
        input.source,
        input.purpose,
        input.signal,
      );
      span.log({
        output: {
          sandboxId: sandbox.id,
          purpose: input.purpose,
          hydratedFromFrozenExport: true,
        },
      });
      return sandbox;
    },
  );
}

async function disposeSandbox(sandbox: SandboxSession): Promise<void> {
  try {
    await sandbox.dispose();
  } catch (deleteError) {
    try {
      await sandbox.stop();
    } catch (stopError) {
      throw new AggregateError(
        [deleteError, stopError],
        `Could not dispose or stop sandbox ${sandbox.id}`,
        { cause: stopError },
      );
    }
  }
}

async function reviewRevision(input: {
  runId: string;
  revision: FrozenRevision;
  workspaceDirectory: string;
  contract: BuildAssignment["contract"];
  verificationContext: CodeReviewRequest["verificationContext"];
  reviewer: CodeReviewPort;
  trace: TraceSpan;
  signal?: AbortSignal | undefined;
}): Promise<ReviewReceipt> {
  const startedAt = new Date().toISOString();
  const expectedPolicyDigest = buildCodeRabbitPolicy(
    input.contract,
    input.verificationContext,
  ).digest;
  try {
    const workspaceInspection = await inspectReviewWorkspace(
      input.workspaceDirectory,
    );
    const expectedReviewedFiles = codeRabbitSemanticReviewFiles(
      workspaceInspection.files,
    );
    if (expectedReviewedFiles.length === 0) {
      throw new CodeRabbitEvidenceError("empty_review_scope");
    }
    const result = await input.trace.child(
      "coderabbit.review",
      "review",
      {
        runId: input.runId,
        revisionHash: input.revision.sourceDigest,
      },
      async (span) => {
        let providerResult: CodeReviewResult;
        try {
          providerResult = await input.reviewer.review(
            {
              runId: input.runId,
              revision: input.revision,
              workspaceDirectory: input.workspaceDirectory,
              contract: input.contract,
              verificationContext: input.verificationContext,
            },
            input.signal,
          );
        } catch (error) {
          if (input.signal?.aborted) {
            throw error;
          }
          throw new CodeRabbitEvidenceError("provider_failure");
        }
        const review = validateAndIntegrateCodeRabbitReview({
          result: providerResult,
          runId: input.runId,
          revision: input.revision,
          contract: input.contract,
          expectedPolicyDigest,
          expectedReviewedFiles,
        });
        span.log({
          output: {
            complete: review.complete,
            findingCount: review.findings.length,
            rawDigest: review.rawDigest,
            policyDigest: review.policyDigest,
            attestationDigest: review.expectedAttestationDigest,
            capabilityState: review.attestation.capabilityState,
            attempts: review.attestation.attempts,
            retryReasons: review.attestation.retryReasons,
            durationMs: review.attestation.durationMs,
            severityCounts: review.attestation.severityCounts,
            categoryCounts: review.attestation.categoryCounts,
            toolCoverage: review.attestation.toolCoverage,
            terminalState: review.attestation.terminalState,
          },
        });
        return review;
      },
    );
    const critical = result.findings.some(
      (finding) => finding.severity === "critical",
    );
    const completedAt = new Date().toISOString();
    return {
      ...createReceiptBase({
        runId: input.runId,
        revisionHash: input.revision.sourceDigest,
        status: result.complete ? (critical ? "FAIL" : "PASS") : "ERROR",
        startedAt,
        completedAt,
        input: {
          revisionHash: input.revision.sourceDigest,
          commitSha: input.revision.commitSha,
        },
        output: {
          complete: result.complete,
          findingCount: result.findings.length,
          rawDigest: result.rawDigest,
          policyDigest: result.policyDigest,
          expectedAttestationDigest: result.expectedAttestationDigest,
          severityCounts: result.attestation.severityCounts,
          categoryCounts: result.attestation.categoryCounts,
          retryReasons: result.attestation.retryReasons,
          toolCoverage: result.attestation.toolCoverage,
        },
      }),
      kind: "coderabbit",
      provider: "coderabbit",
      complete: result.complete,
      findings: result.findings,
      policyDigest: result.policyDigest,
      expectedPolicyDigest,
      attestation: result.attestation,
      expectedAttestationDigest: result.expectedAttestationDigest,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    const completedAt = new Date().toISOString();
    const failureCode =
      error instanceof CodeRabbitEvidenceError
        ? error.code
        : "integration_failure";
    const message = `CodeRabbit review failed closed (${failureCode})`;
    return {
      ...createReceiptBase({
        runId: input.runId,
        revisionHash: input.revision.sourceDigest,
        status: "ERROR",
        startedAt,
        completedAt,
        input: {
          revisionHash: input.revision.sourceDigest,
          commitSha: input.revision.commitSha,
        },
        output: { errorCode: failureCode },
      }),
      kind: "coderabbit",
      provider: "coderabbit",
      complete: false,
      findings: [],
      expectedPolicyDigest,
      error: boundText(message, 8_192),
    };
  }
}

interface IntegratedCodeRabbitReview extends CodeReviewResult {
  attestation: CodeRabbitReviewAttestation;
  expectedAttestationDigest: string;
}

class CodeRabbitEvidenceError extends Error {
  constructor(readonly code: string) {
    super(`CodeRabbit evidence validation failed (${code})`);
    this.name = "CodeRabbitEvidenceError";
  }
}

function validateAndIntegrateCodeRabbitReview(input: {
  result: CodeReviewResult;
  runId: string;
  revision: FrozenRevision;
  contract: BuildAssignment["contract"];
  expectedPolicyDigest: string;
  expectedReviewedFiles: readonly string[];
}): IntegratedCodeRabbitReview {
  const parsedFindings = ReviewFindingSchema.array()
    .max(500)
    .safeParse(input.result.findings);
  if (!parsedFindings.success) {
    throw new CodeRabbitEvidenceError("finding_schema");
  }
  const findings = parsedFindings.data;
  const parsedAttestation = CodeRabbitReviewAttestationSchema.safeParse(
    input.result.attestation,
  );
  if (!parsedAttestation.success) {
    throw new CodeRabbitEvidenceError("attestation_schema");
  }
  const attestation = parsedAttestation.data;

  requireCodeRabbitEvidence(
    input.result.complete,
    "nonterminal_authoritative_review",
  );
  requireCodeRabbitEvidence(
    attestation.reviewKind === "authoritative_full" &&
      attestation.capabilityState === "review-verified",
    "review_authority_state",
  );
  requireCodeRabbitEvidence(
    attestation.authorityKey ===
      digestJson({
        schemaVersion: 1,
        runId: input.runId,
        sourceDigest: input.revision.sourceDigest,
      }),
    "authority_key",
  );
  requireCodeRabbitEvidence(
    attestation.sourceDigest === input.revision.sourceDigest,
    "source_digest",
  );
  requireCodeRabbitEvidence(
    attestation.contractDigest === contractDigest(input.contract),
    "contract_digest",
  );
  requireCodeRabbitEvidence(
    attestation.reviewDigest === input.result.rawDigest,
    "review_digest",
  );
  requireCodeRabbitEvidence(
    attestation.findingSetDigest === digestJson(findings),
    "finding_set_digest",
  );
  requireCodeRabbitEvidence(
    attestation.reviewContextDigest === digestJson(attestation.reviewContext) &&
      attestation.scopeDigest === digestJson(attestation.scope),
    "review_scope_digest",
  );
  requireCodeRabbitEvidence(
    attestation.scope.reviewedFileCount ===
      input.expectedReviewedFiles.length &&
      attestation.scope.reviewedFilesDigest ===
        digestJson([...input.expectedReviewedFiles].sort(compareUtf8)) &&
      findings.every((finding) =>
        input.expectedReviewedFiles.includes(finding.fileName),
      ),
    "review_scope_files",
  );
  requireCodeRabbitEvidence(
    attestation.reviewContext.reviewType === "committed" &&
      attestation.reviewContext.currentBranch === "candidate" &&
      attestation.reviewContext.baseBranch === "main" &&
      attestation.scope.reviewKind === "authoritative_full" &&
      attestation.scope.reviewType === attestation.reviewContext.reviewType &&
      attestation.scope.currentBranch ===
        attestation.reviewContext.currentBranch &&
      attestation.scope.baseBranch === attestation.reviewContext.baseBranch &&
      attestation.scope.baseCommit === attestation.reviewContext.baseCommit &&
      attestation.scope.workingDirectoryDigest ===
        attestation.reviewContext.workingDirectoryDigest &&
      attestation.scope.reviewedFileCount > 0,
    "review_scope_evidence",
  );
  requireCodeRabbitEvidence(
    input.result.policyDigest === input.expectedPolicyDigest &&
      attestation.policyDigest === input.expectedPolicyDigest,
    "review_policy_digest",
  );
  requireCodeRabbitEvidence(
    attestation.policyPackVersion === CODERABBIT_POLICY_PACK_VERSION &&
      attestation.policyPackDigest === CODERABBIT_POLICY_PACK_DIGEST &&
      attestation.configSchemaDigest === CODERABBIT_CONFIG_SCHEMA_DIGEST &&
      attestation.configDigest === CODERABBIT_CONTROLLER_CONFIG_DIGEST &&
      attestation.rulesDigest === CODERABBIT_CONTROLLER_RULES_DIGEST &&
      attestation.toolPolicyDigest === CODERABBIT_TOOL_POLICY_DIGEST &&
      attestation.eventSchemaDigest === CODERABBIT_EVENT_SCHEMA_DIGEST,
    "controller_policy_pack",
  );
  requireCodeRabbitEvidence(
    attestation.reviewFlagsDigest ===
      digestJson(CODERABBIT_REQUIRED_REVIEW_FLAGS),
    "review_flags",
  );
  const cliVersion = attestation.cliVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  requireCodeRabbitEvidence(
    cliVersion.length === 3 && isSupportedCodeRabbitVersion(cliVersion),
    "cli_version",
  );
  requireCodeRabbitEvidence(
    attestation.cliExecutableDigestBefore ===
      attestation.cliExecutableDigestAfter &&
      attestation.cliExecutableDigestBefore ===
        attestation.capability.cliExecutableDigest,
    "cli_executable_digest",
  );
  requireCodeRabbitEvidence(
    attestation.capabilityDigest === digestJson(attestation.capability) &&
      attestation.capability.state === "healthy" &&
      attestation.capability.policyPackVersion ===
        CODERABBIT_POLICY_PACK_VERSION &&
      attestation.capability.policyPackDigest ===
        CODERABBIT_POLICY_PACK_DIGEST &&
      attestation.capability.cliVersion === attestation.cliVersion &&
      attestation.capability.reviewFlagsDigest ===
        digestJson(attestation.capability.reviewFlags) &&
      digestJson([...attestation.capability.reviewFlags].sort()) ===
        digestJson([...CODERABBIT_HANDSHAKE_REVIEW_FLAGS].sort()) &&
      digestJson([...attestation.capability.supportedEventKinds].sort()) ===
        digestJson([...CODERABBIT_SUPPORTED_EVENT_KINDS].sort()) &&
      attestation.capability.agentJsonl &&
      attestation.capability.authenticated &&
      attestation.capability.updatePolicy === "disabled-and-digest-pinned" &&
      attestation.capability.serviceConnectivity === "healthy" &&
      attestation.capability.controllerConfig === "supported" &&
      attestation.capability.toolSupport === "disabled-controller-policy" &&
      digestJson(attestation.capability.doctor) ===
        digestJson(attestation.doctor),
    "capability_digest",
  );
  requireCodeRabbitEvidence(
    attestation.updatePolicy === "disabled-and-digest-pinned" &&
      attestation.authentication === "authenticated" &&
      attestation.serviceConnectivity === "healthy" &&
      attestation.agentJsonl &&
      attestation.terminalState === "review_completed",
    "capability_claim",
  );
  requireCodeRabbitEvidence(
    attestation.doctor.passed === 8 &&
      attestation.doctor.warnings === 1 &&
      attestation.doctor.failed === 0 &&
      attestation.doctor.digest === CODERABBIT_DOCTOR_DIGEST,
    "doctor_result",
  );
  requireCodeRabbitEvidence(
    attestation.eventCounts.reviewContext === 1 &&
      attestation.eventCounts.status >= 1 &&
      attestation.eventCounts.finding === findings.length &&
      attestation.eventCounts.complete === 1 &&
      attestation.eventCounts.error === 0,
    "event_counts",
  );
  requireCodeRabbitEvidence(
    attestation.attempts === attestation.retryReasons.length + 1,
    "retry_attestation",
  );
  requireCodeRabbitEvidence(
    digestJson([...attestation.configuredTools].sort()) ===
      digestJson([...CODERABBIT_TOOL_POLICY.configuredTools].sort()) &&
      attestation.observedTools.length === 0 &&
      attestation.toolCoverage === "disabled-controller-policy",
    "tool_policy",
  );

  for (const finding of findings) {
    const classification = classifyCodeRabbitFinding(finding);
    requireCodeRabbitEvidence(
      finding.severity === classification.severity &&
        finding.category === classification.category &&
        finding.governingInvariant === classification.governingInvariant &&
        finding.controllerRuleId === classification.ruleId,
      "finding_classification",
    );
  }
  requireCodeRabbitEvidence(
    digestJson(attestation.severityCounts) ===
      digestJson(countReviewSeverities(findings)),
    "severity_counts",
  );
  requireCodeRabbitEvidence(
    digestJson(sortedCategoryCounts(attestation.categoryCounts)) ===
      digestJson(
        sortedCategoryCounts(
          countReviewCategories(
            findings.map((finding) => finding.category ?? "code-quality"),
          ),
        ),
      ),
    "category_counts",
  );

  const integratedAttestation = CodeRabbitReviewAttestationSchema.parse({
    ...attestation,
    capabilityState: "proof-integrated",
  });
  return {
    ...input.result,
    findings,
    attestation: integratedAttestation,
    expectedAttestationDigest: sha256(canonicalJson(integratedAttestation)),
  };
}

function requireCodeRabbitEvidence(
  condition: boolean,
  code: string,
): asserts condition {
  if (!condition) {
    throw new CodeRabbitEvidenceError(code);
  }
}

function countReviewSeverities(
  findings: CodeReviewResult["findings"],
): CodeRabbitReviewAttestation["severityCounts"] {
  const counts: CodeRabbitReviewAttestation["severityCounts"] = {
    critical: 0,
    major: 0,
    minor: 0,
    trivial: 0,
    info: 0,
  };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

function countReviewCategories(
  categories: string[],
): CodeRabbitReviewAttestation["categoryCounts"] {
  const counts = new Map<string, number>();
  for (const category of categories) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({
    category,
    count,
  }));
}

function sortedCategoryCounts(
  counts: CodeRabbitReviewAttestation["categoryCounts"],
): CodeRabbitReviewAttestation["categoryCounts"] {
  return [...counts].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.category, "utf8"),
      Buffer.from(right.category, "utf8"),
    ),
  );
}

function recordEvidence(
  store: RunStore,
  runId: string,
  lease: SlotLease,
  receipts: EvidenceReceipt[],
): void {
  for (const receipt of receipts) {
    store.addEvidence(runId, lease, receipt);
  }
}

function indexAuthoritativeReviews(
  receipts: EvidenceReceipt[],
): AuthoritativeReviewLedger {
  const ledger: AuthoritativeReviewLedger = new Map();
  for (const receipt of receipts) {
    if (
      receipt.kind !== "coderabbit" ||
      receipt.attestation?.reviewKind === "advisory_light"
    ) {
      continue;
    }
    const reviews = ledger.get(receipt.revisionHash) ?? [];
    reviews.push(receipt);
    ledger.set(receipt.revisionHash, reviews);
  }
  return ledger;
}

function latestLedgerReview(
  ledger: AuthoritativeReviewLedger,
): ReviewReceipt | undefined {
  return [...ledger.values()].flat().at(-1);
}

async function traceReviewReuse(
  trace: TraceSpan,
  runId: string,
  sourceDigest: string,
  receiptCount: number,
  findingCount: number,
): Promise<void> {
  await trace.child(
    "coderabbit.review.reuse",
    "function",
    {
      runId,
      revisionHash: sourceDigest,
      authorityKey: digestJson({
        schemaVersion: 1,
        runId,
        sourceDigest,
      }),
      receiptCount,
    },
    (span) => {
      span.log({
        output: {
          providerCalled: false,
          terminalState:
            receiptCount === 1 ? "authoritative_review_reused" : "collision",
          repairYield: {
            sourceChanged: false,
            findingCount,
          },
        },
      });
      return Promise.resolve();
    },
  );
}

async function traceRepairYield(
  trace: TraceSpan,
  runId: string,
  previous: ReviewReceipt,
  current: ReviewReceipt,
): Promise<void> {
  const previousCounts = countReviewSeverities(previous.findings);
  const currentCounts = countReviewSeverities(current.findings);
  await trace.child(
    "coderabbit.repair.yield",
    "function",
    {
      runId,
      previousSourceDigest: previous.revisionHash,
      currentSourceDigest: current.revisionHash,
    },
    (span) => {
      span.log({
        output: {
          sourceChanged: previous.revisionHash !== current.revisionHash,
          previousFindingCount: previous.findings.length,
          currentFindingCount: current.findings.length,
          netResolvedFindings: Math.max(
            0,
            previous.findings.length - current.findings.length,
          ),
          previousSeverityCounts: previousCounts,
          currentSeverityCounts: currentCounts,
          terminalState:
            current.attestation?.terminalState ??
            (current.complete ? "unattested_complete" : "failed_closed"),
        },
      });
      return Promise.resolve();
    },
  );
}

function reviewFeedback(receipt: ReviewReceipt): string[] {
  if (!receipt.complete) {
    return ["CodeRabbit authoritative review did not complete"];
  }
  const counts = countReviewSeverities(receipt.findings);
  const actionableCount = counts.critical + counts.major + counts.minor;
  return actionableCount === 0
    ? []
    : [
        `CodeRabbit authoritative review reported ${String(actionableCount)} actionable finding(s): ${String(counts.critical)} critical, ${String(counts.major)} major, ${String(counts.minor)} minor`,
      ];
}

function createCodeRabbitRepairBriefs(
  receipt: ReviewReceipt,
): CodeRabbitRepairBrief[] {
  if (
    !receipt.complete ||
    receipt.attestation?.reviewKind !== "authoritative_full" ||
    receipt.attestation.capabilityState !== "proof-integrated" ||
    !receipt.policyDigest ||
    receipt.policyDigest !== receipt.expectedPolicyDigest ||
    receipt.expectedAttestationDigest !==
      sha256(canonicalJson(receipt.attestation))
  ) {
    return [];
  }
  const attestation = receipt.attestation;

  return receipt.findings
    .filter((finding) =>
      ["critical", "major", "minor"].includes(finding.severity),
    )
    .slice(0, 20)
    .map((finding) => {
      const classification = classifyCodeRabbitFinding(finding);
      const remediation = finding.codegenInstructions
        ? boundText(finding.codegenInstructions, 4_000)
        : finding.suggestions && finding.suggestions.length > 0
          ? boundText(finding.suggestions.join("\n"), 4_000)
          : undefined;
      const hasValidRange =
        finding.startLine !== undefined &&
        finding.endLine !== undefined &&
        finding.endLine >= finding.startLine;
      return CodeRabbitRepairBriefSchema.parse({
        schemaVersion: 1,
        findingDigest: digestJson(finding),
        fileName: finding.fileName,
        range: hasValidRange
          ? {
              startLine: finding.startLine,
              endLine: finding.endLine,
            }
          : null,
        severity: classification.severity,
        category: classification.category,
        governingInvariant: classification.governingInvariant,
        ...(classification.ruleId
          ? { controllerRuleId: classification.ruleId }
          : {}),
        controllerPolicyVersion: CODERABBIT_POLICY_PACK_VERSION,
        controllerPolicyDigest: receipt.policyDigest,
        reviewDigest: attestation.reviewDigest,
        sourceDigest: receipt.revisionHash,
        untrustedSummary: boundText(finding.message, 4_000),
        ...(remediation ? { untrustedRemediation: remediation } : {}),
      });
    });
}

interface ClassifiedFeedback {
  terminal: string[];
  actionable: string[];
}

const EMPTY_CLASSIFIED_FEEDBACK: ClassifiedFeedback = {
  terminal: [],
  actionable: [],
};
const MAX_CLASSIFIED_FEEDBACK_ITEMS = 20;
const OPERATIONAL_RASTER_ERROR_CODES = new Set<
  NonNullable<RasterClaimReceipt["errorCode"]>
>([
  "aborted",
  "model_capability_unavailable",
  "model_response_invalid",
  "policy_bound_exceeded",
  "provider_error",
  "workspace_read_failed",
]);
const OPERATIONAL_PREVIEW_ERROR_PREFIXES = [
  "Rendered-page baseline recapture dimensions changed",
  "Rendered-page probe did not restore the exact pixel baseline",
  "Rendered-page screenshot is not a PNG",
  "Rendered-page screenshot has ",
  "Rendered-page screenshots have unexpected dimensions",
  "Protocol error ",
  "Target page, context or browser has been closed",
  "browser.newContext:",
  "browser.newPage:",
  "browserType.launch:",
  "cdpSession.",
  "page.screenshot:",
] as const;

function classifyRasterFeedback(
  receipt: RasterClaimReceipt,
): ClassifiedFeedback {
  if (receipt.status === "PASS") {
    return EMPTY_CLASSIFIED_FEEDBACK;
  }

  const terminal: string[] = [];
  const candidate: string[] = [];
  if (receipt.errorCode) {
    terminal.push(
      `Raster claim inspection did not complete (${receipt.errorCode})`,
    );
  }
  for (const match of receipt.matches) {
    candidate.push(
      `${rasterAssetLabel(receipt, match.assetIndex)} matches forbidden claim index(es) ${match.forbiddenClaimIndices.join(", ")}; remove the unsupported claim from the candidate`,
    );
  }
  for (const assetIndex of receipt.unsupportedAssetIndices) {
    candidate.push(
      `${rasterAssetLabel(receipt, assetIndex)} contains an assertion not supported by the approved business facts; replace or remove it`,
    );
  }
  for (const assetIndex of receipt.unverifiedAssetIndices) {
    candidate.push(
      `${rasterAssetLabel(receipt, assetIndex)} could not be conclusively inspected; replace or remove rasterized text so the claim can be verified`,
    );
  }

  const operational =
    receipt.errorCode !== undefined &&
    OPERATIONAL_RASTER_ERROR_CODES.has(receipt.errorCode);
  if (!operational && candidate.length === 0) {
    candidate.push(
      `Candidate raster assets failed inspection (${receipt.errorCode ?? receipt.status}); replace invalid, unsupported, oversized, or multi-frame raster assets`,
    );
  }
  return {
    terminal: limitClassifiedFeedback([...terminal, ...candidate], "raster"),
    actionable: operational ? [] : limitClassifiedFeedback(candidate, "raster"),
  };
}

function rasterAssetLabel(
  receipt: RasterClaimReceipt,
  assetIndex: number,
): string {
  return assetIndex < receipt.workspaceAssetCount
    ? `Workspace raster asset ${assetIndex}`
    : `Rendered screenshot asset ${assetIndex - receipt.workspaceAssetCount}`;
}

function classifyPreviewFeedback(
  receipt: PreviewReceipt,
  contract: BuildAssignment["contract"],
): ClassifiedFeedback {
  if (receipt.status === "PASS") {
    return EMPTY_CLASSIFIED_FEEDBACK;
  }
  const hardRequirementIds = new Set(
    contract.requirements
      .filter((requirement) => requirement.priority === "hard")
      .map((requirement) => requirement.id),
  );
  const terminal: string[] = [];
  const actionable: string[] = [];

  for (const check of receipt.checks) {
    const label = previewCheckLabel(check);
    const blocking =
      check.discovered === true ||
      check.requirementId === undefined ||
      hardRequirementIds.has(check.requirementId);
    const forbiddenClaimIndices = check.forbiddenClaimIndices ?? [];
    if (forbiddenClaimIndices.length > 0) {
      const message = `${label} contains forbidden claim index(es) ${forbiddenClaimIndices.join(", ")}`;
      terminal.push(message);
      actionable.push(message);
    }
    if (!blocking) {
      continue;
    }
    if (check.error) {
      const message = `${label} failed: ${boundText(check.error, 1_500)}`;
      terminal.push(message);
      if (!isOperationalPreviewError(check.error)) {
        actionable.push(message);
      }
      continue;
    }
    if (check.actualStatus !== check.expectedStatus) {
      const message = `${label} expected HTTP ${check.expectedStatus} but received ${String(check.actualStatus)}`;
      terminal.push(message);
      actionable.push(message);
    }
    if (check.missingText.length > 0) {
      const message = `${label} is missing required visible text: ${boundedMissingText(check.missingText)}`;
      terminal.push(message);
      actionable.push(message);
    }
  }

  return {
    terminal: limitClassifiedFeedback(terminal, "preview"),
    actionable: limitClassifiedFeedback(actionable, "preview"),
  };
}

function previewCheckLabel(check: PreviewReceipt["checks"][number]): string {
  const path = boundText(check.path, 500);
  if (check.discovered) {
    return `Discovered rendered route ${path}`;
  }
  if (check.requirementId !== undefined) {
    return `Rendered preview ${path} for requirement ${boundText(check.requirementId, 300)} verifier ${String(check.verifierIndex)}`;
  }
  return `Rendered preview ${path}`;
}

function boundedMissingText(values: string[]): string {
  const shown = values
    .slice(0, 5)
    .map((value) => JSON.stringify(boundText(value, 240)))
    .join(", ");
  return values.length > 5
    ? `${shown} (${values.length - 5} additional value(s) omitted)`
    : shown;
}

function isOperationalPreviewError(error: string): boolean {
  return OPERATIONAL_PREVIEW_ERROR_PREFIXES.some((prefix) =>
    error.startsWith(prefix),
  );
}

function limitClassifiedFeedback(
  feedback: string[],
  kind: "preview" | "raster",
): string[] {
  const unique = [...new Set(feedback.map((item) => boundText(item, 2_000)))];
  if (unique.length <= MAX_CLASSIFIED_FEEDBACK_ITEMS) {
    return unique;
  }
  return [
    ...unique.slice(0, MAX_CLASSIFIED_FEEDBACK_ITEMS),
    `${unique.length - MAX_CLASSIFIED_FEEDBACK_ITEMS} additional ${kind} diagnostic(s) omitted`,
  ];
}

function evaluationFeedback(receipt: EvaluationReceipt): string[] {
  return [
    ...receipt.requirements
      .filter((result) => result.status !== "PASS")
      .map(
        (result) =>
          `Requirement ${result.requirementId} is ${result.status}: ${result.explanation}`,
      ),
    ...receipt.unsupportedClaims.map(
      (claim) =>
        `Unsupported claim in ${claim.location}: ${claim.claim} (${claim.reason})`,
    ),
  ];
}

function commandFeedback(receipts: EvidenceReceipt[]): string[] {
  return receipts.flatMap((receipt) => {
    if (
      (receipt.kind === "artifact" ||
        receipt.kind === "build" ||
        receipt.kind === "container-build" ||
        receipt.kind === "dependency-bootstrap" ||
        receipt.kind === "forbidden-claim" ||
        receipt.kind === "test" ||
        receipt.kind === "requirement-command") &&
      receipt.status !== "PASS"
    ) {
      return [
        `${receipt.kind} command failed: ${receipt.command}\n${receipt.stderr || receipt.stdout}`,
      ];
    }
    return [];
  });
}

function requireAssignment(store: RunStore, runId: string): BuildAssignment {
  const assignment = store.getAssignment(runId);
  if (!assignment) {
    throw new Error(`Assignment is missing for run ${runId}`);
  }
  return assignment;
}

function ensureActive(
  store: RunStore,
  runId: string,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Build run aborted");
  }
  const run = store.getRun(runId);
  if (!run || run.cancelRequested) {
    throw new Error("Build run cancelled");
  }
}

function assertFrozenDigest(
  actualDigest: string,
  revision: FrozenRevision,
): void {
  if (actualDigest !== revision.sourceDigest) {
    throw new Error(
      `Frozen revision integrity check failed (${sha256(actualDigest).slice(0, 12)})`,
    );
  }
}

function bindRevisionToControllerSource(
  builderRevision: FrozenRevision,
  source: ExportedWorkspace,
): FrozenRevision {
  if (!/^[a-f0-9]{64}$/.test(source.contentDigest)) {
    throw new Error("Controller source content digest is invalid");
  }
  return {
    sourceDigest: source.contentDigest,
    commitSha: builderRevision.commitSha,
    frozenAt: builderRevision.frozenAt,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "aborted";
    }
    return (
      error.name
        .replace(/Error$/, "")
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replaceAll(/[^A-Za-z0-9]+/g, "_")
        .toLowerCase() || "build_run_failed"
    );
  }
  return "build_run_failed";
}

function snapshotNameFor(runId: string, revision: FrozenRevision): string {
  return `buildlabs-${runId.slice(0, 8)}-${revision.sourceDigest.slice(0, 12)}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Build run aborted");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Build run aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(
          error instanceof Error
            ? error
            : new Error("Build run operation failed"),
        );
      },
    );
  });
}

function flushTraceBestEffort(trace: TracePort): void {
  void Promise.resolve()
    .then(() => trace.flush())
    .catch(() => undefined);
}
