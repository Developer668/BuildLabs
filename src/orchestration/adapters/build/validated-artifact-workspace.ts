import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as tar from "tar";

import type { OutboxEvent } from "../../../domain/artifact.js";
import { ValidatedProvenArtifact } from "../../ports/build-backend.js";
import { BuildAdapterError } from "./build-adapter-error.js";

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_EXTRACTED_FILE_BYTES = 50 * 1_024 * 1_024;
const MAX_EXTRACTED_BYTES = 500 * 1_024 * 1_024;
const MAX_DECOMPRESSION_RATIO = 100;
const ALLOWED_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
]);

export interface ValidateArtifactWorkspaceRequest {
  event: OutboxEvent;
  body: AsyncIterable<Uint8Array>;
  temporaryParentDirectory?: string;
  signal?: AbortSignal;
}

export async function validateArtifactWorkspace(
  request: ValidateArtifactWorkspaceRequest,
): Promise<ValidatedProvenArtifact> {
  const parent = await validateTemporaryParent(
    request.temporaryParentDirectory ?? tmpdir(),
  );
  const root = await mkdtemp(join(parent, "buildlabs-proven-"));
  const archivePath = join(root, "candidate.tar.gz");
  const directory = join(root, "workspace");
  try {
    const downloaded = await downloadExactArchive(
      archivePath,
      request.body,
      request.event.payload.artifact.sizeBytes,
      request.event.payload.artifact.sha256,
      request.signal,
    );
    await lstat(root);
    await mkdir(directory, { mode: 0o700 });
    await extractSafeArchive(archivePath, directory);
    await requireDockerfile(directory);
    const workspaceSha256 = await computeWorkspaceSha256(directory);
    await rm(archivePath, { force: true });
    return new ValidatedArtifactWorkspace(
      request.event,
      directory,
      root,
      downloaded.sha256,
      downloaded.sizeBytes,
      workspaceSha256,
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error instanceof BuildAdapterError) {
      throw error;
    }
    throw new BuildAdapterError(
      "build-backend",
      "validate_artifact",
      "ARTIFACT_INTEGRITY_FAILED",
    );
  }
}

export async function computeWorkspaceSha256(
  directory: string,
): Promise<string> {
  const root = await realpath(resolve(directory));
  const hash = createHash("sha256");
  let entries = 0;
  let totalBytes = 0;

  const visit = async (current: string): Promise<void> => {
    const handle = await opendir(current);
    const children = [];
    for await (const child of handle) {
      children.push(child);
    }
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES || child.name === ".git") {
        throw new BuildAdapterError(
          "build-backend",
          "validate_workspace",
          "UNSAFE_ARCHIVE",
        );
      }
      const path = join(current, child.name);
      const metadata = await lstat(path);
      const relativePath = relative(root, path).split(sep).join("/");
      assertContained(root, path);
      if (metadata.isSymbolicLink()) {
        throw new BuildAdapterError(
          "build-backend",
          "validate_workspace",
          "UNSAFE_ARCHIVE",
        );
      }
      if (metadata.isDirectory()) {
        hash.update(
          `D\u0000${relativePath}\u0000${metadata.mode & 0o777}\u0000`,
        );
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new BuildAdapterError(
          "build-backend",
          "validate_workspace",
          "UNSAFE_ARCHIVE",
        );
      }
      if (
        metadata.size > MAX_EXTRACTED_FILE_BYTES ||
        totalBytes + metadata.size > MAX_EXTRACTED_BYTES
      ) {
        throw new BuildAdapterError(
          "build-backend",
          "validate_workspace",
          "UNSAFE_ARCHIVE",
        );
      }
      totalBytes += metadata.size;
      hash.update(
        `F\u0000${relativePath}\u0000${metadata.mode & 0o777}\u0000${metadata.size}\u0000`,
      );
      const stream = createReadStream(path);
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
      hash.update("\u0000");
    }
  };

  await visit(root);
  return hash.digest("hex");
}

class ValidatedArtifactWorkspace extends ValidatedProvenArtifact {
  readonly eventId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly candidateId: string;
  readonly contractHash: string;
  readonly revisionHash: string;
  readonly artifactId: string;
  readonly sourceSha256: string;
  readonly sourceSizeBytes: number;
  readonly workspaceSha256: string;
  readonly directory: string;
  readonly #root: string;
  #cleaned = false;

