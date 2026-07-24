import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODERABBIT_ADVISORY_REVIEW_FLAG,
  CODERABBIT_CONFIG_SCHEMA_DIGEST,
  CODERABBIT_CONFIG_SCHEMA_VERSION,
  CODERABBIT_CONTROLLER_CONFIG_CONTENT,
  CODERABBIT_CONTROLLER_CONFIG_DIGEST,
  CODERABBIT_CONTROLLER_RULES,
  CODERABBIT_CONTROLLER_RULES_CONTENT,
  CODERABBIT_CONTROLLER_RULES_DIGEST,
  CODERABBIT_EVENT_SCHEMA_DESCRIPTOR,
  CODERABBIT_EVENT_SCHEMA_DIGEST,
  CODERABBIT_EVENT_SCHEMA_VERSION,
  CODERABBIT_MAXIMUM_CLI_VERSION_EXCLUSIVE,
  CODERABBIT_MINIMUM_CLI_VERSION,
  CODERABBIT_POLICY_PACK_DIGEST,
  CODERABBIT_POLICY_PACK_VERSION,
  CODERABBIT_REQUIRED_REVIEW_FLAGS,
  CODERABBIT_RETRY_DELAYS_MILLISECONDS,
  CODERABBIT_SUPPORTED_EVENT_KINDS,
  CODERABBIT_TOOL_POLICY,
  CODERABBIT_TOOL_POLICY_DIGEST,
  classifyCodeRabbitFinding,
  compareCodeRabbitVersion,
  isSupportedCodeRabbitVersion,
} from "../src/adapters/coderabbit/policy-pack.js";
import {
  CodeRabbitProtocolError,
  type ExpectedCodeRabbitReviewContext,
  parseCodeRabbitEvents,
  runCodeRabbitReviewWithRetry,
} from "../src/adapters/coderabbit/protocol.js";
import {
  codeRabbitSemanticReviewFiles,
  computeReviewWorkspaceDigest,
  inspectReviewWorkspace,
  isReviewControlPath,
  validateReviewFindingPaths,
} from "../src/adapters/coderabbit/workspace-policy.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";

const temporaryDirectories: string[] = [];

