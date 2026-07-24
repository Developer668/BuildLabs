import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FilesystemArtifactStore,
  resolveArtifactFileForDownload,
} from "../src/adapters/filesystem/artifact-store.js";
import { artifactArchiveFilename } from "../src/domain/artifact.js";
import type { FrozenRevision } from "../src/domain/run.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type { ExportedWorkspace } from "../src/ports/index.js";

describe("FilesystemArtifactStore", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("persists and resolves a content-addressed candidate archive", async () => {
    const fixture = await createFixture();
    const runId = randomUUID();
    const artifact = await fixture.store.persist(
      runId,
      fixture.revision,
      fixture.workspace,
      "buildlapse-dind-browser-v2",
    );

    const resolvedPath = await resolveArtifactFileForDownload(
      fixture.artifactDirectory,
      artifact,
    );
    const archive = await readFile(resolvedPath);

    expect(resolvedPath).toBe(
      await realpath(
        join(fixture.artifactDirectory, artifactArchiveFilename(artifact)),
      ),
    );
    expect(artifact).toMatchObject({
      runId,
      revisionHash: fixture.revision.sourceDigest,
      format: "tar.gz",
      sha256: sha256(archive),
      sizeBytes: archive.byteLength,
      dockerfilePath: "Dockerfile",
      daytonaSnapshot: "buildlapse-dind-browser-v2",
    });
  });

  it("rejects a same-size archive whose bytes no longer match its receipt", async () => {
    const fixture = await createFixture();
    const artifact = await fixture.store.persist(
      randomUUID(),
      fixture.revision,
      fixture.workspace,
      "buildlapse-dind-browser-v2",
    );
    const archivePath = await resolveArtifactFileForDownload(
      fixture.artifactDirectory,
      artifact,
    );
    const tampered = await readFile(archivePath);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await writeFile(archivePath, tampered);

    await expect(
      resolveArtifactFileForDownload(fixture.artifactDirectory, artifact),
    ).rejects.toThrow("Artifact archive digest does not match its receipt");
  });

  it("rejects symbolic links in the candidate workspace", async () => {
    const fixture = await createFixture();
    await symlink("/etc/passwd", join(fixture.workspace.directory, "escape"));

    await expect(
      fixture.store.persist(
        randomUUID(),
        fixture.revision,
        fixture.workspace,
        "buildlapse-dind-browser-v2",
      ),
    ).rejects.toThrow("Candidate workspace contains a non-regular entry");
  });

  it("rejects candidate Git metadata", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.workspace.directory, ".git"));

    await expect(
      fixture.store.persist(
        randomUUID(),
        fixture.revision,
        fixture.workspace,
        "buildlapse-dind-browser-v2",
      ),
    ).rejects.toThrow("Candidate workspace must not contain Git metadata");
  });

  async function createFixture(): Promise<{
    artifactDirectory: string;
    revision: FrozenRevision;
    store: FilesystemArtifactStore;
    workspace: ExportedWorkspace;
  }> {
    const root = await mkdtemp(join(tmpdir(), "buildlapse-artifact-store-"));
    temporaryDirectories.push(root);
    const artifactDirectory = join(root, "artifacts");
    const workspaceDirectory = join(root, "workspace");
    await mkdir(workspaceDirectory);
    await mkdir(join(workspaceDirectory, "src"));
    await Promise.all([
      writeFile(
        join(workspaceDirectory, "Dockerfile"),
        "FROM node:24-alpine\nCOPY . /app\n",
      ),
      writeFile(
        join(workspaceDirectory, "src", "index.js"),
        "console.log('Buildlapse candidate');\n",
      ),
    ]);

    const sourceDigest = sha256("controller-attested-source");
    const revision: FrozenRevision = {
      sourceDigest,
      commitSha: "a".repeat(40),
      frozenAt: "2026-07-24T12:00:00.000Z",
    };
    return {
      artifactDirectory,
      revision,
      store: new FilesystemArtifactStore(artifactDirectory),
      workspace: {
        directory: workspaceDirectory,
        archivePath: join(root, "controller-export.tar"),
        archiveSha256: sha256("controller-export"),
        contentDigest: sourceDigest,
        cleanup: () => Promise.resolve(),
      },
    };
  }
});
