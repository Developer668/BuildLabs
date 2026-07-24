import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseGitTreeManifest,
  sourceTreeDigest,
  validateSourceArchive,
} from "../src/adapters/daytona/daytona-sandbox.js";

describe("Daytona source archive validation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("accepts regular source-only archives", async () => {
    const { source, archive } = await fixture();
    await writeFile(join(source, "Dockerfile"), "FROM node:24\n");
    await tar.c({ cwd: source, file: archive }, ["."]);

    await expect(validateSourceArchive(archive)).resolves.toBeUndefined();
  });

  it("rejects symbolic links before host extraction", async () => {
    const { source, archive } = await fixture();
    await symlink("/etc/passwd", join(source, "escape"));
    await tar.c({ cwd: source, file: archive }, ["."]);

    await expect(validateSourceArchive(archive)).rejects.toThrow(
      "unsupported entry type SymbolicLink",
    );
  });

  it("rejects an archive that omits a frozen export-ignored file", async () => {
    const { source, archive } = await fixture();
    await writeFile(
      join(source, ".gitattributes"),
      "hidden.txt export-ignore\n",
    );
    await tar.c({ cwd: source, file: archive }, [".gitattributes"]);
    const frozenTree = parseGitTreeManifest(
      Buffer.from(
        [
          `100644 blob ${gitBlobOid("hidden.txt export-ignore\n")}\t.gitattributes\0`,
          `100644 blob ${gitBlobOid("hidden\n")}\thidden.txt\0`,
        ].join(""),
      ),
    );

    await expect(validateSourceArchive(archive, frozenTree)).rejects.toThrow(
      "does not match its frozen Git tree",
    );
  });

  it("rejects archive bytes transformed from the frozen Git blob", async () => {
    const { source, archive } = await fixture();
    await writeFile(join(source, "app.txt"), "PASS\n");
    await tar.c({ cwd: source, file: archive }, ["app.txt"]);
    const frozenTree = parseGitTreeManifest(
      Buffer.from(`100644 blob ${gitBlobOid("FAIL\n")}\tapp.txt\0`),
    );

    await expect(validateSourceArchive(archive, frozenTree)).rejects.toThrow(
      "file bytes do not match the frozen Git tree",
    );
  });

  it("exports and validates nested files from the exact recursive Git tree", async () => {
    const { source, archive } = await fixture();
    const nestedDirectory = join(source, "src", "features", "checkout");
    await mkdir(nestedDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(source, "Dockerfile"), "FROM node:24\n"),
      writeFile(
        join(nestedDirectory, "handler.ts"),
        "export const handler = () => 'nested';\n",
      ),
    ]);
    git(source, ["init", "--quiet"]);
    git(source, ["add", "--all"]);
    git(source, [
      "-c",
      "user.name=Buildlapse Test",
      "-c",
      "user.email=test@buildlapse.invalid",
      "commit",
      "--quiet",
      "--message",
      "nested source",
    ]);

    const manifest = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", "--full-tree", "HEAD"],
      { cwd: source },
    );
    git(source, ["archive", "--format=tar", `--output=${archive}`, "HEAD"]);
    const frozenTree = parseGitTreeManifest(manifest);

    expect([...frozenTree.keys()]).toEqual([
      "Dockerfile",
      "src/features/checkout/handler.ts",
    ]);
    await expect(
      validateSourceArchive(archive, frozenTree),
    ).resolves.toBeUndefined();
  });

  it("derives a deterministic content identity from paths, modes, and bytes", async () => {
    const first = await fixture();
    const second = await fixture();
    const nestedPath = join("src", "tools", "build.sh");
    await Promise.all([
      mkdir(join(first.source, "src", "tools"), { recursive: true }),
      mkdir(join(second.source, "src", "tools"), { recursive: true }),
    ]);
    await writeFile(join(first.source, nestedPath), "#!/bin/sh\necho build\n");
    await writeFile(join(first.source, "Dockerfile"), "FROM node:24\n");
    await writeFile(join(second.source, "Dockerfile"), "FROM node:24\n");
    await writeFile(join(second.source, nestedPath), "#!/bin/sh\necho build\n");
    await Promise.all([
      chmod(join(first.source, nestedPath), 0o755),
      chmod(join(second.source, nestedPath), 0o755),
    ]);

    const expected = await sourceTreeDigest(first.source);
    await expect(sourceTreeDigest(second.source)).resolves.toBe(expected);

    await chmod(join(second.source, nestedPath), 0o644);
    await expect(sourceTreeDigest(second.source)).resolves.not.toBe(expected);
  });

  async function fixture(): Promise<{
    source: string;
    archive: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "buildlapse-archive-test-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    await mkdir(source);
    return { source, archive: join(directory, "workspace.tar") };
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitBlobOid(contents: string): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
