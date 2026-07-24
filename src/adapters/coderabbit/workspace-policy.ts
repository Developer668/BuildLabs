import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import type { ReviewFinding } from "../../domain/evidence.js";

const MAX_REVIEW_TREE_ENTRIES = 10_000;
const MAX_REVIEW_TREE_BYTES = 500 * 1_024 * 1_024;
const MAX_REVIEW_FILE_BYTES = 50 * 1_024 * 1_024;
const ROOT_NODE_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const UNSUPPORTED_LOCKFILES = new Set(["bun.lock", "bun.lockb", "deno.lock"]);
const TOOL_SHADOW_FILES = new Set([
  ".actionlint.yaml",
  ".actionlint.yml",
  ".betterleaks.toml",
  ".checkov.baseline",
  ".checkov.yaml",
  ".checkov.yml",
  ".gitleaks.toml",
  ".gitleaksignore",
  ".hadolint.yaml",
  ".hadolint.yml",
  ".hadolintignore",
  ".eslintignore",
  ".npmrc",
  ".osv-scanner.toml",
  ".pnp.cjs",
  ".pnp.js",
  ".pnpmfile.cjs",
  ".semgrepignore",
  ".semgrep.yaml",
  ".semgrep.yml",
  ".shellcheckrc",
  ".trivy.yaml",
  ".trivy.yml",
  ".trivyignore",
  ".trivyignore.yaml",
  ".yarnrc",
  ".yarnrc.yml",
  ".zizmor.yaml",
  ".zizmor.yml",
  "actionlint.yaml",
  "actionlint.yml",
  "betterleaks.toml",
  "biome.json",
  "biome.jsonc",
  "checkov.yaml",
  "checkov.yml",
  "doctor.config.cjs",
  "doctor.config.cts",
  "doctor.config.js",
  "doctor.config.json",
  "doctor.config.mjs",
  "doctor.config.mts",
  "doctor.config.ts",
  "eslint.config.cjs",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  "gitleaks.toml",
  "hadolint.yaml",
  "hadolint.yml",
  "osv-scanner.toml",
  "react-doctor.config.json",
  "semgrep.yaml",
  "semgrep.config.yaml",
  "semgrep.config.yml",
  "semgrep.yml",
  "sgconfig.yaml",
  "sgconfig.yml",
  "trivy.yaml",
  "trivy.yml",
  "zizmor.yaml",
  "zizmor.yml",
]);
const CONTROLLER_SHADOW_FILES = new Set([
  "buildlabs-coderabbit-config.yaml",
  "buildlabs-coderabbit-rules.md",
  "buildlabs-review-policy.md",
  ".gitattributes",
]);
const REVIEW_GUIDELINE_FILES = new Set([
  ".cursorrules",
  ".windsurfrules",
  "agent.md",
  "agents.md",
  "claude.md",
  "gemini.md",
  "review.md",
]);
const PACKAGE_TOOL_POLICY_KEYS = new Set([
  "actionlint",
  "biome",
  "checkov",
  "eslintConfig",
  "eslintIgnore",
  "gitleaks",
  "hadolint",
  "osvScanner",
  "reactDoctor",
  "semgrep",
  "shellcheck",
  "trivy",
  "zizmor",
]);
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "install",
  "postinstall",
  "preinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
]);
const WORKFLOW_TOOL_PATTERNS = [
  { name: "actionlint", pattern: /\bactionlint\b/iu },
  { name: "biome", pattern: /\bbiome\b/iu },
  { name: "checkov", pattern: /\bcheckov\b/iu },
  { name: "gitleaks", pattern: /\b(?:betterleaks|gitleaks)\b/iu },
] as const;

export interface ReviewWorkspaceInspection {
  sourceDigest: string;
  files: string[];
  totalBytes: number;
}

