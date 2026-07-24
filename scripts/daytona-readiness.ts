import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { DaytonaSandboxProvider } from "../src/adapters/daytona/daytona-sandbox.js";
import { installDaytonaScriptFailureRedaction } from "../src/adapters/daytona/daytona-script-safety.js";
import { loadConfig } from "../src/config.js";

installDaytonaScriptFailureRedaction("readiness");

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const config = loadConfig();
const provider = new DaytonaSandboxProvider(config);

try {
  const report = await provider.readinessReport(AbortSignal.timeout(30_000));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.overall === "degraded" || report.overall === "unconfigured") {
    process.exitCode = 1;
  }
} finally {
  await provider.close(AbortSignal.timeout(10_000));
}
