import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { verifyPatchProviderExport } from "../../application/patch-model-provider.js";
import {
  PatchProviderExportSchema,
  PatchProviderToolDefinitionSchema,
  type PatchProviderExport,
} from "../../domain/patch-model-provider.js";
import { digestJson, sha256 } from "../../lib/canonical-json.js";

export const FIREWORKS_EVAL_PROTOCOL_VERSION = "0.3.32";
export const FIREWORKS_MANAGED_RFT_BASE_MODEL =
  "accounts/fireworks/models/kimi-k2p6";

const MAX_AUTHORIZED_COST_MICROS = 1_000_000_000;
const RFT_COST_POLICY = Object.freeze({
  version: 1,
  maximumGpuHourlyRateMicros: 12_000_000,
  maximumGpusPerNode: 8,
  minimumAggregateTokensPerSecond: 4,
  maximumEvaluatorSecondsPerRollout: 120,
  fixedTrainerSecondsPerEpoch: 3_600,
});
export const FIREWORKS_RFT_COST_POLICY_DIGEST = digestJson(RFT_COST_POLICY);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AccountIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const ModelResourceSchema = z
  .string()
  .max(256)
  .regex(/^accounts\/[A-Za-z0-9._-]+\/models\/[A-Za-z0-9._-]+$/);
const DatasetResourceSchema = z
  .string()
  .max(256)
  .regex(/^accounts\/[A-Za-z0-9._-]+\/datasets\/[A-Za-z0-9._-]+$/);
const EvaluatorResourceSchema = z
  .string()
  .max(256)
  .regex(/^accounts\/[A-Za-z0-9._-]+\/evaluators\/[A-Za-z0-9._-]+$/);
const IsoTimestampSchema = z.string().datetime({ offset: true });

const CapabilityBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  modelResource: ModelResourceSchema,
  lifecycleState: z.literal("READY"),
  supportsServerless: z.literal(true),
  tunable: z.literal(true),
  rlTunable: z.literal(true),
  rlLoraTunable: z.boolean(),
  rlFullParameterTunable: z.boolean(),
  trainingContextLength: z.number().int().min(1_024).max(1_048_576),
  observedAt: IsoTimestampSchema,
  catalogDigest: Sha256Schema,
});

export const FireworksTrainingCapabilitySnapshotSchema = z
  .strictObject({
    ...CapabilityBodySchema.shape,
    snapshotDigest: Sha256Schema,
  })
  .superRefine((snapshot, context) => {
    const body = CapabilityBodySchema.parse({
      schemaVersion: snapshot.schemaVersion,
      modelResource: snapshot.modelResource,
      lifecycleState: snapshot.lifecycleState,
      supportsServerless: snapshot.supportsServerless,
      tunable: snapshot.tunable,
      rlTunable: snapshot.rlTunable,
      rlLoraTunable: snapshot.rlLoraTunable,
      rlFullParameterTunable: snapshot.rlFullParameterTunable,
      trainingContextLength: snapshot.trainingContextLength,
      observedAt: snapshot.observedAt,
      catalogDigest: snapshot.catalogDigest,
    });
    if (snapshot.snapshotDigest !== digestJson(body)) {
      context.addIssue({
        code: "custom",
        message: "Training capability snapshot digest does not match",
        path: ["snapshotDigest"],
      });
    }
    if (!snapshot.rlLoraTunable && !snapshot.rlFullParameterTunable) {
      context.addIssue({
        code: "custom",
        message: "Training capability snapshot lacks a detailed RFT method",
        path: ["rlLoraTunable"],
      });
    }
  });
export type FireworksTrainingCapabilitySnapshot = z.infer<
  typeof FireworksTrainingCapabilitySnapshotSchema
>;

export function createFireworksTrainingCapabilitySnapshot(
  input: z.input<typeof CapabilityBodySchema>,
): FireworksTrainingCapabilitySnapshot {
  const body = CapabilityBodySchema.parse(input);
  return FireworksTrainingCapabilitySnapshotSchema.parse({
    ...body,
    snapshotDigest: digestJson(body),
  });
}

const TrainingRecipeSchema = z.strictObject({
  datasetResource: DatasetResourceSchema,
  evaluationDatasetResource: DatasetResourceSchema,
  evaluatorResource: EvaluatorResourceSchema,
  baseModelResource: ModelResourceSchema,
  warmStartFromModelResource: ModelResourceSchema.optional(),
  outputModelResource: ModelResourceSchema,
  epochs: z.number().int().min(1).max(4),
  learningRate: z.number().positive().max(0.001),
  maxContextLength: z.number().int().min(1_024).max(65_536),
  maxOutputTokens: z.number().int().min(1).max(65_536),
  responseCandidatesCount: z.number().int().min(1).max(8),
  maxConcurrentRollouts: z.number().int().min(1).max(32),
  maxConcurrentEvaluations: z.number().int().min(1).max(16),
  nodeCount: z.number().int().min(1).max(4),
});
export type FireworksTrainingRecipe = z.infer<typeof TrainingRecipeSchema>;

const ExecutionAuthorizationSchema = z.strictObject({
  executePaidMutation: z.boolean(),
  authorizationId: Sha256Schema,
  expiresAt: IsoTimestampSchema,
  authorizedSubmissionKey: Sha256Schema,
  authorizedDatasetDigests: z.array(Sha256Schema).min(1).max(32),
  authorizedDatasetResources: z.array(DatasetResourceSchema).min(1).max(32),
  authorizedEvaluatorResources: z.array(EvaluatorResourceSchema).min(1).max(16),
  authorizedBaseModels: z.array(ModelResourceSchema).min(1).max(16),
  authorizedOutputModels: z.array(ModelResourceSchema).min(1).max(16),
  maximumCostMicros: z
    .number()
    .int()
    .positive()
    .max(MAX_AUTHORIZED_COST_MICROS),
});
export type FireworksTrainingExecutionAuthorization = z.infer<
  typeof ExecutionAuthorizationSchema
>;

const ServerExecutionPolicySchema = z.discriminatedUnion(
  "executePaidMutation",
  [
    z.strictObject({ executePaidMutation: z.literal(false) }),
    ExecutionAuthorizationSchema.extend({
      executePaidMutation: z.literal(true),
    }),
  ],
);
export type FireworksTrainingServerExecutionPolicy = z.infer<
  typeof ServerExecutionPolicySchema
>;

export const FireworksTrainingInputSchema = z.strictObject({
  accountId: AccountIdSchema,
  providerExport: PatchProviderExportSchema,
  evaluationProviderExport: PatchProviderExportSchema,
  capability: FireworksTrainingCapabilitySnapshotSchema,
  recipe: TrainingRecipeSchema,
  execution: ExecutionAuthorizationSchema,
});
export type FireworksTrainingInput = z.infer<
  typeof FireworksTrainingInputSchema
>;

export interface FireworksImprovementLoopStatus {
  datasetReady: boolean;
  providerValidated: boolean;
  trainingSubmitted: boolean;
  checkpointReady: boolean;
  evaluated: boolean;
  eligible: boolean;
  promoted: false;
}

const INITIAL_STATUS: FireworksImprovementLoopStatus = Object.freeze({
  datasetReady: true,
  providerValidated: false,
  trainingSubmitted: false,
  checkpointReady: false,
  evaluated: false,
  eligible: false,
  promoted: false,
});

