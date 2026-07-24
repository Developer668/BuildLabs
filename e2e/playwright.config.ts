import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { HANDOFF_VARIABLE } from "./lib/runtime.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runDirectory = join(repositoryRoot, ".buildlabs", "e2e-journey");

// Global setup and the workers are separate processes, so they meet at a file.
process.env[HANDOFF_VARIABLE] ??= join(runDirectory, "runtime.json");

const live = process.env.E2E_LIVE === "1";
if (!live) {
  process.env.E2E_STUB ??= "1";
}

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Live mode talks to real providers and a real Daytona build; stub mode is
  // meant to stay inside a CI gate's patience.
  timeout: live ? 45 * 60_000 : 6 * 60_000,
  expect: { timeout: 15_000 },
  globalSetup: "./global-setup.ts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: join(runDirectory, "report") }],
  ],
  outputDir: join(runDirectory, "artifacts"),
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // The stub certificate is deliberately self-signed.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "journey",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        permissions: ["microphone"],
        // The fake-microphone and host-resolver launch arguments live in the
        // spec: they depend on ports global setup allocates after this config
        // is evaluated.
      },
    },
  ],
});