const expectedContext: ExpectedCodeRabbitReviewContext = {
  reviewKind: "authoritative_full",
  reviewType: "committed",
  currentBranch: "buildlabs-candidate",
  baseCommit: "a".repeat(40),
  workingDirectory: "/controller/review",
  expectedFiles: ["Dockerfile", "src/index.ts"],
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CodeRabbit strict agent JSONL protocol", () => {
  it("accepts one fully bound context, progress stream, finding, and terminal", () => {
    const output = jsonl([
      reviewContext(),
      { type: "status", phase: "analyzing", status: "reviewing" },
      { type: "heartbeat", status: "reviewing" },
      {
        type: "finding",
        severity: "minor",
        fileName: "src/index.ts",
        codegenInstructions: "The input should be validated before use.",
        suggestions: ["Use the existing schema parser."],
      },
      {
        type: "complete",
        status: "review_completed",
        findings: 1,
        reviewedFiles: ["src/index.ts", "Dockerfile"],
      },
    ]);

    const result = parseCodeRabbitEvents(output, expectedContext);

    expect(result).toMatchObject({
      complete: true,
      terminalState: "review_completed",
      eventCounts: {
        reviewContext: 1,
        status: 1,
        heartbeat: 1,
        finding: 1,
        complete: 1,
        error: 0,
      },
      findings: [
        {
          severity: "minor",
          fileName: "src/index.ts",
          message: "The input should be validated before use.",
          category: "code-quality",
        },
      ],
    });
    expect(result.rawDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.reviewContextDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.scopeDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses comment text when the live CLI emits an empty codegen prompt", () => {
    const result = parseCodeRabbitEvents(
      jsonl([
        reviewContext(),
        { type: "status", phase: "analyzing", status: "reviewing" },
        {
          type: "finding",
          severity: "minor",
          fileName: "src/index.ts",
          codegenInstructions: "",
          comment: "Validate this behavior.",
          suggestions: [],
        },
        {
          type: "complete",
          status: "review_completed",
          findings: 1,
          reviewedFiles: [...expectedContext.expectedFiles],
        },
      ]),
      expectedContext,
    );

    expect(result.findings[0]).toMatchObject({
      message: "Validate this behavior.",
      fileName: "src/index.ts",
    });
    expect(result.findings[0]).not.toHaveProperty("codegenInstructions");
  });

  it.each([
    {
      name: "malformed JSON",
      output: () => `${JSON.stringify(reviewContext())}\n{not-json`,
      expected: "malformed JSONL",
    },
    {
      name: "an unknown event kind",
      output: () =>
        jsonl([
          reviewContext(),
          { type: "progress", status: "reviewing" },
          complete(),
        ]),
      expected: "unsupported event type",
    },
    {
      name: "a line over the byte limit",
      output: () =>
        jsonl([
          reviewContext(),
          {
            type: "status",
            status: "reviewing",
            message: "x".repeat(256 * 1_024),
          },
          complete(),
        ]),
      expected: "oversized event",
    },
    {
      name: "an undeclared field on a known event",
      output: () =>
        jsonl([
          reviewContext(),
          { type: "status", status: "reviewing", forged: true },
          complete(),
        ]),
      expected: "invalid status",
    },
  ])("rejects $name", ({ output, expected }) => {
    expect(() => parseCodeRabbitEvents(output(), expectedContext)).toThrow(
      expected,
    );
  });

  it("rejects missing, duplicate, forged, and post-terminal events", () => {
    const cases = [
      {
        output: jsonl([reviewContext()]),
        expected: "did not emit a completion event",
      },
      {
        output: jsonl([reviewContext(), reviewContext(), complete()]),
        expected: "multiple review context events",
      },
      {
        output: jsonl([reviewContext(), complete(), complete()]),
        expected: "data after its terminal event",
      },
      {
        output: jsonl([
          reviewContext(),
          {
            type: "finding",
            severity: "major",
            fileName: "src/index.ts",
            codegenInstructions: "",
            comment: "Return errors through the typed result.",
            suggestions: [],
          },
          { ...complete(), findings: 0 },
        ]),
        expected: "finding count did not match",
      },
      {
        output: jsonl([
          reviewContext(),
          complete(),
          { type: "heartbeat", status: "reviewing" },
        ]),
        expected: "data after its terminal event",
      },
      {
        output: jsonl([
          reviewContext(),
          {
            type: "error",
            errorType: "review",
            message: "Provider failure.",
            recoverable: false,
            retryable: false,
          },
          complete(),
        ]),
        expected: "data after its terminal event",
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        parseCodeRabbitEvents(testCase.output, expectedContext),
      ).toThrow(testCase.expected);
    }
  });

  it("rejects skipped, context-mismatched, missing, duplicate, or partial scope", () => {
    const wrongContext = reviewContext();
    wrongContext.baseCommit = "b".repeat(40);
    const cases = [
      {
        output: jsonl([
          reviewContext(),
          { type: "status", phase: "analyzing", status: "review_skipped" },
          complete(),
        ]),
        expected: "skipped the review",
      },
      {
        output: jsonl([wrongContext, complete()]),
        expected: "context did not match controller scope",
      },
      {
        output: jsonl([
          reviewContext(),
          {
            type: "complete",
            status: "review_completed",
            findings: 0,
          },
        ]),
        expected: "invalid completion",
      },
      {
        output: jsonl([
          reviewContext(),
          {
            ...complete(),
            reviewedFiles: ["src/index.ts", "src/index.ts"],
          },
        ]),
        expected: "partial or mismatched",
      },
      {
        output: jsonl([
          reviewContext(),
          {
            ...complete(),
            reviewedFiles: ["src/index.ts"],
          },
        ]),
        expected: "partial or mismatched",
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        parseCodeRabbitEvents(testCase.output, expectedContext),
      ).toThrow(testCase.expected);
    }
  });

  it("never accepts a large-scope error's narrower candidates", () => {
    const error = captureProtocolError(() =>
      parseCodeRabbitEvents(
        jsonl([
          reviewContext(),
          {
            type: "error",
            errorType: "review",
            message: "The requested scope is too large.",
            recoverable: false,
            retryable: false,
            actualFiles: 2_001,
            maxFiles: 2_000,
            candidatesNote: "Narrower alternatives are available.",
            candidates: [
              {
                label: "src only",
                args: ["review", "--dir", "src"],
              },
            ],
          },
        ]),
        expectedContext,
      ),
    );

    expect(error.message).toContain("rejected the authoritative scope");
    expect(error.retryReason).toBeUndefined();
  });

  it("rejects finding path escapes before they can enter repair evidence", () => {
    expect(() =>
      parseCodeRabbitEvents(
        jsonl([
          reviewContext(),
          {
            type: "finding",
            severity: "major",
            fileName: "../outside.ts",
            codegenInstructions: "",
            comment: "Invalid location.",
            suggestions: [],
          },
          complete(),
        ]),
        expectedContext,
      ),
    ).toThrow("invalid finding");
  });
});