export interface FireworksDatasetDownloadManifest {
  schemaVersion: 1;
  bundleDigest: string;
  datasetResource: string;
  format: "fireworks-rft-jsonl";
  split: "heldout" | "train";
  lineCount: number;
  byteCount: number;
  contentSha256: string;
  manifestDigest: string;
}

export interface FireworksRftPlan {
  schemaVersion: 1;
  provider: "fireworks";
  workflow: "eval-protocol-managed-rft";
  evalProtocolVersion: typeof FIREWORKS_EVAL_PROTOCOL_VERSION;
  accountId: string;
  jobId: string;
  jobResource: string;
  submissionKey: string;
  bundleDigest: string;
  datasetContentSha256: string;
  evaluationDatasetContentSha256: string;
  projectScopeId: string;
  providerPolicyDigest: string;
  capabilitySnapshotDigest: string;
  costPolicyDigest: string;
  recipe: FireworksTrainingRecipe;
  conservativeCostUpperBoundMicros: number;
  planDigest: string;
}

export interface FireworksRftDryRun {
  plan: FireworksRftPlan;
  executable: "uvx";
  arguments: string[];
  mutationExecuted: false;
  status: FireworksImprovementLoopStatus;
}

interface JsonRecord {
  [key: string]: unknown;
}

const RftLineSchema = z.strictObject({
  messages: z.tuple([
    z.strictObject({
      role: z.literal("system"),
      content: z.string().min(1).max(20_000),
    }),
    z.strictObject({
      role: z.literal("user"),
      content: z.string().min(1).max(2_000_000),
    }),
  ]),
  tools: z.array(PatchProviderToolDefinitionSchema).length(1),
  metadata: z.strictObject({
    schemaVersion: z.literal(1),
    caseId: Sha256Schema,
    projectScopeId: Sha256Schema,
    split: z.enum(["train", "heldout"]),
    bundleDigest: Sha256Schema,
    contractRevision: z.number().int().positive(),
    sourceDigest: Sha256Schema,
    providerSourceDigest: Sha256Schema,
    providerPolicyDigest: Sha256Schema,
  }),
});

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function assertNoRewardLeakage(value: unknown, path = "record"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoRewardLeakage(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "expected",
        "expected_output",
        "gold_answer",
        "reward",
        "reward_components",
        "target",
      ].includes(key.toLocaleLowerCase("en-US"))
    ) {
      throw new Error(
        `Training prompt contains reward leakage at ${path}.${key}`,
      );
    }
    assertNoRewardLeakage(child, `${path}.${key}`);
  }
}

