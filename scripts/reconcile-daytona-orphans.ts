import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";

import { Daytona } from "@daytona/sdk";

import { reconcileDaytonaOrphans } from "../src/adapters/daytona/daytona-operations.js";
import { installDaytonaScriptFailureRedaction } from "../src/adapters/daytona/daytona-script-safety.js";
import { loadConfig } from "../src/config.js";

installDaytonaScriptFailureRedaction("orphan_reconciler");

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const args = parseArguments(process.argv.slice(2));
const config = loadConfig();
const activeReferences = await loadActiveSandboxIds(
  config.BUILDLABS_DATABASE_PATH,
  args.activeIdFile,
  args.delete,
);
const activeSandboxIds = activeReferences.ids;
const daytona = new Daytona({
  apiKey: config.DAYTONA_API_KEY,
  apiUrl: config.DAYTONA_API_URL,
  ...(config.DAYTONA_TARGET ? { target: config.DAYTONA_TARGET } : {}),
  otelEnabled: config.DAYTONA_OTEL_ENABLED,
});

try {
  const report = await reconcileDaytonaOrphans({
    client: daytona,
    activeSandboxIds,
    gracePeriodMs: args.graceMs,
    dryRun: !args.delete,
  });
  process.stdout.write(
    `${JSON.stringify({
      ...report,
      activeControllerReferences: activeSandboxIds.size,
      activeReferenceSource: activeReferences.source,
    })}\n`,
  );
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
} finally {
  await daytona[Symbol.asyncDispose]();
}

function parseArguments(values: string[]): {
  delete: boolean;
  graceMs: number;
  activeIdFile?: string;
} {
  let deleteResources = false;
  let graceMs = 6 * 60 * 60 * 1_000;
  let activeIdFile: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--delete") {
      deleteResources = true;
      continue;
    }
    if (value === "--grace-ms") {
      const raw = values[++index];
      if (!raw || !/^\d+$/u.test(raw)) {
        throw new Error("--grace-ms requires an integer");
      }
      graceMs = Number(raw);
      continue;
    }
    if (value === "--active-id-file") {
      const path = values[++index];
      if (!path) {
        throw new Error("--active-id-file requires a path");
      }
      activeIdFile = path;
      continue;
    }
    throw new Error(`Unsupported reconciler argument: ${value ?? ""}`);
  }
  return {
    delete: deleteResources,
    graceMs,
    ...(activeIdFile ? { activeIdFile } : {}),
  };
}

async function loadActiveSandboxIds(
  databasePath: string,
  activeIdFile: string | undefined,
  deleting: boolean,
): Promise<{
  ids: Set<string>;
  source: "controller_database" | "active_id_file" | "none" | "unavailable";
}> {
  const ids = new Set<string>();
  if (activeIdFile) {
    const parsed = JSON.parse(await readFile(activeIdFile, "utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length > 10_000 ||
      parsed.some((value) => typeof value !== "string")
    ) {
      throw new Error("Active Daytona sandbox ID file must be a JSON array");
    }
    for (const value of parsed as string[]) {
      assertSandboxId(value);
      ids.add(value);
    }
    return { ids, source: "active_id_file" };
  }
  if (databasePath !== ":memory:" && existsSync(databasePath)) {
    try {
      const { default: Database } = await import("better-sqlite3");
      const database = new Database(databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const rows = database
          .prepare(
            `SELECT sandbox_id, builder_sandbox_id, verification_sandbox_id
             FROM build_runs
             WHERE status IN ('queued', 'running')`,
          )
          .all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          for (const value of Object.values(row)) {
            if (typeof value === "string") {
              assertSandboxId(value);
              ids.add(value);
            }
          }
        }
      } finally {
        database.close();
      }
      return { ids, source: "controller_database" };
    } catch {
      if (deleting) {
        throw new Error(
          "Deletion requires a readable controller database or --active-id-file",
        );
      }
      return { ids, source: "unavailable" };
    }
  }
  if (deleting) {
    throw new Error(
      "Deletion requires a readable controller database or --active-id-file",
    );
  }
  return { ids, source: "none" };
}

function assertSandboxId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error("Active Daytona sandbox ID is invalid");
  }
}
