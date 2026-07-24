import type { RunStore, SandboxProvider } from "../ports/index.js";

export interface RunRecoveryResult {
  recoveredRunCount: number;
  deletedSandboxCount: number;
  failedSandboxIds: string[];
}

export async function recoverInterruptedRunSandboxes(
  store: RunStore,
  sandboxProvider: SandboxProvider,
  signal?: AbortSignal,
): Promise<RunRecoveryResult> {
  const recoveredRuns = store.recoverInterruptedRuns();
  const sandboxIds = [
    ...new Set(recoveredRuns.flatMap((run) => run.sandboxIds)),
  ];
  const results = await Promise.allSettled(
    sandboxIds.map((sandboxId) =>
      sandboxProvider.deleteSandbox(sandboxId, signal),
    ),
  );
  const failedSandboxIds = sandboxIds.filter(
    (_sandboxId, index) => results[index]?.status === "rejected",
  );
  const failedSandboxIdSet = new Set(failedSandboxIds);
  for (const recoveredRun of recoveredRuns) {
    if (
      recoveredRun.sandboxIds.every(
        (sandboxId) => !failedSandboxIdSet.has(sandboxId),
      )
    ) {
      store.markRecoveryCleanupComplete(recoveredRun.runId);
    }
  }
  return {
    recoveredRunCount: recoveredRuns.filter((run) => run.newlyRecovered).length,
    deletedSandboxCount: sandboxIds.length - failedSandboxIds.length,
    failedSandboxIds,
  };
}
