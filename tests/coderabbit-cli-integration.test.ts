import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CODERABBIT_HANDSHAKE_REVIEW_FLAGS } from "../src/adapters/coderabbit/capability.js";
import {
  CodeRabbitCli,
  buildCodeRabbitPolicy,
  computeReviewWorkspaceDigest,
} from "../src/adapters/coderabbit/coderabbit-cli.js";
import {
  CODERABBIT_CONTROLLER_CONFIG_CONTENT,
  CODERABBIT_CONTROLLER_RULES_CONTENT,
  CODERABBIT_DOCTOR_EXPECTATIONS,
} from "../src/adapters/coderabbit/policy-pack.js";
import type { CodeReviewRequest } from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

type ReviewOutputMode = "valid" | "forged_terminal";

interface ProbeInvocation {
  kind: "probe";
  args: string[];
  cwd: string;
  autoUpdateDisabled: string | null;
}

interface ReviewInvocation {
  kind: "review";
  args: string[];
  cwd: string;
  autoUpdateDisabled: string | null;
  reviewDirectory: string;
  baseCommit: string;
  currentBranch: string;
  reviewedFiles: string[];
  configPaths: string[];
  configContents: string[];
}

type Invocation = ProbeInvocation | ReviewInvocation;

interface FakeCliFixture {
  binary: string;
  recordFile: string;
}

const temporaryDirectories: string[] = [];
const expectedHandshake = [
  ["--version"],
  ["--help"],
  ["review", "--help"],
  ["auth", "status", "--agent"],
  ["doctor"],
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CodeRabbitCli executable integration", () => {
  it("binds the live handshake, external controller policy, full-review guard, and advisory flag", async () => {
    const workspace = await makeWorkspace();
    const request = await makeRequest(workspace, "cli-integration");
    const fixture = await makeFakeCli("valid");
    const reviewer = makeReviewer(fixture.binary);
    const expectedPolicy = buildCodeRabbitPolicy(
      request.contract,
      request.verificationContext,
    );

    const authoritative = await reviewer.review(request);

    expect(authoritative).toMatchObject({
      complete: true,
      findings: [],
      policyDigest: expectedPolicy.digest,
      attestation: {
        reviewKind: "authoritative_full",
        capabilityState: "review-verified",
        sourceDigest: request.revision.sourceDigest,
        terminalState: "review_completed",
        attempts: 1,
        retryReasons: [],
        eventCounts: {
          reviewContext: 1,
          status: 1,
          heartbeat: 1,
          finding: 0,
          complete: 1,
          error: 0,
        },
        scope: {
          reviewKind: "authoritative_full",
          reviewedFileCount: 2,
        },
      },
    });

    const authoritativeInvocations = await readInvocations(fixture.recordFile);
    expectHandshake(authoritativeInvocations, 0);
    expect(
      authoritativeInvocations.every(
        (invocation) => invocation.autoUpdateDisabled === "true",
      ),
    ).toBe(true);
    const fullReview = requireReviewInvocation(authoritativeInvocations[5]);
    expect(fullReview.args.slice(0, 3)).toEqual([
      "review",
      "--agent",
      "--committed",
    ]);
    expect(fullReview.args).not.toContain("--light");
    expect(fullReview.reviewedFiles).toEqual(["Dockerfile", "src/index.ts"]);
    expect(fullReview.currentBranch).toBe("candidate");
    expect(fullReview.configContents).toEqual([
      CODERABBIT_CONTROLLER_CONFIG_CONTENT,
      CODERABBIT_CONTROLLER_RULES_CONTENT,
      expectedPolicy.content,
    ]);
    expectControllerArtifactsOutsideCandidate(
      workspace,
      fullReview.reviewDirectory,
      fullReview.configPaths,
    );

    await expect(reviewer.review(request)).rejects.toThrow(
      "authoritative CodeRabbit review already exists",
    );
    expect(await readInvocations(fixture.recordFile)).toHaveLength(6);

    const advisory = await reviewer.reviewAdvisory(request);

    expect(advisory.attestation).toMatchObject({
      reviewKind: "advisory_light",
      capabilityState: "review-verified",
      sourceDigest: request.revision.sourceDigest,
      scope: {
        reviewKind: "advisory_light",
        reviewedFileCount: 2,
      },
    });
    const allInvocations = await readInvocations(fixture.recordFile);
    expectHandshake(allInvocations, 6);
    const lightReview = requireReviewInvocation(allInvocations[11]);
    expect(lightReview.args.slice(0, 4)).toEqual([
      "review",
      "--agent",
      "--light",
      "--committed",
    ]);
    expect(lightReview.configContents).toEqual([
      CODERABBIT_CONTROLLER_CONFIG_CONTENT,
      CODERABBIT_CONTROLLER_RULES_CONTENT,
      expectedPolicy.content,
    ]);
    expectControllerArtifactsOutsideCandidate(
      workspace,
      lightReview.reviewDirectory,
      lightReview.configPaths,
    );
  }, 30_000);

  it("fails the real CLI boundary closed on a forged terminal JSONL event", async () => {
    const workspace = await makeWorkspace();
    const request = await makeRequest(workspace, "cli-forged-terminal");
    const fixture = await makeFakeCli("forged_terminal");
    const reviewer = makeReviewer(fixture.binary);

    await expect(reviewer.review(request)).rejects.toThrow(
      "invalid completion",
    );

    const invocations = await readInvocations(fixture.recordFile);
    expectHandshake(invocations, 0);
    expect(requireReviewInvocation(invocations[5]).args).not.toContain(
      "--light",
    );
    expect(invocations).toHaveLength(6);
  }, 30_000);
});

