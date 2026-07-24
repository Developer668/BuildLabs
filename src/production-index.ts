import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  determineSupervisorExitCode,
  type SupervisedChildExit,
} from "./production-supervisor-policy.js";

const SHUTDOWN_TIMEOUT_MILLISECONDS = 30_000;
const childEnvironment = {
  ...process.env,
  NODE_ENV: "production",
};
const children = [
  startChild("build-agent-backend", "./index.js"),
  startChild("general-orchestrator", "./orchestration-index.js"),
];

let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;
let requestedSignal: NodeJS.Signals | undefined;
let forcedShutdown = false;

function shutdown(signal: NodeJS.Signals = "SIGTERM"): void {
  if (stopping) {
    return;
  }
  stopping = true;
  requestedSignal = signal;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
  shutdownTimer = setTimeout(() => {
    forcedShutdown = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, SHUTDOWN_TIMEOUT_MILLISECONDS);
  shutdownTimer.unref();
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

await Promise.race(children.map(waitForChild));
const unexpectedExit = !stopping;

if (unexpectedExit) {
  process.stderr.write(
    "A required BuildLabs backend process stopped; shutting down the complete runtime\n",
  );
  shutdown("SIGTERM");
}
const childResults = await Promise.all(children.map(waitForChild));
if (shutdownTimer) {
  clearTimeout(shutdownTimer);
}
process.exitCode = determineSupervisorExitCode({
  unexpectedExit,
  forcedShutdown,
  requestedSignal,
  childResults,
});

function startChild(name: string, relativeModule: string): ChildProcess {
  const modulePath = fileURLToPath(new URL(relativeModule, import.meta.url));
  const child = spawn(process.execPath, [modulePath], {
    env: childEnvironment,
    shell: false,
    stdio: "inherit",
  });
  child.once("error", () => {
    process.stderr.write(`${name} could not start\n`);
  });
  return child;
}

function waitForChild(child: ChildProcess): Promise<SupervisedChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
