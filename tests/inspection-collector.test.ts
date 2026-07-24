import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectWorkspaceInspection } from "../src/application/inspection-collector.js";

describe("source inspection coverage", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("fails instead of silently truncating excess source files", async () => {
    const directory = await workspace();
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(directory, `file-${index}.ts`), "export {};\n");
    }

    await expect(
      collectWorkspaceInspection(directory, { maxFiles: 2 }),
    ).rejects.toThrow("Source inspection is incomplete");
  });

  it("fails instead of truncating an oversized source file", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "large.ts"), "x".repeat(101));

    await expect(
      collectWorkspaceInspection(directory, { maxFileBytes: 100 }),
    ).rejects.toThrow("exceeds the per-file limit");
  });

  it.each([
    "npm-shrinkwrap.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ])(
    "omits the controller-verified root lockfile %s from semantic model context",
    async (lockfile) => {
      const directory = await workspace();
      await writeFile(join(directory, lockfile), "x".repeat(101));
      await writeFile(join(directory, "source.ts"), "export {};\n");

      const inspected = await collectWorkspaceInspection(directory, {
        maxFileBytes: 100,
      });

      expect(inspected).toEqual([
        { path: "source.ts", contents: "export {};\n" },
      ]);
    },
  );

  it("does not exempt an oversized nested lockfile from complete inspection", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "nested"));
    await writeFile(
      join(directory, "nested", "package-lock.json"),
      "x".repeat(101),
    );

    await expect(
      collectWorkspaceInspection(directory, { maxFileBytes: 100 }),
    ).rejects.toThrow("nested/package-lock.json exceeds the per-file limit");
  });

  it("does not descend into excluded dependency directories", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(directory, "node_modules", "tool.js"), "export {};\n");
    await symlink(
      "../tool.js",
      join(directory, "node_modules", ".bin", "tool"),
    );
    await writeFile(join(directory, "source.ts"), "export {};\n");

    await expect(collectWorkspaceInspection(directory)).resolves.toEqual([
      { path: "source.ts", contents: "export {};\n" },
    ]);
  });

  it("still fails closed on a symbolic link in application source", async () => {
    const directory = await workspace();
    await writeFile(join(directory, "source.ts"), "export {};\n");
    await symlink("source.ts", join(directory, "linked.ts"));

    await expect(collectWorkspaceInspection(directory)).rejects.toThrow(
      "Source inspection encountered a symbolic link",
    );
  });

  it("preserves phone and email claims for unsupported-fact evaluation", async () => {
    const directory = await workspace();
    const contents =
      'export const contact = "invented@example.com / 510-555-1212";\n';
    await writeFile(join(directory, "contact.ts"), contents);

    const inspected = await collectWorkspaceInspection(directory);

    expect(inspected[0]?.contents).toBe(contents);
  });

  async function workspace(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), "buildlabs-inspection-test-"),
    );
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    return directory;
  }
});