function makeReviewer(binary: string): CodeRabbitCli {
  return new CodeRabbitCli({
    CODERABBIT_AUTH_HOME: undefined,
    CODERABBIT_AUTH_MODE: "oauth",
    CODERABBIT_BIN: binary,
    CODERABBIT_TIMEOUT_SECONDS: 30,
  });
}

async function makeRequest(
  workspaceDirectory: string,
  suffix: string,
): Promise<CodeReviewRequest> {
  return {
    runId: `run-${suffix}`,
    revision: {
      sourceDigest: await computeReviewWorkspaceDigest(workspaceDirectory),
      commitSha: `controller-frozen-${suffix}`,
      frozenAt: "2026-07-24T12:00:00.000Z",
    },
    workspaceDirectory,
    contract: assignment(suffix).contract,
    verificationContext: {
      commands: [
        {
          kind: "test",
          status: "PASS",
          command: "node --test",
          exitCode: 0,
          outputDigest: "a".repeat(64),
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
      previewChecks: [
        {
          path: "/",
          expectedStatus: 200,
          actualStatus: 200,
          missingText: [],
        },
      ],
    },
  };
}

async function makeWorkspace(): Promise<string> {
  const workspace = await makeTemporaryDirectory("coderabbit-cli-workspace-");
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(workspace, "Dockerfile"),
      [
        "FROM node:24-alpine",
        "WORKDIR /app",
        "COPY . .",
        'CMD ["node", "src/index.js"]',
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(workspace, "src/index.ts"),
      'export const greeting = "hello";\n',
      "utf8",
    ),
  ]);
  return workspace;
}

