import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface ServiceHandle {
  name: string;
  child: ChildProcess;
  logPath: string;
  stop(): Promise<void>;
}

export interface StartServiceOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  readyUrl: string;
  readyTimeoutMs?: number;
  /** Extra fetch init for the readiness probe (bearer tokens, mostly). */
  readyInit?: RequestInit;
  acceptStatus?: (status: number) => boolean;
}

export async function startService(
  options: StartServiceOptions,
): Promise<ServiceHandle> {
  const log: WriteStream = createWriteStream(options.logPath, { flags: "a" });
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);

  let exited:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  const handle: ServiceHandle = {
    name: options.name,
    child,
    logPath: options.logPath,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) {
          break;
        }
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      log.end();
    },
  };

  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
  const accept = options.acceptStatus ?? ((status: number) => status < 500);
  let lastError = "no probe attempted";
  while (Date.now() < deadline) {
    if (exited) {
      await handle.stop();
      throw new Error(
        `${options.name} exited before becoming ready (code ${String(exited.code)}, signal ${String(exited.signal)}). See ${options.logPath}`,
      );
    }
    try {
      const response = await fetch(options.readyUrl, {
        ...options.readyInit,
        signal: AbortSignal.timeout(4_000),
      });
      if (accept(response.status)) {
        return handle;
      }
      lastError = `probe returned ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  await handle.stop();
  throw new Error(
    `${options.name} never became ready at ${options.readyUrl} (${lastError}). See ${options.logPath}`,
  );
}

export async function stopServices(
  handles: readonly ServiceHandle[],
): Promise<void> {
  await Promise.all(handles.map((handle) => handle.stop()));
}
