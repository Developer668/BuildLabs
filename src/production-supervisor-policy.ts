export interface SupervisedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SupervisorExitPolicyInput {
  unexpectedExit: boolean;
  forcedShutdown: boolean;
  requestedSignal: NodeJS.Signals | undefined;
  childResults: readonly SupervisedChildExit[];
}

export function determineSupervisorExitCode(
  input: SupervisorExitPolicyInput,
): number {
  const childFailed = input.childResults.some(
    (result) =>
      (result.code !== null && result.code !== 0) ||
      result.signal === "SIGKILL",
  );
  if (input.unexpectedExit || input.forcedShutdown || childFailed) {
    return 1;
  }
  if (input.requestedSignal === "SIGINT") {
    return 130;
  }
  if (input.requestedSignal === "SIGTERM") {
    return 143;
  }
  return 0;
}
