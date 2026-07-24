import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteRunStore } from "../src/adapters/sqlite/run-store.js";
import { buildCodeRabbitPolicy } from "../src/adapters/coderabbit/coderabbit-cli.js";
import { BuildRunExecutor } from "../src/application/build-run-executor.js";
import { BuildScheduler } from "../src/application/build-scheduler.js";
import { DEPENDENCY_BOOTSTRAP_COMMAND } from "../src/application/dependency-bootstrap.js";
import type { ProvenArtifact } from "../src/domain/artifact.js";
import type { FrozenRevision } from "../src/domain/run.js";
import { sha256 } from "../src/lib/canonical-json.js";
import {
  RasterClaimInspectionError,
  type AgentMessage,
  type AgentToolDefinition,
  type ArtifactStore,
  type CodeReviewPort,
  type CodeReviewRequest,
  type CodeReviewResult,
  type ContractEvaluationInput,
  type ContractEvaluationOutput,
  type ExportedWorkspace,
  type ModelPort,
  type ModelTurn,
  type PreviewTarget,
  type RasterClaimInspectionInput,
  type RasterClaimInspectionOutput,
  type SandboxFile,
  type SandboxProvider,
  type SandboxSession,
  type TracePort,
  type TraceSpan,
} from "../src/ports/index.js";
import { artifact, assignment } from "./fixtures.js";

