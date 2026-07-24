import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { canonicalJson, sha256 } from "../../lib/canonical-json.js";

const OpaqueIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CatalogModelSchema = z
  .object({
    name: z.string().min(1).max(512),
    state: z.string().min(1).max(64),
    contextLength: z.number().int().nonnegative().max(10_000_000),
    trainingContextLength: z
      .number()
      .int()
      .nonnegative()
      .max(10_000_000)
      .optional(),
    supportsServerless: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsImageInput: z.boolean().optional(),
    tunable: z.boolean().optional(),
    rlTunable: z.boolean().optional(),
    supervisedLoraTunable: z.boolean().optional(),
    supervisedFullParameterTunable: z.boolean().optional(),
    rlLoraTunable: z.boolean().optional(),
    rlFullParameterTunable: z.boolean().optional(),
  })
  .passthrough();
const CatalogPageSchema = z
  .object({
    models: z.array(CatalogModelSchema).max(2_000),
    nextPageToken: z.string().max(4_096).optional(),
  })
  .passthrough();
const InferenceIndexSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
          })
          .passthrough(),
      )
      .max(10_000),
  })
  .passthrough();

export const FireworksModelRoleSchema = z.enum([
  "builder",
  "patch",
  "orchestration",
  "raster",
  "voice",
  "evaluator",
]);
export type FireworksModelRole = z.infer<typeof FireworksModelRoleSchema>;
export type FireworksServiceTier = "priority" | "standard";

export interface FireworksCatalogModel {
  readonly name: string;
  readonly state: string;
  readonly contextLength: number;
  readonly trainingContextLength: number;
  readonly supportsServerless: boolean;
  readonly supportsTools: boolean;
  readonly supportsImageInput: boolean;
  readonly supportsSupervisedTraining: boolean;
  readonly supportsReinforcementTraining: boolean;
}

export interface FireworksCatalogSnapshot {
  readonly models: readonly FireworksCatalogModel[];
  readonly inferenceModelIds: readonly string[];
  readonly digest: string;
}

export interface ActiveCapabilityResult {
  readonly returnedModelId: string;
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
}

export interface ActiveCapabilityProbe {
  probe(
    modelId: string,
    requirements: RoleCapabilityRequirements,
    signal?: AbortSignal,
  ): Promise<ActiveCapabilityResult>;
}

export interface FireworksCatalogSource {
  load(signal?: AbortSignal): Promise<FireworksCatalogSnapshot>;
}

export interface RoleCapabilityRequirements {
  readonly minimumContextLength: number;
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly training: boolean;
  readonly minimumTrainingContextLength: number;
}

interface RolePolicy {
  readonly candidates: readonly string[];
  readonly requirements: RoleCapabilityRequirements;
  readonly serviceTier: FireworksServiceTier;
}

const MODEL = {
  deepseekV4Pro: "accounts/fireworks/models/deepseek-v4-pro",
  glm5p2: "accounts/fireworks/models/glm-5p2",
  kimiK2p6: "accounts/fireworks/models/kimi-k2p6",
  kimiK2p7Code: "accounts/fireworks/models/kimi-k2p7-code",
  minimaxM2p7: "accounts/fireworks/models/minimax-m2p7",
} as const;

export const FIREWORKS_ROUTER_POLICY_VERSION = "buildlabs-fireworks-router-v1";

const ROLE_POLICIES: Readonly<Record<FireworksModelRole, RolePolicy>> = {
  builder: {
    candidates: [
      MODEL.kimiK2p7Code,
      MODEL.glm5p2,
      MODEL.deepseekV4Pro,
      MODEL.minimaxM2p7,
      MODEL.kimiK2p6,
    ],
    requirements: {
      minimumContextLength: 131_072,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: false,
      training: false,
      minimumTrainingContextLength: 0,
    },
    serviceTier: "standard",
  },
  patch: {
    candidates: [MODEL.kimiK2p7Code, MODEL.kimiK2p6],
    requirements: {
      minimumContextLength: 131_072,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: false,
      training: true,
      minimumTrainingContextLength: 65_536,
    },
    serviceTier: "standard",
  },
  orchestration: {
    candidates: [
      MODEL.glm5p2,
      MODEL.deepseekV4Pro,
      MODEL.kimiK2p6,
      MODEL.kimiK2p7Code,
    ],
    requirements: {
      minimumContextLength: 262_144,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: false,
      training: false,
      minimumTrainingContextLength: 0,
    },
    serviceTier: "standard",
  },
  raster: {
    candidates: [MODEL.kimiK2p6, MODEL.kimiK2p7Code],
    requirements: {
      minimumContextLength: 131_072,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: true,
      training: false,
      minimumTrainingContextLength: 0,
    },
    serviceTier: "standard",
  },
  voice: {
    candidates: [MODEL.kimiK2p6, MODEL.glm5p2],
    requirements: {
      minimumContextLength: 131_072,
      tools: true,
      reasoning: false,
      structuredOutput: true,
      vision: false,
      training: false,
      minimumTrainingContextLength: 0,
    },
    serviceTier: "standard",
  },
  evaluator: {
    candidates: [
      MODEL.glm5p2,
      MODEL.deepseekV4Pro,
      MODEL.kimiK2p6,
      MODEL.kimiK2p7Code,
    ],
    requirements: {
      minimumContextLength: 262_144,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: false,
      training: false,
      minimumTrainingContextLength: 0,
    },
    serviceTier: "standard",
  },
};

