import { lstat, opendir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

import type {
  InspectedSourceFile,
  SandboxFile,
  SandboxSession,
} from "../ports/index.js";

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const EXCLUDED_SEGMENTS = new Set([
  ".buildlabs",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const VERIFIED_ROOT_LOCKFILES = new Set([
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export interface InspectionCollectionOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export async function collectSourceInspection(
  sandbox: SandboxSession,
  options: InspectionCollectionOptions = {},
): Promise<InspectedSourceFile[]> {
  return collectInspection(
    await sandbox.listFiles(".", 8),
    (path) => sandbox.readFile(path),
    options,
  );
}

export async function collectWorkspaceInspection(
  root: string,
  options: InspectionCollectionOptions = {},
): Promise<InspectedSourceFile[]> {
  const files: SandboxFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolute = join(directory, entry.name);
      const normalized = relative(root, absolute).split(sep).join("/");
      if (isExcludedPath(normalized)) {
        continue;
      }
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("Source inspection encountered a symbolic link");
      }
      files.push({
        path: normalized,
        name: entry.name,
        size: metadata.size,
        isDirectory: metadata.isDirectory(),
      });
      if (metadata.isDirectory()) {
        await visit(absolute);
      } else if (!metadata.isFile()) {
        throw new Error("Source inspection encountered a non-regular file");
      }
    }
  };
  await visit(root);
  return collectInspection(
    files,
    (path) => readFile(join(root, path), "utf8"),
    options,
  );
}

async function collectInspection(
  files: SandboxFile[],
  read: (path: string) => Promise<string>,
  options: InspectionCollectionOptions,
): Promise<InspectedSourceFile[]> {
  const maxFiles = options.maxFiles ?? 1_000;
  const maxFileBytes = options.maxFileBytes ?? 250_000;
  const maxTotalBytes = options.maxTotalBytes ?? 2_000_000;
  const candidates = files
    .filter(isInspectableFile)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (candidates.length > maxFiles) {
    throw new Error(
      `Source inspection is incomplete: ${candidates.length} files exceed the ${maxFiles}-file limit`,
    );
  }

  const inspected: InspectedSourceFile[] = [];
  let totalBytes = 0;
  for (const file of candidates) {
    if (file.size < 0 || file.size > maxFileBytes) {
      throw new Error(
        `Source inspection is incomplete: ${file.path} exceeds the per-file limit`,
      );
    }
    if (totalBytes + file.size > maxTotalBytes) {
      throw new Error(
        `Source inspection is incomplete: source exceeds the ${maxTotalBytes}-byte limit`,
      );
    }
    const contents = await read(file.path);
    const actualBytes = Buffer.byteLength(contents, "utf8");
    if (
      actualBytes > maxFileBytes ||
      totalBytes + actualBytes > maxTotalBytes
    ) {
      throw new Error(
        `Source inspection is incomplete: ${file.path} changed or exceeds limits`,
      );
    }
    totalBytes += actualBytes;
    inspected.push({ path: file.path, contents });
  }
  return inspected;
}

function isInspectableFile(file: SandboxFile): boolean {
  if (file.isDirectory) {
    return false;
  }
  const normalized = posix.normalize(file.path);
  if (isExcludedPath(normalized)) {
    return false;
  }
  // Frozen dependency verification already binds these generated files to the revision.
  if (VERIFIED_ROOT_LOCKFILES.has(normalized)) {
    return false;
  }
  if (normalized.endsWith("package.json")) {
    return true;
  }
  return SOURCE_EXTENSIONS.has(posix.extname(normalized).toLowerCase());
}

function isExcludedPath(path: string): boolean {
  return posix
    .normalize(path)
    .split("/")
    .some((segment) => EXCLUDED_SEGMENTS.has(segment));
}