const RASTER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("BuildRunExecutor", () => {
  let webServer: Server;
  let previewUrl: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    webServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<main>Mission Peak Electric</main>");
    });
    await new Promise<void>((resolve) => {
      webServer.listen(0, "127.0.0.1", resolve);
    });
    const address = webServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Test preview server did not bind");
    }
    previewUrl = `http://127.0.0.1:${address.port}`;
    store = new SqliteRunStore({ path: ":memory:", slotCount: 4 });
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve, reject) => {
      webServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it("publishes only an exact-revision, Dockerized, fully proven candidate", async () => {
    const input = assignment("executor-pass");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    const artifactStore = new FakeArtifactStore();
    const trace = new TestTrace();
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      trace,
      artifactStore,
    );

    await executor.execute(run.id, lease);

    const finalRun = store.getRun(run.id);
    const delivery = provider.verifiers.find(
      (sandbox) => sandbox.role === "delivery",
    )!;
    expect(finalRun).toMatchObject({
      status: "passed",
      builderSandboxId: builder.id,
      verificationSandboxId: delivery.id,
      sandboxId: delivery.id,
    });
    expect(store.getArtifact(run.id)).toMatchObject({
      runId: run.id,
      revisionHash: builder.controllerContentDigest,
      dockerfilePath: "Dockerfile",
    });
    expect(builder.disposeCalls).toBe(1);
    expect(
      provider.verifiers.find((sandbox) => sandbox.role === "commands")
        ?.disposeCalls,
    ).toBe(1);
    const commandVerifier = provider.verifiers.find(
      (sandbox) => sandbox.role === "commands",
    )!;
    expect(commandVerifier.commands[1]).toBe(DEPENDENCY_BOOTSTRAP_COMMAND);
    expect(
      store
        .listEvidence(run.id)
        .find((receipt) => receipt.kind === "dependency-bootstrap"),
    ).toMatchObject({
      status: "PASS",
      command: DEPENDENCY_BOOTSTRAP_COMMAND,
    });
    expect(delivery.disposeCalls).toBe(0);
    expect(artifactStore.persistedRoles).toEqual(["delivery"]);
    expect(store.listOutbox(10)).toHaveLength(1);
    expect(store.listOutbox(10)[0]?.payload.sandboxId).toBe(delivery.id);
    expect(delivery.proofOperations).toEqual([
      "container-build",
      "network-seal",
      "container-preview",
      "rendered-inspection",
      "snapshot",
      "network-seal-reapplied",
      "container-preview",
    ]);
    expect(delivery.networkSealCalls).toBe(2);
    expect(delivery.networkSealed).toBe(true);
    expect(trace.childNames).toContain(
      "daytona.verifier.delivery.network-seal",
    );
    expect(
      store
        .listEvents(run.id, 0)
        .filter((event) => event.type === "agent.tool_completed"),
    ).toEqual([
      expect.objectContaining({
        payload: {
          step: 1,
          repairRound: 0,
          toolName: "start_preview",
          ok: true,
        },
      }),
      expect.objectContaining({
        payload: {
          step: 1,
          repairRound: 0,
          toolName: "finish",
          ok: true,
        },
      }),
    ]);
  });

  it("persists and proves visual claim evidence for a zero-claim contract", async () => {
    const input = assignment("executor-zero-claims");
    input.contract.forbiddenClaims = [];
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    expect(
      store
        .listEvidence(run.id)
        .find((receipt) => receipt.kind === "visual-claim"),
    ).toMatchObject({
      kind: "visual-claim",
      status: "PASS",
      forbiddenClaimIndices: [],
      provider: "fireworks",
      renderedAssetCount: 1,
    });
    expect(
      store
        .listEvidence(run.id)
        .some((receipt) => receipt.kind === "forbidden-claim"),
    ).toBe(false);
  });

  it("binds proof to controller-held bytes instead of a forged builder identity", async () => {
    const input = assignment("executor-controller-content-binding");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const forgedDigest = sha256("attacker-controlled manifest");
    const controllerBytes = Buffer.from(
      "controller-downloaded and validated source bytes\n",
    );
    const builder = new FakeSandbox(
      "sandbox-builder",
      "builder",
      previewUrl,
      {
        sourceDigest: forgedDigest,
        commitSha: "9".repeat(40),
        frozenAt: "2026-07-23T12:00:00.000Z",
      },
      controllerBytes,
    );
    const provider = new FakeSandboxProvider(builder);
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    const expectedRevision = sha256(controllerBytes);
    expect(expectedRevision).not.toBe(forgedDigest);
    expect(store.getRun(run.id)).toMatchObject({
      status: "passed",
      revisionHash: expectedRevision,
    });
    expect(store.getArtifact(run.id)?.revisionHash).toBe(expectedRevision);
    expect(
      store
        .listEvidence(run.id)
        .every((receipt) => receipt.revisionHash === expectedRevision),
    ).toBe(true);
    expect(
      provider.verifiers.every(
        (sandbox) =>
          sandbox.revision.sourceDigest === expectedRevision &&
          sandbox.revision.commitSha === builder.revision.commitSha &&
          sandbox.revision.frozenAt === builder.revision.frozenAt,
      ),
    ).toBe(true);
    expect(store.listOutbox(10)[0]?.revisionHash).toBe(expectedRevision);
  });

  it("fails closed before candidate commands when frozen dependencies cannot be restored", async () => {
    const input = assignment("executor-dependency-bootstrap");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.failDependencyBootstrap = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    const commandVerifier = provider.verifiers.find(
      (sandbox) => sandbox.role === "commands",
    )!;
    expect(store.getRun(run.id)).toMatchObject({
      status: "rejected",
      errorCode: "proof_gate_rejected",
    });
    expect(commandVerifier.commands).toHaveLength(2);
    expect(commandVerifier.commands[1]).toBe(DEPENDENCY_BOOTSTRAP_COMMAND);
    expect(
      store
        .listEvidence(run.id)
        .find((receipt) => receipt.kind === "dependency-bootstrap"),
    ).toMatchObject({ status: "FAIL", exitCode: 65 });
    expect(
      store
        .listEvidence(run.id)
        .some((receipt) => receipt.kind === "build" || receipt.kind === "test"),
    ).toBe(false);
  });

  it("fails closed if controller-held source is raced between verifier hydrations", async () => {
    const input = assignment("executor-controller-source-race");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.tamperSourceAfterCommandHydration = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      errorCode: "build_run_failed",
    });
    expect(provider.verifiers).toHaveLength(1);
    expect(provider.verifiers[0]).toMatchObject({
      role: "commands",
      disposeCalls: 1,
    });
    expect(builder.disposeCalls).toBe(1);
    expect(store.getArtifact(run.id)).toBeUndefined();
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("stops a disposable verifier when Daytona deletion fails", async () => {
    const input = assignment("executor-verifier-delete-fallback");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.failCommandDisposal = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    const commandVerifier = provider.verifiers.find(
      (sandbox) => sandbox.role === "commands",
    )!;
    expect(commandVerifier.disposeCalls).toBe(1);
    expect(commandVerifier.stopCalls).toBe(1);
  });

  it("rejects evidence when delivery-verifier source mutates after hydration", async () => {
    const input = assignment("executor-dirty");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.dirtyDeliveryAfterFirstIntegrityCheck = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    const finalRun = store.getRun(run.id);
    expect(finalRun).toMatchObject({
      status: "rejected",
      errorCode: "proof_gate_rejected",
    });
    expect(
      provider.verifiers.every((sandbox) => sandbox.disposeCalls === 1),
    ).toBe(true);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("fails closed when CodeRabbit cannot complete", async () => {
    const input = assignment("executor-review-error");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    const executor = makeExecutor(provider, new FailingReviewer());

    await executor.execute(run.id, lease);

    const finalRun = store.getRun(run.id);
    expect(finalRun?.status).toBe("rejected");
    const review = store
      .listEvidence(run.id)
      .find((receipt) => receipt.kind === "coderabbit");
    expect(review).toMatchObject({ status: "ERROR", complete: false });
    expect(
      provider.verifiers.every((sandbox) => sandbox.disposeCalls === 1),
    ).toBe(true);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("does not spend a repair round on an operational CodeRabbit failure", async () => {
    const input = assignment("executor-review-operational-error");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const reviewer = new FailingReviewer(
      "Rate limit exceeded; CodeRabbit did not emit a completion event",
    );
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      reviewer,
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("rejected");
    expect(reviewer.calls).toBe(1);
    expect(model.userPrompts).toHaveLength(1);
    expect(provider.verifiers).toHaveLength(2);
    expect(
      store
        .listEvidence(run.id)
        .find((receipt) => receipt.kind === "coderabbit"),
    ).toMatchObject({
      status: "ERROR",
      complete: false,
      error: "Rate limit exceeded; CodeRabbit did not emit a completion event",
    });
  });

  it("repairs independent code failures without forwarding CodeRabbit operational errors", async () => {
    const input = assignment("executor-code-and-review-errors");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const reviewer = new FailingReviewer(
      "Rate limit exceeded; CodeRabbit did not emit a completion event",
    );
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    provider.failDependencyBootstrap = true;
    const executor = makeExecutor(
      provider,
      reviewer,
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("rejected");
    expect(reviewer.calls).toBe(2);
    expect(model.userPrompts).toHaveLength(2);
    expect(model.userPrompts[1]).toContain(
      "dependency-bootstrap command failed",
    );
    expect(model.userPrompts[1]).not.toContain("Rate limit exceeded");
    expect(model.userPrompts[1]).not.toContain(
      "CodeRabbit did not emit a completion event",
    );
    expect(provider.verifiers).toHaveLength(4);
  });

  it("does not trust complete CodeRabbit findings with an unbound policy", async () => {
    const input = assignment("executor-review-policy-unbound");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const reviewer = new UnboundFindingsReviewer();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      reviewer,
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "rejected",
      errorCode: "proof_gate_rejected",
    });
    expect(store.getRun(run.id)?.errorMessage).toContain(
      "CodeRabbit review policy digest does not match the controller policy",
    );
    expect(reviewer.calls).toBe(1);
    expect(model.userPrompts).toHaveLength(1);
    expect(provider.verifiers).toHaveLength(2);
  });

  it.each([
    ["provider error", "provider_error"],
    ["missing capability", "model_capability_unavailable"],
    ["malformed response", "model_response_invalid"],
  ] as const)(
    "does not spend a source repair on a raster %s",
    async (_label, errorCode) => {
      const input = assignment(`executor-raster-${errorCode}`);
      input.limits.maxRepairRounds = 1;
      const run = store.createRun(input).run;
      const lease = store.acquireSlot(run.id, 30_000)!;
      const model = operationalRasterModel(errorCode);
      const provider = new FakeSandboxProvider(
        new FakeSandbox("sandbox-builder", "builder", previewUrl),
      );
      const executor = makeExecutor(
        provider,
        new PassingReviewer(),
        new TestTrace(),
        new FakeArtifactStore(),
        model,
      );

      await executor.execute(run.id, lease);

      expect(store.getRun(run.id)).toMatchObject({
        status: "rejected",
        errorCode: "proof_gate_rejected",
      });
      expect(store.getRun(run.id)?.errorMessage).toContain(
        `Raster claim inspection did not complete (${errorCode})`,
      );
      expect(model.userPrompts).toHaveLength(1);
      expect(provider.verifiers).toHaveLength(2);
    },
  );

  it("repairs a candidate raster claim failure with bounded asset feedback", async () => {
    const input = assignment("executor-raster-candidate-repair");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new RepairingRasterModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    expect(model.userPrompts).toHaveLength(2);
    expect(model.userPrompts[1]).toContain(
      "Rendered screenshot asset 0 matches forbidden claim index(es) 0",
    );
    expect(provider.verifiers).toHaveLength(4);
  });

  it("does not trust malformed Fireworks evaluation guidance as repair input", async () => {
    const input = assignment("executor-evaluation-malformed");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new MalformedEvaluationModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "rejected",
      errorCode: "proof_gate_rejected",
    });
    expect(store.getRun(run.id)?.errorMessage).toContain(
      "Contract evaluation did not pass (ERROR)",
    );
    expect(store.getRun(run.id)?.errorMessage).not.toContain(
      "UNTRUSTED EVALUATOR GUIDANCE",
    );
    expect(model.userPrompts).toHaveLength(1);
    expect(provider.verifiers).toHaveLength(2);
  });

  it("repairs a structurally valid Fireworks hard-requirement failure", async () => {
    const input = assignment("executor-evaluation-candidate-repair");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new RepairingEvaluationModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    expect(model.userPrompts).toHaveLength(2);
    expect(model.userPrompts[1]).toContain(
      "Requirement homepage is FAIL: Candidate homepage hierarchy is incomplete.",
    );
    expect(provider.verifiers).toHaveLength(4);
  });

  it("does not spend a repair round on pixel-probe infrastructure failure", async () => {
    const input = assignment("executor-preview-pixel-probe");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    provider.renderedInspectionError =
      "Rendered-page probe did not restore the exact pixel baseline (captures=5,baselineMatches=0)";
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "rejected",
      errorCode: "proof_gate_rejected",
    });
    expect(store.getRun(run.id)?.errorMessage).toContain(
      "Rendered-page probe did not restore the exact pixel baseline",
    );
    expect(model.userPrompts).toHaveLength(1);
    expect(provider.verifiers).toHaveLength(2);
  });

  it("surfaces candidate renderer errors to the repair agent", async () => {
    const input = assignment("executor-preview-candidate-error");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    provider.renderedInspectionError =
      "Rendered-page interaction attempted blocked network access (http)";
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("rejected");
    expect(model.userPrompts).toHaveLength(2);
    expect(model.userPrompts[1]).toContain(
      "Rendered-page interaction attempted blocked network access (http)",
    );
    expect(provider.verifiers).toHaveLength(4);
  });

  it("surfaces exact missing rendered text to the repair agent", async () => {
    const input = assignment("executor-preview-missing-text");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const model = new PassingModel();
    const provider = new FakeSandboxProvider(
      new FakeSandbox("sandbox-builder", "builder", previewUrl),
    );
    provider.renderedVisibleText = "A different business";
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("rejected");
    expect(model.userPrompts).toHaveLength(2);
    expect(model.userPrompts[1]).toContain(
      'is missing required visible text: "Mission Peak Electric"',
    );
    expect(provider.verifiers).toHaveLength(4);
  });

  it("does not publish when the Braintrust trace cannot be flushed", async () => {
    const input = assignment("executor-trace-flush");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new FailingFlushTrace(),
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      errorCode: "build_run_failed",
    });
    expect(builder.disposeCalls).toBe(1);
    expect(
      provider.verifiers.every((sandbox) => sandbox.disposeCalls === 1),
    ).toBe(true);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("releases the slot when cancellation and shutdown interrupt a hanging trace flush", async () => {
    const input = assignment("executor-hanging-trace-flush");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const trace = new HangingFlushTrace();
    const executor = makeExecutor(
      new FakeSandboxProvider(builder),
      new PassingReviewer(),
      trace,
    );
    const scheduler = new BuildScheduler(store, executor, {
      leaseMilliseconds: 30_000,
      pollMilliseconds: 5,
    });

    scheduler.start();
    await waitUntil(() => trace.flushCalls === 1, 2_000);
    scheduler.cancel(run.id);
    await settleWithin(scheduler.stop(), 500);

    expect(scheduler.activeCount).toBe(0);
    expect(store.getRun(run.id)?.status).toBe("cancelled");
    expect(builder.disposeCalls).toBe(1);
    const next = store.createRun(assignment("executor-released-slot")).run;
    expect(store.acquireSlot(next.id, 30_000)?.slotId).toBe(1);
  });

  it("repairs actionable noncritical CodeRabbit findings when budget remains", async () => {
    const input = assignment("executor-review-repair");
    input.limits.maxRepairRounds = 1;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const reviewer = new RepairingReviewer();
    const model = new PassingModel();
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    const executor = makeExecutor(
      provider,
      reviewer,
      new TestTrace(),
      new FakeArtifactStore(),
      model,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    expect(reviewer.calls).toBe(2);
    expect(model.userPrompts[1]).toContain("Add an aria-live error summary.");
    expect(provider.verifiers).toHaveLength(4);
    expect(
      provider.verifiers.filter((sandbox) => sandbox.disposeCalls === 1),
    ).toHaveLength(3);
  });

  it("keeps poisoned builder state out of every proof surface", async () => {
    const input = assignment("executor-isolated-verifier");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    builder.rejectVerificationCommands = true;
    const provider = new FakeSandboxProvider(builder);
    const reviewer = new PassingReviewer();
    const artifactStore = new FakeArtifactStore();
    const executor = makeExecutor(
      provider,
      reviewer,
      new TestTrace(),
      artifactStore,
    );

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("passed");
    expect(
      builder.commands.some(
        (command) =>
          command.includes("npm run build") || command.includes("docker build"),
      ),
    ).toBe(false);
    expect(builder.containerPreviewCalls).toBe(0);
    expect(builder.snapshotCalls).toBe(0);
    expect(reviewer.reviewedRoles).toEqual(["delivery"]);
    expect(artifactStore.persistedRoles).toEqual(["delivery"]);
  });

  it("fails closed when a provider reuses the builder as a verifier", async () => {
    const input = assignment("executor-reused-builder");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.reuseBuilderForCommands = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      errorCode: "build_run_failed",
    });
    expect(builder.disposeCalls).toBe(1);
    expect(provider.verifiers).toHaveLength(0);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("rejects a Dockerfile that depends on ignored host build output", async () => {
    const input = assignment("executor-clean-container-context");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.deliveryRequiresGeneratedDist = true;
    const executor = makeExecutor(provider, new PassingReviewer());

    await executor.execute(run.id, lease);

    expect(store.getRun(run.id)?.status).toBe("rejected");
    const commandVerifier = provider.verifiers.find(
      (sandbox) => sandbox.role === "commands",
    )!;
    const deliveryVerifier = provider.verifiers.find(
      (sandbox) => sandbox.role === "delivery",
    )!;
    expect(commandVerifier.generatedDist).toBe(true);
    expect(deliveryVerifier.generatedDist).toBe(false);
    expect(
      store
        .listEvidence(run.id)
        .find((receipt) => receipt.kind === "container-build"),
    ).toMatchObject({ status: "FAIL", exitCode: 1 });
    expect(deliveryVerifier.containerPreviewCalls).toBe(0);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  it("fails closed before preview when the delivery network seal fails", async () => {
    const input = assignment("executor-network-seal-failure");
    input.limits.maxRepairRounds = 0;
    const run = store.createRun(input).run;
    const lease = store.acquireSlot(run.id, 30_000)!;
    const builder = new FakeSandbox("sandbox-builder", "builder", previewUrl);
    const provider = new FakeSandboxProvider(builder);
    provider.failDeliveryNetworkSeal = true;
    const artifactStore = new FakeArtifactStore();
    const executor = makeExecutor(
      provider,
      new PassingReviewer(),
      new TestTrace(),
      artifactStore,
    );

    await executor.execute(run.id, lease);

    const delivery = provider.verifiers.find(
      (sandbox) => sandbox.role === "delivery",
    )!;
    expect(store.getRun(run.id)).toMatchObject({
      status: "failed",
      errorCode: "build_run_failed",
    });
    expect(delivery.proofOperations).toEqual([
      "container-build",
      "network-seal",
    ]);
    expect(delivery.containerPreviewCalls).toBe(0);
    expect(delivery.snapshotCalls).toBe(0);
    expect(delivery.disposeCalls).toBe(1);
    expect(artifactStore.persistedRoles).toEqual([]);
    expect(store.listOutbox(10)).toHaveLength(0);
  });

  function makeExecutor(
    provider: SandboxProvider,
    reviewer: CodeReviewPort,
    trace: TracePort = new TestTrace(),
    artifactStore: ArtifactStore = new FakeArtifactStore(),
    model: ModelPort = new PassingModel(),
  ): BuildRunExecutor {
    return new BuildRunExecutor({
      store,
      sandboxProvider: provider,
      artifactStore,
      model,
      reviewer,
      trace,
    });
  }
});

class FakeSandbox implements SandboxSession {
  readonly workDir = "/workspace";
  readonly commands: string[] = [];
  generatedDist = false;
  rejectVerificationCommands = false;
  dirtyAfterFirstIntegrityCheck = false;
  deliveryRequiresGeneratedDist = false;
  failNetworkSeal = false;
  failDependencyBootstrap = false;
  renderedInspectionError: string | undefined;
  renderedVisibleText: string | undefined;
  containerPreviewCalls = 0;
  networkSealCalls = 0;
  networkSealed = false;
  snapshotCalls = 0;
  stopCalls = 0;
  disposeCalls = 0;
  failDisposal = false;
  readonly proofOperations: string[] = [];
  readonly sourceBytes: Buffer;
  #digestChecks = 0;

  constructor(
    readonly id: string,
    readonly role: "builder" | "commands" | "delivery",
    readonly previewUrl: string,
    readonly revision: FrozenRevision = {
      sourceDigest: "e".repeat(64),
      commitSha: "f".repeat(40),
      frozenAt: "2026-07-23T12:00:00.000Z",
    },
    sourceBytes: Uint8Array = Buffer.from("controller-held-source\n"),
  ) {
    this.sourceBytes = Buffer.from(sourceBytes);
  }

  get controllerContentDigest(): string {
    return sha256(this.sourceBytes);
  }

  runCommand(command: string) {
    this.commands.push(command);
    if (
      this.role === "commands" &&
      this.failDependencyBootstrap &&
      command === DEPENDENCY_BOOTSTRAP_COMMAND
    ) {
      return Promise.resolve({
        exitCode: 65,
        stdout: "",
        stderr: "A supported frozen lockfile is required for verification",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      });
    }
    if (
      this.role === "builder" &&
      this.rejectVerificationCommands &&
      (command.includes("npm run build") ||
        command.includes("npm test") ||
        command.includes("docker build"))
    ) {
      return Promise.resolve({
        exitCode: 97,
        stdout: "",
        stderr: "verification command reached the poisoned builder",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      });
    }
    if (this.role === "commands" && command.includes("npm run build")) {
      this.generatedDist = true;
    }
    if (
      this.role === "delivery" &&
      command.includes("docker build") &&
      this.deliveryRequiresGeneratedDist &&
      !this.generatedDist
    ) {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "COPY failed: dist does not exist in the clean source export",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      });
    }
    if (this.role === "delivery" && command.includes("docker build")) {
      this.proofOperations.push("container-build");
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
    });
  }

  readFile(path: string) {
    return Promise.resolve(path === "Dockerfile" ? "FROM node:24" : "");
  }

  writeFile() {
    return Promise.resolve();
  }

  listFiles(): Promise<SandboxFile[]> {
    return Promise.resolve([
      {
        path: "src/index.ts",
        name: "index.ts",
        size: 20,
        isDirectory: false,
      },
    ]);
  }

  startPreview() {
    return Promise.resolve();
  }

  sealNetworkForProof() {
    this.proofOperations.push("network-seal");
    if (this.role !== "delivery") {
      return Promise.reject(
        new Error("network sealing is restricted to the delivery verifier"),
      );
    }
    if (this.failNetworkSeal) {
      return Promise.reject(new Error("Daytona network seal failed"));
    }
    this.networkSealCalls += 1;
    this.networkSealed = true;
    return Promise.resolve();
  }

  startContainerPreview() {
    this.containerPreviewCalls += 1;
    this.proofOperations.push("container-preview");
    if (this.role !== "delivery" || !this.networkSealed) {
      return Promise.reject(
        new Error(
          "container preview requires a network-sealed delivery verifier",
        ),
      );
    }
    return Promise.resolve();
  }

  async inspectRenderedPages(paths: string[]) {
    this.proofOperations.push("rendered-inspection");
    if (this.role !== "delivery" || !this.networkSealed) {
      throw new Error(
        "rendered proof requires a network-sealed delivery verifier",
      );
    }
    if (this.renderedInspectionError) {
      return paths.map((path) => ({
        path,
        status: null,
        error: this.renderedInspectionError!,
      }));
    }
    return Promise.all(
      paths.map(async (path) => {
        const response = await fetch(new URL(path, this.previewUrl));
        const body = await response.text();
        return {
          path,
          status: response.status,
          visibleText:
            this.renderedVisibleText ??
            body
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim(),
          screenshotSha256s: [sha256(Buffer.from(RASTER_PNG_BASE64, "base64"))],
          screenshotBase64s: [RASTER_PNG_BASE64],
        };
      }),
    );
  }

  freeze() {
    if (this.role !== "builder") {
      return Promise.reject(new Error("only the builder freezes revisions"));
    }
    return Promise.resolve(this.revision);
  }

  currentRevisionDigest() {
    this.#digestChecks += 1;
    if (this.dirtyAfterFirstIntegrityCheck && this.#digestChecks > 1) {
      return Promise.resolve("1".repeat(64));
    }
    return Promise.resolve(this.revision.sourceDigest);
  }

  createSnapshot(name: string) {
    this.snapshotCalls += 1;
    this.proofOperations.push("snapshot");
    if (this.role !== "delivery" || !this.networkSealed) {
      return Promise.reject(
        new Error(
          "snapshot promotion requires a network-sealed delivery verifier",
        ),
      );
    }
    this.networkSealed = false;
    this.networkSealCalls += 1;
    this.networkSealed = true;
    this.proofOperations.push("network-seal-reapplied");
    return Promise.resolve(name);
  }

  async exportWorkspace(revision: FrozenRevision): Promise<ExportedWorkspace> {
    expect(revision).toEqual(this.revision);
    const root = await mkdtemp(join(tmpdir(), "buildlapse-test-"));
    const directory = join(root, "workspace");
    const archivePath = join(root, "workspace.tar");
    const archiveBytes = Buffer.from(this.sourceBytes);
    await mkdir(directory);
    await Promise.all([
      writeFile(join(directory, "Dockerfile"), "FROM node:24\n"),
      writeFile(join(directory, "source-role.txt"), `${this.role}\n`),
      writeFile(archivePath, archiveBytes),
    ]);
    return {
      directory,
      archivePath,
      archiveSha256: sha256(archiveBytes),
      contentDigest: this.controllerContentDigest,
      cleanup: async () => {
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  getPreview(): Promise<PreviewTarget> {
    return Promise.resolve({
      url: this.previewUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  stop() {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  dispose() {
    this.disposeCalls += 1;
    if (this.failDisposal) {
      return Promise.reject(new Error("Daytona deletion failed"));
    }
    return Promise.resolve();
  }
}

class FakeSandboxProvider implements SandboxProvider {
  readonly verifiers: FakeSandbox[] = [];
  dirtyDeliveryAfterFirstIntegrityCheck = false;
  deliveryRequiresGeneratedDist = false;
  failDeliveryNetworkSeal = false;
  failDependencyBootstrap = false;
  reuseBuilderForCommands = false;
  renderedInspectionError: string | undefined;
  renderedVisibleText: string | undefined;
  tamperSourceAfterCommandHydration = false;
  failCommandDisposal = false;
  #verifierSequence = 0;

  constructor(private readonly builder: FakeSandbox) {}

  create(): Promise<SandboxSession> {
    return Promise.resolve(this.builder);
  }

  async createVerifier(
    _runId: string,
    _assignment: Parameters<SandboxProvider["createVerifier"]>[1],
    revision: FrozenRevision,
    source: ExportedWorkspace,
    purpose: "commands" | "delivery",
  ): Promise<SandboxSession> {
    const archiveBytes = await readFile(source.archivePath);
    if (sha256(archiveBytes) !== source.archiveSha256) {
      throw new Error("Controller source export digest does not match");
    }
    if (
      sha256(archiveBytes) !== source.contentDigest ||
      revision.sourceDigest !== source.contentDigest
    ) {
      throw new Error("Controller source content binding does not match");
    }
    expect(revision).toMatchObject({
      commitSha: this.builder.revision.commitSha,
      frozenAt: this.builder.revision.frozenAt,
    });
    if (purpose === "commands" && this.reuseBuilderForCommands) {
      return this.builder;
    }
    this.#verifierSequence += 1;
    const sandbox = new FakeSandbox(
      `sandbox-verifier-${purpose}-${this.#verifierSequence}`,
      purpose,
      this.builder.previewUrl,
      revision,
      archiveBytes,
    );
    if (purpose === "delivery") {
      sandbox.dirtyAfterFirstIntegrityCheck =
        this.dirtyDeliveryAfterFirstIntegrityCheck;
      sandbox.deliveryRequiresGeneratedDist =
        this.deliveryRequiresGeneratedDist;
      sandbox.failNetworkSeal = this.failDeliveryNetworkSeal;
      sandbox.renderedInspectionError = this.renderedInspectionError;
      sandbox.renderedVisibleText = this.renderedVisibleText;
    } else {
      sandbox.failDisposal = this.failCommandDisposal;
      sandbox.failDependencyBootstrap = this.failDependencyBootstrap;
    }
    this.verifiers.push(sandbox);
    if (purpose === "commands" && this.tamperSourceAfterCommandHydration) {
      await writeFile(source.archivePath, "raced attacker source\n");
    }
    return sandbox;
  }

  getPreview(sandboxId: string): Promise<PreviewTarget> {
    const sandbox = this.verifiers.find((entry) => entry.id === sandboxId);
    if (!sandbox) {
      return Promise.reject(new Error(`Unknown verifier ${sandboxId}`));
    }
    return sandbox.getPreview();
  }

  materializeFrozenPreview(): Promise<PreviewTarget> {
    return Promise.resolve({
      url: this.builder.previewUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = [this.builder, ...this.verifiers].find(
      (entry) => entry.id === sandboxId,
    );
    return sandbox ? sandbox.dispose() : Promise.resolve();
  }

  health(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class PassingModel implements ModelPort {
  readonly userPrompts: string[] = [];

  complete(
    messages: AgentMessage[],
    _tools: AgentToolDefinition[],
  ): Promise<ModelTurn> {
    this.userPrompts.push(
      messages.find((message) => message.role === "user")?.content ?? "",
    );
    return Promise.resolve({
      content: null,
      toolCalls: [
        {
          id: "preview",
          name: "start_preview",
          argumentsJson: "{}",
        },
        {
          id: "finish",
          name: "finish",
          argumentsJson: JSON.stringify({ summary: "Candidate ready" }),
        },
      ],
    });
  }

  evaluateContract(
    input: ContractEvaluationInput,
  ): Promise<ContractEvaluationOutput> {
    return Promise.resolve({
      requirements: input.contract.requirements.map((requirement) => ({
        requirementId: requirement.id,
        status: "PASS" as const,
        explanation: "Verified by supplied evidence.",
        evidenceRefs: (
          input.requiredEvidenceRefsByRequirement[requirement.id] ?? []
        ).flatMap((group) => group.slice(0, 1)),
      })),
      unsupportedClaims: [],
      summary: "All hard requirements passed.",
    });
  }

  inspectRasterClaims(
    input: RasterClaimInspectionInput,
  ): Promise<RasterClaimInspectionOutput> {
    return Promise.resolve({
      modelDigest: sha256("test-fireworks-vision-model"),
      results: input.assets.map((asset) => ({
        assetIndex: asset.index,
        status: "CLEAR" as const,
        matchedForbiddenClaimIndices: [],
      })),
    });
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class OperationalRasterModel extends PassingModel {
  constructor(
    private readonly failure: "model_response_invalid" | "provider_error",
  ) {
    super();
  }

  override inspectRasterClaims(): Promise<RasterClaimInspectionOutput> {
    return this.failure === "model_response_invalid"
      ? Promise.reject(
          new RasterClaimInspectionError(
            "MODEL_RESPONSE_INVALID",
            "Fireworks returned malformed raster output",
          ),
        )
      : Promise.reject(new Error("Fireworks raster provider unavailable"));
  }
}

class NoRasterCapabilityModel implements ModelPort {
  readonly #delegate = new PassingModel();
  readonly userPrompts = this.#delegate.userPrompts;

  complete(
    messages: Parameters<ModelPort["complete"]>[0],
    tools: Parameters<ModelPort["complete"]>[1],
    _context: Parameters<ModelPort["complete"]>[2],
    _signal?: Parameters<ModelPort["complete"]>[3],
  ): ReturnType<ModelPort["complete"]> {
    return this.#delegate.complete(messages, tools);
  }

  evaluateContract(
    input: Parameters<ModelPort["evaluateContract"]>[0],
    _signal?: Parameters<ModelPort["evaluateContract"]>[1],
  ): ReturnType<ModelPort["evaluateContract"]> {
    return this.#delegate.evaluateContract(input);
  }

  health(_signal?: AbortSignal): ReturnType<ModelPort["health"]> {
    return this.#delegate.health();
  }
}

function operationalRasterModel(
  errorCode:
    | "model_capability_unavailable"
    | "model_response_invalid"
    | "provider_error",
): OperationalRasterModel | NoRasterCapabilityModel {
  return errorCode === "model_capability_unavailable"
    ? new NoRasterCapabilityModel()
    : new OperationalRasterModel(errorCode);
}

class RepairingRasterModel extends PassingModel {
  rasterCalls = 0;

  override inspectRasterClaims(
    input: RasterClaimInspectionInput,
  ): Promise<RasterClaimInspectionOutput> {
    this.rasterCalls += 1;
    return Promise.resolve({
      modelDigest: sha256("test-fireworks-vision-model"),
      results: input.assets.map((asset) => ({
        assetIndex: asset.index,
        status:
          this.rasterCalls === 1 && asset.index === 0
            ? ("MATCH" as const)
            : ("CLEAR" as const),
        matchedForbiddenClaimIndices:
          this.rasterCalls === 1 && asset.index === 0 ? [0] : [],
      })),
    });
  }
}

class MalformedEvaluationModel extends PassingModel {
  override evaluateContract(
    input: ContractEvaluationInput,
  ): Promise<ContractEvaluationOutput> {
    const requirements = input.contract.requirements.map((requirement) => ({
      requirementId: requirement.id,
      status:
        requirement.id === "homepage" ? ("FAIL" as const) : ("PASS" as const),
      explanation:
        requirement.id === "homepage"
          ? "UNTRUSTED EVALUATOR GUIDANCE"
          : "Verified by supplied evidence.",
      evidenceRefs: [],
    }));
    requirements.push({
      requirementId: "homepage",
      status: "FAIL",
      explanation: "UNTRUSTED EVALUATOR GUIDANCE",
      evidenceRefs: [],
    });
    return Promise.resolve({
      requirements,
      unsupportedClaims: [],
      summary: "Malformed duplicate result.",
    });
  }
}

class RepairingEvaluationModel extends PassingModel {
  evaluationCalls = 0;

  override evaluateContract(
    input: ContractEvaluationInput,
  ): Promise<ContractEvaluationOutput> {
    this.evaluationCalls += 1;
    return Promise.resolve({
      requirements: input.contract.requirements.map((requirement) => ({
        requirementId: requirement.id,
        status:
          this.evaluationCalls === 1 && requirement.id === "homepage"
            ? ("FAIL" as const)
            : ("PASS" as const),
        explanation:
          this.evaluationCalls === 1 && requirement.id === "homepage"
            ? "Candidate homepage hierarchy is incomplete."
            : "Verified by supplied evidence.",
        evidenceRefs: (
          input.requiredEvidenceRefsByRequirement[requirement.id] ?? []
        ).flatMap((group) => group.slice(0, 1)),
      })),
      unsupportedClaims: [],
      summary:
        this.evaluationCalls === 1
          ? "One hard requirement failed."
          : "All hard requirements passed.",
    });
  }
}

class PassingReviewer implements CodeReviewPort {
  readonly reviewedRoles: string[] = [];

  async review(request: CodeReviewRequest): Promise<CodeReviewResult> {
    this.reviewedRoles.push(
      (
        await readFile(
          join(request.workspaceDirectory, "source-role.txt"),
          "utf8",
        )
      ).trim(),
    );
    return {
      complete: true,
      findings: [],
      rawDigest: sha256("clean review"),
      policyDigest: buildCodeRabbitPolicy(
        request.contract,
        request.verificationContext,
      ).digest,
    };
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class UnboundFindingsReviewer implements CodeReviewPort {
  calls = 0;

  review(): Promise<CodeReviewResult> {
    this.calls += 1;
    return Promise.resolve({
      complete: true,
      findings: [
        {
          severity: "major",
          fileName: "src/index.ts",
          message: "UNBOUND REVIEW GUIDANCE",
          codegenInstructions: "UNBOUND REVIEW GUIDANCE",
        },
      ],
      rawDigest: sha256("unbound review"),
      policyDigest: sha256("wrong controller policy"),
    });
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingReviewer implements CodeReviewPort {
  calls = 0;

  constructor(private readonly message: string = "CodeRabbit unavailable") {}

  review(_request: CodeReviewRequest): Promise<CodeReviewResult> {
    this.calls += 1;
    return Promise.reject(new Error(this.message));
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class RepairingReviewer implements CodeReviewPort {
  calls = 0;

  review(request: CodeReviewRequest): Promise<CodeReviewResult> {
    this.calls += 1;
    return Promise.resolve({
      complete: true,
      findings:
        this.calls === 1
          ? [
              {
                severity: "major",
                fileName: "src/index.ts",
                message: "Form errors are not announced accessibly.",
                codegenInstructions: "Add an aria-live error summary.",
              },
            ]
          : [],
      rawDigest: sha256(`repair review ${this.calls}`),
      policyDigest: buildCodeRabbitPolicy(
        request.contract,
        request.verificationContext,
      ).digest,
    });
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeArtifactStore implements ArtifactStore {
  readonly persistedRoles: string[] = [];

  async persist(
    runId: string,
    revision: FrozenRevision,
    workspace: ExportedWorkspace,
    daytonaSnapshot: string,
  ): Promise<ProvenArtifact> {
    this.persistedRoles.push(
      (
        await readFile(join(workspace.directory, "source-role.txt"), "utf8")
      ).trim(),
    );
    return {
      ...artifact(runId, revision.sourceDigest),
      daytonaSnapshot,
    };
  }
}

class TestTrace implements TracePort {
  readonly childNames: string[] = [];

  run<T>(
    _run: Parameters<TracePort["run"]>[0],
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(new TestSpan(this.childNames));
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  health(): Promise<void> {
    return Promise.resolve();
  }
}

class FailingFlushTrace extends TestTrace {
  override flush(): Promise<void> {
    return Promise.reject(new Error("Braintrust flush failed"));
  }
}

class HangingFlushTrace extends TestTrace {
  flushCalls = 0;
  readonly #pending = new Promise<void>(() => undefined);

  override flush(): Promise<void> {
    this.flushCalls += 1;
    return this.#pending;
  }
}

class TestSpan implements TraceSpan {
  readonly traceId = "trace-test";

  constructor(private readonly childNames: string[] = []) {}

  log(): void {}

  child<T>(
    name: string,
    _type: "function" | "llm" | "review" | "score" | "task" | "tool",
    _input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    this.childNames.push(name);
    return operation(this);
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMilliseconds: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Operation did not settle within deadline")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