export async function inspectReviewWorkspace(
  workspaceDirectory: string,
): Promise<ReviewWorkspaceInspection> {
  const workspaceMetadata = await lstat(workspaceDirectory);
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("Review workspace root must be a regular directory");
  }
  const root = await realpath(resolve(workspaceDirectory));
  const files: string[] = [];
  const rootLockfiles = new Set<string>();
  let hasRootPackageJson = false;
  let entries = 0;
  let totalBytes = 0;

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_REVIEW_TREE_ENTRIES) {
        throw new Error("Review workspace contains too many entries");
      }
      if (containsControlCharacter(entry.name)) {
        throw new Error("Review workspace contains an unsafe path");
      }
      const relativePath = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (isReviewControlPath(relativePath)) {
        throw new Error(
          `Candidate contains controller-owned review metadata: ${relativePath}`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new Error("Review workspace contains a symbolic link");
      }
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Review workspace contains a non-regular entry");
      }
      const metadata = await lstat(join(directory, entry.name));
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1
      ) {
        throw new Error("Review workspace changed while being inspected");
      }
      if (metadata.size > MAX_REVIEW_FILE_BYTES) {
        throw new Error("Review workspace contains an oversized file");
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_REVIEW_TREE_BYTES) {
        throw new Error("Review workspace exceeds its aggregate byte limit");
      }
      assertDependencyPolicy(relativePath, rootLockfiles);
      if (relativePath === "package.json") {
        hasRootPackageJson = true;
      }
      if (isGitHubWorkflowPath(relativePath)) {
        await assertWorkflowDoesNotShadowControllerTools(
          join(directory, entry.name),
        );
      }
      files.push(relativePath);
    }
  };
  await visit(root, "");
  files.sort(compareUtf8);
  if (rootLockfiles.size > 1) {
    throw new Error(
      "Review workspace contains multiple root lockfile families",
    );
  }
  await assertRootDependencyPolicy(root, hasRootPackageJson, rootLockfiles);
  return {
    sourceDigest: await digestReviewFiles(root, files),
    files,
    totalBytes,
  };
}

async function assertRootDependencyPolicy(
  root: string,
  hasPackageJson: boolean,
  rootLockfiles: ReadonlySet<string>,
): Promise<void> {
  if (hasPackageJson && rootLockfiles.size !== 1) {
    throw new Error(
      "Review workspace package root is missing one frozen lockfile",
    );
  }
  if (!hasPackageJson && rootLockfiles.size > 0) {
    throw new Error("Review workspace lockfile is missing its package root");
  }
  if (!hasPackageJson) {
    return;
  }

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as unknown;
  } catch {
    throw new Error("Review workspace package manifest is invalid");
  }
  if (
    !packageJson ||
    typeof packageJson !== "object" ||
    Array.isArray(packageJson)
  ) {
    throw new Error("Review workspace package manifest is invalid");
  }
  const manifest = packageJson as Record<string, unknown>;
  const embeddedToolPolicy = [...PACKAGE_TOOL_POLICY_KEYS].find((key) =>
    Object.hasOwn(manifest, key),
  );
  if (embeddedToolPolicy) {
    throw new Error(
      `Review workspace package manifest shadows controller tool policy: ${embeddedToolPolicy}`,
    );
  }
  const scripts = manifest.scripts;
  if (scripts !== undefined) {
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new Error("Review workspace package scripts are invalid");
    }
    const lifecycleScript = [...INSTALL_LIFECYCLE_SCRIPTS].find((script) =>
      Object.hasOwn(scripts, script),
    );
    if (lifecycleScript) {
      throw new Error(
        `Review workspace package manifest contains an install lifecycle script: ${lifecycleScript}`,
      );
    }
  }
  const packageManager = manifest.packageManager;
  const lockfile = [...rootLockfiles][0];
  const expectedManager =
    lockfile === "pnpm-lock.yaml"
      ? "pnpm"
      : lockfile === "yarn.lock"
        ? "yarn"
        : "npm";
  if (
    (expectedManager !== "npm" && typeof packageManager !== "string") ||
    (packageManager !== undefined &&
      (typeof packageManager !== "string" ||
        !new RegExp(
          `^${expectedManager}@[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`,
        ).test(packageManager)))
  ) {
    throw new Error(
      "Review workspace package manager is not exactly pinned to its lockfile family",
    );
  }
}

export async function assertNoReviewControlFiles(
  workspaceDirectory: string,
): Promise<void> {
  await inspectReviewWorkspace(workspaceDirectory);
}

export async function computeReviewWorkspaceDigest(
  workspaceDirectory: string,
): Promise<string> {
  return (await inspectReviewWorkspace(workspaceDirectory)).sourceDigest;
}

export function codeRabbitSemanticReviewFiles(
  sourceFiles: readonly string[],
): string[] {
  return sourceFiles.filter(
    (path) => path.includes("/") || !ROOT_NODE_LOCKFILES.has(path),
  );
}

export async function validateReviewFindingPaths(
  workspaceDirectory: string,
  findings: readonly ReviewFinding[],
): Promise<void> {
  const root = await realpath(resolve(workspaceDirectory));
  for (const finding of findings) {
    const fileName = validateWorkspaceRelativePath(finding.fileName);
    const candidate = resolve(root, ...fileName.split("/"));
    assertContainedPath(root, candidate);

    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch {
      throw new Error(
        `CodeRabbit finding references a missing file: ${fileName}`,
      );
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `CodeRabbit finding does not reference a regular file: ${fileName}`,
      );
    }
    assertContainedPath(root, await realpath(candidate));
  }
}

