import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FIREWORKS_MANAGED_RFT_BASE_MODEL,
  FireworksTrainingLifecycle,
  createFireworksTrainingCapabilitySnapshot,
  dryRunFireworksRft,
  exportFireworksDatasetManifest,
  type FireworksCommandRunner,
  type FireworksSubmissionLedger,
  type FireworksTrainingHttpClient,
  type FireworksTrainingInput,
  type FireworksTrainingServerExecutionPolicy,
} from "../src/adapters/fireworks/fireworks-training.js";
import type { PatchProviderExport } from "../src/domain/patch-model-provider.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";

const NOW = new Date("2026-07-24T18:00:00.000Z");
const ACCOUNT = "buildlabs-test";
const EVALUATOR = `accounts/${ACCOUNT}/evaluators/patch-evaluator-v1`;
const OUTPUT_MODEL = `accounts/${ACCOUNT}/models/patch-candidate-v1`;
const WARM_START_MODEL = `accounts/${ACCOUNT}/models/patch-sft-v1`;
const KEY = "buildlabs-provider-attestation-key-for-tests";
const BUNDLE_DIGEST = "b".repeat(64);
const BUNDLE_SIGNATURE = "c".repeat(64);
const PROJECT_SCOPE_ID = "f".repeat(64);
const PROVIDER_POLICY_DIGEST = "3".repeat(64);
const CONSENT_DIGEST = "4".repeat(64);

function exportSignature(body: Readonly<Record<string, unknown>>): string {
  return createHmac("sha256", Buffer.from(KEY, "utf8"))
    .update("buildlabs.patch-provider.export.v1")
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

function providerExport(input: {
  split: "heldout" | "train";
  caseId?: string;
  projectScopeId?: string;
  bundleDigest?: string;
  mutateRecord?: (record: Record<string, unknown>) => void;
}): PatchProviderExport {
  const projectScopeId = input.projectScopeId ?? PROJECT_SCOPE_ID;
  const bundleDigest = input.bundleDigest ?? BUNDLE_DIGEST;
  const record: Record<string, unknown> = {
    messages: [
      { role: "system", content: "Apply the smallest safe patch." },
      { role: "user", content: "Fix the governed hard requirement." },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply a patch.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { patch: { type: "string" } },
            required: ["patch"],
          },
        },
      },
    ],
    metadata: {
      schemaVersion: 1,
      caseId: input.caseId ?? (input.split === "train" ? "a" : "e").repeat(64),
      projectScopeId,
      split: input.split,
      bundleDigest,
      contractRevision: 1,
      sourceDigest: "1".repeat(64),
      providerSourceDigest: "2".repeat(64),
      providerPolicyDigest: PROVIDER_POLICY_DIGEST,
    },
  };
  input.mutateRecord?.(record);
  const content = `${JSON.stringify(record)}\n`;
  const contentSha256 = sha256(content);
  const attestationBody = {
    schemaVersion: 1 as const,
    purpose: "fireworks-provider-export" as const,
    projectScopeId,
    bundleDigest,
    bundleAttestationSignature: BUNDLE_SIGNATURE,
    providerPolicyDigest: PROVIDER_POLICY_DIGEST,
    consentReceiptDigests: [CONSENT_DIGEST],
    format: "fireworks-rft-jsonl" as const,
    split: input.split,
    lineCount: 1,
    contentSha256,
  };
  return {
    schemaVersion: 1,
    bundleDigest,
    format: "fireworks-rft-jsonl",
    split: input.split,
    lineCount: 1,
    contentSha256,
    content,
    attestation: {
      ...attestationBody,
      signature: exportSignature(attestationBody),
    },
  };
}

