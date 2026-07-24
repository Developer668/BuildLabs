import { readFileSync, writeFileSync } from "node:fs";

/**
 * Everything `global-setup` discovers and the journey spec needs. It travels
 * through a file (not module state) because Playwright runs global setup and
 * the workers in different processes.
 */
export interface JourneyRuntime {
  mode: "stub" | "live";
  runDirectory: string;
  /** Absolute path to the generated fake-microphone capture. */
  audioFixturePath: string;
  /** Loopback origins the services actually listen on. */
  origins: {
    buildBackend: string;
    orchestrator: string;
    dashboard: string;
    voiceIntake: string;
  };
  /** Public HTTPS origin the emailed login link must point at. */
  dashboardPublicOrigin: string;
  /**
   * Chromium cannot resolve `dashboardPublicOrigin`; the browser is launched
   * with a host-resolver rule mapping it here (TLS front for the dashboard).
   */
  dashboardTlsPort: number;
  tokens: {
    buildBackend: string;
    orchestrator: string;
  };
  /** Plain-HTTP control API of the provider stub (`""` in live mode). */
  stubControlOrigin: string;
  /** Secrets the spec needs in order to forge correctly-signed webhooks. */
  secrets: {
    stripeWebhook: string;
    resendWebhook: string;
    elevenLabsWebhook: string;
  };
  /** Non-fatal capability gaps discovered while booting. */
  degradations: string[];
}

const HANDOFF_VARIABLE = "BUILDLABS_E2E_RUNTIME_FILE";

export function runtimeHandoffPath(): string {
  const path = process.env[HANDOFF_VARIABLE];
  if (!path) {
    throw new Error(
      `${HANDOFF_VARIABLE} is unset. Run the journey through e2e/playwright.config.ts.`,
    );
  }
  return path;
}

export function writeJourneyRuntime(runtime: JourneyRuntime): void {
  writeFileSync(runtimeHandoffPath(), JSON.stringify(runtime, null, 2), "utf8");
}

export function readJourneyRuntime(): JourneyRuntime {
  return JSON.parse(
    readFileSync(runtimeHandoffPath(), "utf8"),
  ) as JourneyRuntime;
}

export { HANDOFF_VARIABLE };
