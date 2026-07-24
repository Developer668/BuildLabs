import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CODERABBIT_HANDSHAKE_REVIEW_FLAGS,
  createCodeRabbitInvocationEnvironment,
  probeCodeRabbitCapabilities,
} from "../src/adapters/coderabbit/capability.js";
import {
  CODERABBIT_DOCTOR_EXPECTATIONS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
} from "../src/adapters/coderabbit/policy-pack.js";

interface FakeCliScenario {
  version?: string;
  versionExitCode?: number;
  rootHelp?: string;
  rootHelpExitCode?: number;
  reviewHelp?: string;
  reviewHelpExitCode?: number;
  authenticated?: boolean;
  authExitCode?: number;
  authPayload?: Record<string, unknown>;
  doctorOutput?: string;
  doctorExitCode?: number;
  mutateOnDoctor?: boolean;
  enforceControllerEnvironment?: boolean;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CodeRabbit capability handshake", () => {
  it("separates an uninstalled binary from every executable state", async () => {
    const diagnosticDirectory = await makeTemporaryDirectory();

    const report = await probeCodeRabbitCapabilities({
      binary: join(diagnosticDirectory, "missing-coderabbit"),
      diagnosticDirectory,
      env: probeEnvironment(),
    });

    expect(report).toMatchObject({
      state: "uninstalled",
      reasonCode: "binary_not_found",
      agentJsonl: false,
      authenticated: false,
      controllerConfig: "unverified",
      serviceConnectivity: "unverified",
      toolSupport: "unverified",
      updatePolicy: "unverified",
    });
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each(["0.6.9", "0.8.0"])(
    "fails closed on CLI version drift at %s",
    async (version) => {
      const fixture = await makeFakeCli({ version });

      const report = await probeFixture(fixture);

      expect(report).toMatchObject({
        state: "incompatible",
        reasonCode: "version_out_of_range",
        cliVersion: version,
        agentJsonl: false,
        authenticated: false,
      });
    },
  );

  it.each([
    {
      name: "a missing root command",
      scenario: {
        rootHelp: ["Commands:", "  auth", "  review"].join("\n"),
      },
      reasonCode: "root_commands_missing",
    },
    {
      name: "a missing review flag",
      scenario: {
        reviewHelp: defaultReviewHelp().replace("  --config\n", ""),
      },
      reasonCode: "required_review_flags_missing",
    },
  ])(
    "rejects $name before authentication",
    async ({ scenario, reasonCode }) => {
      const fixture = await makeFakeCli(scenario);

      const report = await probeFixture(fixture);

      expect(report).toMatchObject({
        state: "incompatible",
        reasonCode,
        authenticated: false,
      });
    },
  );

  it("separates valid but unauthenticated agent status", async () => {
    const fixture = await makeFakeCli({ authenticated: false });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "unauthenticated",
      reasonCode: "authentication_required",
      agentJsonl: true,
      authenticated: false,
      controllerConfig: "supported",
      toolSupport: "disabled-controller-policy",
      updatePolicy: "unverified",
    });
    expect(report.doctor).toBeUndefined();
  });

