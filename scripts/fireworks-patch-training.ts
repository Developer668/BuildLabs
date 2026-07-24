import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  FileFireworksSubmissionLedger,
  FireworksTrainingInputSchema,
  FireworksTrainingLifecycle,
  dryRunFireworksRft,
  exportFireworksDatasetManifest,
  validateFireworksRftPlan,
  type FireworksTrainingObservation,
  type FireworksTrainingServerExecutionPolicy,
  type FireworksTrainingSubmissionReceipt,
} from "../src/adapters/fireworks/fireworks-training.js";

type Action =
  | "cancel"
  | "cleanup"
  | "dry-run"
  | "export"
  | "observe"
  | "provider-validate"
  | "submit"
  | "validate";

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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function serverPolicy(
  action: Action,
): Promise<FireworksTrainingServerExecutionPolicy> {
  if (!["submit", "cancel", "cleanup"].includes(action)) {
    return { executePaidMutation: false };
  }
  if (process.env.FIREWORKS_EXECUTE_PAID_MUTATION !== "true") {
    throw new Error(
      "Paid mutation requires FIREWORKS_EXECUTE_PAID_MUTATION=true",
    );
  }
  const path = requiredEnvironment("FIREWORKS_EXECUTION_POLICY_PATH");
  return (await readJson(path)) as FireworksTrainingServerExecutionPolicy;
}

async function main(): Promise<void> {
  const values = argumentsMap(process.argv.slice(2));
  const action = required(values, "action") as Action;
  if (
    ![
      "cancel",
      "cleanup",
      "dry-run",
      "export",
      "observe",
      "provider-validate",
      "submit",
      "validate",
    ].includes(action)
  ) {
    throw new Error("Unsupported Fireworks Patch Model action");
  }
  const input = FireworksTrainingInputSchema.parse(
    await readJson(required(values, "input")),
  );
  const attestationKey = requiredEnvironment("PATCH_PROVIDER_ATTESTATION_KEY");

  if (action === "validate") {
    process.stdout.write(
      `${JSON.stringify(validateFireworksRftPlan(input, attestationKey))}\n`,
    );
    return;
  }
  if (action === "dry-run") {
    process.stdout.write(
      `${JSON.stringify(dryRunFireworksRft(input, attestationKey))}\n`,
    );
    return;
  }
  if (action === "export") {
    validateFireworksRftPlan(input, attestationKey);
    const outputDirectory = required(values, "output-dir");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const exports = [
      {
        providerExport: input.providerExport,
        resource: input.recipe.datasetResource,
      },
      {
        providerExport: input.evaluationProviderExport,
        resource: input.recipe.evaluationDatasetResource,
      },
    ];
    const manifests = [];
    for (const item of exports) {
      const manifest = exportFireworksDatasetManifest(
        item.providerExport,
        item.resource,
      );
      const path = join(
        outputDirectory,
        `${manifest.split}-${manifest.contentSha256}.jsonl`,
      );
      await writeFile(path, item.providerExport.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      manifests.push(manifest);
    }
    process.stdout.write(`${JSON.stringify({ manifests })}\n`);
    return;
  }

  const policy = await serverPolicy(action);
  const ledgerDirectory =
    process.env.FIREWORKS_RFT_LEDGER_DIR ??
    join(process.cwd(), ".buildlabs", "fireworks-rft-ledger");
  const lifecycle = new FireworksTrainingLifecycle({
    apiKey: requiredEnvironment("FIREWORKS_API_KEY"),
    providerAttestationKey: attestationKey,
    serverExecutionPolicy: policy,
    ledger: new FileFireworksSubmissionLedger(ledgerDirectory),
  });

  if (action === "provider-validate") {
    process.stdout.write(
      `${JSON.stringify(await lifecycle.validateProvider(input))}\n`,
    );
    return;
  }
  if (action === "submit") {
    process.stdout.write(`${JSON.stringify(await lifecycle.submit(input))}\n`);
    return;
  }

  const receipt = (await readJson(
    required(values, "receipt"),
  )) as FireworksTrainingSubmissionReceipt;
  if (action === "observe") {
    process.stdout.write(
      `${JSON.stringify(await lifecycle.observe(receipt))}\n`,
    );
    return;
  }
  if (action === "cancel") {
    process.stdout.write(
      `${JSON.stringify(await lifecycle.cancel(input, receipt))}\n`,
    );
    return;
  }
  const observation = (await readJson(
    required(values, "observation"),
  )) as FireworksTrainingObservation;
  process.stdout.write(
    `${JSON.stringify(await lifecycle.cleanup(input, receipt, observation))}\n`,
  );
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`Fireworks Patch Model workflow failed: ${code}\n`);
  process.exitCode = 1;
});
