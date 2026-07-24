import { existsSync, readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { loadConfig } from "../src/config.js";
import { describeConfigIssues } from "../src/lib/config-diagnostics.js";
import { loadOrchestrationConfig } from "../src/orchestration/runtime/config.js";

/**
 * Reports, per service, which configuration variables are missing or invalid.
 *
 * The build backend and the orchestrator own Zod schemas, so this defers to
 * them. The dashboard and voice-intake read `process.env` ad hoc at the point
 * of use, so their requirements are declared here — keep these lists in step
 * with the accessors they name.
 *
 * Each service is checked against the env files it actually loads at runtime:
 * the Node services read the repository-root `.env`, while Next.js and vinext
 * read env files from their own app directory and never see the root file.
 *
 * Values are never printed. Only variable names and constraints appear.
 */

interface VariableRequirement {
  readonly name: string;
  /** Where the value is read, so a drifted list is easy to re-verify. */
  readonly readAt: string;
  readonly check?: (value: string) => string | undefined;
  /** Declared for completeness; absence is reported as a note, not a failure. */
  readonly optional?: true;
}

const MIN_SECRET_BYTES = 32;

function minimumBytes(bytes: number) {
  return (value: string): string | undefined =>
    Buffer.byteLength(value, "utf8") >= bytes
      ? undefined
      : `must be at least ${bytes} bytes`;
}

function hexDigest(value: string): string | undefined {
  return /^[a-f0-9]{64}$/i.test(value)
    ? undefined
    : "must be a 64-character hex digest";
}

function serviceUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]).has(
    url.hostname,
  );
  return url.protocol === "https:" || (url.protocol === "http:" && loopback)
    ? undefined
    : "must use HTTPS, except for an HTTP loopback address";
}

const DASHBOARD_REQUIREMENTS: readonly VariableRequirement[] = [
  {
    name: "BUILDLABS_OPERATOR_TOKEN",
    readAt: "apps/dashboard/lib/operator-auth.ts",
    check: minimumBytes(20),
  },
  {
    name: "BUILDLABS_INTERNAL_TOKEN",
    readAt: "apps/dashboard/lib/operator-server/client.ts",
    check: minimumBytes(16),
  },
  {
    name: "BUILDLABS_DASHBOARD_ALIAS_SECRET",
    readAt: "apps/dashboard/lib/server/aliases.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "BUILDLABS_DASHBOARD_INTERNAL_TOKEN",
    readAt: "apps/dashboard/lib/server/wip-raster.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "BUILDLABS_DASHBOARD_WIP_ATTESTATION_SECRET",
    readAt: "apps/dashboard/lib/server/wip-raster.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "BUILDLABS_DASHBOARD_WIP_POLICY_DIGEST",
    readAt: "apps/dashboard/lib/server/wip-raster.ts",
    check: hexDigest,
  },
  {
    name: "BUILDLABS_ORCHESTRATION_URL",
    readAt: "apps/dashboard/lib/server/orchestration-client.ts",
    check: serviceUrl,
    optional: true,
  },
  {
    name: "BUILDLABS_BUILD_BACKEND_URL",
    readAt: "apps/dashboard/lib/operator-server/client.ts",
    check: serviceUrl,
    optional: true,
  },
];

const VOICE_INTAKE_REQUIREMENTS: readonly VariableRequirement[] = [
  {
    name: "ELEVENLABS_API_KEY",
    readAt: "apps/voice-intake/lib/elevenlabs.ts",
    check: minimumBytes(20),
  },
  {
    name: "ELEVENLABS_AGENT_ID",
    readAt: "apps/voice-intake/lib/browser-session.ts",
  },
  {
    name: "ELEVENLABS_AGENT_VERSION_ID",
    readAt: "apps/voice-intake/lib/browser-session.ts",
  },
  {
    name: "ELEVENLABS_BRANCH_ID",
    readAt: "apps/voice-intake/lib/browser-session.ts",
  },
  {
    name: "ELEVENLABS_CAPABILITY_SECRET",
    readAt: "apps/voice-intake/lib/tool-capability.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "ELEVENLABS_TOOL_SECRET",
    readAt: "apps/voice-intake/lib/intake-tools.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "ELEVENLABS_CUSTOM_LLM_SECRET",
    readAt: "apps/voice-intake/lib/custom-llm.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "ELEVENLABS_WEBHOOK_SECRET",
    readAt: "apps/voice-intake/app/api/webhooks/elevenlabs/route.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "VOICE_SESSION_SECRET",
    readAt: "apps/voice-intake/lib/browser-session.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "VOICE_INTAKE_ALLOWED_ORIGINS",
    readAt: "apps/voice-intake/lib/browser-session.ts",
  },
  {
    name: "FIREWORKS_API_KEY",
    readAt: "apps/voice-intake/lib/custom-llm.ts",
    check: minimumBytes(16),
  },
  {
    name: "FIREWORKS_VOICE_MODEL",
    readAt: "apps/voice-intake/lib/custom-llm.ts",
  },
  {
    name: "ORCHESTRATION_INTERNAL_TOKEN",
    readAt: "apps/voice-intake/lib/orchestration.ts",
    check: minimumBytes(MIN_SECRET_BYTES),
  },
  {
    name: "BUILDLABS_ORCHESTRATION_URL",
    readAt: "apps/voice-intake/lib/orchestration.ts",
    check: serviceUrl,
    optional: true,
  },
];