export function isReviewControlPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1);
  if (!name) {
    return false;
  }
  const lowerParts = parts.map((part) => part.toLowerCase());
  const lowerName = name.toLowerCase();
  const lowerPath = lowerParts.join("/");

  if (
    lowerParts.some((part) =>
      [".git", ".hg", ".jj", ".svn", ".buildlabs"].includes(part),
    ) ||
    lowerName === ".gitmodules"
  ) {
    return true;
  }
  if (
    lowerName.startsWith(".coderabbit") ||
    [
      "coderabbit.yaml",
      "coderabbit.yml",
      "coderabbit.json",
      "coderabbit.toml",
    ].includes(lowerName) ||
    CONTROLLER_SHADOW_FILES.has(lowerName) ||
    isToolShadowFileName(lowerName) ||
    REVIEW_GUIDELINE_FILES.has(lowerName)
  ) {
    return true;
  }
  if (
    lowerPath === ".github/copilot-instructions.md" ||
    (lowerPath.startsWith(".github/instructions/") &&
      lowerName.endsWith(".instructions.md"))
  ) {
    return true;
  }
  return lowerParts.some(
    (part, index) =>
      (part === ".cursor" && lowerParts[index + 1] === "rules") ||
      part === ".clinerules" ||
      part === ".rules",
  );
}

function isToolShadowFileName(name: string): boolean {
  return (
    TOOL_SHADOW_FILES.has(name) ||
    name === ".eslintrc" ||
    name.startsWith(".eslintrc.") ||
    name === ".trivyignore.yaml" ||
    name.startsWith("eslint.config.")
  );
}

function isGitHubWorkflowPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".github/workflows/") &&
    (lower.endsWith(".yml") || lower.endsWith(".yaml"))
  );
}

async function assertWorkflowDoesNotShadowControllerTools(
  path: string,
): Promise<void> {
  const contents = await readFile(path, "utf8");
  const tool = WORKFLOW_TOOL_PATTERNS.find(({ pattern }) =>
    pattern.test(contents),
  )?.name;
  if (tool) {
    throw new Error(
      `Candidate workflow can suppress the controller-owned ${tool} review tool`,
    );
  }
}

function assertDependencyPolicy(
  path: string,
  rootLockfiles: Set<string>,
): void {
  const parts = path.split("/");
  const name = parts.at(-1);
  if (!name) {
    return;
  }
  if (
    parts.length > 1 &&
    (name === "package.json" ||
      ROOT_NODE_LOCKFILES.has(name) ||
      UNSUPPORTED_LOCKFILES.has(name) ||
      name === ".npmrc" ||
      name === ".yarnrc" ||
      name === ".yarnrc.yml" ||
      name === ".pnpmfile.cjs")
  ) {
    throw new Error(
      `Review workspace contains an alternate dependency root: ${path}`,
    );
  }
  if (parts.length === 1 && ROOT_NODE_LOCKFILES.has(name)) {
    rootLockfiles.add(name);
  }
  if (UNSUPPORTED_LOCKFILES.has(name)) {
    throw new Error(
      `Review workspace contains an unsupported lockfile: ${path}`,
    );
  }
}

async function digestReviewFiles(
  root: string,
  files: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  hash.update("buildlabs-source-tree-v1\0");
  for (const path of files) {
    const absolutePath = join(root, ...path.split("/"));
    const metadata = await lstat(absolutePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1
    ) {
      throw new Error("Review workspace changed while being attested");
    }
    const mode = metadata.mode & 0o111 ? "100755" : "100644";
    hash.update(mode);
    hash.update("\0");
    hash.update(String(Buffer.byteLength(path, "utf8")));
    hash.update("\0");
    hash.update(path);
    hash.update("\0");
    hash.update(String(metadata.size));
    hash.update("\0");
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk as Buffer);
    }
  }
  return hash.digest("hex");
}

function validateWorkspaceRelativePath(path: string): string {
  if (
    path.length < 1 ||
    path.length > 2_000 ||
    containsControlCharacter(path) ||
    path.includes("\\") ||
    posix.isAbsolute(path)
  ) {
    throw new Error("CodeRabbit finding path is invalid");
  }
  const parts = path.split("/");
  if (
    parts.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("CodeRabbit finding path is invalid");
  }
  const normalized = posix.normalize(path);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error("CodeRabbit finding path is invalid");
  }
  return normalized;
}

function assertContainedPath(root: string, path: string): void {
  const child = relative(root, path);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error("CodeRabbit finding escaped the review workspace");
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
