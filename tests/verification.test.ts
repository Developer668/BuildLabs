import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { forbiddenClaimsCommand } from "../src/application/verification.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("forbidden claim verification", () => {
  it("returns only bounded path and line diagnostics for production matches", async () => {
    const workspace = await createWorkspace({
      "src/page.tsx": [
        "export const harmless = true;",
        'export const claim = "24/7 emergency service"; // private-adjacent-text',
      ].join("\n"),
      "src/testimonials.ts": 'export const heading = "24/7 emergency service";',
    });

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("24/7 emergency service");
    expect(result.stdout).not.toContain("private-adjacent-text");
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        { forbiddenClaimIndex: 0, path: "src/page.tsx", line: 2 },
        { forbiddenClaimIndex: 0, path: "src/testimonials.ts", line: 1 },
      ],
      truncated: false,
    });
  });

  it("scans tracked tests and fixture-named paths because names are untrusted", async () => {
    const workspace = await createWorkspace({
      "src/page.tsx": "export const title = 'Mission Peak Electric';",
      "tests/page.test.ts":
        'expect(rendered).not.toContain("24/7 emergency service");',
      "tests/fixtures.ts":
        'export const forbiddenClaims = ["24/7 emergency service"];',
      "src/content.fixture.json": '{"forbiddenClaim":"24/7 emergency service"}',
    });

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout).matches).toEqual(
      expect.arrayContaining([
        {
          forbiddenClaimIndex: 0,
          path: "tests/page.test.ts",
          line: 1,
        },
        {
          forbiddenClaimIndex: 0,
          path: "tests/fixtures.ts",
          line: 1,
        },
      ]),
    );
  });

  it("scans a production route even when its directory is named test", async () => {
    const workspace = await createWorkspace({
      "src/app/test/page.tsx":
        "export default () => <p>24/7 emergency service</p>;",
    });

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        {
          forbiddenClaimIndex: 0,
          path: "src/app/test/page.tsx",
          line: 1,
        },
      ],
      truncated: false,
    });
  });

  it.each(["node_modules/served/claim.txt", ".buildlapse/claim.txt"])(
    "rejects a frozen tree containing controller-reserved path %s",
    async (path) => {
      const workspace = await createWorkspace({
        [path]: "24/7 emergency service",
      });

      const result = await runForbiddenClaimScan(
        workspace,
        "24/7 emergency service",
      );

      expect(result).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: "BUILDLAPSE_FORBIDDEN_CLAIM_SCAN_ERROR_V1\n",
      });
    },
  );

  it("scans only the frozen tracked source and handles shell metacharacters literally", async () => {
    const claim = "don't claim $(touch escaped) `uname`";
    const workspace = await createWorkspace({
      "src/page.ts": "export const title = 'Safe';",
    });
    await writeFile(
      join(workspace, "untracked.ts"),
      `export const ignored = ${JSON.stringify(claim)};`,
    );

    const cleanResult = await runForbiddenClaimScan(workspace, claim);
    expect(cleanResult).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    await writeFile(
      join(workspace, "src/page.ts"),
      `export const unsafe = ${JSON.stringify(claim)};`,
    );
    await git(workspace, ["add", "src/page.ts"]);
    await git(workspace, ["commit", "-q", "-m", "tracked claim"]);

    const matchedResult = await runForbiddenClaimScan(workspace, claim);
    expect(matchedResult.exitCode).toBe(1);
    expect(parseDiagnostics(matchedResult.stdout)).toEqual({
      matches: [{ forbiddenClaimIndex: 0, path: "src/page.ts", line: 1 }],
      truncated: false,
    });
    expect(matchedResult.stdout).not.toContain(claim);
  });

  it("caps the number and size of diagnostics", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `src/file-${String(index).padStart(2, "0")}.ts`,
        `export const claim = "24/7 emergency service"; // secret-${index}`,
      ]),
    );
    const workspace = await createWorkspace(files);

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );
    const diagnostics = parseDiagnostics(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(8_192);
    expect(diagnostics.matches).toHaveLength(20);
    expect(diagnostics.truncated).toBe(true);
    expect(result.stdout).not.toContain("secret-");
  });

  it("ignores binary assets and reports repeated multiline claims accurately", async () => {
    const claim = "always open\nincluding holidays";
    const workspace = await createWorkspace({
      "src/content.ts": `${claim}\nexport const safe = true;\n${claim}`,
    });
    const binaryPath = join(workspace, "public", "asset.bin");
    await mkdir(join(binaryPath, ".."), { recursive: true });
    await writeFile(
      binaryPath,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
    );
    await git(workspace, ["add", "public/asset.bin"]);
    await git(workspace, ["commit", "-q", "-m", "binary asset"]);

    const result = await runForbiddenClaimScan(workspace, claim);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        { forbiddenClaimIndex: 0, path: "src/content.ts", line: 1 },
        { forbiddenClaimIndex: 0, path: "src/content.ts", line: 4 },
      ],
      truncated: false,
    });
    expect(result.stdout).not.toContain("asset.bin");
  });

  it("does not trust a binary-looking filename without matching magic bytes", async () => {
    const claim = "24/7 emergency service";
    const workspace = await createWorkspace({
      "public/payload.png": `<p>${claim}</p>`,
    });

    const result = await runForbiddenClaimScan(workspace, claim);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        {
          forbiddenClaimIndex: 0,
          path: "public/payload.png",
          line: 1,
        },
      ],
      truncated: false,
    });
  });

  it("scans cleartext payloads appended to verified binary bytes", async () => {
    const claim = "24/7 emergency service";
    const workspace = await createWorkspace({
      "src/page.ts": "export const safe = true;",
    });
    await mkdir(join(workspace, "public"), { recursive: true });
    await writeFile(
      join(workspace, "public", "payload.png"),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from(`<p>${claim}</p>`, "utf8"),
      ]),
    );
    await git(workspace, ["add", "public/payload.png"]);
    await git(workspace, ["commit", "-q", "-m", "binary payload"]);

    const result = await runForbiddenClaimScan(workspace, claim);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        {
          forbiddenClaimIndex: 0,
          path: "public/payload.png",
          line: 3,
        },
      ],
      truncated: false,
    });
  });

  it("does not compact unrelated bytes inside a verified binary asset", async () => {
    const workspace = await createWorkspace({
      "src/page.ts": "export const safe = true;",
    });
    await mkdir(join(workspace, "public"), { recursive: true });
    await writeFile(
      join(workspace, "public", "asset.png"),
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from([111, 0, 112, 0, 101, 0, 110]),
      ]),
    );
    await git(workspace, ["add", "public/asset.png"]);
    await git(workspace, ["commit", "-q", "-m", "binary separators"]);

    const result = await runForbiddenClaimScan(workspace, "open");

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("accounts for a large verified binary without applying text limits", async () => {
    const workspace = await createWorkspace({
      "src/page.ts": "export const safe = true;",
    });
    const hero = Buffer.alloc(5 * 1_024 * 1_024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(hero);
    await mkdir(join(workspace, "public"), { recursive: true });
    await writeFile(join(workspace, "public", "hero.png"), hero);
    await git(workspace, ["add", "public/hero.png"]);
    await git(workspace, ["commit", "-q", "-m", "large hero"]);

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("scans forced-tracked production output and split source literals", async () => {
    const claim = "24/7 emergency service";
    const workspace = await createWorkspace({
      "dist/index.html": `<p>${claim}</p>`,
      "src/page.tsx": '<p>{"24/7"} {"emergency service"}</p>',
    });

    const result = await runForbiddenClaimScan(workspace, claim);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        { forbiddenClaimIndex: 0, path: "dist/index.html", line: 1 },
        { forbiddenClaimIndex: 0, path: "src/page.tsx", line: 1 },
      ],
      truncated: false,
    });
  });

  it.each([
    'show.onclick=()=>{output.textContent=atob("MjQvNyBlbWVyZ2VuY3kgc2VydmljZQ==")}',
    'const claim = Buffer.from("MjQvNyBlbWVyZ2VuY3kgc2VydmljZQ==", "base64").toString()',
  ])("scans bounded Base64-decoded source payloads", async (source) => {
    const workspace = await createWorkspace({
      "src/interaction.js": source,
    });

    const result = await runForbiddenClaimScan(
      workspace,
      "24/7 emergency service",
    );

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout).matches).toEqual([
      {
        forbiddenClaimIndex: 0,
        path: "src/interaction.js",
        line: 1,
      },
    ]);
  });

  it("scans all claims in one pass and binds diagnostics to claim order", async () => {
    const workspace = await createWorkspace({
      "src/page.ts":
        'export const claims = ["same-day service", "open weekends"];',
    });

    const result = await runForbiddenClaimScan(workspace, [
      "open weekends",
      "same-day service",
    ]);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        { forbiddenClaimIndex: 1, path: "src/page.ts", line: 1 },
        { forbiddenClaimIndex: 0, path: "src/page.ts", line: 1 },
      ],
      truncated: false,
    });
  });

  it("never treats NUL-containing text source as an ignorable binary", async () => {
    const claim = "24/7 emergency service";
    const workspace = await createWorkspace({
      "dist/index.html": `<p>safe\u0000${claim}</p>`,
    });

    const result = await runForbiddenClaimScan(workspace, claim);

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        {
          forbiddenClaimIndex: 0,
          path: "dist/index.html",
          line: 1,
        },
      ],
      truncated: false,
    });
  });

  it("matches non-BMP Unicode claims without a UTF-16/code-point gap", async () => {
    const workspace = await createWorkspace({
      "src/page.ts": 'export const iconLabel = "😀";',
    });

    const result = await runForbiddenClaimScan(workspace, "😀");

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout)).toEqual({
      matches: [
        {
          forbiddenClaimIndex: 0,
          path: "src/page.ts",
          line: 1,
        },
      ],
      truncated: false,
    });
  });

  it("matches canonically equivalent Unicode source text", async () => {
    const workspace = await createWorkspace({
      "src/page.ts": 'export const label = "cafe\u0301 service";',
    });

    const result = await runForbiddenClaimScan(workspace, "café service");

    expect(result.exitCode).toBe(1);
    expect(parseDiagnostics(result.stdout).matches).toEqual([
      {
        forbiddenClaimIndex: 0,
        path: "src/page.ts",
        line: 1,
      },
    ]);
  });
});