const SENSITIVE_TRAINING_CONTENT = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:api[_-]?key|authorization|password|private[_-]?key|secret|token)\b\s*[:=]\s*["'][^"'\n]{4,}/iu,
  /\b(?:pi|cs_(?:test|live)|cus|ch|pm|seti|sub|in)_[A-Za-z0-9]{8,}\b/iu,
  /(?:^|[\s"'=(])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/mu,
  /<\s*\/?\s*think\s*>|\breasoning_content\b|\bchain[- ]of[- ]thought\b|\bprivate scratchpad\b/iu,
  /\b(?:stdout|stderr)\s*:/iu,
] as const;

function assertSanitizedTrainingContent(content: string): void {
  if (SENSITIVE_TRAINING_CONTENT.some((pattern) => pattern.test(content))) {
    throw new Error("Training export contains sensitive or private content");
  }
}

interface ValidatedRftExport {
  readonly caseIds: ReadonlySet<string>;
  readonly projectScopeId: string;
  readonly providerPolicyDigest: string;
}

function validateRftJsonl(
  providerExport: PatchProviderExport,
  expectedSplit: "heldout" | "train",
): ValidatedRftExport {
  if (
    providerExport.format !== "fireworks-rft-jsonl" ||
    providerExport.split !== expectedSplit
  ) {
    throw new Error(
      `Managed RFT requires the Fireworks ${expectedSplit} split`,
    );
  }
  if (sha256(providerExport.content) !== providerExport.contentSha256) {
    throw new Error("Training export content digest does not match");
  }
  const lines = providerExport.content.endsWith("\n")
    ? providerExport.content.slice(0, -1).split("\n")
    : providerExport.content.split("\n");
  if (
    lines.length !== providerExport.lineCount ||
    lines.some((line) => line.length === 0)
  ) {
    throw new Error("Training export line count does not match");
  }
  const caseIds = new Set<string>();
  const projectScopeIds = new Set<string>();
  const providerPolicyDigests = new Set<string>();
  for (const [index, line] of lines.entries()) {
    assertSanitizedTrainingContent(line);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Training export line ${index + 1} is invalid JSON`);
    }
    const record = jsonRecord(parsed, `Training export line ${index + 1}`);
    assertNoRewardLeakage(record);
    const trainingRecord = RftLineSchema.parse(record);
    if (trainingRecord.metadata.bundleDigest !== providerExport.bundleDigest) {
      throw new Error("Training record belongs to another provider bundle");
    }
    if (trainingRecord.metadata.split !== expectedSplit) {
      throw new Error("Training record belongs to the wrong split");
    }
    if (caseIds.has(trainingRecord.metadata.caseId)) {
      throw new Error("Training export contains duplicate cases");
    }
    caseIds.add(trainingRecord.metadata.caseId);
    projectScopeIds.add(trainingRecord.metadata.projectScopeId);
    providerPolicyDigests.add(trainingRecord.metadata.providerPolicyDigest);
  }
  if (projectScopeIds.size !== 1) {
    throw new Error("Training export cannot mix project scopes");
  }
  if (providerPolicyDigests.size !== 1) {
    throw new Error("Training export cannot mix provider policies");
  }
  return {
    caseIds,
    projectScopeId: [...projectScopeIds][0]!,
    providerPolicyDigest: [...providerPolicyDigests][0]!,
  };
}

function validateGovernedExports(
  input: FireworksTrainingInput,
  attestationKey: string | Uint8Array,
): {
  readonly projectScopeId: string;
  readonly providerPolicyDigest: string;
} {
  const trainingExport = verifyPatchProviderExport(
    input.providerExport,
    attestationKey,
  );
  const evaluationExport = verifyPatchProviderExport(
    input.evaluationProviderExport,
    attestationKey,
  );
  const training = validateRftJsonl(trainingExport, "train");
  const evaluation = validateRftJsonl(evaluationExport, "heldout");
  if (
    trainingExport.bundleDigest !== evaluationExport.bundleDigest ||
    trainingExport.attestation.bundleAttestationSignature !==
      evaluationExport.attestation.bundleAttestationSignature ||
    training.projectScopeId !== evaluation.projectScopeId ||
    training.projectScopeId !== trainingExport.attestation.projectScopeId ||
    evaluation.projectScopeId !== evaluationExport.attestation.projectScopeId ||
    training.providerPolicyDigest !== evaluation.providerPolicyDigest ||
    training.providerPolicyDigest !==
      trainingExport.attestation.providerPolicyDigest ||
    evaluation.providerPolicyDigest !==
      evaluationExport.attestation.providerPolicyDigest
  ) {
    throw new Error(
      "Training and held-out exports must share one governed bundle and project",
    );
  }
  if ([...training.caseIds].some((caseId) => evaluation.caseIds.has(caseId))) {
    throw new Error("Training and held-out exports overlap");
  }
  return {
    projectScopeId: training.projectScopeId,
    providerPolicyDigest: training.providerPolicyDigest,
  };
}

function resourceAccount(
  resource: string,
  expectedKind: "datasets" | "evaluators" | "models",
): string {
  const parts = resource.split("/");
  if (
    parts.length !== 4 ||
    parts[0] !== "accounts" ||
    parts[2] !== expectedKind
  ) {
    throw new Error(`Invalid Fireworks ${expectedKind} resource`);
  }
  return parts[1]!;
}

function assertDigestVersionedDataset(
  resource: string,
  contentSha256: string,
): void {
  const resourceId = resource.split("/").at(-1);
  if (
    resourceId === undefined ||
    !resourceId.endsWith(contentSha256.slice(0, 16))
  ) {
    throw new Error(
      "Fireworks dataset resource must end with its content digest prefix",
    );
  }
}

function assertManagedRecipe(
  accountId: string,
  capability: FireworksTrainingCapabilitySnapshot,
  recipe: FireworksTrainingRecipe,
): void {
  if (
    capability.modelResource !== FIREWORKS_MANAGED_RFT_BASE_MODEL ||
    recipe.baseModelResource !== FIREWORKS_MANAGED_RFT_BASE_MODEL ||
    recipe.baseModelResource !== capability.modelResource
  ) {
    throw new Error(
      "Managed RFT is provider-shape-confirmed only for Kimi K2.6",
    );
  }
  if (recipe.maxContextLength > capability.trainingContextLength) {
    throw new Error("Training context exceeds the observed model capability");
  }
  if (recipe.maxOutputTokens > recipe.maxContextLength) {
    throw new Error("Training output limit exceeds the training context");
  }
  for (const [resource, kind] of [
    [recipe.datasetResource, "datasets"],
    [recipe.evaluationDatasetResource, "datasets"],
    [recipe.evaluatorResource, "evaluators"],
    [recipe.outputModelResource, "models"],
  ] as const) {
    if (resourceAccount(resource, kind) !== accountId) {
      throw new Error(`Fireworks ${kind} resource belongs to another account`);
    }
  }
  if (
    recipe.warmStartFromModelResource !== undefined &&
    resourceAccount(recipe.warmStartFromModelResource, "models") !== accountId
  ) {
    throw new Error("Fireworks warm-start model belongs to another account");
  }
  if (recipe.datasetResource === recipe.evaluationDatasetResource) {
    throw new Error("Training and evaluation datasets must be distinct");
  }
}

function divideRoundUp(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function conservativeRftCostUpperBoundMicros(
  input: FireworksTrainingInput,
): number {
  const recipe = input.recipe;
  const rows =
    BigInt(input.providerExport.lineCount) +
    BigInt(input.evaluationProviderExport.lineCount);
  const rolloutCount =
    rows * BigInt(recipe.epochs) * BigInt(recipe.responseCandidatesCount);
  const generatedTokens = rolloutCount * BigInt(recipe.maxOutputTokens);
  const generationSeconds = divideRoundUp(
    generatedTokens,
    BigInt(RFT_COST_POLICY.minimumAggregateTokensPerSecond),
  );
  const evaluationSeconds =
    rolloutCount * BigInt(RFT_COST_POLICY.maximumEvaluatorSecondsPerRollout);
  const fixedTrainerSeconds =
    BigInt(recipe.epochs) * BigInt(RFT_COST_POLICY.fixedTrainerSecondsPerEpoch);
  const billedGpuSeconds =
    (generationSeconds + evaluationSeconds + fixedTrainerSeconds) *
    BigInt(recipe.nodeCount) *
    BigInt(RFT_COST_POLICY.maximumGpusPerNode);
  const costMicros = divideRoundUp(
    billedGpuSeconds * BigInt(RFT_COST_POLICY.maximumGpuHourlyRateMicros),
    3_600n,
  );
  if (
    costMicros > BigInt(Number.MAX_SAFE_INTEGER) ||
    costMicros > BigInt(MAX_AUTHORIZED_COST_MICROS)
  ) {
    throw new Error(
      "Conservative Fireworks RFT cost exceeds the absolute execution limit",
    );
  }
  return Number(costMicros);
}

function planBody(
  input: FireworksTrainingInput,
  governance: {
    readonly projectScopeId: string;
    readonly providerPolicyDigest: string;
  },
): Omit<
  FireworksRftPlan,
  "jobId" | "jobResource" | "planDigest" | "submissionKey"
> {
  return {
    schemaVersion: 1,
    provider: "fireworks",
    workflow: "eval-protocol-managed-rft",
    evalProtocolVersion: FIREWORKS_EVAL_PROTOCOL_VERSION,
    accountId: input.accountId,
    bundleDigest: input.providerExport.bundleDigest,
    datasetContentSha256: input.providerExport.contentSha256,
    evaluationDatasetContentSha256:
      input.evaluationProviderExport.contentSha256,
    projectScopeId: governance.projectScopeId,
    providerPolicyDigest: governance.providerPolicyDigest,
    capabilitySnapshotDigest: input.capability.snapshotDigest,
    costPolicyDigest: FIREWORKS_RFT_COST_POLICY_DIGEST,
    recipe: input.recipe,
    conservativeCostUpperBoundMicros:
      conservativeRftCostUpperBoundMicros(input),
  };
}

export function validateFireworksRftPlan(
  value: FireworksTrainingInput,
  providerAttestationKey: string | Uint8Array,
): FireworksRftPlan {
  const input = FireworksTrainingInputSchema.parse(value);
  const governance = validateGovernedExports(input, providerAttestationKey);
  assertManagedRecipe(input.accountId, input.capability, input.recipe);
  assertDigestVersionedDataset(
    input.recipe.datasetResource,
    input.providerExport.contentSha256,
  );
  assertDigestVersionedDataset(
    input.recipe.evaluationDatasetResource,
    input.evaluationProviderExport.contentSha256,
  );
  const body = planBody(input, governance);
  const submissionKey = digestJson(body);
  const jobId = ResourceIdSchema.parse(
    `buildlabs-rft-${submissionKey.slice(0, 32)}`,
  );
  const planWithoutDigest = {
    ...body,
    jobId,
    jobResource: `accounts/${input.accountId}/reinforcementFineTuningJobs/${jobId}`,
    submissionKey,
  };
  return {
    ...planWithoutDigest,
    planDigest: digestJson(planWithoutDigest),
  };
}

const RUNTIME_EMPTY_ENV_FILE = "<runtime-empty-env-file>";

function commandArguments(
  plan: FireworksRftPlan,
  emptyEnvironmentFile = RUNTIME_EMPTY_ENV_FILE,
): string[] {
  const argumentsList = [
    "--from",
    `eval-protocol==${FIREWORKS_EVAL_PROTOCOL_VERSION}`,
    "eval-protocol",
    "create",
    "rft",
    "--yes",
    "--quiet",
    "--env-file",
    emptyEnvironmentFile,
    "--dataset",
    plan.recipe.datasetResource,
    "--evaluation-dataset",
    plan.recipe.evaluationDatasetResource,
    "--evaluator",
    plan.recipe.evaluatorResource,
    "--job-id",
    plan.jobId,
    "--output-model",
    plan.recipe.outputModelResource,
    "--epochs",
    String(plan.recipe.epochs),
    "--learning-rate",
    String(plan.recipe.learningRate),
    "--max-context-length",
    String(plan.recipe.maxContextLength),
    "--max-output-tokens",
    String(plan.recipe.maxOutputTokens),
    "--response-candidates-count",
    String(plan.recipe.responseCandidatesCount),
    "--max-concurrent-rollouts",
    String(plan.recipe.maxConcurrentRollouts),
    "--max-concurrent-evaluations",
    String(plan.recipe.maxConcurrentEvaluations),
    "--nodes",
    String(plan.recipe.nodeCount),
  ];
  if (plan.recipe.warmStartFromModelResource !== undefined) {
    argumentsList.push(
      "--warm-start-from",
      plan.recipe.warmStartFromModelResource,
    );
  } else {
    argumentsList.push("--base-model", plan.recipe.baseModelResource);
  }
  return argumentsList;
}

export function dryRunFireworksRft(
  input: FireworksTrainingInput,
  providerAttestationKey: string | Uint8Array,
): FireworksRftDryRun {
  const plan = validateFireworksRftPlan(input, providerAttestationKey);
  return {
    plan,
    executable: "uvx",
    arguments: commandArguments(plan),
    mutationExecuted: false,
    status: { ...INITIAL_STATUS },
  };
}

export function exportFireworksDatasetManifest(
  providerExport: PatchProviderExport,
  datasetResource: string,
): FireworksDatasetDownloadManifest {
  const parsed = PatchProviderExportSchema.parse(providerExport);
  DatasetResourceSchema.parse(datasetResource);
  validateRftJsonl(parsed, parsed.split);
  const body = {
    schemaVersion: 1 as const,
    bundleDigest: parsed.bundleDigest,
    datasetResource,
    format: "fireworks-rft-jsonl" as const,
    split: parsed.split,
    lineCount: parsed.lineCount,
    byteCount: Buffer.byteLength(parsed.content, "utf8"),
    contentSha256: parsed.contentSha256,
  };
  return {
    ...body,
    manifestDigest: digestJson(body),
  };
}

function assertExecutionAuthorized(
  input: FireworksTrainingInput,
  plan: FireworksRftPlan,
  now: Date,
  serverPolicy: FireworksTrainingServerExecutionPolicy,
): void {
  const authorization = input.execution;
  if (!authorization.executePaidMutation || !serverPolicy.executePaidMutation) {
    throw new Error("Paid Fireworks training execution is not authorized");
  }
  for (const candidate of [authorization, serverPolicy]) {
    if (candidate.authorizedSubmissionKey !== plan.submissionKey) {
      throw new Error(
        "Training authorization does not match the submission key",
      );
    }
    if (Date.parse(candidate.expiresAt) <= now.getTime()) {
      throw new Error("Training execution authorization has expired");
    }
    const required: Array<readonly [readonly string[], string, string]> = [
      [
        candidate.authorizedDatasetDigests,
        input.providerExport.contentSha256,
        "training dataset digest",
      ],
      [
        candidate.authorizedDatasetDigests,
        input.evaluationProviderExport.contentSha256,
        "held-out dataset digest",
      ],
      [
        candidate.authorizedDatasetResources,
        plan.recipe.datasetResource,
        "training dataset",
      ],
      [
        candidate.authorizedDatasetResources,
        plan.recipe.evaluationDatasetResource,
        "evaluation dataset",
      ],
      [
        candidate.authorizedEvaluatorResources,
        plan.recipe.evaluatorResource,
        "evaluator",
      ],
      [
        candidate.authorizedBaseModels,
        plan.recipe.baseModelResource,
        "base model",
      ],
      [
        candidate.authorizedOutputModels,
        plan.recipe.outputModelResource,
        "output model",
      ],
    ];
    if (plan.recipe.warmStartFromModelResource !== undefined) {
      required.push([
        candidate.authorizedBaseModels,
        plan.recipe.warmStartFromModelResource,
        "warm-start model",
      ]);
    }
    for (const [allowlist, resource, label] of required) {
      if (!allowlist.includes(resource)) {
        throw new Error(`Training ${label} is not explicitly allowlisted`);
      }
    }
  }
  if (
    plan.conservativeCostUpperBoundMicros > authorization.maximumCostMicros ||
    plan.conservativeCostUpperBoundMicros > serverPolicy.maximumCostMicros ||
    authorization.maximumCostMicros > MAX_AUTHORIZED_COST_MICROS ||
    serverPolicy.maximumCostMicros > MAX_AUTHORIZED_COST_MICROS
  ) {
    throw new Error("Training cost exceeds the explicit bounded budget");
  }
}

export interface FireworksCommandRunner {
  run(input: {
    executable: string;
    arguments: string[];
    environment: Readonly<Record<string, string>>;
    workingDirectory: string;
  }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export class LocalFireworksCommandRunner implements FireworksCommandRunner {
  readonly #timeoutMs: number;

  constructor(timeoutMs = 1_800_000) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 3_600_000
    ) {
      throw new Error("Fireworks command timeout must be between 1s and 1h");
    }
    this.#timeoutMs = timeoutMs;
  }

  run(
    input: Parameters<FireworksCommandRunner["run"]>[0],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.executable, input.arguments, {
        cwd: input.workingDirectory,
        env: { ...input.environment },
        shell: false,
        stdio: "ignore",
      });
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Fireworks training command timed out"));
      }, this.#timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(
          new Error("Fireworks training command failed to start", {
            cause: error,
          }),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({
          exitCode: code ?? 1,
          stdout: "",
          stderr: "",
        });
      });
    });
  }
}

interface IsolatedFireworksCommandWorkspace {
  readonly directory: string;
  readonly emptyEnvironmentFile: string;
}

async function createIsolatedFireworksCommandWorkspace(): Promise<IsolatedFireworksCommandWorkspace> {
  const directory = await mkdtemp(join(tmpdir(), "buildlabs-fireworks-rft-"));
  await chmod(directory, 0o700);
  const emptyEnvironmentFile = join(directory, "provider-secrets.empty");
  await writeFile(emptyEnvironmentFile, "", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await chmod(emptyEnvironmentFile, 0o600);
  return { directory, emptyEnvironmentFile };
}

type HttpMethod = "DELETE" | "GET" | "POST";

export interface FireworksTrainingHttpClient {
  request(input: {
    method: HttpMethod;
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
  }): Promise<{ status: number; json?: unknown; text?: string }>;
}

const MAX_PROVIDER_DATASET_BYTES = 100_000_000;

const defaultHttpClient: FireworksTrainingHttpClient = {
  async request(input) {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    let json: unknown;
    let text: string | undefined;
    if (response.headers.get("content-type")?.includes("application/json")) {
      json = await response.json();
    } else {
      const contentLength = response.headers.get("content-length");
      if (
        contentLength !== null &&
        (!/^\d+$/u.test(contentLength) ||
          Number(contentLength) > MAX_PROVIDER_DATASET_BYTES)
      ) {
        throw new Error("Fireworks dataset download exceeds its byte limit");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_PROVIDER_DATASET_BYTES) {
        throw new Error("Fireworks dataset download exceeds its byte limit");
      }
      text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    }
    return {
      status: response.status,
      ...(json === undefined ? {} : { json }),
      ...(text === undefined ? {} : { text }),
    };
  },
};

export interface FireworksSubmissionLedger {
  readonly durable: boolean;
  claim(submissionKey: string): Promise<boolean>;
  complete(submissionKey: string, receiptDigest: string): Promise<void>;
}

export class InMemoryFireworksSubmissionLedger implements FireworksSubmissionLedger {
  readonly durable = false;
  readonly #entries = new Map<string, string | null>();

  claim(submissionKey: string): Promise<boolean> {
    if (this.#entries.has(submissionKey)) return Promise.resolve(false);
    this.#entries.set(submissionKey, null);
    return Promise.resolve(true);
  }

  complete(submissionKey: string, receiptDigest: string): Promise<void> {
    if (!this.#entries.has(submissionKey)) {
      throw new Error("Cannot complete an unclaimed training submission");
    }
    this.#entries.set(submissionKey, receiptDigest);
    return Promise.resolve();
  }
}

export class FileFireworksSubmissionLedger implements FireworksSubmissionLedger {
  readonly durable = true;
  readonly #directory: string;

  constructor(directory: string) {
    if (directory.trim() === "" || directory.includes("\0")) {
      throw new Error("Fireworks submission ledger directory is invalid");
    }
    this.#directory = directory;
  }

  async claim(submissionKey: string): Promise<boolean> {
    const key = Sha256Schema.parse(submissionKey);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, `${key}.json`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return false;
      }
      throw error;
    }
    try {
      await handle.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          submissionKey: key,
          state: "claimed",
        }),
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  }

  async complete(submissionKey: string, receiptDigest: string): Promise<void> {
    const key = Sha256Schema.parse(submissionKey);
    const receipt = Sha256Schema.parse(receiptDigest);
    const path = join(this.#directory, `${key}.json`);
    const claimed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const record = jsonRecord(claimed, "Fireworks submission ledger");
    if (record.submissionKey !== key || record.state !== "claimed") {
      throw new Error("Fireworks submission ledger claim is invalid");
    }
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        submissionKey: key,
        state: "submitted",
        receiptDigest: receipt,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

export interface FireworksProviderValidationReceipt {
  schemaVersion: 1;
  planDigest: string;
  capabilitySnapshotDigest: string;
  trainingDatasetManifestDigest: string;
  evaluationDatasetManifestDigest: string;
  evaluatorResource: string;
  warmStartFromModelResource: string | null;
  jobAbsent: true;
  outputModelAbsent: true;
  validatedAt: string;
  receiptDigest: string;
}

export interface FireworksTrainingSubmissionReceipt {
  schemaVersion: 1;
  submissionKey: string;
  planDigest: string;
  providerValidationReceiptDigest: string;
  authorizationId: string;
  jobId: string;
  jobResource: string;
  outputModelResource: string;
  submittedAt: string;
  receiptDigest: string;
  status: FireworksImprovementLoopStatus;
}

const ProviderStateSchema = z.enum([
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
]);
export type FireworksTrainingProviderState = z.infer<
  typeof ProviderStateSchema
>;

export interface FireworksTrainingObservation {
  schemaVersion: 1;
  jobResource: string;
  providerState: FireworksTrainingProviderState;
  outputModelResource: string | null;
  observedAt: string;
  observationDigest: string;
  status: FireworksImprovementLoopStatus;
}

function normalizedProviderState(
  value: unknown,
): FireworksTrainingProviderState {
  if (typeof value !== "string") {
    throw new Error("Fireworks training response omitted its state");
  }
  const normalized = value
    .replace(/^JOB_STATE_/u, "")
    .toLocaleLowerCase("en-US");
  const aliases: Record<string, FireworksTrainingProviderState> = {
    cancelling: "running",
    creating: "pending",
    queued: "pending",
    succeeded: "completed",
  };
  return ProviderStateSchema.parse(aliases[normalized] ?? normalized);
}

function providerOutputModel(record: JsonRecord): string | null {
  const direct = record.outputModel ?? record.output_model;
  if (typeof direct === "string") return ModelResourceSchema.parse(direct);
  const trainingConfig = record.trainingConfig ?? record.training_config;
  if (trainingConfig !== undefined) {
    const config = jsonRecord(trainingConfig, "Fireworks training config");
    const nested = config.outputModel ?? config.output_model;
    if (typeof nested === "string") return ModelResourceSchema.parse(nested);
  }
  return null;
}

function providerField(
  record: JsonRecord,
  camelCase: string,
  snakeCase: string,
): unknown {
  return record[camelCase] ?? record[snakeCase];
}

function assertExactProviderField(
  record: JsonRecord,
  camelCase: string,
  snakeCase: string,
  expected: string | number,
  label: string,
): void {
  if (providerField(record, camelCase, snakeCase) !== expected) {
    throw new Error(
      `Fireworks submitted training job did not preserve its pinned ${label}`,
    );
  }
}

function assertSubmittedJobMatchesPlan(
  record: JsonRecord,
  plan: FireworksRftPlan,
): void {
  assertExactProviderField(
    record,
    "dataset",
    "dataset",
    plan.recipe.datasetResource,
    "training dataset",
  );
  assertExactProviderField(
    record,
    "evaluationDataset",
    "evaluation_dataset",
    plan.recipe.evaluationDatasetResource,
    "evaluation dataset",
  );
  assertExactProviderField(
    record,
    "evaluator",
    "evaluator",
    plan.recipe.evaluatorResource,
    "evaluator",
  );
  assertExactProviderField(
    record,
    "maxConcurrentRollouts",
    "max_concurrent_rollouts",
    plan.recipe.maxConcurrentRollouts,
    "rollout concurrency",
  );
  assertExactProviderField(
    record,
    "maxConcurrentEvaluations",
    "max_concurrent_evaluations",
    plan.recipe.maxConcurrentEvaluations,
    "evaluation concurrency",
  );
  assertExactProviderField(
    record,
    "nodeCount",
    "node_count",
    plan.recipe.nodeCount,
    "node count",
  );

  const trainingConfig = jsonRecord(
    providerField(record, "trainingConfig", "training_config"),
    "Fireworks submitted training config",
  );
  assertExactProviderField(
    trainingConfig,
    "outputModel",
    "output_model",
    plan.recipe.outputModelResource,
    "output model",
  );
  assertExactProviderField(
    trainingConfig,
    "epochs",
    "epochs",
    plan.recipe.epochs,
    "epoch count",
  );
  assertExactProviderField(
    trainingConfig,
    "learningRate",
    "learning_rate",
    plan.recipe.learningRate,
    "learning rate",
  );
  assertExactProviderField(
    trainingConfig,
    "maxContextLength",
    "max_context_length",
    plan.recipe.maxContextLength,
    "context length",
  );
  const providerBaseModel = providerField(
    trainingConfig,
    "baseModel",
    "base_model",
  );
  const providerWarmStart = providerField(
    trainingConfig,
    "warmStartFrom",
    "warm_start_from",
  );
  if (plan.recipe.warmStartFromModelResource === undefined) {
    if (
      providerBaseModel !== plan.recipe.baseModelResource ||
      (providerWarmStart !== undefined && providerWarmStart !== null)
    ) {
      throw new Error(
        "Fireworks submitted training job did not preserve its pinned base model",
      );
    }
  } else if (
    providerWarmStart !== plan.recipe.warmStartFromModelResource ||
    (providerBaseModel !== undefined && providerBaseModel !== null)
  ) {
    throw new Error(
      "Fireworks submitted training job did not preserve its pinned warm-start model",
    );
  }

  const inferenceParameters = jsonRecord(
    providerField(record, "inferenceParameters", "inference_parameters"),
    "Fireworks submitted inference parameters",
  );
  assertExactProviderField(
    inferenceParameters,
    "maxOutputTokens",
    "max_output_tokens",
    plan.recipe.maxOutputTokens,
    "output token limit",
  );
  assertExactProviderField(
    inferenceParameters,
    "responseCandidatesCount",
    "response_candidates_count",
    plan.recipe.responseCandidatesCount,
    "response candidate count",
  );
}

function successStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function bearerHeaders(apiKey: string): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function assertNamedResource(
  value: unknown,
  expectedName: string,
  label: string,
): JsonRecord {
  const record = jsonRecord(value, label);
  if (record.name !== expectedName) {
    throw new Error(`${label} returned the wrong resource`);
  }
  return record;
}

function assertProviderBaseCapability(
  record: JsonRecord,
  capability: FireworksTrainingCapabilitySnapshot,
  requiredContextLength: number,
): void {
  const matchesSnapshot =
    record.state === "READY" &&
    record.supportsServerless === true &&
    record.tunable === true &&
    record.rlTunable === true &&
    record.rlLoraTunable === capability.rlLoraTunable &&
    record.rlFullParameterTunable === capability.rlFullParameterTunable &&
    record.trainingContextLength === capability.trainingContextLength &&
    Number(record.trainingContextLength) >= requiredContextLength;
  if (
    !matchesSnapshot ||
    (!capability.rlLoraTunable && !capability.rlFullParameterTunable)
  ) {
    throw new Error(
      "Fireworks base model no longer matches its training capability snapshot",
    );
  }
}

function providerValidationBody(
  input: Omit<FireworksProviderValidationReceipt, "receiptDigest">,
): Omit<FireworksProviderValidationReceipt, "receiptDigest"> {
  return input;
}

const TrainingSubmissionReceiptBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionKey: Sha256Schema,
  planDigest: Sha256Schema,
  providerValidationReceiptDigest: Sha256Schema,
  authorizationId: Sha256Schema,
  jobId: ResourceIdSchema,
  jobResource: z.string().min(1).max(512),
  outputModelResource: ModelResourceSchema,
  submittedAt: IsoTimestampSchema,
  status: z.strictObject({
    datasetReady: z.literal(true),
    providerValidated: z.literal(true),
    trainingSubmitted: z.literal(true),
    checkpointReady: z.literal(false),
    evaluated: z.literal(false),
    eligible: z.literal(false),
    promoted: z.literal(false),
  }),
});

const TrainingSubmissionReceiptSchema =
  TrainingSubmissionReceiptBodySchema.extend({
    receiptDigest: Sha256Schema,
  }).superRefine((receipt, context) => {
    const body = TrainingSubmissionReceiptBodySchema.parse({
      schemaVersion: receipt.schemaVersion,
      submissionKey: receipt.submissionKey,
      planDigest: receipt.planDigest,
      providerValidationReceiptDigest: receipt.providerValidationReceiptDigest,
      authorizationId: receipt.authorizationId,
      jobId: receipt.jobId,
      jobResource: receipt.jobResource,
      outputModelResource: receipt.outputModelResource,
      submittedAt: receipt.submittedAt,
      status: receipt.status,
    });
    if (receipt.receiptDigest !== digestJson(body)) {
      context.addIssue({
        code: "custom",
        message: "Fireworks submission receipt digest does not match",
        path: ["receiptDigest"],
      });
    }
  });

const TrainingObservationBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobResource: z.string().min(1).max(512),
  providerState: ProviderStateSchema,
  outputModelResource: ModelResourceSchema.nullable(),
  observedAt: IsoTimestampSchema,
  status: z.strictObject({
    datasetReady: z.literal(true),
    providerValidated: z.literal(true),
    trainingSubmitted: z.literal(true),
    checkpointReady: z.boolean(),
    evaluated: z.literal(false),
    eligible: z.literal(false),
    promoted: z.literal(false),
  }),
});

const TrainingObservationSchema = TrainingObservationBodySchema.extend({
  observationDigest: Sha256Schema,
}).superRefine((observation, context) => {
  const body = TrainingObservationBodySchema.parse({
    schemaVersion: observation.schemaVersion,
    jobResource: observation.jobResource,
    providerState: observation.providerState,
    outputModelResource: observation.outputModelResource,
    observedAt: observation.observedAt,
    status: observation.status,
  });
  if (observation.observationDigest !== digestJson(body)) {
    context.addIssue({
      code: "custom",
      message: "Fireworks training observation digest does not match",
      path: ["observationDigest"],
    });
  }
});

export class FireworksTrainingLifecycle {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #providerAttestationKey: string | Uint8Array;
  readonly #serverExecutionPolicy: FireworksTrainingServerExecutionPolicy;
  readonly #runner: FireworksCommandRunner;
  readonly #http: FireworksTrainingHttpClient;
  readonly #ledger: FireworksSubmissionLedger;
  readonly #now: () => Date;

  constructor(input: {
    apiKey: string;
    providerAttestationKey: string | Uint8Array;
    serverExecutionPolicy?: FireworksTrainingServerExecutionPolicy;
    runner?: FireworksCommandRunner;
    ledger?: FireworksSubmissionLedger;
    http?: FireworksTrainingHttpClient;
    baseUrl?: string;
    now?: () => Date;
  }) {
    if (input.apiKey.length === 0 || input.apiKey.length > 8_192) {
      throw new Error("Fireworks API key is required");
    }
    this.#apiKey = input.apiKey;
    this.#providerAttestationKey = input.providerAttestationKey;
    this.#serverExecutionPolicy = ServerExecutionPolicySchema.parse(
      input.serverExecutionPolicy ?? { executePaidMutation: false },
    );
    this.#runner = input.runner ?? new LocalFireworksCommandRunner();
    this.#ledger = input.ledger ?? new InMemoryFireworksSubmissionLedger();
    this.#http = input.http ?? defaultHttpClient;
    this.#baseUrl = (input.baseUrl ?? "https://api.fireworks.ai").replace(
      /\/+$/u,
      "",
    );
    this.#now = input.now ?? (() => new Date());
  }

  validate(input: FireworksTrainingInput): FireworksRftPlan {
    return validateFireworksRftPlan(input, this.#providerAttestationKey);
  }

  dryRun(input: FireworksTrainingInput): FireworksRftDryRun {
    return dryRunFireworksRft(input, this.#providerAttestationKey);
  }

  exportDatasetManifest(
    providerExport: PatchProviderExport,
    datasetResource: string,
  ): FireworksDatasetDownloadManifest {
    return exportFireworksDatasetManifest(providerExport, datasetResource);
  }

  async validateProvider(
    value: FireworksTrainingInput,
  ): Promise<FireworksProviderValidationReceipt> {
    const input = FireworksTrainingInputSchema.parse(value);
    const plan = validateFireworksRftPlan(input, this.#providerAttestationKey);
    const baseResponse = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${plan.recipe.baseModelResource}`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (!successStatus(baseResponse.status)) {
      throw new Error(
        `Fireworks base model validation failed with status ${baseResponse.status}`,
      );
    }
    const baseModel = assertNamedResource(
      baseResponse.json,
      plan.recipe.baseModelResource,
      "Fireworks base model",
    );
    assertProviderBaseCapability(
      baseModel,
      input.capability,
      plan.recipe.maxContextLength,
    );

    if (plan.recipe.warmStartFromModelResource !== undefined) {
      const warmStartResponse = await this.#http.request({
        method: "GET",
        url: `${this.#baseUrl}/v1/${plan.recipe.warmStartFromModelResource}`,
        headers: bearerHeaders(this.#apiKey),
      });
      if (!successStatus(warmStartResponse.status)) {
        throw new Error(
          `Fireworks warm-start validation failed with status ${warmStartResponse.status}`,
        );
      }
      const warmStart = assertNamedResource(
        warmStartResponse.json,
        plan.recipe.warmStartFromModelResource,
        "Fireworks warm-start model",
      );
      if (warmStart.state !== "READY") {
        throw new Error("Fireworks warm-start model is not ready");
      }
    }

    const trainingManifest = await this.#validateRemoteDataset(
      input.providerExport,
      plan.recipe.datasetResource,
    );
    const evaluationManifest = await this.#validateRemoteDataset(
      input.evaluationProviderExport,
      plan.recipe.evaluationDatasetResource,
    );

    const evaluatorResponse = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${plan.recipe.evaluatorResource}`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (!successStatus(evaluatorResponse.status)) {
      throw new Error(
        `Fireworks evaluator validation failed with status ${evaluatorResponse.status}`,
      );
    }
    const evaluator = assertNamedResource(
      evaluatorResponse.json,
      plan.recipe.evaluatorResource,
      "Fireworks evaluator",
    );
    if ((evaluator.state ?? evaluator.status) !== "ACTIVE") {
      throw new Error("Fireworks evaluator is not active");
    }

    await this.#assertResourceAbsent(plan.jobResource, "training job");
    await this.#assertResourceAbsent(
      plan.recipe.outputModelResource,
      "output model",
    );
    const body = providerValidationBody({
      schemaVersion: 1,
      planDigest: plan.planDigest,
      capabilitySnapshotDigest: input.capability.snapshotDigest,
      trainingDatasetManifestDigest: trainingManifest.manifestDigest,
      evaluationDatasetManifestDigest: evaluationManifest.manifestDigest,
      evaluatorResource: plan.recipe.evaluatorResource,
      warmStartFromModelResource:
        plan.recipe.warmStartFromModelResource ?? null,
      jobAbsent: true,
      outputModelAbsent: true,
      validatedAt: this.#now().toISOString(),
    });
    return {
      ...body,
      receiptDigest: digestJson(body),
    };
  }

  async #validateRemoteDataset(
    providerExport: PatchProviderExport,
    datasetResource: string,
  ): Promise<FireworksDatasetDownloadManifest> {
    const manifest = exportFireworksDatasetManifest(
      providerExport,
      datasetResource,
    );
    const endpoint = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${datasetResource}:getDownloadEndpoint`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (!successStatus(endpoint.status)) {
      throw new Error(
        `Fireworks dataset validation failed with status ${endpoint.status}`,
      );
    }
    const endpointRecord = jsonRecord(
      endpoint.json,
      "Fireworks dataset download endpoint",
    );
    const signedUrls = jsonRecord(
      endpointRecord.filenameToSignedUrls,
      "Fireworks dataset signed URLs",
    );
    const entries = Object.entries(signedUrls);
    if (entries.length !== 1 || typeof entries[0]?.[1] !== "string") {
      throw new Error(
        "Fireworks dataset must resolve to exactly one signed download",
      );
    }
    const signedUrl = new URL(entries[0][1]);
    if (signedUrl.protocol !== "https:") {
      throw new Error("Fireworks dataset download URL must use HTTPS");
    }
    const download = await this.#http.request({
      method: "GET",
      url: signedUrl.toString(),
      headers: { Accept: "application/jsonl" },
    });
    if (!successStatus(download.status) || download.text === undefined) {
      throw new Error(
        `Fireworks dataset download failed with status ${download.status}`,
      );
    }
    if (
      Buffer.byteLength(download.text, "utf8") > MAX_PROVIDER_DATASET_BYTES ||
      sha256(download.text) !== providerExport.contentSha256 ||
      download.text !== providerExport.content
    ) {
      throw new Error("Fireworks remote dataset bytes do not match the plan");
    }
    return manifest;
  }

  async #assertResourceAbsent(resource: string, label: string): Promise<void> {
    const response = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${resource}`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (response.status === 404) return;
    if (successStatus(response.status)) {
      throw new Error(`Fireworks ${label} already exists`);
    }
    throw new Error(
      `Fireworks ${label} absence check failed with status ${response.status}`,
    );
  }

  async submit(
    value: FireworksTrainingInput,
  ): Promise<FireworksTrainingSubmissionReceipt> {
    const input = FireworksTrainingInputSchema.parse(value);
    const plan = validateFireworksRftPlan(input, this.#providerAttestationKey);
    assertExecutionAuthorized(
      input,
      plan,
      this.#now(),
      this.#serverExecutionPolicy,
    );
    if (!this.#ledger.durable) {
      throw new Error(
        "Paid Fireworks training requires a durable submission ledger",
      );
    }
    const providerValidation = await this.validateProvider(input);
    if (!(await this.#ledger.claim(plan.submissionKey))) {
      throw new Error("Duplicate Fireworks RFT submission is blocked");
    }

    const workspace = await createIsolatedFireworksCommandWorkspace();
    let result: Awaited<ReturnType<FireworksCommandRunner["run"]>>;
    try {
      result = await this.#runner.run({
        executable: "uvx",
        arguments: commandArguments(plan, workspace.emptyEnvironmentFile),
        environment: {
          FIREWORKS_API_BASE: this.#baseUrl,
          FIREWORKS_API_KEY: this.#apiKey,
          HOME: workspace.directory,
          PATH:
            process.env.PATH ??
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          PYTHONNOUSERSITE: "1",
          TMPDIR: workspace.directory,
          UV_NO_CONFIG: "1",
        },
        workingDirectory: workspace.directory,
      });
    } finally {
      await rm(workspace.directory, { force: true, recursive: true });
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Fireworks RFT submission failed with exit code ${result.exitCode}`,
      );
    }

    const createdResponse = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${plan.jobResource}`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (!successStatus(createdResponse.status)) {
      throw new Error(
        "Fireworks CLI exited successfully but the training job is not observable",
      );
    }
    const createdJob = assertNamedResource(
      createdResponse.json,
      plan.jobResource,
      "Fireworks submitted training job",
    );
    assertSubmittedJobMatchesPlan(createdJob, plan);

    const submittedAt = this.#now().toISOString();
    const status: FireworksImprovementLoopStatus = {
      ...INITIAL_STATUS,
      providerValidated: true,
      trainingSubmitted: true,
    };
    const body = {
      schemaVersion: 1 as const,
      submissionKey: plan.submissionKey,
      planDigest: plan.planDigest,
      providerValidationReceiptDigest: providerValidation.receiptDigest,
      authorizationId: input.execution.authorizationId,
      jobId: plan.jobId,
      jobResource: plan.jobResource,
      outputModelResource: plan.recipe.outputModelResource,
      submittedAt,
      status,
    };
    const receipt = {
      ...body,
      receiptDigest: digestJson(body),
    };
    await this.#ledger.complete(plan.submissionKey, receipt.receiptDigest);
    return receipt;
  }

  async observe(
    receipt: FireworksTrainingSubmissionReceipt,
  ): Promise<FireworksTrainingObservation> {
    const verifiedReceipt = TrainingSubmissionReceiptSchema.parse(receipt);
    const response = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${verifiedReceipt.jobResource}`,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: "application/json",
      },
    });
    if (!successStatus(response.status)) {
      throw new Error(
        `Fireworks training observation failed with status ${response.status}`,
      );
    }
    const record = jsonRecord(response.json, "Fireworks training response");
    const responseName = record.name;
    if (
      typeof responseName !== "string" ||
      responseName !== verifiedReceipt.jobResource
    ) {
      throw new Error("Fireworks training response returned the wrong job");
    }
    const providerState = normalizedProviderState(
      record.state ?? record.status,
    );
    const outputModelResource = providerOutputModel(record);
    if (
      outputModelResource !== null &&
      outputModelResource !== verifiedReceipt.outputModelResource
    ) {
      throw new Error("Fireworks training response returned the wrong model");
    }
    let checkpointReady = false;
    if (providerState === "completed") {
      if (outputModelResource !== verifiedReceipt.outputModelResource) {
        throw new Error(
          "Completed Fireworks training job omitted its pinned output model",
        );
      }
      const outputResponse = await this.#http.request({
        method: "GET",
        url: `${this.#baseUrl}/v1/${verifiedReceipt.outputModelResource}`,
        headers: bearerHeaders(this.#apiKey),
      });
      if (!successStatus(outputResponse.status)) {
        throw new Error(
          `Fireworks checkpoint validation failed with status ${outputResponse.status}`,
        );
      }
      const outputModel = assertNamedResource(
        outputResponse.json,
        verifiedReceipt.outputModelResource,
        "Fireworks output model",
      );
      if (
        outputModel.state !== "READY" ||
        outputModel.supportsServerless !== true
      ) {
        throw new Error("Fireworks output model is not ready for inference");
      }
      checkpointReady = true;
    }
    const observedAt = this.#now().toISOString();
    const status: FireworksImprovementLoopStatus = {
      datasetReady: true,
      providerValidated: true,
      trainingSubmitted: true,
      checkpointReady,
      evaluated: false,
      eligible: false,
      promoted: false,
    };
    const body = {
      schemaVersion: 1 as const,
      jobResource: verifiedReceipt.jobResource,
      providerState,
      outputModelResource,
      observedAt,
      status,
    };
    return {
      ...body,
      observationDigest: digestJson(body),
    };
  }

  async cancel(
    value: FireworksTrainingInput,
    receipt: FireworksTrainingSubmissionReceipt,
  ): Promise<{
    operation: "cancel";
    jobResource: string;
    receiptDigest: string;
  }> {
    const verifiedReceipt = TrainingSubmissionReceiptSchema.parse(receipt);
    const input = FireworksTrainingInputSchema.parse(value);
    const plan = validateFireworksRftPlan(input, this.#providerAttestationKey);
    assertExecutionAuthorized(
      input,
      plan,
      this.#now(),
      this.#serverExecutionPolicy,
    );
    if (
      verifiedReceipt.submissionKey !== plan.submissionKey ||
      verifiedReceipt.jobResource !== plan.jobResource
    ) {
      throw new Error("Cancellation receipt does not match the training plan");
    }
    const response = await this.#http.request({
      method: "POST",
      url: `${this.#baseUrl}/v1/${verifiedReceipt.jobResource}:cancel`,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!successStatus(response.status)) {
      throw new Error(
        `Fireworks training cancellation failed with status ${response.status}`,
      );
    }
    const body = {
      operation: "cancel" as const,
      jobResource: verifiedReceipt.jobResource,
    };
    return { ...body, receiptDigest: digestJson(body) };
  }

  async cleanup(
    value: FireworksTrainingInput,
    receipt: FireworksTrainingSubmissionReceipt,
    observation: FireworksTrainingObservation,
  ): Promise<{
    operation: "cleanup";
    jobResource: string;
    receiptDigest: string;
  }> {
    const verifiedReceipt = TrainingSubmissionReceiptSchema.parse(receipt);
    const verifiedObservation = TrainingObservationSchema.parse(observation);
    const input = FireworksTrainingInputSchema.parse(value);
    const plan = validateFireworksRftPlan(input, this.#providerAttestationKey);
    assertExecutionAuthorized(
      input,
      plan,
      this.#now(),
      this.#serverExecutionPolicy,
    );
    if (
      verifiedReceipt.submissionKey !== plan.submissionKey ||
      verifiedReceipt.jobResource !== plan.jobResource ||
      verifiedObservation.jobResource !== verifiedReceipt.jobResource
    ) {
      throw new Error("Cleanup evidence does not match the training plan");
    }
    if (
      verifiedObservation.providerState !== "cancelled" &&
      verifiedObservation.providerState !== "completed" &&
      verifiedObservation.providerState !== "failed"
    ) {
      throw new Error(
        "Only terminal Fireworks training jobs may be cleaned up",
      );
    }
    const reread = await this.#http.request({
      method: "GET",
      url: `${this.#baseUrl}/v1/${verifiedReceipt.jobResource}`,
      headers: bearerHeaders(this.#apiKey),
    });
    if (!successStatus(reread.status)) {
      throw new Error(
        `Fireworks cleanup revalidation failed with status ${reread.status}`,
      );
    }
    const currentJob = assertNamedResource(
      reread.json,
      verifiedReceipt.jobResource,
      "Fireworks cleanup job",
    );
    const currentState = normalizedProviderState(
      currentJob.state ?? currentJob.status,
    );
    if (
      currentState !== "cancelled" &&
      currentState !== "completed" &&
      currentState !== "failed"
    ) {
      throw new Error("Fireworks cleanup job is not terminal");
    }
    const response = await this.#http.request({
      method: "DELETE",
      url: `${this.#baseUrl}/v1/${verifiedReceipt.jobResource}`,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
    if (!successStatus(response.status)) {
      throw new Error(
        `Fireworks training cleanup failed with status ${response.status}`,
      );
    }
    const body = {
      operation: "cleanup" as const,
      jobResource: verifiedReceipt.jobResource,
    };
    return { ...body, receiptDigest: digestJson(body) };
  }
}