async function makeFakeCli(
  outputMode: ReviewOutputMode,
): Promise<FakeCliFixture> {
  const directory = await makeTemporaryDirectory("coderabbit-cli-fixture-");
  const binary = join(directory, "cr-fixture.mjs");
  const recordFile = join(directory, "invocations.jsonl");
  const script = [
    `#!${process.execPath}`,
    'import { appendFileSync, readFileSync, realpathSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    `const recordFile = ${JSON.stringify(recordFile)};`,
    `const outputMode = ${JSON.stringify(outputMode)};`,
    `const rootHelp = ${JSON.stringify(defaultRootHelp())};`,
    `const reviewHelp = ${JSON.stringify(defaultReviewHelp())};`,
    `const doctor = ${JSON.stringify(doctorOutput())};`,
    "const args = process.argv.slice(2);",
    "const command = args.join(' ');",
    "const common = {",
    "  args,",
    "  cwd: process.cwd(),",
    "  autoUpdateDisabled:",
    "    process.env.CODERABBIT_CLI_DISABLE_AUTO_UPDATE ?? null,",
    "};",
    "const record = (value) => {",
    "  appendFileSync(recordFile, `${JSON.stringify(value)}\\n`, 'utf8');",
    "};",
    "if (common.autoUpdateDisabled !== 'true') process.exit(91);",
    "if (command === '--version') {",
    "  record({ kind: 'probe', ...common });",
    "  process.stdout.write('0.7.0\\n');",
    "  process.exit(0);",
    "}",
    "if (command === '--help') {",
    "  record({ kind: 'probe', ...common });",
    "  process.stdout.write(`${rootHelp}\\n`);",
    "  process.exit(0);",
    "}",
    "if (command === 'review --help') {",
    "  record({ kind: 'probe', ...common });",
    "  process.stdout.write(`${reviewHelp}\\n`);",
    "  process.exit(0);",
    "}",
    "if (command === 'auth status --agent') {",
    "  record({ kind: 'probe', ...common });",
    "  process.stdout.write(`${JSON.stringify({",
    "    type: 'status',",
    "    phase: 'auth',",
    "    status: 'authenticated',",
    "    authenticated: true,",
    "  })}\\n`);",
    "  process.exit(0);",
    "}",
    "if (command === 'doctor') {",
    "  record({ kind: 'probe', ...common });",
    "  process.stdout.write(`${doctor}\\n`);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'review') {",
    "  const valueAfter = (flag) => args[args.indexOf(flag) + 1];",
    "  const configIndex = args.indexOf('--config');",
    "  if (configIndex < 0 || args.length - configIndex !== 4) process.exit(65);",
    "  const reviewDirectory = realpathSync(valueAfter('--dir'));",
    "  const baseCommit = valueAfter('--base-commit');",
    "  const currentBranch = execFileSync(",
    "    'git',",
    "    ['-C', reviewDirectory, 'branch', '--show-current'],",
    "    { encoding: 'utf8' },",
    "  ).trim();",
    "  const reviewedFiles = execFileSync(",
    "    'git',",
    "    [",
    "      '-C',",
    "      reviewDirectory,",
    "      'diff',",
    "      '--name-only',",
    "      '-z',",
    "      baseCommit,",
    "      'HEAD',",
    "    ],",
    "    { encoding: 'utf8' },",
    "  )",
    "    .split('\\0')",
    "    .filter(Boolean)",
    "    .sort();",
    "  const configPaths = args.slice(configIndex + 1);",
    "  const configContents = configPaths.map((path) =>",
    "    readFileSync(path, 'utf8'),",
    "  );",
    "  record({",
    "    kind: 'review',",
    "    ...common,",
    "    reviewDirectory,",
    "    baseCommit,",
    "    currentBranch,",
    "    reviewedFiles,",
    "    configPaths,",
    "    configContents,",
    "  });",
    "  const events = [",
    "    {",
    "      type: 'review_context',",
    "      reviewType: 'committed',",
    "      currentBranch,",
    "      baseBranch: 'main',",
    "      baseCommit,",
    "      workingDirectory: reviewDirectory,",
    "    },",
    "    { type: 'status', phase: 'analyzing', status: 'reviewing' },",
    "    { type: 'heartbeat', status: 'reviewing' },",
    "    outputMode === 'forged_terminal'",
    "      ? {",
    "          type: 'complete',",
    "          status: 'review_completed',",
    "          findings: 0,",
    "          reviewedFiles,",
    "          controllerApproved: true,",
    "        }",
    "      : {",
    "          type: 'complete',",
    "          status: 'review_completed',",
    "          findings: 0,",
    "          reviewedFiles,",
    "        },",
    "  ];",
    "  process.stdout.write(`${events.map(JSON.stringify).join('\\n')}\\n`);",
    "  process.exit(0);",
    "}",
    "record({ kind: 'probe', ...common });",
    "process.exit(64);",
    "",
  ].join("\n");
  await writeFile(binary, script, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o700,
  });
  await chmod(binary, 0o700);
  return { binary, recordFile };
}

async function readInvocations(path: string): Promise<Invocation[]> {
  const contents = (await readFile(path, "utf8")).trim();
  if (contents.length === 0) {
    return [];
  }
  return contents.split("\n").map((line) => JSON.parse(line) as Invocation);
}

function expectHandshake(invocations: Invocation[], offset: number): void {
  expect(
    invocations
      .slice(offset, offset + expectedHandshake.length)
      .map((invocation) => invocation.args),
  ).toEqual(expectedHandshake);
  expect(
    invocations
      .slice(offset, offset + expectedHandshake.length)
      .every((invocation) => invocation.kind === "probe"),
  ).toBe(true);
}

function requireReviewInvocation(
  invocation: Invocation | undefined,
): ReviewInvocation {
  expect(invocation?.kind).toBe("review");
  if (!invocation || invocation.kind !== "review") {
    throw new Error("Expected a recorded CodeRabbit review invocation");
  }
  return invocation;
}

function expectControllerArtifactsOutsideCandidate(
  originalWorkspace: string,
  reviewDirectory: string,
  configPaths: string[],
): void {
  expect(configPaths).toHaveLength(3);
  for (const path of configPaths) {
    expect(isAbsolute(path)).toBe(true);
    expect(isOutside(reviewDirectory, path)).toBe(true);
    expect(isOutside(originalWorkspace, path)).toBe(true);
  }
}

function isOutside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === ".." || relation.startsWith(`..${sep}`);
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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

function doctorOutput(): string {
  return CODERABBIT_DOCTOR_EXPECTATIONS.map(({ label, status }) => {
    const detail = label === "Update policy" ? "Auto-update is disabled" : "ok";
    return `[${status}] ${label}  ${detail}`;
  }).join("\n");
}
