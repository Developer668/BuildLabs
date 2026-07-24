import { readFile } from "node:fs/promises";

import { BraintrustPatchModelMatrix } from "../src/adapters/braintrust/patch-model-matrix.js";
import { evaluatePatchModelMatrix } from "../src/application/patch-model-evaluation.js";
import { PatchEvaluationMatrixInputSchema } from "../src/domain/patch-model-evaluation.js";

function argumentsMap(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be provided as --name value pairs");
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const values = argumentsMap(process.argv.slice(2));
  const action = required(values, "action");
  const rawInput = await readJson(required(values, "input"));
  const eligibilityKeyId = requiredEnvironment(
    "PATCH_ELIGIBILITY_SIGNING_KEY_ID",
  );
  const eligibilityKey = requiredEnvironment("PATCH_ELIGIBILITY_SIGNING_KEY");

  if (action === "eligibility") {
    const matrix = PatchEvaluationMatrixInputSchema.parse(rawInput);
    process.stdout.write(
      `${JSON.stringify(
        evaluatePatchModelMatrix(matrix, {
          keyId: eligibilityKeyId,
          key: eligibilityKey,
        }),
      )}\n`,
    );
    return;
  }
  if (action !== "record") {
    throw new Error("Unsupported Braintrust Patch Model action");
  }
  if (process.env.BRAINTRUST_EXECUTE_EVALUATION !== "true") {
    throw new Error(
      "Braintrust recording requires BRAINTRUST_EXECUTE_EVALUATION=true",
    );
  }
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput) ||
    !("trialsByModel" in rawInput)
  ) {
    throw new Error("Braintrust matrix recording input is malformed");
  }
  const record = rawInput as Record<string, unknown>;
  const rawTrials = record.trialsByModel;
  if (
    typeof rawTrials !== "object" ||
    rawTrials === null ||
    Array.isArray(rawTrials)
  ) {
    throw new Error("Braintrust trialsByModel must be an object");
  }
  const adapter = new BraintrustPatchModelMatrix({
    apiKey: requiredEnvironment("BRAINTRUST_API_KEY"),
    ...(process.env.BRAINTRUST_ORG_NAME
      ? { orgName: process.env.BRAINTRUST_ORG_NAME }
      : {}),
    eligibilityKeyId,
    eligibilityKey,
    checkpointAttestationKey: requiredEnvironment(
      "PATCH_CHECKPOINT_ATTESTATION_KEY",
    ),
  });
  const result = await adapter.recordAndEvaluate({
    dataset: record.dataset as Parameters<
      BraintrustPatchModelMatrix["recordAndEvaluate"]
    >[0]["dataset"],
    minimumTrialsPerCase: Number(record.minimumTrialsPerCase),
    minimumTerminalScore: Number(record.minimumTerminalScore),
    minimumPairedImprovement: Number(record.minimumPairedImprovement),
    models: record.models as Parameters<
      BraintrustPatchModelMatrix["recordAndEvaluate"]
    >[0]["models"],
    trialsByModel: new Map(
      Object.entries(rawTrials).map(([model, trials]) => [
        model,
        trials as Parameters<
          BraintrustPatchModelMatrix["recordAndEvaluate"]
        >[0]["trialsByModel"] extends ReadonlyMap<string, infer TrialGroup>
          ? TrialGroup
          : never,
      ]),
    ),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Braintrust Patch Model workflow failed: ${code}\n`);
  process.exitCode = 1;
});
