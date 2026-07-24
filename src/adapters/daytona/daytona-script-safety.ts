import { classifyDaytonaFailure } from "./daytona-control-plane.js";

export interface DaytonaScriptFailureRecord {
  schema: "buildlabs.daytona.script-failure.v1";
  script: string;
  outcome: "failed";
  failureCode: ReturnType<typeof classifyDaytonaFailure>;
}

export function daytonaScriptFailureRecord(
  script: string,
  error: unknown,
): DaytonaScriptFailureRecord {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(script)) {
    throw new Error("Daytona script identity is invalid");
  }
  return {
    schema: "buildlabs.daytona.script-failure.v1",
    script,
    outcome: "failed",
    failureCode: classifyDaytonaFailure(error),
  };
}

export function installDaytonaScriptFailureRedaction(script: string): void {
  let emitted = false;
  const fail = (error: unknown): never => {
    if (!emitted) {
      emitted = true;
      process.stderr.write(
        `${JSON.stringify(daytonaScriptFailureRecord(script, error))}\n`,
      );
    }
    process.exit(1);
  };
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);
}