function baseInput(): FireworksTrainingInput {
  const training = providerExport({ split: "train" });
  const evaluation = providerExport({ split: "heldout" });
  const datasetResource =
    `accounts/${ACCOUNT}/datasets/patch-train-` +
    training.contentSha256.slice(0, 16);
  const evaluationDatasetResource =
    `accounts/${ACCOUNT}/datasets/patch-heldout-` +
    evaluation.contentSha256.slice(0, 16);
  const capability = createFireworksTrainingCapabilitySnapshot({
    schemaVersion: 1,
    modelResource: FIREWORKS_MANAGED_RFT_BASE_MODEL,
    lifecycleState: "READY",
    supportsServerless: true,
    tunable: true,
    rlTunable: true,
    rlLoraTunable: true,
    rlFullParameterTunable: false,
    trainingContextLength: 65_536,
    observedAt: NOW.toISOString(),
    catalogDigest: "d".repeat(64),
  });
  return {
    accountId: ACCOUNT,
    providerExport: training,
    evaluationProviderExport: evaluation,
    capability,
    recipe: {
      datasetResource,
      evaluationDatasetResource,
      evaluatorResource: EVALUATOR,
      baseModelResource: FIREWORKS_MANAGED_RFT_BASE_MODEL,
      outputModelResource: OUTPUT_MODEL,
      epochs: 1,
      learningRate: 0.00001,
      maxContextLength: 32_768,
      maxOutputTokens: 1_024,
      responseCandidatesCount: 2,
      maxConcurrentRollouts: 4,
      maxConcurrentEvaluations: 2,
      nodeCount: 1,
    },
    execution: {
      executePaidMutation: false,
      authorizationId: "5".repeat(64),
      expiresAt: "2026-07-25T18:00:00.000Z",
      authorizedSubmissionKey: "0".repeat(64),
      authorizedDatasetDigests: ["0".repeat(64)],
      authorizedDatasetResources: [datasetResource, evaluationDatasetResource],
      authorizedEvaluatorResources: [EVALUATOR],
      authorizedBaseModels: [FIREWORKS_MANAGED_RFT_BASE_MODEL],
      authorizedOutputModels: [OUTPUT_MODEL],
      maximumCostMicros: 200_000_000,
    },
  };
}

function authorize(input: FireworksTrainingInput): FireworksTrainingInput {
  const submissionKey = dryRunFireworksRft(input, KEY).plan.submissionKey;
  return {
    ...input,
    execution: {
      ...input.execution,
      executePaidMutation: true,
      authorizedSubmissionKey: submissionKey,
      authorizedDatasetDigests: [
        input.providerExport.contentSha256,
        input.evaluationProviderExport.contentSha256,
      ],
    },
  };
}

function serverPolicy(
  input: FireworksTrainingInput,
): Extract<
  FireworksTrainingServerExecutionPolicy,
  { executePaidMutation: true }
> {
  const authorized = authorize(input);
  return {
    ...authorized.execution,
    executePaidMutation: true,
  };
}

class DurableLedger implements FireworksSubmissionLedger {
  readonly durable = true;
  readonly keys = new Set<string>();

  claim(submissionKey: string): Promise<boolean> {
    if (this.keys.has(submissionKey)) return Promise.resolve(false);
    this.keys.add(submissionKey);
    return Promise.resolve(true);
  }

