import { createReadStream } from "node:fs";
import { lstat, mkdir, opendir, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as tar from "tar";

import {
  artifactArchiveFilename,
  artifactDownloadPath,
  ProvenArtifactSchema,
  type ProvenArtifact,
} from "../../domain/artifact.js";
import type { FrozenRevision } from "../../domain/run.js";
import type { ArtifactStore, ExportedWorkspace } from "../../ports/index.js";

const MAX_WORKSPACE_ENTRIES = 10_000;
const MAX_WORKSPACE_FILE_BYTES = 50 * 1_024 * 1_024;
const MAX_WORKSPACE_BYTES = 500 * 1_024 * 1_024;

export class FilesystemArtifactStore implements ArtifactStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async persist(
    runId: string,
    revision: FrozenRevision,
    workspace: ExportedWorkspace,
    daytonaSnapshot: string,
  ): Promise<ProvenArtifact> {
    await validateWorkspaceTree(workspace.directory);
    const dockerfile = join(workspace.directory, "Dockerfile");
    const dockerfileStat = await lstat(dockerfile);
    if (!dockerfileStat.isFile() || dockerfileStat.isSymbolicLink()) {
      throw new Error("Root Dockerfile must be a regular file");
    }
    if (dockerfileStat.size === 0) {
      throw new Error("Root Dockerfile must not be empty");
    }

    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const artifactId = randomUUID();
    const filename = artifactArchiveFilename({
      artifactId,
      runId,
      revisionHash: revision.sourceDigest,
    });
    const outputPath = join(this.#directory, filename);

    await tar.c(
      {
        cwd: workspace.directory,
        file: outputPath,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      ["."],
    );

    const outputStat = await stat(outputPath);
    if (!outputStat.isFile() || outputStat.size === 0) {
      throw new Error("Artifact archive was not created");
    }

    return ProvenArtifactSchema.parse({
      artifactId,
      runId,
      revisionHash: revision.sourceDigest,
      format: "tar.gz",
      uri: artifactDownloadPath(runId, artifactId),
      sha256: await sha256File(outputPath),
      sizeBytes: outputStat.size,
      dockerfilePath: "Dockerfile",
      daytonaSnapshot,
      createdAt: new Date().toISOString(),
    });
  }
}

export async function resolveArtifactFileForDownload(
  directory: string,
  input: ProvenArtifact,
): Promise<string> {
  const artifact = ProvenArtifactSchema.parse(input);
  const root = await realpath(resolve(directory));
  const candidatePath = resolve(root, artifactArchiveFilename(artifact));
  assertContainedPath(root, candidatePath);

  const candidateStat = await lstat(candidatePath);
  if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
    throw new Error("Artifact archive is not a regular file");
  }
  if (candidateStat.size !== artifact.sizeBytes) {
    throw new Error("Artifact archive size does not match its receipt");
  }

  const resolvedPath = await realpath(candidatePath);
  assertContainedPath(root, resolvedPath);
  if ((await sha256File(resolvedPath)) !== artifact.sha256) {
    throw new Error("Artifact archive digest does not match its receipt");
  }
  return resolvedPath;
}

async function validateWorkspaceTree(root: string): Promise<void> {
  let entries = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entries += 1;
      if (entries > MAX_WORKSPACE_ENTRIES) {
        throw new Error("Candidate workspace contains too many entries");
      }
      if (entry.name === ".git") {
        throw new Error("Candidate workspace must not contain Git metadata");
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (
        metadata.isSymbolicLink() ||
        (!metadata.isFile() && !metadata.isDirectory())
      ) {
        throw new Error("Candidate workspace contains a non-regular entry");
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (
        metadata.size > MAX_WORKSPACE_FILE_BYTES ||
        totalBytes + metadata.size > MAX_WORKSPACE_BYTES
      ) {
        throw new Error("Candidate workspace exceeds artifact size limits");
      }
      totalBytes += metadata.size;
    }
  };
  await visit(root);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function assertContainedPath(root: string, path: string): void {
  const child = relative(root, path);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error("Artifact archive escaped its storage root");
  }
}
