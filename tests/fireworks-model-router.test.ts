import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIREWORKS_ROUTER_POLICY_DIGEST,
  FireworksCapabilityRouter,
  FireworksCatalogClient,
  FileFireworksPinStore,
  FireworksRoutingError,
  type ActiveCapabilityProbe,
  type FireworksCatalogModel,
  type FireworksCatalogSnapshot,
  type FireworksCatalogSource,
  type FireworksModelPin,
  type FireworksPinStore,
} from "../src/adapters/fireworks/model-router.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";

const GLM = "accounts/fireworks/models/glm-5p2";
const KIMI_CODE = "accounts/fireworks/models/kimi-k2p7-code";
const MINIMAX = "accounts/fireworks/models/minimax-m3";

function catalogModel(
  name: string,
  overrides: Partial<FireworksCatalogModel> = {},
): FireworksCatalogModel {
  return {
    name,
    state: "READY",
    contextLength: 1_048_576,
    trainingContextLength: 65_536,
    supportsServerless: true,
    supportsTools: true,
    supportsImageInput: false,
    supportsSupervisedTraining: false,
    supportsReinforcementTraining: false,
    ...overrides,
  };
}

function snapshot(
  models: readonly FireworksCatalogModel[],
  inferenceModelIds: readonly string[],
): FireworksCatalogSnapshot {
  return {
    models,
    inferenceModelIds,
    digest: sha256(canonicalJson({ models, inferenceModelIds })),
  };
}

const passingProbe: ActiveCapabilityProbe = {
  probe: (modelId) =>
    Promise.resolve({
      returnedModelId: modelId,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: modelId.includes("kimi"),
    }),
};