export const FIREWORKS_ROUTER_POLICY_DIGEST = sha256(
  canonicalJson({
    version: FIREWORKS_ROUTER_POLICY_VERSION,
    roles: ROLE_POLICIES,
  }),
);

export interface FireworksCapabilitySnapshot {
  readonly catalogDigest: string;
  readonly modelId: string;
  readonly state: string;
  readonly contextLength: number;
  readonly trainingContextLength: number;
  readonly serverless: true;
  readonly tools: true;
  readonly reasoning: boolean;
  readonly reasoningEvidence: "not_required" | "verified";
  readonly structuredOutput: true;
  readonly vision: boolean;
  readonly visionEvidence: "not_required" | "verified";
  readonly supervisedTraining: boolean;
  readonly reinforcementTraining: boolean;
}

export interface FireworksModelPin {
  readonly trajectoryId: string;
  readonly cacheIsolationKey: string;
  readonly role: FireworksModelRole;
  readonly modelId: string;
  readonly serviceTier: FireworksServiceTier;
  readonly capabilitySnapshot: FireworksCapabilitySnapshot;
  readonly capabilitySnapshotDigest: string;
  readonly routerPolicyDigest: string;
  readonly fallbackReason: string;
}

const FireworksCapabilitySnapshotSchema = z.strictObject({
  catalogDigest: OpaqueIdSchema,
  modelId: z.string().min(1).max(512),
  state: z.string().min(1).max(64),
  contextLength: z.number().int().positive().max(10_000_000),
  trainingContextLength: z.number().int().nonnegative().max(10_000_000),
  serverless: z.literal(true),
  tools: z.literal(true),
  reasoning: z.boolean(),
  reasoningEvidence: z.enum(["not_required", "verified"]),
  structuredOutput: z.literal(true),
  vision: z.boolean(),
  visionEvidence: z.enum(["not_required", "verified"]),
  supervisedTraining: z.boolean(),
  reinforcementTraining: z.boolean(),
});

const FireworksModelPinSchema = z.strictObject({
  trajectoryId: OpaqueIdSchema,
  cacheIsolationKey: OpaqueIdSchema,
  role: FireworksModelRoleSchema,
  modelId: z.string().min(1).max(512),
  serviceTier: z.enum(["priority", "standard"]),
  capabilitySnapshot: FireworksCapabilitySnapshotSchema,
  capabilitySnapshotDigest: OpaqueIdSchema,
  routerPolicyDigest: OpaqueIdSchema,
  fallbackReason: z.string().min(1).max(20_000),
});

export interface FireworksPinStore {
  load(trajectoryId: string): Promise<FireworksModelPin | undefined>;
  createIfAbsent(pin: FireworksModelPin): Promise<FireworksModelPin>;
}

export class InMemoryFireworksPinStore implements FireworksPinStore {
  readonly #pins = new Map<string, FireworksModelPin>();

