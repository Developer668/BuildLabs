import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";
import type { CodeReviewCapabilityReport } from "../../ports/index.js";
import {
  CODERABBIT_ADVISORY_REVIEW_FLAG,
  CODERABBIT_CONTROLLER_CONFIG_CONTENT,
  CODERABBIT_CONTROLLER_CONFIG_DIGEST,
  CODERABBIT_DOCTOR_EXPECTATIONS,
  CODERABBIT_POLICY_PACK_DIGEST,
  CODERABBIT_POLICY_PACK_VERSION,
  CODERABBIT_REQUIRED_REVIEW_FLAGS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
  CODERABBIT_TOOL_POLICY,
  isSupportedCodeRabbitVersion,
} from "./policy-pack.js";

const MAX_COMMAND_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const MAX_PROBE_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_SHORT_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_LONG_TIMEOUT_MILLISECONDS = 30_000;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "gu",
);

export const CODERABBIT_HANDSHAKE_REVIEW_FLAGS = [
  "--agent",
  "--light",
  "--committed",
  "--uncommitted",
  "--include-untracked",
  "--config",
  "--base",
  "--base-commit",
  "--dir",
  "--show-prompts",
] as const;

const REQUIRED_ROOT_COMMANDS = ["auth", "doctor", "review"] as const;
const DOCTOR_CHECK_LABELS = CODERABBIT_DOCTOR_EXPECTATIONS.map(
  (expectation) => expectation.label,
);
const CONNECTIVITY_CHECK_LABELS = [
  "Service URLs",
  "Backend reachable",
  "WebSocket reachable",
] as const;

type DoctorCheckLabel =
  (typeof CODERABBIT_DOCTOR_EXPECTATIONS)[number]["label"];
type DoctorCheckStatus = "pass" | "warn" | "fail";
type CapabilityFacts = Omit<
  CodeReviewCapabilityReport,
  "digest" | "reasonCode" | "state"
>;

export interface CodeRabbitCapabilityProbeInput {
  binary: string;
  env: NodeJS.ProcessEnv;
  diagnosticDirectory: string;
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
}

interface ProbeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface DoctorParseResult {
  valid: boolean;
  controlledUpdateWarning: boolean;
  serviceConnectivity: "healthy" | "unhealthy";
  summary: NonNullable<CodeReviewCapabilityReport["doctor"]>;
}

class ProbeCommandError extends Error {
  override readonly name = "ProbeCommandError";

  constructor(
    readonly code: "aborted" | "output_limit" | "spawn_failed" | "timed_out",
  ) {
    super(`CodeRabbit capability command failed: ${code}`);
  }
}

/**
 * Produces the controller-owned environment used for every CodeRabbit process.
 * Authentication state may be inherited, but repository configuration cannot
 * override the disabled update policy or inject an alternate YAML config.
 */
export function createCodeRabbitInvocationEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  credentialHome?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const passthroughKeys = [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "all_proxy",
  ] as const;
  for (const key of passthroughKeys) {
    const value = baseEnv[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  if (credentialHome) {
    env.HOME = credentialHome;
  }
  env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE = "true";
  env.FORCE_COLOR = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = "1";
  env.PAGER = "cat";
  env.TERM = "dumb";

  delete env.CI;
  return env;
}

export async function probeCodeRabbitCapabilities(
  input: CodeRabbitCapabilityProbeInput,
): Promise<CodeReviewCapabilityReport> {
  throwIfAborted(input.signal);
  const commandTimeoutCap = normalizeTimeout(input.timeoutMilliseconds);
  const env = createCodeRabbitInvocationEnvironment(input.env);
  const facts: CapabilityFacts = {
    policyPackVersion: CODERABBIT_POLICY_PACK_VERSION,
    policyPackDigest: CODERABBIT_POLICY_PACK_DIGEST,
    agentJsonl: false,
    supportedEventKinds: [],
    reviewFlags: [],
    authenticated: false,
    updatePolicy: "unverified",
    serviceConnectivity: "unverified",
    controllerConfig: "unverified",
    toolSupport: "unverified",
  };

  let executable: string | undefined;
  try {
    executable = await resolveExecutable(input.binary, env);
  } catch {
    rethrowAbort(input.signal);
  }
  if (!executable) {
    return finalizeReport("uninstalled", facts, "binary_not_found");
  }

  try {
    facts.cliExecutableDigest = await sha256File(executable);
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("uninstalled", facts, "binary_unreadable");
  }

  let versionResult: ProbeCommandResult;
  try {
    versionResult = await runProbeCommand({
      executable,
      args: ["--version"],
      cwd: input.diagnosticDirectory,
      env,
      signal: input.signal,
      timeoutMilliseconds: Math.min(
        commandTimeoutCap,
        DEFAULT_SHORT_TIMEOUT_MILLISECONDS,
      ),
    });
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("uninstalled", facts, "binary_execution_failed");
  }
  if (versionResult.exitCode !== 0) {
    return finalizeReport("incompatible", facts, "version_command_failed");
  }
  const parsedVersion = parseVersion(versionResult.stdout);
  if (!parsedVersion) {
    return finalizeReport("incompatible", facts, "version_unreadable");
  }
  facts.cliVersion = parsedVersion.text;
  if (!isSupportedCodeRabbitVersion(parsedVersion.parts)) {
    return finalizeReport("incompatible", facts, "version_out_of_range");
  }

  let rootHelpResult: ProbeCommandResult;
  try {
    rootHelpResult = await runProbeCommand({
      executable,
      args: ["--help"],
      cwd: input.diagnosticDirectory,
      env,
      signal: input.signal,
      timeoutMilliseconds: Math.min(
        commandTimeoutCap,
        DEFAULT_SHORT_TIMEOUT_MILLISECONDS,
      ),
    });
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("incompatible", facts, "root_help_failed");
  }
  if (rootHelpResult.exitCode !== 0) {
    return finalizeReport("incompatible", facts, "root_help_failed");
  }
  const rootHelp = normalizeCommandOutput(rootHelpResult);
  facts.rootHelpDigest = sha256(rootHelp);
  if (
    !REQUIRED_ROOT_COMMANDS.every((command) =>
      hasRootCommand(rootHelp, command),
    )
  ) {
    return finalizeReport("incompatible", facts, "root_commands_missing");
  }

  let reviewHelpResult: ProbeCommandResult;
  try {
    reviewHelpResult = await runProbeCommand({
      executable,
      args: ["review", "--help"],
      cwd: input.diagnosticDirectory,
      env,
      signal: input.signal,
      timeoutMilliseconds: Math.min(
        commandTimeoutCap,
        DEFAULT_SHORT_TIMEOUT_MILLISECONDS,
      ),
    });
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("incompatible", facts, "review_help_failed");
  }
  if (reviewHelpResult.exitCode !== 0) {
    return finalizeReport("incompatible", facts, "review_help_failed");
  }
  const reviewHelp = normalizeCommandOutput(reviewHelpResult);
  facts.reviewHelpDigest = sha256(reviewHelp);
  facts.reviewFlags = CODERABBIT_HANDSHAKE_REVIEW_FLAGS.filter((flag) =>
    hasReviewFlag(reviewHelp, flag),
  );
  facts.reviewFlagsDigest = sha256(canonicalJson(facts.reviewFlags));
  if (
    !CODERABBIT_REQUIRED_REVIEW_FLAGS.every((flag) =>
      facts.reviewFlags.includes(flag),
    ) ||
    !facts.reviewFlags.includes(CODERABBIT_ADVISORY_REVIEW_FLAG) ||
    facts.reviewFlags.length !== CODERABBIT_HANDSHAKE_REVIEW_FLAGS.length
  ) {
    return finalizeReport(
      "incompatible",
      facts,
      "required_review_flags_missing",
    );
  }

  facts.agentJsonl = true;
  facts.supportedEventKinds = [...CODERABBIT_SUPPORTED_EVENT_KINDS];
  if (!controllerPolicyIsInternallyConsistent()) {
    return finalizeReport("incompatible", facts, "controller_policy_invalid");
  }
  facts.controllerConfig = "supported";
  facts.toolSupport = "disabled-controller-policy";

  let authenticationResult: ProbeCommandResult;
  try {
    authenticationResult = await runProbeCommand({
      executable,
      args: ["auth", "status", "--agent"],
      cwd: input.diagnosticDirectory,
      env,
      signal: input.signal,
      timeoutMilliseconds: Math.min(
        commandTimeoutCap,
        DEFAULT_LONG_TIMEOUT_MILLISECONDS,
      ),
    });
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("unhealthy", facts, "authentication_probe_failed");
  }
  const authenticated = parseAgentAuthentication(authenticationResult.stdout);
  if (authenticated === undefined) {
    return finalizeReport(
      "incompatible",
      facts,
      "authentication_status_invalid",
    );
  }
  if (!authenticated) {
    return finalizeReport("unauthenticated", facts, "authentication_required");
  }
  if (authenticationResult.exitCode !== 0) {
    return finalizeReport("unhealthy", facts, "authentication_probe_failed");
  }
  facts.authenticated = true;

  let diagnosticRepository: string | undefined;
  try {
    diagnosticRepository = await createDiagnosticRepository(
      input.diagnosticDirectory,
      env,
      input.signal,
      Math.min(commandTimeoutCap, DEFAULT_SHORT_TIMEOUT_MILLISECONDS),
    );
  } catch {
    rethrowAbort(input.signal);
    return finalizeReport("unhealthy", facts, "diagnostic_repository_failed");
  }

  try {
    let doctorResult: ProbeCommandResult;
    try {
      doctorResult = await runProbeCommand({
        executable,
        args: ["doctor"],
        cwd: diagnosticRepository,
        env,
        signal: input.signal,
        timeoutMilliseconds: Math.min(
          commandTimeoutCap,
          DEFAULT_LONG_TIMEOUT_MILLISECONDS,
        ),
      });
    } catch {
      rethrowAbort(input.signal);
      return finalizeReport("unhealthy", facts, "doctor_command_failed");
    }

    const doctor = parseDoctorOutput(
      normalizeCommandOutput(doctorResult, false),
    );
    facts.doctor = doctor.summary;
    facts.serviceConnectivity = doctor.serviceConnectivity;
    if (!doctor.valid) {
      return finalizeReport("unhealthy", facts, "doctor_output_invalid");
    }
    if (doctorResult.exitCode !== 0 || doctor.summary.failed > 0) {
      return finalizeReport("unhealthy", facts, "doctor_check_failed");
    }
    if (!doctor.controlledUpdateWarning) {
      return finalizeReport("unhealthy", facts, "update_policy_not_enforced");
    }
    if (doctor.serviceConnectivity !== "healthy") {
      return finalizeReport("unhealthy", facts, "service_unreachable");
    }

    let executableDigestAfter: string;
    try {
      executableDigestAfter = await sha256File(executable);
    } catch {
      return finalizeReport("unhealthy", facts, "binary_post_probe_unreadable");
    }
    if (executableDigestAfter !== facts.cliExecutableDigest) {
      return finalizeReport("unhealthy", facts, "binary_changed_during_probe");
    }
    facts.updatePolicy = "disabled-and-digest-pinned";
    return finalizeReport("healthy", facts);
  } finally {
    await rm(diagnosticRepository, { force: true, recursive: true });
  }
}

function finalizeReport(
  state: CodeReviewCapabilityReport["state"],
  facts: CapabilityFacts,
  reasonCode?: string,
): CodeReviewCapabilityReport {
  const report = {
    state,
    ...facts,
    ...(reasonCode ? { reasonCode } : {}),
  };
  return {
    ...report,
    digest: sha256(canonicalJson(report)),
  };
}

function normalizeTimeout(timeoutMilliseconds?: number): number {
  if (
    timeoutMilliseconds === undefined ||
    !Number.isFinite(timeoutMilliseconds)
  ) {
    return MAX_PROBE_TIMEOUT_MILLISECONDS;
  }
  return Math.max(
    1,
    Math.min(MAX_PROBE_TIMEOUT_MILLISECONDS, Math.floor(timeoutMilliseconds)),
  );
}

async function resolveExecutable(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (
    binary.trim() !== binary ||
    binary.length === 0 ||
    binary.includes("\0")
  ) {
    return undefined;
  }

  const candidates =
    isAbsolute(binary) || binary.includes("/")
      ? [resolve(binary)]
      : (env.PATH ?? "")
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => join(entry, binary));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const metadata = await lstat(resolved);
      if (metadata.isFile()) {
        return resolved;
      }
    } catch {
      // Continue through PATH without exposing host paths in the report.
    }
  }
  return undefined;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const rawChunk of createReadStream(path)) {
    const chunk: unknown = rawChunk;
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("CodeRabbit executable stream was not binary");
    }
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function parseVersion(
  stdout: string,
): { text: string; parts: readonly number[] } | undefined {
  const normalized = stripAnsi(stdout).trim();
  const match =
    /^(?:coderabbit(?:\s+cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/iu.exec(
      normalized,
    );
  if (!match) {
    return undefined;
  }
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return undefined;
  }
  return {
    text: parts.join("."),
    parts,
  };
}

function normalizeCommandOutput(
  result: ProbeCommandResult,
  includeStderr = true,
): string {
  const combined = includeStderr
    ? `${result.stdout}\n${result.stderr}`
    : result.stdout;
  return stripAnsi(combined)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function hasRootCommand(help: string, command: string): boolean {
  const escaped = escapeRegularExpression(command);
  return new RegExp(`^\\s{0,8}${escaped}(?:\\s|$)`, "imu").test(help);
}

function hasReviewFlag(help: string, flag: string): boolean {
  const escaped = escapeRegularExpression(flag);
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|,|=|$)`, "mu").test(help);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function controllerPolicyIsInternallyConsistent(): boolean {
  if (
    sha256(CODERABBIT_CONTROLLER_CONFIG_CONTENT) !==
      CODERABBIT_CONTROLLER_CONFIG_DIGEST ||
    !CODERABBIT_TOOL_POLICY.deterministicBuildLabsScannersRemainAuthoritative ||
    CODERABBIT_TOOL_POLICY.jsonlReportsToolCoverage ||
    CODERABBIT_TOOL_POLICY.proofBearing
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(CODERABBIT_CONTROLLER_CONFIG_CONTENT) as {
      reviews?: { tools?: Record<string, unknown> };
    };
    const tools = parsed.reviews?.tools;
    return (
      tools !== undefined &&
      Object.keys(tools).length ===
        CODERABBIT_TOOL_POLICY.disabledTools.length &&
      CODERABBIT_TOOL_POLICY.configuredTools.every((tool) =>
        Object.hasOwn(tools, tool),
      ) &&
      CODERABBIT_TOOL_POLICY.disabledTools.every(({ name }) => {
        const configuration = tools[name];
        if (
          !configuration ||
          typeof configuration !== "object" ||
          Array.isArray(configuration)
        ) {
          return false;
        }
        const values = configuration as Record<string, unknown>;
        return name === "ast-grep"
          ? values.essential_rules === false &&
              Array.isArray(values.rule_dirs) &&
              values.rule_dirs.length === 0 &&
              Array.isArray(values.util_dirs) &&
              values.util_dirs.length === 0 &&
              Array.isArray(values.packages) &&
              values.packages.length === 0
          : values.enabled === false;
      })
    );
  } catch {
    return false;
  }
}

function parseAgentAuthentication(stdout: string): boolean | undefined {
  if (Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (
    parsed.type !== "status" ||
    parsed.phase !== "auth" ||
    typeof parsed.status !== "string" ||
    parsed.status.length === 0 ||
    parsed.status.length > 128 ||
    typeof parsed.authenticated !== "boolean"
  ) {
    return undefined;
  }
  if (parsed.authenticated && parsed.status !== "authenticated") {
    return undefined;
  }
  return parsed.authenticated;
}

function parseDoctorOutput(output: string): DoctorParseResult {
  const checks = new Map<DoctorCheckLabel, DoctorCheckStatus>();
  let invalid = false;

  for (const line of output.split("\n")) {
    const statusMatch = /^\s*\[(pass|warn|fail)\]\s+(.+?)\s*$/iu.exec(line);
    if (!statusMatch) {
      continue;
    }
    const status = statusMatch[1] as DoctorCheckStatus;
    const remainder = statusMatch[2] ?? "";
    const label = DOCTOR_CHECK_LABELS.find(
      (candidate) =>
        remainder === candidate ||
        (remainder.startsWith(candidate) &&
          /^\s{2,}/u.test(remainder.slice(candidate.length))),
    );
    if (!label || checks.has(label)) {
      invalid = true;
      continue;
    }
    checks.set(label, status);
    if (
      label === "Update policy" &&
      status === "warn" &&
      !/\bauto-update is disabled\b/iu.test(remainder)
    ) {
      invalid = true;
    }
  }

  if (checks.size !== DOCTOR_CHECK_LABELS.length) {
    invalid = true;
  }
  const passed = [...checks.values()].filter(
    (status) => status === "pass",
  ).length;
  const warnings = [...checks.values()].filter(
    (status) => status === "warn",
  ).length;
  const failed = [...checks.values()].filter(
    (status) => status === "fail",
  ).length;
  const controlledUpdateWarning =
    checks.get("Update policy") === "warn" &&
    warnings === 1 &&
    DOCTOR_CHECK_LABELS.filter((label) => label !== "Update policy").every(
      (label) => checks.get(label) === "pass",
    );
  const serviceConnectivity = CONNECTIVITY_CHECK_LABELS.every(
    (label) => checks.get(label) === "pass",
  )
    ? "healthy"
    : "unhealthy";
  const digest = sha256(
    canonicalJson(
      DOCTOR_CHECK_LABELS.map((label) => ({
        label,
        status: checks.get(label) ?? "missing",
      })),
    ),
  );

  return {
    valid: !invalid,
    controlledUpdateWarning,
    serviceConnectivity,
    summary: {
      passed,
      warnings,
      failed,
      digest,
    },
  };
}

async function createDiagnosticRepository(
  diagnosticDirectory: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): Promise<string> {
  const root = await realpath(resolve(diagnosticDirectory));
  if (!(await stat(root)).isDirectory()) {
    throw new Error("CodeRabbit diagnostic root is not a directory");
  }
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(join(root, ".buildlabs-coderabbit-doctor-"));

  try {
    await requireSuccessfulCommand({
      executable: "git",
      args: ["init", "--quiet", "--initial-branch=main", repository],
      cwd: root,
      env,
      signal,
      timeoutMilliseconds,
    });
    const readmePath = join(repository, "README.md");
    if (dirname(readmePath) !== repository) {
      throw new Error("CodeRabbit diagnostic path escaped its repository");
    }
    await writeFile(readmePath, "# BuildLabs CodeRabbit diagnostic fixture\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await requireSuccessfulCommand({
      executable: "git",
      args: ["-C", repository, "add", "--", "README.md"],
      cwd: root,
      env,
      signal,
      timeoutMilliseconds,
    });
    await requireSuccessfulCommand({
      executable: "git",
      args: [
        "-C",
        repository,
        "-c",
        "user.name=BuildLabs Controller",
        "-c",
        "user.email=controller@buildlabs.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "controller diagnostic baseline",
      ],
      cwd: root,
      env,
      signal,
      timeoutMilliseconds,
    });
    return repository;
  } catch (error) {
    await rm(repository, { force: true, recursive: true });
    throw error;
  }
}

async function requireSuccessfulCommand(
  input: Parameters<typeof runProbeCommand>[0],
): Promise<void> {
  const result = await runProbeCommand(input);
  if (result.exitCode !== 0) {
    throw new Error("Controller diagnostic command failed");
  }
}

async function runProbeCommand(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  timeoutMilliseconds: number;
}): Promise<ProbeCommandResult> {
  throwIfAborted(input.signal);
  return await new Promise<ProbeCommandResult>((resolvePromise, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    };
    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (
      destination: Buffer[],
      chunk: Buffer | string,
      stream: "stderr" | "stdout",
    ): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") {
        stdoutBytes += buffer.byteLength;
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
          settleReject(new ProbeCommandError("output_limit"));
          return;
        }
      } else {
        stderrBytes += buffer.byteLength;
        if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
          settleReject(new ProbeCommandError("output_limit"));
          return;
        }
      }
      destination.push(buffer);
    };
    const abort = (): void => {
      settleReject(new ProbeCommandError("aborted"));
    };
    const timer = setTimeout(() => {
      settleReject(new ProbeCommandError("timed_out"));
    }, input.timeoutMilliseconds);

    child.stdout.on("data", (chunk: Buffer | string) => {
      collect(stdoutChunks, chunk, "stdout");
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      collect(stderrChunks, chunk, "stderr");
    });
    child.once("error", () => {
      settleReject(new ProbeCommandError("spawn_failed"));
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: typeof code === "number" && signal === null ? code : 128,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
    input.signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    rethrowAbort(signal);
  }
}

function rethrowAbort(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("CodeRabbit capability probe aborted");
}