describe("Fireworks capability routing", () => {
  it("paginates the complete catalog and cross-checks the inference index", async () => {
    const names = Array.from(
      { length: 291 },
      (_, index) => `accounts/fireworks/models/model-${index}`,
    );
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      urls.push(url.toString());
      if (
        url.pathname.endsWith("/models") &&
        url.pathname.includes("inference")
      ) {
        return Promise.resolve(Response.json({ data: [{ id: "model-290" }] }));
      }
      const pageToken = url.searchParams.get("pageToken");
      const offset = pageToken === null ? 0 : Number(pageToken);
      const page = names.slice(offset, offset + 200).map((name) => ({
        name,
        state: "READY",
        contextLength: name.endsWith("model-0") ? 0 : 262_144,
        trainingContextLength: name.endsWith("290") ? 65_536 : 0,
        supportsServerless: true,
        supportsTools: true,
        tunable: name.endsWith("290"),
        rlTunable: name.endsWith("290"),
        supervisedLoraTunable: name.endsWith("290"),
        supervisedFullParameterTunable: false,
        rlLoraTunable: name.endsWith("290"),
        rlFullParameterTunable: false,
      }));
      return Promise.resolve(
        Response.json({
          models: page,
          ...(offset + 200 < names.length
            ? { nextPageToken: String(offset + 200) }
            : { nextPageToken: "" }),
        }),
      );
    };
    const client = new FireworksCatalogClient({
      apiKey: "test",
      controlPlaneBaseUrl: "https://catalog.test/v1",
      inferenceBaseUrl: "https://catalog.test/inference/v1",
      fetchImpl,
    });

    const result = await client.load();

    expect(result.models).toHaveLength(291);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain("pageToken=200");
    expect(result.inferenceModelIds).toEqual([
      "accounts/fireworks/models/model-290",
    ]);
    expect(result.models.at(-1)).toMatchObject({
      name: "accounts/fireworks/models/model-99",
    });
    expect(
      result.models.find(({ name }) => name.endsWith("model-290")),
    ).toMatchObject({
      supportsSupervisedTraining: true,
      supportsReinforcementTraining: true,
      trainingContextLength: 65_536,
    });
    expect(
      result.models.find(({ name }) => name.endsWith("model-0")),
    ).toMatchObject({ contextLength: 0 });
  });

  it("admits a cataloged serverless model through the stronger active probe when the inference index is stale", async () => {
    const source: FireworksCatalogSource = {
      load: () =>
        Promise.resolve(
          snapshot(
            [
              catalogModel(MINIMAX),
              catalogModel(KIMI_CODE, {
                supportsSupervisedTraining: true,
                supportsReinforcementTraining: true,
              }),
              catalogModel(GLM),
            ],
            [GLM],
          ),
        ),
    };
    const router = new FireworksCapabilityRouter(source, passingProbe);

    const pin = await router.route("builder", "a".repeat(64));

    expect(pin.modelId).toBe(MINIMAX);
    expect(pin.fallbackReason).toContain(
      `${MINIMAX}:inference_index_advisory_miss_active_probe_passed`,
    );
    expect(pin.routerPolicyDigest).toBe(FIREWORKS_ROUTER_POLICY_DIGEST);
    expect(pin.cacheIsolationKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(pin.capabilitySnapshotDigest).toBe(
      sha256(canonicalJson(pin.capabilitySnapshot)),
    );
  });

  it("skips zero-context catalog entries without rejecting the full catalog", async () => {
    const source: FireworksCatalogSource = {
      load: () =>
        Promise.resolve(
          snapshot(
            [catalogModel(KIMI_CODE, { contextLength: 0 }), catalogModel(GLM)],
            [KIMI_CODE, GLM],
          ),
        ),
    };
    const pin = await new FireworksCapabilityRouter(source, passingProbe).route(
      "builder",
      "0".repeat(64),
    );

    expect(pin.modelId).toBe(GLM);
    expect(pin.fallbackReason).toContain(`${KIMI_CODE}:context_too_small`);
  });

  it("fails closed when a pinned model disappears instead of silently rerouting", async () => {
    let reads = 0;
    const source: FireworksCatalogSource = {
      load: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? snapshot([catalogModel(GLM)], [GLM])
            : snapshot(
                [catalogModel("accounts/fireworks/models/deepseek-v4-pro")],
                ["accounts/fireworks/models/deepseek-v4-pro"],
              ),
        );
      },
    };
    const router = new FireworksCapabilityRouter(source, passingProbe);
    const trajectory = "b".repeat(64);
    await router.route("builder", trajectory);

    await expect(router.route("builder", trajectory)).rejects.toMatchObject({
      code: "model_disappeared",
    });
  });

  it("rejects capability and returned-model mismatches", async () => {
    const source: FireworksCatalogSource = {
      load: () => Promise.resolve(snapshot([catalogModel(GLM)], [GLM])),
    };
    const mismatchingProbe: ActiveCapabilityProbe = {
      probe: () =>
        Promise.resolve({
          returnedModelId: "accounts/fireworks/models/other",
          tools: true,
          reasoning: true,
          structuredOutput: true,
          vision: false,
        }),
    };
    await expect(
      new FireworksCapabilityRouter(source, mismatchingProbe).route(
        "builder",
        "c".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "capability_mismatch" });

    const router = new FireworksCapabilityRouter(source, passingProbe);
    const pin = await router.route("builder", "d".repeat(64));
    expect(() =>
      router.assertResponseModel(
        pin,
        "accounts/fireworks/models/deepseek-v4-pro",
      ),
    ).toThrow(FireworksRoutingError);
  });

  it("routes every role only through its exact capability contract", async () => {
    const KIMI = "accounts/fireworks/models/kimi-k2p6";
    const source: FireworksCatalogSource = {
      load: () =>
        Promise.resolve(
          snapshot(
            [
              catalogModel(GLM),
              catalogModel(KIMI, {
                supportsImageInput: true,
                supportsSupervisedTraining: true,
                supportsReinforcementTraining: true,
              }),
            ],
            [GLM, KIMI],
          ),
        ),
    };
    const requirements = new Map<string, unknown>();
    const observingProbe: ActiveCapabilityProbe = {
      probe(modelId, roleRequirements) {
        requirements.set(`${requirements.size}:${modelId}`, roleRequirements);
        return Promise.resolve({
          returnedModelId: modelId,
          tools: true,
          reasoning: roleRequirements.reasoning,
          structuredOutput: true,
          vision: roleRequirements.vision,
        });
      },
    };
    const router = new FireworksCapabilityRouter(source, observingProbe);

    const roles = [
      "builder",
      "patch",
      "orchestration",
      "raster",
      "voice",
      "evaluator",
    ] as const;
    const pins = await Promise.all(
      roles.map((role, index) =>
        router.route(role, String(index + 1).repeat(64)),
      ),
    );

    expect(pins.map((pin) => pin.role)).toEqual(roles);
    expect(pins.every((pin) => pin.serviceTier === "standard")).toBe(true);
    expect(
      pins.find((pin) => pin.role === "patch")?.capabilitySnapshot
        .reinforcementTraining,
    ).toBe(true);
    expect(
      pins.find((pin) => pin.role === "raster")?.capabilitySnapshot.vision,
    ).toBe(true);
    expect(
      [...requirements.values()].some(
        (value) =>
          (value as { minimumTrainingContextLength?: number })
            .minimumTrainingContextLength === 65_536,
      ),
    ).toBe(true);
  });

  it("rejects forged trajectory pins", async () => {
    const source: FireworksCatalogSource = {
      load: () => Promise.resolve(snapshot([catalogModel(GLM)], [GLM])),
    };
    const router = new FireworksCapabilityRouter(source, passingProbe);
    const pin = await router.route("builder", "e".repeat(64));

    expect(() =>
      router.assertPin({
        ...pin,
        serviceTier: "priority",
      }),
    ).toThrow("does not match");
    expect(() =>
      router.assertPin({
        ...pin,
        capabilitySnapshotDigest: "0".repeat(64),
      }),
    ).toThrow("does not match");
  });

  it("rehydrates a durable pin and rejects a concurrent role change", async () => {
    let durablePin: FireworksModelPin | undefined;
    const store: FireworksPinStore = {
      load: () => Promise.resolve(durablePin),
      createIfAbsent(pin) {
        durablePin ??= pin;
        return Promise.resolve(durablePin);
      },
    };
    const source: FireworksCatalogSource = {
      load: () => Promise.resolve(snapshot([catalogModel(GLM)], [GLM])),
    };
    const trajectoryId = "f".repeat(64);
    const first = new FireworksCapabilityRouter(source, passingProbe, store);
    const pin = await first.route("builder", trajectoryId);
    const restarted = new FireworksCapabilityRouter(
      source,
      passingProbe,
      store,
    );

    await expect(restarted.route("builder", trajectoryId)).resolves.toEqual(
      pin,
    );
    await expect(restarted.route("patch", trajectoryId)).rejects.toMatchObject({
      code: "role_changed",
    });
  });

  it("persists an atomic pin across router processes", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "buildlabs-fireworks-pins-"),
    );
    try {
      const source: FireworksCatalogSource = {
        load: () => Promise.resolve(snapshot([catalogModel(GLM)], [GLM])),
      };
      const trajectoryId = "9".repeat(64);
      const first = new FireworksCapabilityRouter(
        source,
        passingProbe,
        new FileFireworksPinStore(directory),
      );
      const pin = await first.route("builder", trajectoryId);
      const restarted = new FireworksCapabilityRouter(
        source,
        passingProbe,
        new FileFireworksPinStore(directory),
      );

      await expect(restarted.route("builder", trajectoryId)).resolves.toEqual(
        pin,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