  load(trajectoryId: string): Promise<FireworksModelPin | undefined> {
    return Promise.resolve(this.#pins.get(trajectoryId));
  }

  createIfAbsent(pin: FireworksModelPin): Promise<FireworksModelPin> {
    const existing = this.#pins.get(pin.trajectoryId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.#pins.set(pin.trajectoryId, pin);
    return Promise.resolve(pin);
  }
}

export class FileFireworksPinStore implements FireworksPinStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (directory.trim() === "" || directory.includes("\0")) {
      throw new Error("Fireworks pin directory is invalid");
    }
    this.#directory = directory;
  }

  async load(trajectoryId: string): Promise<FireworksModelPin | undefined> {
    const id = OpaqueIdSchema.parse(trajectoryId);
    try {
      return FireworksModelPinSchema.parse(
        JSON.parse(
          await readFile(join(this.#directory, `${id}.json`), "utf8"),
        ) as unknown,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async createIfAbsent(pin: FireworksModelPin): Promise<FireworksModelPin> {
    const parsed = FireworksModelPinSchema.parse(pin);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const path = join(this.#directory, `${parsed.trajectoryId}.json`);
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
        const existing = await this.load(parsed.trajectoryId);
        if (existing === undefined) {
          throw new Error(
            "Fireworks pin disappeared after an atomic conflict",
            { cause: error },
          );
        }
        return existing;
      }
      throw error;
    }
    try {
      await handle.writeFile(canonicalJson(parsed), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return parsed;
  }
}

export class FireworksRoutingError extends Error {
  constructor(
    readonly code:
      | "capability_mismatch"
      | "model_disappeared"
      | "response_model_mismatch"
      | "role_changed",
    message: string,
  ) {
    super(message);
    this.name = "FireworksRoutingError";
  }
}

function normalizeModelId(modelId: string): string {
  if (modelId.startsWith("accounts/")) {
    return modelId;
  }
  return `accounts/fireworks/models/${modelId}`;
}

function hasSupervisedTrainingCapability(
  model: z.infer<typeof CatalogModelSchema>,
): boolean {
  return Boolean(
    model.tunable &&
    (model.supervisedLoraTunable || model.supervisedFullParameterTunable),
  );
}

function hasReinforcementTrainingCapability(
  model: z.infer<typeof CatalogModelSchema>,
): boolean {
  return Boolean(
    model.rlTunable && (model.rlLoraTunable || model.rlFullParameterTunable),
  );
}

function toCatalogModel(
  model: z.infer<typeof CatalogModelSchema>,
): FireworksCatalogModel {
  return {
    name: normalizeModelId(model.name),
    state: model.state,
    contextLength: model.contextLength,
    trainingContextLength: model.trainingContextLength ?? 0,
    supportsServerless: model.supportsServerless ?? false,
    supportsTools: model.supportsTools ?? false,
    supportsImageInput: model.supportsImageInput ?? false,
    supportsSupervisedTraining: hasSupervisedTrainingCapability(model),
    supportsReinforcementTraining: hasReinforcementTrainingCapability(model),
  };
}

export interface FireworksCatalogClientOptions {
  readonly apiKey: string;
  readonly controlPlaneBaseUrl?: string;
  readonly inferenceBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pageSize?: number;
}

export class FireworksCatalogClient implements FireworksCatalogSource {
  readonly #apiKey: string;
  readonly #controlPlaneBaseUrl: string;
  readonly #inferenceBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;

  constructor(options: FireworksCatalogClientOptions) {
    this.#apiKey = z.string().min(1).parse(options.apiKey);
    this.#controlPlaneBaseUrl = (
      options.controlPlaneBaseUrl ?? "https://api.fireworks.ai/v1"
    ).replace(/\/+$/, "");
    this.#inferenceBaseUrl = (
      options.inferenceBaseUrl ?? "https://api.fireworks.ai/inference/v1"
    ).replace(/\/+$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#pageSize = z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .parse(options.pageSize ?? 200);
  }

  async load(signal?: AbortSignal): Promise<FireworksCatalogSnapshot> {
    const models: FireworksCatalogModel[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(
        `${this.#controlPlaneBaseUrl}/accounts/fireworks/models`,
      );
      url.searchParams.set("pageSize", String(this.#pageSize));
      if (pageToken !== undefined) {
        url.searchParams.set("pageToken", pageToken);
      }
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        throw new FireworksRoutingError(
          "capability_mismatch",
          `Fireworks catalog read failed with status ${response.status}`,
        );
      }
      const parsed = CatalogPageSchema.parse(await response.json());
      models.push(...parsed.models.map(toCatalogModel));
      pageToken =
        parsed.nextPageToken === undefined || parsed.nextPageToken === ""
          ? undefined
          : parsed.nextPageToken;
      if (pageToken === undefined) {
        break;
      }
      if (seenTokens.has(pageToken)) {
        throw new FireworksRoutingError(
          "capability_mismatch",
          "Fireworks catalog repeated a pagination token",
        );
      }
      seenTokens.add(pageToken);
      if (page === 19) {
        throw new FireworksRoutingError(
          "capability_mismatch",
          "Fireworks catalog exceeded the bounded page count",
        );
      }
    }

    const inferenceResponse = await this.#fetch(
      `${this.#inferenceBaseUrl}/models`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#apiKey}` },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!inferenceResponse.ok) {
      throw new FireworksRoutingError(
        "capability_mismatch",
        `Fireworks inference index read failed with status ${inferenceResponse.status}`,
      );
    }
    const inference = InferenceIndexSchema.parse(
      await inferenceResponse.json(),
    );
    const normalizedModels = [...models].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const inferenceModelIds = [
      ...new Set(inference.data.map((entry) => normalizeModelId(entry.id))),
    ].sort();
    return {
      models: normalizedModels,
      inferenceModelIds,
      digest: sha256(
        canonicalJson({ models: normalizedModels, inferenceModelIds }),
      ),
    };
  }
}

function staticMismatch(
  model: FireworksCatalogModel | undefined,
  inferenceIds: ReadonlySet<string>,
  requirements: RoleCapabilityRequirements,
): string | undefined {
  if (model === undefined) return "not_in_catalog";
  if (model.state !== "READY") return "not_ready";
  if (!model.supportsServerless) return "not_serverless";
  if (!inferenceIds.has(model.name)) return "not_in_inference_index";
  if (model.contextLength < requirements.minimumContextLength)
    return "context_too_small";
  if (requirements.tools && !model.supportsTools) return "tools_missing";
  if (requirements.vision && !model.supportsImageInput) return "vision_missing";
  if (
    requirements.training &&
    (!model.supportsReinforcementTraining ||
      model.trainingContextLength < requirements.minimumTrainingContextLength)
  )
    return "training_missing";
  return undefined;
}

function activeMismatch(
  active: ActiveCapabilityResult,
  requirements: RoleCapabilityRequirements,
): string | undefined {
  if (requirements.tools && !active.tools) return "active_tools_missing";
  if (requirements.reasoning && !active.reasoning)
    return "active_reasoning_missing";
  if (requirements.structuredOutput && !active.structuredOutput)
    return "active_structured_output_missing";
  if (requirements.vision && !active.vision) return "active_vision_missing";
  return undefined;
}

export class FireworksCapabilityRouter {
  readonly #catalog: FireworksCatalogSource;
  readonly #probe: ActiveCapabilityProbe;
  readonly #pinStore: FireworksPinStore;
  readonly #activeEvidence = new Map<string, ActiveCapabilityResult>();
  readonly #pins = new Map<string, FireworksModelPin>();

  constructor(
    catalog: FireworksCatalogSource,
    probe: ActiveCapabilityProbe,
    pinStore: FireworksPinStore = new InMemoryFireworksPinStore(),
  ) {
    this.#catalog = catalog;
    this.#probe = probe;
    this.#pinStore = pinStore;
  }

  async route(
    roleInput: FireworksModelRole,
    trajectoryIdInput: string,
    signal?: AbortSignal,
  ): Promise<FireworksModelPin> {
    const role = FireworksModelRoleSchema.parse(roleInput);
    const trajectoryId = OpaqueIdSchema.parse(trajectoryIdInput);
    const snapshot = await this.#catalog.load(signal);
    const existing =
      this.#pins.get(trajectoryId) ?? (await this.#pinStore.load(trajectoryId));
    if (existing !== undefined) {
      this.#pins.set(trajectoryId, existing);
      this.assertPin(existing);
      if (existing.role !== role) {
        throw new FireworksRoutingError(
          "role_changed",
          "A pinned trajectory cannot change model roles",
        );
      }
      const model = snapshot.models.find(
        (candidate) => candidate.name === existing.modelId,
      );
      const mismatch = staticMismatch(
        model,
        new Set(snapshot.inferenceModelIds),
        ROLE_POLICIES[role].requirements,
      );
      if (mismatch !== undefined) {
        throw new FireworksRoutingError(
          "model_disappeared",
          `Pinned Fireworks model is no longer usable: ${mismatch}`,
        );
      }
      return existing;
    }

    const policy = ROLE_POLICIES[role];
    const modelById = new Map(
      snapshot.models.map((model) => [model.name, model] as const),
    );
    const inferenceIds = new Set(snapshot.inferenceModelIds);
    const rejected: string[] = [];
    for (const candidateId of policy.candidates) {
      const model = modelById.get(candidateId);
      const mismatch = staticMismatch(model, inferenceIds, policy.requirements);
      if (mismatch !== undefined) {
        rejected.push(`${candidateId}:${mismatch}`);
        continue;
      }
      if (model === undefined) continue;
      let active: ActiveCapabilityResult;
      try {
        const evidenceKey = sha256(
          canonicalJson({
            catalogDigest: snapshot.digest,
            candidateId,
            requirements: policy.requirements,
          }),
        );
        const cached = this.#activeEvidence.get(evidenceKey);
        active =
          cached ??
          (await this.#probe.probe(candidateId, policy.requirements, signal));
        this.#activeEvidence.set(evidenceKey, active);
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[a-z_]{1,64}$/u.test(error.code)
            ? error.code
            : "unknown";
        rejected.push(`${candidateId}:active_probe_failed_${code}`);
        continue;
      }
      if (normalizeModelId(active.returnedModelId) !== candidateId) {
        rejected.push(`${candidateId}:active_model_mismatch`);
        continue;
      }
      const activeFailure = activeMismatch(active, policy.requirements);
      if (activeFailure !== undefined) {
        rejected.push(`${candidateId}:${activeFailure}`);
        continue;
      }
      const capabilitySnapshot: FireworksCapabilitySnapshot = {
        catalogDigest: snapshot.digest,
        modelId: candidateId,
        state: model.state,
        contextLength: model.contextLength,
        trainingContextLength: model.trainingContextLength,
        serverless: true,
        tools: true,
        reasoning: active.reasoning,
        reasoningEvidence: policy.requirements.reasoning
          ? "verified"
          : "not_required",
        structuredOutput: true,
        vision: active.vision,
        visionEvidence: policy.requirements.vision
          ? "verified"
          : "not_required",
        supervisedTraining: model.supportsSupervisedTraining,
        reinforcementTraining: model.supportsReinforcementTraining,
      };
      const pin: FireworksModelPin = {
        trajectoryId,
        cacheIsolationKey: sha256(
          canonicalJson({
            trajectoryId,
            routerPolicyDigest: FIREWORKS_ROUTER_POLICY_DIGEST,
          }),
        ),
        role,
        modelId: candidateId,
        serviceTier: policy.serviceTier,
        capabilitySnapshot,
        capabilitySnapshotDigest: sha256(canonicalJson(capabilitySnapshot)),
        routerPolicyDigest: FIREWORKS_ROUTER_POLICY_DIGEST,
        fallbackReason:
          rejected.length === 0 ? "preferred" : rejected.join(","),
      };
      const stored = await this.#pinStore.createIfAbsent(pin);
      if (stored.role !== role) {
        throw new FireworksRoutingError(
          "role_changed",
          "A concurrent pinned trajectory cannot change model roles",
        );
      }
      if (canonicalJson(stored) !== canonicalJson(pin)) {
        throw new FireworksRoutingError(
          "response_model_mismatch",
          "A concurrent Fireworks route disagreed with the durable pin",
        );
      }
      this.#pins.set(trajectoryId, stored);
      return stored;
    }
    throw new FireworksRoutingError(
      "capability_mismatch",
      `No Fireworks model satisfies role ${role}; ${rejected.join(",")}`,
    );
  }

  assertResponseModel(pin: FireworksModelPin, returnedModelId: string): void {
    this.assertPin(pin);
    if (normalizeModelId(returnedModelId) !== pin.modelId) {
      throw new FireworksRoutingError(
        "response_model_mismatch",
        "Fireworks returned a model other than the trajectory pin",
      );
    }
  }

  assertPin(pin: FireworksModelPin): void {
    const pinned = this.#pins.get(pin.trajectoryId);
    if (
      pinned === undefined ||
      pin.routerPolicyDigest !== FIREWORKS_ROUTER_POLICY_DIGEST ||
      pin.cacheIsolationKey !==
        sha256(
          canonicalJson({
            trajectoryId: pin.trajectoryId,
            routerPolicyDigest: FIREWORKS_ROUTER_POLICY_DIGEST,
          }),
        ) ||
      pin.capabilitySnapshotDigest !==
        sha256(canonicalJson(pin.capabilitySnapshot)) ||
      canonicalJson(pin) !== canonicalJson(pinned)
    ) {
      throw new FireworksRoutingError(
        "response_model_mismatch",
        "Fireworks request does not match the trajectory's router pin",
      );
    }
  }
}