  complete(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeFireworksProvider implements FireworksTrainingHttpClient {
  readonly requests: Parameters<FireworksTrainingHttpClient["request"]>[0][] =
    [];
  input: FireworksTrainingInput;
  jobExists = false;
  jobState = "JOB_STATE_RUNNING";
  outputReady = false;
  evaluatorState = "ACTIVE";
  jobIdentityMode: "exact" | "missing-dataset" | "wrong-evaluator" = "exact";
  remoteTrainingContent?: string;
  remoteEvaluationContent?: string;

  constructor(input: FireworksTrainingInput) {
    this.input = input;
  }

  request(
    request: Parameters<FireworksTrainingHttpClient["request"]>[0],
  ): Promise<Awaited<ReturnType<FireworksTrainingHttpClient["request"]>>> {
    this.requests.push(request);
    const plan = dryRunFireworksRft(this.input, KEY).plan;
    if (request.url.endsWith(`/${plan.recipe.baseModelResource}`)) {
      return Promise.resolve({
        status: 200,
        json: {
          name: plan.recipe.baseModelResource,
          state: "READY",
          supportsServerless: true,
          tunable: true,
          rlTunable: true,
          rlLoraTunable: true,
          rlFullParameterTunable: false,
          trainingContextLength: 65_536,
        },
      });
    }
    if (
      plan.recipe.warmStartFromModelResource !== undefined &&
      request.url.endsWith(`/${plan.recipe.warmStartFromModelResource}`)
    ) {
      return Promise.resolve({
        status: 200,
        json: {
          name: plan.recipe.warmStartFromModelResource,
          state: "READY",
        },
      });
    }
    if (
      request.url.endsWith(
        `/${plan.recipe.datasetResource}:getDownloadEndpoint`,
      )
    ) {
      return Promise.resolve({
        status: 200,
        json: {
          filenameToSignedUrls: {
            "train.jsonl": "https://signed.test/train.jsonl",
          },
        },
      });
    }
    if (
      request.url.endsWith(
        `/${plan.recipe.evaluationDatasetResource}:getDownloadEndpoint`,
      )
    ) {
      return Promise.resolve({
        status: 200,
        json: {
          filenameToSignedUrls: {
            "heldout.jsonl": "https://signed.test/heldout.jsonl",
          },
        },
      });
    }
    if (request.url === "https://signed.test/train.jsonl") {
      return Promise.resolve({
        status: 200,
        text: this.remoteTrainingContent ?? this.input.providerExport.content,
      });
    }
    if (request.url === "https://signed.test/heldout.jsonl") {
      return Promise.resolve({
        status: 200,
        text:
          this.remoteEvaluationContent ??
          this.input.evaluationProviderExport.content,
      });
    }
    if (request.url.endsWith(`/${plan.recipe.evaluatorResource}`)) {
      return Promise.resolve({
        status: 200,
        json: {
          name: plan.recipe.evaluatorResource,
          state: this.evaluatorState,
        },
      });
    }
    if (request.url.endsWith(`/${plan.jobResource}`)) {
      const trainingConfig = {
        outputModel: plan.recipe.outputModelResource,
        epochs: plan.recipe.epochs,
        learningRate: plan.recipe.learningRate,
        maxContextLength: plan.recipe.maxContextLength,
        ...(plan.recipe.warmStartFromModelResource === undefined
          ? { baseModel: plan.recipe.baseModelResource }
          : { warmStartFrom: plan.recipe.warmStartFromModelResource }),
      };
      return Promise.resolve(
        this.jobExists
          ? {
              status: 200,
              json: {
                name: plan.jobResource,
                state: this.jobState,
                ...(this.jobIdentityMode === "missing-dataset"
                  ? {}
                  : { dataset: plan.recipe.datasetResource }),
                evaluationDataset: plan.recipe.evaluationDatasetResource,
                evaluator:
                  this.jobIdentityMode === "wrong-evaluator"
                    ? `accounts/${ACCOUNT}/evaluators/wrong`
                    : plan.recipe.evaluatorResource,
                maxConcurrentRollouts: plan.recipe.maxConcurrentRollouts,
                maxConcurrentEvaluations: plan.recipe.maxConcurrentEvaluations,
                nodeCount: plan.recipe.nodeCount,
                trainingConfig,
                inferenceParameters: {
                  maxOutputTokens: plan.recipe.maxOutputTokens,
                  responseCandidatesCount: plan.recipe.responseCandidatesCount,
                },
              },
            }
          : { status: 404 },
      );
    }
    if (request.url.endsWith(`/${plan.recipe.outputModelResource}`)) {
      return Promise.resolve(
        this.outputReady
          ? {
              status: 200,
              json: {
                name: plan.recipe.outputModelResource,
                state: "READY",
                supportsServerless: true,
              },
            }
          : { status: 404 },
      );
    }
    if (request.url.endsWith(`/${plan.jobResource}:cancel`)) {
      this.jobState = "JOB_STATE_CANCELLED";
      return Promise.resolve({ status: 200, json: {} });
    }
    if (
      request.method === "DELETE" &&
      request.url.endsWith(`/${plan.jobResource}`)
    ) {
      return Promise.resolve({ status: 204 });
    }
    throw new Error(`Unexpected fake Fireworks request: ${request.url}`);
  }
}

function fakeRunner(provider: FakeFireworksProvider): {
  runner: FireworksCommandRunner;
  calls: Parameters<FireworksCommandRunner["run"]>[0][];
  isolation: {
    emptyEnvironmentContent?: string;
    emptyEnvironmentMode?: number;
  };
} {
  const calls: Parameters<FireworksCommandRunner["run"]>[0][] = [];
  const isolation: {
    emptyEnvironmentContent?: string;
    emptyEnvironmentMode?: number;
  } = {};
  return {
    calls,
    isolation,
    runner: {
      async run(input) {
        calls.push(input);
        const envFileFlag = input.arguments.indexOf("--env-file");
        const envFile = input.arguments[envFileFlag + 1];
        if (envFileFlag < 0 || envFile === undefined) {
          throw new Error("Missing isolated Eval Protocol environment file");
        }
        isolation.emptyEnvironmentContent = await readFile(envFile, "utf8");
        isolation.emptyEnvironmentMode = (await stat(envFile)).mode & 0o777;
        provider.jobExists = true;
        return {
          exitCode: 0,
          stdout: "provider output containing raw log material",
          stderr: "",
        };
      },
    },
  };
}

function executableLifecycle(input: FireworksTrainingInput) {
  const authorized = authorize(input);
  const provider = new FakeFireworksProvider(authorized);
  const { runner, calls, isolation } = fakeRunner(provider);
  const lifecycle = new FireworksTrainingLifecycle({
    apiKey: "fireworks-secret",
    providerAttestationKey: KEY,
    serverExecutionPolicy: serverPolicy(input),
    runner,
    ledger: new DurableLedger(),
    http: provider,
    now: () => NOW,
  });
  return { authorized, provider, calls, isolation, lifecycle };
}

describe("Fireworks managed RFT lifecycle", () => {
  it("binds both governed splits in a pure local dry-run", () => {
    const input = baseInput();
    const dryRun = dryRunFireworksRft(input, KEY);

    expect(dryRun.mutationExecuted).toBe(false);
    expect(dryRun.plan.datasetContentSha256).toBe(
      input.providerExport.contentSha256,
    );
    expect(dryRun.plan.evaluationDatasetContentSha256).toBe(
      input.evaluationProviderExport.contentSha256,
    );
    expect(dryRun.plan.conservativeCostUpperBoundMicros).toBeGreaterThan(0);
    expect(dryRun.plan.conservativeCostUpperBoundMicros).not.toBe(
      input.execution.maximumCostMicros,
    );
    expect(dryRun.plan.costPolicyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      dryRunFireworksRft(
        {
          ...input,
          recipe: { ...input.recipe, maxOutputTokens: 2_048 },
        },
        KEY,
      ).plan.conservativeCostUpperBoundMicros,
    ).toBeGreaterThan(dryRun.plan.conservativeCostUpperBoundMicros);
    expect(dryRun.arguments).not.toContain("--dry-run");
    expect(dryRun.arguments).toContain("--env-file");
    expect(dryRun.status).toEqual({
      datasetReady: true,
      providerValidated: false,
      trainingSubmitted: false,
      checkpointReady: false,
      evaluated: false,
      eligible: false,
      promoted: false,
    });

    const trainManifest = exportFireworksDatasetManifest(
      input.providerExport,
      input.recipe.datasetResource,
    );
    const heldoutManifest = exportFireworksDatasetManifest(
      input.evaluationProviderExport,
      input.recipe.evaluationDatasetResource,
    );
    expect(trainManifest.split).toBe("train");
    expect(heldoutManifest.split).toBe("heldout");
    expect(JSON.stringify([trainManifest, heldoutManifest])).not.toMatch(
      /signed|stdout|stderr|https?:\/\//iu,
    );
  });

  it("rejects held-out swaps, overlap, bad signatures, and reward leakage", () => {
    const input = baseInput();
    const changedHeldout = providerExport({
      split: "heldout",
      caseId: "9".repeat(64),
    });
    const changedInput: FireworksTrainingInput = {
      ...input,
      evaluationProviderExport: changedHeldout,
      recipe: {
        ...input.recipe,
        evaluationDatasetResource:
          `accounts/${ACCOUNT}/datasets/patch-heldout-` +
          changedHeldout.contentSha256.slice(0, 16),
      },
    };
    expect(dryRunFireworksRft(changedInput, KEY).plan.submissionKey).not.toBe(
      dryRunFireworksRft(input, KEY).plan.submissionKey,
    );

    const overlap = providerExport({
      split: "heldout",
      caseId: "a".repeat(64),
    });
    expect(() =>
      dryRunFireworksRft(
        {
          ...input,
          evaluationProviderExport: overlap,
          recipe: {
            ...input.recipe,
            evaluationDatasetResource:
              `accounts/${ACCOUNT}/datasets/patch-heldout-` +
              overlap.contentSha256.slice(0, 16),
          },
        },
        KEY,
      ),
    ).toThrow(/overlap/u);

    const crossProject = providerExport({
      split: "heldout",
      projectScopeId: "8".repeat(64),
    });
    expect(() =>
      dryRunFireworksRft(
        {
          ...input,
          evaluationProviderExport: crossProject,
          recipe: {
            ...input.recipe,
            evaluationDatasetResource:
              `accounts/${ACCOUNT}/datasets/patch-heldout-` +
              crossProject.contentSha256.slice(0, 16),
          },
        },
        KEY,
      ),
    ).toThrow(/one governed bundle and project/u);

    const badSignature = structuredClone(input.providerExport);
    badSignature.attestation.signature = "0".repeat(64);
    expect(() =>
      dryRunFireworksRft({ ...input, providerExport: badSignature }, KEY),
    ).toThrow(/signature is invalid/u);

    const rewardLeak = providerExport({
      split: "train",
      mutateRecord(record) {
        record.reward = 1;
      },
    });
    expect(() =>
      dryRunFireworksRft(
        {
          ...input,
          providerExport: rewardLeak,
          recipe: {
            ...input.recipe,
            datasetResource:
              `accounts/${ACCOUNT}/datasets/patch-train-` +
              rewardLeak.contentSha256.slice(0, 16),
          },
        },
        KEY,
      ),
    ).toThrow(/reward leakage/u);
  });

  it("requires independent execution policy, exact allowlists, and budget", async () => {
    const input = authorize(baseInput());
    const provider = new FakeFireworksProvider(input);
    const { runner, calls } = fakeRunner(provider);
    const disabled = new FireworksTrainingLifecycle({
      apiKey: "fireworks-secret",
      providerAttestationKey: KEY,
      runner,
      http: provider,
      ledger: new DurableLedger(),
      now: () => NOW,
    });
    await expect(disabled.submit(input)).rejects.toThrow(/not authorized/u);
    expect(provider.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const badHeldoutAllowlist = {
      ...input,
      execution: {
        ...input.execution,
        authorizedDatasetDigests: [input.providerExport.contentSha256],
      },
    };
    const policy = serverPolicy(baseInput());
    const guarded = new FireworksTrainingLifecycle({
      apiKey: "fireworks-secret",
      providerAttestationKey: KEY,
      serverExecutionPolicy: policy,
      runner,
      http: provider,
      ledger: new DurableLedger(),
      now: () => NOW,
    });
    await expect(guarded.submit(badHeldoutAllowlist)).rejects.toThrow(
      /held-out dataset digest.*allowlisted/u,
    );
    await expect(
      guarded.submit({
        ...input,
        execution: { ...input.execution, maximumCostMicros: 1 },
      }),
    ).rejects.toThrow(/bounded budget/u);
    const serverBudgetGuarded = new FireworksTrainingLifecycle({
      apiKey: "fireworks-secret",
      providerAttestationKey: KEY,
      serverExecutionPolicy: { ...policy, maximumCostMicros: 1 },
      runner,
      http: provider,
      ledger: new DurableLedger(),
      now: () => NOW,
    });
    await expect(serverBudgetGuarded.submit(input)).rejects.toThrow(
      /bounded budget/u,
    );
    expect(provider.requests).toHaveLength(0);
  });

  it("authenticates exact provider resources and remote bytes before submit", async () => {
    const { authorized, provider, calls, isolation, lifecycle } =
      executableLifecycle(baseInput());

    const receipt = await lifecycle.submit(authorized);

    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.environment).sort()).toEqual([
      "FIREWORKS_API_BASE",
      "FIREWORKS_API_KEY",
      "HOME",
      "PATH",
      "PYTHONNOUSERSITE",
      "TMPDIR",
      "UV_NO_CONFIG",
    ]);
    expect(calls[0]?.environment.FIREWORKS_API_KEY).toBe("fireworks-secret");
    expect(
      calls[0]?.environment.PATCH_PROVIDER_ATTESTATION_KEY,
    ).toBeUndefined();
    expect(calls[0]?.workingDirectory).not.toBe(process.cwd());
    expect(calls[0]?.environment.HOME).toBe(calls[0]?.workingDirectory);
    expect(calls[0]?.environment.TMPDIR).toBe(calls[0]?.workingDirectory);
    const envFileFlag = calls[0]!.arguments.indexOf("--env-file");
    expect(envFileFlag).toBeGreaterThan(0);
    expect(calls[0]!.arguments[envFileFlag + 1]).toContain(
      calls[0]!.workingDirectory,
    );
    expect(calls[0]!.arguments[envFileFlag + 1]).not.toBe(
      `${process.cwd()}/.env`,
    );
    expect(isolation).toEqual({
      emptyEnvironmentContent: "",
      emptyEnvironmentMode: 0o600,
    });
    await expect(stat(calls[0]!.workingDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(receipt.status).toMatchObject({
      datasetReady: true,
      providerValidated: true,
      trainingSubmitted: true,
      promoted: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("raw log material");
    const signedRequests = provider.requests.filter(({ url }) =>
      url.startsWith("https://signed.test/"),
    );
    expect(signedRequests).toHaveLength(2);
    expect(
      signedRequests.every(({ headers }) => !("Authorization" in headers)),
    ).toBe(true);
  });

  it("fails closed on remote contamination, inactive evaluator, and existing job", async () => {
    for (const mode of ["remote", "evaluator", "job"] as const) {
      const input = baseInput();
      const { authorized, provider, calls, lifecycle } =
        executableLifecycle(input);
      if (mode === "remote") provider.remoteEvaluationContent = "{}\n";
      if (mode === "evaluator") provider.evaluatorState = "DISABLED";
      if (mode === "job") provider.jobExists = true;

      await expect(lifecycle.submit(authorized)).rejects.toThrow(
        mode === "remote"
          ? /remote dataset bytes/u
          : mode === "evaluator"
            ? /not active/u
            : /training job already exists/u,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("blocks duplicate submissions across lifecycle instances", async () => {
    const input = baseInput();
    const authorized = authorize(input);
    const provider = new FakeFireworksProvider(authorized);
    const { runner, calls } = fakeRunner(provider);
    const ledger = new DurableLedger();
    const options = {
      apiKey: "fireworks-secret",
      providerAttestationKey: KEY,
      serverExecutionPolicy: serverPolicy(input),
      runner,
      ledger,
      http: provider,
      now: () => NOW,
    } as const;
    const first = new FireworksTrainingLifecycle(options);
    const second = new FireworksTrainingLifecycle(options);

    await first.submit(authorized);
    await expect(second.submit(authorized)).rejects.toThrow(
      /training job already exists|Duplicate Fireworks RFT submission/u,
    );
    expect(calls).toHaveLength(1);
  });

  it("supports the documented SFT warm-start flag only when pinned", async () => {
    const base = baseInput();
    const withWarmStart: FireworksTrainingInput = {
      ...base,
      recipe: {
        ...base.recipe,
        warmStartFromModelResource: WARM_START_MODEL,
      },
      execution: {
        ...base.execution,
        authorizedBaseModels: [
          ...base.execution.authorizedBaseModels,
          WARM_START_MODEL,
        ],
      },
    };
    const authorized = authorize(withWarmStart);
    const provider = new FakeFireworksProvider(authorized);
    const { runner, calls } = fakeRunner(provider);
    const policy = serverPolicy(withWarmStart);
    const lifecycle = new FireworksTrainingLifecycle({
      apiKey: "fireworks-secret",
      providerAttestationKey: KEY,
      serverExecutionPolicy: {
        ...policy,
        authorizedBaseModels: [
          ...policy.authorizedBaseModels,
          WARM_START_MODEL,
        ],
      },
      runner,
      ledger: new DurableLedger(),
      http: provider,
      now: () => NOW,
    });

    await lifecycle.submit(authorized);

    const flag = calls[0]?.arguments.indexOf("--warm-start-from") ?? -1;
    expect(flag).toBeGreaterThan(0);
    expect(calls[0]?.arguments[flag + 1]).toBe(WARM_START_MODEL);
    expect(calls[0]?.arguments).not.toContain("--base-model");
  });

  it("fails closed when authoritative job identity is missing or changed", async () => {
    for (const mode of ["missing-dataset", "wrong-evaluator"] as const) {
      const input = baseInput();
      const { authorized, provider, lifecycle } = executableLifecycle(input);
      provider.jobIdentityMode = mode;
      await expect(lifecycle.submit(authorized)).rejects.toThrow(
        /did not preserve its pinned/u,
      );
    }
  });

  it("requires a ready checkpoint and revalidates terminal cleanup", async () => {
    const { authorized, provider, lifecycle } =
      executableLifecycle(baseInput());
    const receipt = await lifecycle.submit(authorized);
    provider.jobState = "JOB_STATE_COMPLETED";

    await expect(lifecycle.observe(receipt)).rejects.toThrow(
      /checkpoint validation failed/u,
    );
    provider.outputReady = true;
    const observation = await lifecycle.observe(receipt);
    expect(observation.status).toMatchObject({
      checkpointReady: true,
      evaluated: false,
      eligible: false,
      promoted: false,
    });

    const tampered = {
      ...observation,
      providerState: "completed" as const,
      observationDigest: "0".repeat(64),
    };
    await expect(
      lifecycle.cleanup(authorized, receipt, tampered),
    ).rejects.toThrow();

    provider.jobState = "JOB_STATE_RUNNING";
    await expect(
      lifecycle.cleanup(authorized, receipt, observation),
    ).rejects.toThrow(/not terminal/u);
    provider.jobState = "JOB_STATE_COMPLETED";
    await expect(
      lifecycle.cleanup(authorized, receipt, observation),
    ).resolves.toMatchObject({ operation: "cleanup" });
  });
});