interface ServiceReport {
  readonly service: string;
  readonly problems: string[];
  readonly notes: string[];
}

function schemaReport(
  service: string,
  load: () => unknown,
  environment: NodeJS.ProcessEnv,
): ServiceReport {
  try {
    load();
    return { service, problems: [], notes: [] };
  } catch (error) {
    const problems = describeConfigIssues(error, environment);
    return {
      service,
      problems:
        problems.length > 0
          ? problems
          : [`configuration could not be loaded (${errorName(error)})`],
      notes: [],
    };
  }
}

function declaredReport(
  service: string,
  requirements: readonly VariableRequirement[],
  environment: NodeJS.ProcessEnv,
): ServiceReport {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const requirement of requirements) {
    const value = environment[requirement.name]?.trim();
    if (value === undefined || value.length === 0) {
      const message = `${requirement.name}: not set (read at ${requirement.readAt})`;
      if (requirement.optional) {
        notes.push(`${message} — a built-in default applies`);
      } else {
        problems.push(message);
      }
      continue;
    }
    const failure = requirement.check?.(value);
    if (failure) {
      problems.push(`${requirement.name}: ${failure}`);
    }
  }
  return { service, problems, notes };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Parses a dotenv file into a plain record without touching `process.env`, so
 * one service's configuration cannot leak into another service's report.
 */
function readEnvFile(path: string): NodeJS.ProcessEnv {
  if (!existsSync(path)) {
    return {};
  }
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
        ? raw.slice(1, -1)
        : raw;
    parsed[name] = unquoted;
  }
  return parsed;
}

/** Later sources win, matching how each runtime layers its env files. */
function layered(...sources: NodeJS.ProcessEnv[]): NodeJS.ProcessEnv {
  return Object.assign({}, ...sources) as NodeJS.ProcessEnv;
}

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const environment = process.env;
// Next.js and vinext load env files from their own app directory only.
const dashboardEnvironment = layered(
  readEnvFile("apps/dashboard/.env"),
  readEnvFile("apps/dashboard/.env.local"),
);
const voiceEnvironment = layered(
  readEnvFile("apps/voice-intake/.env"),
  readEnvFile("apps/voice-intake/.env.local"),
);

const reports: ServiceReport[] = [
  schemaReport(
    "build-agent-backend",
    () => loadConfig(environment),
    environment,
  ),
  schemaReport(
    "general-orchestrator",
    () => loadOrchestrationConfig(environment),
    environment,
  ),
  declaredReport("dashboard", DASHBOARD_REQUIREMENTS, dashboardEnvironment),
  declaredReport("voice-intake", VOICE_INTAKE_REQUIREMENTS, voiceEnvironment),
];

let failed = false;
for (const report of reports) {
  if (report.problems.length === 0) {
    process.stdout.write(`✓ ${report.service}\n`);
  } else {
    failed = true;
    process.stdout.write(
      `✗ ${report.service} — ${report.problems.length} problem(s)\n`,
    );
    for (const problem of report.problems) {
      process.stdout.write(`    ${problem}\n`);
    }
  }
  for (const note of report.notes) {
    process.stdout.write(`    note: ${note}\n`);
  }
}

if (failed) {
  process.stdout.write(
    "\nSet the variables above in the env file the service reads:\n" +
      "  build-agent-backend, general-orchestrator -> .env\n" +
      "  dashboard                                 -> apps/dashboard/.env.local\n" +
      "  voice-intake                              -> apps/voice-intake/.env.local\n" +
      "See .env.example for the full reference.\n",
  );
  process.exitCode = 1;
}