  it("treats malformed agent authentication as protocol incompatibility", async () => {
    const fixture = await makeFakeCli({
      authPayload: {
        authenticated: "yes",
      },
    });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "incompatible",
      reasonCode: "authentication_status_invalid",
      authenticated: false,
    });
  });

  it("fails closed on a permanent doctor command failure", async () => {
    const fixture = await makeFakeCli({ doctorExitCode: 7 });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "unhealthy",
      reasonCode: "doctor_check_failed",
      authenticated: true,
      serviceConnectivity: "healthy",
      doctor: {
        passed: 8,
        warnings: 1,
        failed: 0,
      },
    });
  });

  it("fails closed when a required service check is unhealthy", async () => {
    const fixture = await makeFakeCli({
      doctorOutput: doctorOutput({ "Backend reachable": "fail" }),
    });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "unhealthy",
      reasonCode: "doctor_check_failed",
      authenticated: true,
      serviceConnectivity: "unhealthy",
      doctor: {
        failed: 1,
      },
    });
  });

  it("requires the controlled disabled-update warning", async () => {
    const fixture = await makeFakeCli({
      doctorOutput: doctorOutput({ "Update policy": "pass" }),
    });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "unhealthy",
      reasonCode: "update_policy_not_enforced",
      authenticated: true,
      updatePolicy: "unverified",
    });
  });

  it("reaches healthy only with exact flags, controller config, and bounded tool claims", async () => {
    const fixture = await makeFakeCli({
      enforceControllerEnvironment: true,
    });

    const report = await probeFixture(fixture, {
      BUILDLABS_PRIVATE_SECRET: "must-not-reach-the-cli",
      CI: "true",
      CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "false",
      YAML_CONFIG: "/candidate/injected.yaml",
    });

    expect(report).toMatchObject({
      state: "healthy",
      agentJsonl: true,
      authenticated: true,
      updatePolicy: "disabled-and-digest-pinned",
      serviceConnectivity: "healthy",
      controllerConfig: "supported",
      toolSupport: "disabled-controller-policy",
      doctor: {
        passed: 8,
        warnings: 1,
        failed: 0,
      },
    });
    expect(report.reviewFlags).toEqual(CODERABBIT_HANDSHAKE_REVIEW_FLAGS);
    expect(report.supportedEventKinds).toEqual(
      CODERABBIT_SUPPORTED_EVENT_KINDS,
    );
    expect(report.cliExecutableDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.rootHelpDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.reviewHelpDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.reviewFlagsDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps authentication identity, doctor details, paths, and secrets out of reports", async () => {
    const identity = "private-user@example.invalid";
    const providerDetail = "provider-session-secret";
    const fixture = await makeFakeCli({
      authPayload: {
        account: identity,
        authenticated: true,
      },
      doctorOutput: doctorOutput({}, providerDetail),
    });

    const first = await probeFixture(fixture);
    const second = await probeFixture(fixture);
    const serialized = JSON.stringify(first);

    expect(first.state).toBe("healthy");
    expect(second.digest).toBe(first.digest);
    expect(serialized).not.toContain(identity);
    expect(serialized).not.toContain(providerDetail);
    expect(serialized).not.toContain(fixture.binary);
    expect(serialized).not.toContain(fixture.diagnosticDirectory);
  });

  it("detects an executable digest change during the probe", async () => {
    const fixture = await makeFakeCli({ mutateOnDoctor: true });

    const report = await probeFixture(fixture);

    expect(report).toMatchObject({
      state: "unhealthy",
      reasonCode: "binary_changed_during_probe",
      authenticated: true,
      updatePolicy: "unverified",
    });
  });
});

describe("CodeRabbit invocation environment", () => {
  it("allowlists runtime values, strips candidate overrides, and forces update isolation", () => {
    const environment = createCodeRabbitInvocationEnvironment(
      {
        HOME: "/credential-home",
        PATH: "/controller/bin",
        LANG: "C",
        CI: "true",
        CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "false",
        YAML_CONFIG: "/candidate/.coderabbit.yaml",
        BUILDLABS_PRIVATE_SECRET: "never-forward",
      },
      "/controller-owned-home",
    );

    expect(environment).toMatchObject({
      HOME: "/controller-owned-home",
      PATH: "/controller/bin",
      LANG: "C",
      CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "true",
      FORCE_COLOR: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_COLOR: "1",
      PAGER: "cat",
      TERM: "dumb",
    });
    expect(environment).not.toHaveProperty("CI");
    expect(environment).not.toHaveProperty("YAML_CONFIG");
    expect(environment).not.toHaveProperty("BUILDLABS_PRIVATE_SECRET");
  });
});

interface FakeCliFixture {
  binary: string;
  diagnosticDirectory: string;
}