  constructor(
    event: OutboxEvent,
    directory: string,
    root: string,
    sourceSha256: string,
    sourceSizeBytes: number,
    workspaceSha256: string,
  ) {
    super();
    this.eventId = event.eventId;
    this.runId = event.runId;
    this.projectId = event.payload.projectId;
    this.candidateId = event.payload.candidateId;
    this.contractHash = event.payload.contractHash;
    this.revisionHash = event.revisionHash;
    this.artifactId = event.payload.artifact.artifactId;
    this.sourceSha256 = sourceSha256;
    this.sourceSizeBytes = sourceSizeBytes;
    this.workspaceSha256 = workspaceSha256;
    this.directory = directory;
    this.#root = root;
  }

  assertUsable(): void {
    if (this.#cleaned) {
      throw new BuildAdapterError(
        "build-backend",
        "use_artifact",
        "POLICY_BLOCKED",
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) {
      return;
    }
    this.#cleaned = true;
    await rm(this.#root, { recursive: true, force: true });
  }
}

async function downloadExactArchive(
  archivePath: string,
  body: AsyncIterable<Uint8Array>,
  expectedSizeBytes: number,
  expectedSha256: string,
  signal: AbortSignal | undefined,
): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await open(archivePath, "wx", 0o600);
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of body) {
      if (signal?.aborted) {
        throw new BuildAdapterError(
          "build-backend",
          "download_artifact",
          "ABORTED",
        );
      }
      const buffer = Buffer.from(chunk);
      if (total + buffer.byteLength > expectedSizeBytes) {
        throw new BuildAdapterError(
          "build-backend",
          "download_artifact",
          "ARTIFACT_INTEGRITY_FAILED",
        );
      }
      await writeAll(handle, buffer, total);
      total += buffer.byteLength;
      hash.update(buffer);
    }
  } catch (error) {
    if (error instanceof BuildAdapterError) {
      throw error;
    }
    throw new BuildAdapterError(
      "build-backend",
      "download_artifact",
      "PROVIDER_FAILURE",
    );
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  if (total !== expectedSizeBytes || digest !== expectedSha256) {
    throw new BuildAdapterError(
      "build-backend",
      "download_artifact",
      "ARTIFACT_INTEGRITY_FAILED",
    );
  }
  return { sha256: digest, sizeBytes: total };
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      position + offset,
    );
    if (result.bytesWritten <= 0) {
      throw new BuildAdapterError(
        "build-backend",
        "download_artifact",
        "PROVIDER_FAILURE",
      );
    }
    offset += result.bytesWritten;
  }
}

async function extractSafeArchive(
  archivePath: string,
  directory: string,
): Promise<void> {
  let unsafe = false;
  let entries = 0;
  let extractedBytes = 0;
  try {
    await tar.x({
      cwd: directory,
      file: archivePath,
      gzip: true,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      unlink: true,
      noMtime: true,
      maxDepth: 64,
      maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
      filter: (path, entry) => {
        entries += 1;
        extractedBytes += entry.size;
        const entryType = "type" in entry ? entry.type : undefined;
        const safe =
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          entries <= MAX_ARCHIVE_ENTRIES &&
          extractedBytes <= MAX_EXTRACTED_BYTES &&
          entry.size <= MAX_EXTRACTED_FILE_BYTES &&
          entryType !== undefined &&
          ALLOWED_ENTRY_TYPES.has(entryType) &&
          safeArchivePath(path);
        if (!safe) {
          unsafe = true;
        }
        return safe;
      },
    });
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      "extract_artifact",
      "UNSAFE_ARCHIVE",
    );
  }
  if (unsafe) {
    throw new BuildAdapterError(
      "build-backend",
      "extract_artifact",
      "UNSAFE_ARCHIVE",
    );
  }
}

function safeArchivePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    !segments.includes("..") &&
    !segments.includes(".git") &&
    segments.every((segment) => segment.length <= 255)
  );
}

async function requireDockerfile(directory: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(join(directory, "Dockerfile"));
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      "extract_artifact",
      "UNSAFE_ARCHIVE",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new BuildAdapterError(
      "build-backend",
      "extract_artifact",
      "UNSAFE_ARCHIVE",
    );
  }
}

async function validateTemporaryParent(value: string): Promise<string> {
  let path: string;
  try {
    path = await realpath(resolve(value));
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new BuildAdapterError(
      "build-backend",
      "configuration",
      "INVALID_INPUT",
    );
  }
  return path;
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, resolve(candidate));
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new BuildAdapterError(
      "build-backend",
      "validate_workspace",
      "UNSAFE_ARCHIVE",
    );
  }
}