describe("CodeRabbit typed retry policy", () => {
  it("marks only a structured retryable rate-limit terminal as transient", () => {
    const transient = captureProtocolError(() =>
      parseCodeRabbitEvents(
        jsonl([
          reviewContext(),
          {
            type: "error",
            errorType: "rate_limit",
            code: 429,
            message: "Rate limit exceeded.",
            recoverable: true,
            retryable: true,
          },
        ]),
        expectedContext,
      ),
    );
    expect(transient.retryReason).toBe("structured_rate_limit");

    for (const event of [
      {
        type: "error",
        errorType: "rate_limit",
        code: 429,
        message: "Rate limit exceeded.",
        recoverable: false,
        retryable: false,
      },
      {
        type: "error",
        errorType: "auth",
        message: "Authentication failed.",
        recoverable: false,
        retryable: true,
      },
      {
        type: "error",
        errorType: "review",
        message: "Review configuration failed.",
        recoverable: false,
        retryable: true,
      },
    ]) {
      const permanent = captureProtocolError(() =>
        parseCodeRabbitEvents(jsonl([reviewContext(), event]), expectedContext),
      );
      expect(permanent.retryReason).toBeUndefined();
    }
  });

  it("rejects findings outside the controller-attested reviewed file set", () => {
    expect(() =>
      parseCodeRabbitEvents(
        jsonl([
          reviewContext(),
          {
            type: "finding",
            severity: "minor",
            fileName: "other.ts",
            codegenInstructions: "",
            comment: "This file was not part of the reviewed scope.",
            suggestions: [],
          },
          { ...complete(), findings: 1 },
        ]),
        expectedContext,
      ),
    ).toThrow("outside controller review scope");
  });

  it("does not retry a rate-limit event mixed with a parser failure", () => {
    const mixed = captureProtocolError(() =>
      parseCodeRabbitEvents(
        [
          JSON.stringify(reviewContext()),
          "{not-json",
          JSON.stringify({
            type: "error",
            errorType: "rate_limit",
            message: "Rate limit exceeded.",
            recoverable: true,
            retryable: true,
          }),
        ].join("\n"),
        expectedContext,
      ),
    );

    expect(mixed.message).toContain("malformed JSONL");
    expect(mixed.retryReason).toBeUndefined();
  });

  it("uses the bounded 15/30-second schedule for typed failures", async () => {
    vi.useFakeTimers();
    const retryEvents: Array<{
      reason: string;
      attempt: number;
      delay: number;
    }> = [];
    let attempts = 0;
    const review = runCodeRabbitReviewWithRetry(
      () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(
            new CodeRabbitProtocolError(
              "CodeRabbit did not emit a completion event",
              "missing_terminal_completion",
            ),
          );
        }
        return Promise.resolve("complete");
      },
      {
        onRetry: (reason, attempt, delay) => {
          retryEvents.push({ reason, attempt, delay });
        },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(review).resolves.toBe("complete");
    expect(attempts).toBe(3);
    expect(retryEvents).toEqual([
      {
        reason: "missing_terminal_completion",
        attempt: 1,
        delay: 15_000,
      },
      {
        reason: "missing_terminal_completion",
        attempt: 2,
        delay: 30_000,
      },
    ]);
  });

  it("does not retry prose lookalikes or permanent protocol errors", async () => {
    vi.useFakeTimers();
    for (const error of [
      new Error("rate limit"),
      new CodeRabbitProtocolError("authentication failed"),
      new CodeRabbitProtocolError("configuration failed"),
    ]) {
      let attempts = 0;
      const result = runCodeRabbitReviewWithRetry(() => {
        attempts += 1;
        return Promise.reject(error);
      });

      await expect(result).rejects.toBe(error);
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe("CodeRabbit candidate policy isolation", () => {
  it.each([
    ".CodeRabbit.YML",
    "CODERABBIT.TOML",
    ".coderabbit-security",
    "nested/AGENT.md",
    "nested/.GITLEAKS.toml",
    "eslint.config.js",
    ".eslintrc.cjs",
    "biome.jsonc",
    ".shellcheckrc",
    ".gitleaksignore",
    ".semgrepignore",
    "doctor.config.ts",
    "react-doctor.config.json",
    ".pnpmfile.cjs",
    "buildlabs-coderabbit-config.yaml",
    ".github/instructions/review.instructions.md",
    ".clinerules/security.md",
  ])("rejects alternate or case-shifted control path %s", async (path) => {
    expect(isReviewControlPath(path)).toBe(true);
    const workspace = await makeWorkspace({
      [path]: "candidate supplied review metadata\n",
    });
    await expect(inspectReviewWorkspace(workspace)).rejects.toThrow(
      "controller-owned review metadata",
    );
  });

  it("finds ignored and generated review metadata", async () => {
    const workspace = await makeWorkspace({
      ".gitignore": "generated/\n",
      "generated/.coderabbit.yaml": "reviews: {}\n",
      "src/index.ts": "export const value = 1;\n",
    });

    await expect(inspectReviewWorkspace(workspace)).rejects.toThrow(
      "generated/.coderabbit.yaml",
    );
  });

  it.each([
    { ".git/config": "[core]\n" },
    { ".gitmodules": '[submodule "vendor"]\n' },
    { "vendor/.git/HEAD": "ref: refs/heads/main\n" },
  ])("rejects nested repositories and submodule metadata", async (files) => {
    const workspace = await makeWorkspace(files);
    await expect(inspectReviewWorkspace(workspace)).rejects.toThrow(
      "controller-owned review metadata",
    );
  });

  it("rejects symlinks, including paths that escape the workspace", async () => {
    const outside = await makeWorkspace({
      "outside.ts": "export const outside = true;\n",
    });
    const workspace = await makeWorkspace({
      "src/index.ts": "export const inside = true;\n",
    });
    await symlink(
      join(outside, "outside.ts"),
      join(workspace, "src", "linked.ts"),
    );

    await expect(inspectReviewWorkspace(workspace)).rejects.toThrow(
      "symbolic link",
    );
    await expect(
      validateReviewFindingPaths(workspace, [
        {
          severity: "major",
          fileName: "src/linked.ts",
          message: "The path must remain inside the workspace.",
        },
      ]),
    ).rejects.toThrow("regular file");
  });

  it.each([
    { "nested/package.json": "{}\n" },
    { "nested/package-lock.json": "{}\n" },
    { "nested/pnpm-lock.yaml": "lockfileVersion: 9\n" },
    { "nested/bun.lock": "{}\n" },
  ])("rejects alternate dependency roots", async (files) => {
    const workspace = await makeWorkspace({
      "src/index.ts": "export const value = 1;\n",
      ...files,
    });
    await expect(inspectReviewWorkspace(workspace)).rejects.toThrow(
      "alternate dependency root",
    );
  });

  it("rejects mixed root lockfile families and unsupported root locks", async () => {
    const mixed = await makeWorkspace({
      "package-lock.json": "{}\n",
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
    });
    await expect(inspectReviewWorkspace(mixed)).rejects.toThrow(
      "multiple root lockfile families",
    );

    const unsupported = await makeWorkspace({
      "bun.lockb": "lock\n",
    });
    await expect(inspectReviewWorkspace(unsupported)).rejects.toThrow(
      "unsupported lockfile",
    );
  });

  it("rejects unfrozen roots and mismatched package-manager pins", async () => {
    const unlocked = await makeWorkspace({
      "package.json": '{"name":"fixture"}\n',
    });
    await expect(inspectReviewWorkspace(unlocked)).rejects.toThrow(
      "missing one frozen lockfile",
    );

    const mismatched = await makeWorkspace({
      "package.json": '{"name":"fixture","packageManager":"npm@11.17.0"}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    await expect(inspectReviewWorkspace(mismatched)).rejects.toThrow(
      "not exactly pinned",
    );

    const pinned = await makeWorkspace({
      "package.json": '{"name":"fixture","packageManager":"pnpm@10.13.1"}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    await expect(inspectReviewWorkspace(pinned)).resolves.toMatchObject({
      files: ["package.json", "pnpm-lock.yaml"],
    });
    const inspection = await inspectReviewWorkspace(pinned);
    expect(codeRabbitSemanticReviewFiles(inspection.files)).toEqual([
      "package.json",
    ]);
    const beforeLockChange = inspection.sourceDigest;
    await writeFile(
      join(pinned, "pnpm-lock.yaml"),
      "lockfileVersion: '9.1'\n",
      "utf8",
    );
    expect((await inspectReviewWorkspace(pinned)).sourceDigest).not.toBe(
      beforeLockChange,
    );
  });

  it("rejects embedded tool policy and install lifecycle scripts", async () => {
    const embeddedToolPolicy = await makeWorkspace({
      "package.json":
        '{"name":"fixture","eslintConfig":{"ignorePatterns":["**/*"]}}\n',
      "package-lock.json": "{}\n",
    });
    await expect(inspectReviewWorkspace(embeddedToolPolicy)).rejects.toThrow(
      "shadows controller tool policy",
    );

    const lifecycleScript = await makeWorkspace({
      "package.json":
        '{"name":"fixture","scripts":{"postinstall":"node setup.js"}}\n',
      "package-lock.json": "{}\n",
    });
    await expect(inspectReviewWorkspace(lifecycleScript)).rejects.toThrow(
      "install lifecycle script",
    );
  });

  it("rejects direct finding escapes and missing files", async () => {
    const workspace = await makeWorkspace({
      "src/index.ts": "export const value = 1;\n",
    });
    const finding = {
      severity: "major" as const,
      message: "The referenced file must be controller-attested.",
    };

    await expect(
      validateReviewFindingPaths(workspace, [
        { ...finding, fileName: "../outside.ts" },
      ]),
    ).rejects.toThrow("path is invalid");
    await expect(
      validateReviewFindingPaths(workspace, [
        { ...finding, fileName: "/tmp/outside.ts" },
      ]),
    ).rejects.toThrow("path is invalid");
    await expect(
      validateReviewFindingPaths(workspace, [
        { ...finding, fileName: "src/missing.ts" },
      ]),
    ).rejects.toThrow("missing file");
  });

  it("binds the source digest to paths, bytes, and executable mode", async () => {
    const workspace = await makeWorkspace({
      "src/index.ts": "export const value = 1;\n",
    });
    const first = await inspectReviewWorkspace(workspace);
    expect(first.files).toEqual(["src/index.ts"]);
    expect(first.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await computeReviewWorkspaceDigest(workspace)).toBe(
      first.sourceDigest,
    );

    await writeFile(
      join(workspace, "src", "index.ts"),
      "export const value = 2;\n",
      "utf8",
    );
    const changedContent = await computeReviewWorkspaceDigest(workspace);
    expect(changedContent).not.toBe(first.sourceDigest);

    await chmod(join(workspace, "src", "index.ts"), 0o755);
    expect(await computeReviewWorkspaceDigest(workspace)).not.toBe(
      changedContent,
    );
  });
});

describe("CodeRabbit controller policy attestation", () => {
  it("escalates every controller invariant category to critical", () => {
    const cases = [
      ["mutable preview exposure", "raw-preview-exposure", "BL-CR-001"],
      ["client_secret forwarding", "production-credentials", "BL-CR-002"],
      ["skip verification path", "proof-gate", "BL-CR-003"],
      ["Checkout Session mismatch", "payment-gate", "BL-CR-004"],
      ["approved facts lack evidence", "business-claims", "BL-CR-005"],
      ["webhook signature verification", "unsafe-webhook", "BL-CR-006"],
      ["unrestricted logs", "unrestricted-logs", "BL-CR-007"],
      ["cross-project cache", "cross-project-isolation", "BL-CR-008"],
      ["Dockerfile runs as root", "docker-delivery", "BL-CR-009"],
      ["mixed lockfile families", "dependency-policy", "BL-CR-010"],
    ] as const;

    for (const [message, category, ruleId] of cases) {
      expect(
        classifyCodeRabbitFinding({
          severity: "trivial",
          fileName: "src/index.ts",
          message,
        }),
      ).toMatchObject({
        severity: "critical",
        category,
        ruleId,
      });
    }
  });

  it("binds controller content and tool/event policy to distinct digests", () => {
    expect(sha256(CODERABBIT_CONTROLLER_CONFIG_CONTENT)).toBe(
      CODERABBIT_CONTROLLER_CONFIG_DIGEST,
    );
    expect(sha256(CODERABBIT_CONTROLLER_RULES_CONTENT)).toBe(
      CODERABBIT_CONTROLLER_RULES_DIGEST,
    );
    expect(sha256(canonicalJson(CODERABBIT_EVENT_SCHEMA_DESCRIPTOR))).toBe(
      CODERABBIT_EVENT_SCHEMA_DIGEST,
    );
    expect(sha256(canonicalJson(CODERABBIT_TOOL_POLICY))).toBe(
      CODERABBIT_TOOL_POLICY_DIGEST,
    );

    const digests = [
      CODERABBIT_CONFIG_SCHEMA_DIGEST,
      CODERABBIT_CONTROLLER_CONFIG_DIGEST,
      CODERABBIT_CONTROLLER_RULES_DIGEST,
      CODERABBIT_EVENT_SCHEMA_DIGEST,
      CODERABBIT_TOOL_POLICY_DIGEST,
      CODERABBIT_POLICY_PACK_DIGEST,
    ];
    expect(digests.every((digest) => /^[a-f0-9]{64}$/u.test(digest))).toBe(
      true,
    );
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("locks controller ownership, tool honesty, event kinds, and retry policy", () => {
    expect(CODERABBIT_POLICY_PACK_VERSION).toBe("buildlabs-coderabbit-v1");
    expect(CODERABBIT_CONFIG_SCHEMA_VERSION).toBe("schema.v2-2026-07-24");
    expect(CODERABBIT_EVENT_SCHEMA_VERSION).toBe("coderabbit-agent-jsonl-v1");
    expect(CODERABBIT_REQUIRED_REVIEW_FLAGS).toEqual([
      "--agent",
      "--committed",
      "--base-commit",
      "--dir",
      "--config",
    ]);
    expect(CODERABBIT_ADVISORY_REVIEW_FLAG).toBe("--light");
    expect(CODERABBIT_RETRY_DELAYS_MILLISECONDS).toEqual([15_000, 30_000]);
    expect(CODERABBIT_SUPPORTED_EVENT_KINDS).toEqual([
      "review_context",
      "status",
      "heartbeat",
      "finding",
      "complete",
      "error",
    ]);
    expect(CODERABBIT_TOOL_POLICY).toMatchObject({
      candidateConfigurationAccepted: false,
      jsonlReportsToolCoverage: false,
      proofBearing: false,
      deterministicBuildLabsScannersRemainAuthoritative: true,
      astGrep: {
        essentialRules: false,
        customRuleDirectories: false,
        customPackages: false,
      },
      semanticReviewExclusions: [
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
      ],
    });
    expect(CODERABBIT_TOOL_POLICY.configuredTools).toEqual([]);
    expect(CODERABBIT_TOOL_POLICY.disabledTools).toHaveLength(57);
    const controllerConfig = JSON.parse(
      CODERABBIT_CONTROLLER_CONFIG_CONTENT,
    ) as {
      reviews: {
        path_filters: string[];
        tools: Record<string, Record<string, unknown>>;
      };
    };
    expect(controllerConfig.reviews.path_filters).toEqual([
      "**/*",
      "!package-lock.json",
      "!npm-shrinkwrap.json",
      "!pnpm-lock.yaml",
      "!yarn.lock",
    ]);
    expect(Object.keys(controllerConfig.reviews.tools)).toHaveLength(57);
    expect(
      Object.entries(controllerConfig.reviews.tools).every(
        ([name, configuration]) =>
          name === "ast-grep"
            ? configuration.essential_rules === false
            : configuration.enabled === false,
      ),
    ).toBe(true);
    expect(CODERABBIT_CONTROLLER_RULES).toHaveLength(10);
  });

  it("fails closed across CLI range drift", () => {
    expect(CODERABBIT_MINIMUM_CLI_VERSION).toEqual([0, 7, 0]);
    expect(CODERABBIT_MAXIMUM_CLI_VERSION_EXCLUSIVE).toEqual([0, 8, 0]);
    expect(isSupportedCodeRabbitVersion([0, 6, 99])).toBe(false);
    expect(isSupportedCodeRabbitVersion([0, 7, 0])).toBe(true);
    expect(isSupportedCodeRabbitVersion([0, 7, 99])).toBe(true);
    expect(isSupportedCodeRabbitVersion([0, 8, 0])).toBe(false);
    expect(isSupportedCodeRabbitVersion([1, 0, 0])).toBe(false);
    expect(compareCodeRabbitVersion([0, 7, 1], [0, 7, 0])).toBeGreaterThan(0);
    expect(compareCodeRabbitVersion([0, 7], [0, 7, 0])).toBe(0);
  });
});

function reviewContext(): {
  type: "review_context";
  reviewType: "committed";
  currentBranch: string;
  baseBranch: string;
  baseCommit: string;
  workingDirectory: string;
} {
  return {
    type: "review_context",
    reviewType: "committed",
    currentBranch: expectedContext.currentBranch,
    baseBranch: "main",
    baseCommit: expectedContext.baseCommit,
    workingDirectory: expectedContext.workingDirectory,
  };
}

function complete(): {
  type: "complete";
  status: "review_completed";
  findings: number;
  reviewedFiles: string[];
} {
  return {
    type: "complete",
    status: "review_completed",
    findings: 0,
    reviewedFiles: [...expectedContext.expectedFiles],
  };
}

function jsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function captureProtocolError(
  operation: () => unknown,
): CodeRabbitProtocolError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CodeRabbitProtocolError);
    return error as CodeRabbitProtocolError;
  }
  throw new Error("Expected a CodeRabbit protocol error");
}

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "coderabbit-attestation-"));
  temporaryDirectories.push(workspace);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(workspace, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, "utf8");
  }
  return workspace;
}