async function createWorkspace(files: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "buildlapse-verification-"));
  temporaryDirectories.push(workspace);
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.name", "Buildlapse Test"]);
  await git(workspace, [
    "config",
    "user.email",
    "buildlapse-test@example.invalid",
  ]);
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(workspace, ...path.split("/"));
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, `${contents}\n`);
  }
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-q", "-m", "frozen source"]);
  return workspace;
}

async function git(workspace: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 1_024 * 1_024,
  });
}

async function runForbiddenClaimScan(
  workspace: string,
  claims: string | string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      "/bin/sh",
      [
        "-c",
        forbiddenClaimsCommand(typeof claims === "string" ? [claims] : claims),
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 64 * 1_024,
      },
    );
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return {
        exitCode: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
    throw error;
  }
}

function parseDiagnostics(stdout: string): {
  matches: Array<{
    path: string;
    line: number;
    forbiddenClaimIndex: number;
    pathDigest?: string;
    pathTruncated?: boolean;
  }>;
  truncated: boolean;
} {
  const prefix = "BUILDLAPSE_FORBIDDEN_CLAIM_MATCHES_V1 ";
  expect(stdout.startsWith(prefix)).toBe(true);
  return JSON.parse(stdout.slice(prefix.length)) as {
    matches: Array<{
      path: string;
      line: number;
      forbiddenClaimIndex: number;
      pathDigest?: string;
      pathTruncated?: boolean;
    }>;
    truncated: boolean;
  };
}
