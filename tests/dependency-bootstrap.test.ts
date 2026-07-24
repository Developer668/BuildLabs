import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { DEPENDENCY_BOOTSTRAP_COMMAND } from "../src/application/dependency-bootstrap.js";

const execFileAsync = promisify(execFile);

describe("verifier dependency bootstrap", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("is a no-op outside Node package workspaces", async () => {
    const root = await workspace();

    await expect(runBootstrap(root)).resolves.toMatchObject({ stdout: "" });
  });

  it("fails closed when package.json has no frozen lockfile", async () => {
    const root = await workspace();
    await writeFile(join(root, "package.json"), '{"private":true}\n');

    await expect(runBootstrap(root)).rejects.toMatchObject({ code: 65 });
  });

  it("fails closed on a nested Node package root", async () => {
    const root = await workspace();
    await mkdir(join(root, "app"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "app", "package.json"), '{"private":true}\n'),
      writeFile(
        join(root, "app", "package-lock.json"),
        '{"lockfileVersion":3}\n',
      ),
    ]);

    await expect(runBootstrap(root)).rejects.toMatchObject({ code: 65 });
  });

  it("fails closed when multiple root lockfile families are present", async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(join(root, "package.json"), '{"private":true}\n'),
      writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n'),
      writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
    ]);

    await expect(runBootstrap(root)).rejects.toMatchObject({ code: 65 });
  });

  it("uses npm ci with lifecycle scripts and side-channel checks disabled", async () => {
    const root = await workspace();
    await Promise.all([
      writeFile(join(root, "package.json"), '{"private":true}\n'),
      writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n'),
    ]);
    await fakeExecutable(root, "npm", "printf '%s\\n' \"$*\"");

    const result = await runBootstrap(root);

    expect(result.stdout.trim()).toBe(
      "ci --ignore-scripts --no-audit --no-fund",
    );
  });

  it.each([
    {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      contents: "lockfileVersion: '9.0'\n",
      packageManager: "pnpm@9.15.0",
      expected: "pnpm@9.15.0 install --frozen-lockfile --ignore-scripts",
    },
    {
      name: "modern Yarn",
      lockfile: "yarn.lock",
      contents: "__metadata:\n  version: 8\n",
      packageManager: "yarn@4.6.0",
      expected: "yarn@4.6.0 install --immutable --mode=skip-build",
    },
    {
      name: "classic Yarn",
      lockfile: "yarn.lock",
      contents: "# yarn lockfile v1\n",
      packageManager: "yarn@1.22.22",
      expected:
        "yarn@1.22.22 install --frozen-lockfile --ignore-scripts --non-interactive",
    },
  ])("uses a frozen, script-free $name install", async (testCase) => {
    const root = await workspace();
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          private: true,
          packageManager: testCase.packageManager,
        }),
      ),
      writeFile(join(root, testCase.lockfile), testCase.contents),
    ]);
    await fakeExecutable(root, "corepack", "printf '%s\\n' \"$*\"");

    const result = await runBootstrap(root);

    expect(result.stdout.trim()).toBe(testCase.expected);
  });

  it.each([
    {
      lockfile: "pnpm-lock.yaml",
      contents: "lockfileVersion: '9.0'\n",
    },
    {
      lockfile: "yarn.lock",
      contents: "__metadata:\n  version: 8\n",
    },
  ])("requires an exact packageManager pin for $lockfile", async (testCase) => {
    const root = await workspace();
    await Promise.all([
      writeFile(join(root, "package.json"), '{"private":true}\n'),
      writeFile(join(root, testCase.lockfile), testCase.contents),
    ]);
    await fakeExecutable(root, "corepack", "exit 99");

    await expect(runBootstrap(root)).rejects.toMatchObject({ code: 65 });
  });

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "buildlapse-bootstrap-"));
    roots.push(root);
    await mkdir(join(root, "bin"));
    return root;
  }
});

async function fakeExecutable(
  root: string,
  name: string,
  body: string,
): Promise<void> {
  const path = join(root, "bin", name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

function runBootstrap(root: string) {
  return execFileAsync("/bin/sh", ["-c", DEPENDENCY_BOOTSTRAP_COMMAND], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
}
