import { describe, expect, it } from "vitest";

import {
  CONTAINER_BUILD_COMMAND,
  runCommandVerification,
} from "../src/application/verification.js";
import { CommandReceiptSchema } from "../src/domain/evidence.js";
import { digestJson, sha256 } from "../src/lib/canonical-json.js";
import type {
  CommandResult,
  SandboxAsyncExecutionReceipt,
  SandboxSession,
  TraceSpan,
} from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

const RUN_ID = "d3703216-b5b2-4c9a-a371-158925b48125";
const REVISION_HASH = sha256("daytona async command receipt");

class TestSpan implements TraceSpan {
  readonly traceId = "daytona-command-receipts";

  log(): void {}

  child<T>(
    _name: string,
    _type: "function" | "llm" | "review" | "score" | "task" | "tool",
    _input: unknown,
    operation: (span: TraceSpan) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}

function asyncReceipt(
  command: string,
  outcome: SandboxAsyncExecutionReceipt["outcome"],
): SandboxAsyncExecutionReceipt {
  return {
    schema: "buildlabs.daytona.async-execution.v1",
    commandSha256: sha256(command),
    sessionRef: sha256(`session:${outcome}`),
    commandRef: sha256(`command:${outcome}`),
    startedAt: "2026-07-24T20:00:00.000Z",
    completedAt: "2026-07-24T20:00:01.000Z",
    durationMs: 1_000,
    outcome,
    exitCode: outcome === "completed" ? 0 : null,
    stdoutSha256: sha256(outcome === "completed" ? "ok" : ""),
    stderrSha256: sha256(""),
    stdoutBytes: outcome === "completed" ? 2 : 0,
    stderrBytes: 0,
    outputTruncated: false,
    sandboxTerminated: outcome !== "completed",
    ...(outcome === "timed_out"
      ? { failureCode: "timeout" as const }
      : outcome === "cancelled"
        ? { failureCode: "aborted" as const }
        : {}),
  };
}

function commandResult(): CommandResult {
  return {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1_000,
  };
}

function verificationSandbox(input: {
  outcome: SandboxAsyncExecutionReceipt["outcome"];
}): SandboxSession {
  const staleReceipt = asyncReceipt("prior command", "completed");
  staleReceipt.sessionRef = sha256("stale session");
  const history = [staleReceipt];
  return {
    id: "opaque-test-sandbox",
    workDir: "/workspace",
    asyncExecutionReceipts: () => structuredClone(history),
    runCommand: (command, timeoutSeconds) => {
      if (timeoutSeconds < 600) {
        return Promise.resolve(commandResult());
      }
      history.push(asyncReceipt(command, input.outcome));
      if (input.outcome !== "completed") {
        return Promise.reject(new Error(`async ${input.outcome}`));
      }
      return Promise.resolve(commandResult());
    },
  } as SandboxSession;
}

async function verify(outcome: SandboxAsyncExecutionReceipt["outcome"]) {
  return await runCommandVerification({
    runId: RUN_ID,
    revisionHash: REVISION_HASH,
    assignment: assignment(`async-${outcome}`),
    sandbox: verificationSandbox({ outcome }),
    phase: "delivery",
    trace: new TestSpan(),
  });
}

describe("Daytona durable async command receipts", () => {
  it("binds the newly emitted successful async receipt into command evidence", async () => {
    const receipts = await verify("completed");
    const receipt = CommandReceiptSchema.parse(
      receipts.find((candidate) => candidate.kind === "container-build"),
    );

    expect(receipt.asyncExecution).toMatchObject({
      outcome: "completed",
      commandSha256: sha256(CONTAINER_BUILD_COMMAND),
    });
    expect(receipt.asyncExecution?.sessionRef).not.toBe(
      sha256("stale session"),
    );
    expect(receipt.inputDigest).toBe(
      digestJson({
        kind: "container-build",
        command: CONTAINER_BUILD_COMMAND,
        timeoutSeconds: 900,
      }),
    );
    expect(receipt.outputDigest).toBe(
      digestJson({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1_000,
        asyncExecution: receipt.asyncExecution,
      }),
    );
  });

  it.each(["timed_out", "cancelled"] as const)(
    "binds a thrown %s async receipt into errored command evidence",
    async (outcome) => {
      const receipts = await verify(outcome);
      const receipt = CommandReceiptSchema.parse(
        receipts.find((candidate) => candidate.kind === "container-build"),
      );

      expect(receipt).toMatchObject({
        status: "ERROR",
        asyncExecution: {
          outcome,
          commandSha256: sha256(CONTAINER_BUILD_COMMAND),
          sandboxTerminated: true,
        },
      });
      expect(receipt.outputDigest).toBe(
        digestJson({
          error: `async ${outcome}`,
          asyncExecution: receipt.asyncExecution,
        }),
      );
    },
  );
});