async function makeFakeCli(
  scenario: FakeCliScenario = {},
): Promise<FakeCliFixture> {
  const diagnosticDirectory = await makeTemporaryDirectory();
  const binary = join(diagnosticDirectory, "coderabbit-fixture.mjs");
  const normalizedScenario = {
    version: "0.7.0",
    versionExitCode: 0,
    rootHelp: defaultRootHelp(),
    rootHelpExitCode: 0,
    reviewHelp: defaultReviewHelp(),
    reviewHelpExitCode: 0,
    authenticated: true,
    authExitCode: 0,
    authPayload: {},
    doctorOutput: doctorOutput(),
    doctorExitCode: 0,
    mutateOnDoctor: false,
    enforceControllerEnvironment: false,
    ...scenario,
  };
  const script = [
    `#!${process.execPath}`,
    'import { appendFileSync } from "node:fs";',
    `const scenario = ${JSON.stringify(normalizedScenario)};`,
    "if (scenario.enforceControllerEnvironment) {",
    "  const forbidden = ['BUILDLABS_PRIVATE_SECRET', 'CI', 'YAML_CONFIG'];",
    "  const invalid = forbidden.some((key) => process.env[key] !== undefined) ||",
    "    process.env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE !== 'true';",
    "  if (invalid) process.exit(91);",
    "}",
    "const command = process.argv.slice(2).join(' ');",
    "if (command === '--version') {",
    "  process.stdout.write(`${scenario.version}\\n`);",
    "  process.exit(scenario.versionExitCode);",
    "}",
    "if (command === '--help') {",
    "  process.stdout.write(`${scenario.rootHelp}\\n`);",
    "  process.exit(scenario.rootHelpExitCode);",
    "}",
    "if (command === 'review --help') {",
    "  process.stdout.write(`${scenario.reviewHelp}\\n`);",
    "  process.exit(scenario.reviewHelpExitCode);",
    "}",
    "if (command === 'auth status --agent') {",
    "  const status = {",
    "    type: 'status',",
    "    phase: 'auth',",
    "    status: scenario.authenticated ? 'authenticated' : 'unauthenticated',",
    "    authenticated: scenario.authenticated,",
    "    ...scenario.authPayload,",
    "  };",
    "  process.stdout.write(`${JSON.stringify(status)}\\n`);",
    "  process.exit(scenario.authExitCode);",
    "}",
    "if (command === 'doctor') {",
    "  process.stdout.write(`${scenario.doctorOutput}\\n`);",
    "  if (scenario.mutateOnDoctor) {",
    "    appendFileSync(process.argv[1], '\\n// mutated during capability probe\\n');",
    "  }",
    "  process.exit(scenario.doctorExitCode);",
    "}",
    "process.exit(64);",
    "",
  ].join("\n");
  await writeFile(binary, script, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o700,
  });
  await chmod(binary, 0o700);
  return { binary, diagnosticDirectory };
}

async function probeFixture(
  fixture: FakeCliFixture,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return await probeCodeRabbitCapabilities({
    binary: fixture.binary,
    diagnosticDirectory: fixture.diagnosticDirectory,
    env: {
      ...probeEnvironment(),
      ...envOverrides,
    },
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coderabbit-capability-"));
  temporaryDirectories.push(directory);
  return directory;
}

function probeEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    LANG: "C",
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  };
}

function defaultRootHelp(): string {
  return ["Commands:", "  auth", "  doctor", "  review"].join("\n");
}

function defaultReviewHelp(): string {
  return [
    "Usage: coderabbit review [options]",
    ...CODERABBIT_HANDSHAKE_REVIEW_FLAGS.map((flag) => `  ${flag}`),
  ].join("\n");
}

function doctorOutput(
  overrides: Partial<
    Record<
      (typeof CODERABBIT_DOCTOR_EXPECTATIONS)[number]["label"],
      "fail" | "pass" | "warn"
    >
  > = {},
  opaqueDetail = "ok",
): string {
  return CODERABBIT_DOCTOR_EXPECTATIONS.map(({ label, status }) => {
    const actualStatus = overrides[label] ?? status;
    const detail =
      label === "Update policy" && actualStatus === "warn"
        ? "Auto-update is disabled"
        : opaqueDetail;
    return `[${actualStatus}] ${label}  ${detail}`;
  }).join("\n");
}
