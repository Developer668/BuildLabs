import { describe, expect, it } from "vitest";

import {
  BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
  ElevenLabsAgentManifestSchema,
  type ElevenLabsAgentManifest,
} from "../src/adapters/elevenlabs/agent-manifest.js";
import {
  ElevenLabsAgentReconciler,
  ElevenLabsManifestBindingsSchema,
  buildDesiredState,
  type ElevenLabsAgentAdminPort,
  type ElevenLabsManifestBindings,
} from "../src/adapters/elevenlabs/agent-reconciler.js";

type JsonRecord = Record<string, unknown>;

const BINDINGS: ElevenLabsManifestBindings = {
  agentId: "agent_buildlabs_voice_001",
  voiceId: "voice_buildlabs_001",
  publicBaseUrl: "https://voice.buildlabs.example",
  customLlmSecretId: "secret_custom_llm_001",
  toolBearerSecretId: "secret_tool_bearer_001",
  preCallSecretId: "secret_precall_bearer_001",
  webhookId: "webhook_buildlabs_voice_001",
};

const MAIN_VERSION = "version_main_0001";
const MANAGED_BRANCH_ID = "branch_buildlabs_dev_0001";
const MANAGED_BRANCH_VERSION = "version_buildlabs_dev_0001";

class InMemoryElevenLabsAdmin implements ElevenLabsAgentAdminPort {
  readonly createBranchCalls: Array<{
    agentId: string;
    input: Parameters<ElevenLabsAgentAdminPort["createBranch"]>[1];
  }> = [];
  readonly updateAgentCalls: Array<{
    agentId: string;
    input: Parameters<ElevenLabsAgentAdminPort["updateAgent"]>[1];
  }> = [];
  readonly createToolCalls: JsonRecord[] = [];
  readonly updateToolCalls: Array<{ id: string; input: JsonRecord }> = [];
  readonly createTestCalls: JsonRecord[] = [];
  readonly updateTestCalls: Array<{ id: string; input: JsonRecord }> = [];
  readonly webhooks: JsonRecord[] = [
    {
      webhookId: BINDINGS.webhookId,
      webhookUrl: "https://voice.buildlabs.example/api/webhooks/elevenlabs",
      authType: "hmac",
      isDisabled: false,
      isAutoDisabled: false,
      events: ["post_call_transcription"],
    },
  ];
  readonly tools = new Map<
    string,
    { id: string; toolConfig: JsonRecord; responseMocks?: unknown }
  >();
  readonly toolDependents = new Map<string, unknown>();
  readonly tests = new Map<
    string,
    {
      id: string;
      name: string;
      type: "llm" | "tool" | "simulation";
      detail: JsonRecord;
    }
  >();
  corruptCreatedTestReadback = false;

  readonly #mainAgent: {
    agentId: string;
    name: string;
    conversationConfig: JsonRecord;
    platformSettings: JsonRecord;
    versionId: string;
    mainBranchId?: string;
  };
  #branch:
    | {
        id: string;
        name: string;
        isArchived: boolean;
        currentLivePercentage: number;
        versionId: string;
        agent: {
          name: string;
          conversationConfig: JsonRecord;
          platformSettings: JsonRecord;
        };
      }
    | undefined;

  constructor(agentId = BINDINGS.agentId, versioningEnabled = true) {
    this.#mainAgent = {
      agentId,
      name: BUILDLABS_ELEVENLABS_AGENT_MANIFEST.agent.name,
      conversationConfig: {},
      platformSettings: {},
      versionId: MAIN_VERSION,
      ...(versioningEnabled ? { mainBranchId: "branch_main_0001" } : {}),
    };
  }

  get mutationCount() {
    return (
      this.createBranchCalls.length +
      this.updateAgentCalls.length +
      this.createToolCalls.length +
      this.updateToolCalls.length +
      this.createTestCalls.length +
      this.updateTestCalls.length
    );
  }

  getAgent(agentId: string, branchId?: string): Promise<unknown> {
    expect(agentId).toBe(this.#mainAgent.agentId);
    if (!branchId) return Promise.resolve(structuredClone(this.#mainAgent));
    if (!this.#branch || branchId !== this.#branch.id) {
      throw new Error("Unknown test branch");
    }
    return Promise.resolve({
      agentId,
      name: this.#branch.agent.name,
      conversationConfig: structuredClone(
        this.#branch.agent.conversationConfig,
      ),
      platformSettings: structuredClone(this.#branch.agent.platformSettings),
      versionId: this.#branch.versionId,
      branchId: this.#branch.id,
      mainBranchId: this.#mainAgent.mainBranchId,
    });
  }

  listBranches(agentId: string): Promise<unknown[]> {
    expect(agentId).toBe(this.#mainAgent.agentId);
    return Promise.resolve(
      this.#branch
        ? [
            {
              id: this.#branch.id,
              name: this.#branch.name,
              isArchived: this.#branch.isArchived,
              currentLivePercentage: this.#branch.currentLivePercentage,
            },
          ]
        : [],
    );
  }

  getBranch(agentId: string, branchId: string): Promise<unknown> {
    expect(agentId).toBe(this.#mainAgent.agentId);
    if (!this.#branch || branchId !== this.#branch.id) {
      throw new Error("Unknown test branch");
    }
    return Promise.resolve({
      id: this.#branch.id,
      name: this.#branch.name,
      isArchived: this.#branch.isArchived,
      currentLivePercentage: this.#branch.currentLivePercentage,
      mostRecentVersions: [
        {
          id: this.#branch.versionId,
          seqNoInBranch: 1,
        },
      ],
    });
  }

  createBranch(
    agentId: string,
    input: Parameters<ElevenLabsAgentAdminPort["createBranch"]>[1],
  ): Promise<{ createdBranchId: string; createdVersionId: string }> {
    this.createBranchCalls.push({ agentId, input: structuredClone(input) });
    this.#branch = {
      id: MANAGED_BRANCH_ID,
      name: input.name,
      isArchived: false,
      currentLivePercentage: 0,
      versionId: MANAGED_BRANCH_VERSION,
      agent: {
        name: this.#mainAgent.name,
        conversationConfig: structuredClone(input.conversationConfig),
        platformSettings: structuredClone(input.platformSettings),
      },
    };
    return Promise.resolve({
      createdBranchId: MANAGED_BRANCH_ID,
      createdVersionId: MANAGED_BRANCH_VERSION,
    });
  }

  updateAgent(
    agentId: string,
    input: Parameters<ElevenLabsAgentAdminPort["updateAgent"]>[1],
  ): Promise<unknown> {
    this.updateAgentCalls.push({ agentId, input: structuredClone(input) });
    if (!this.#branch || input.branchId !== this.#branch.id) {
      throw new Error("Unknown test branch");
    }
    this.#branch.agent = {
      name: input.name,
      conversationConfig: structuredClone(input.conversationConfig),
      platformSettings: structuredClone(input.platformSettings),
    };
    this.#branch.versionId = "version_buildlabs_dev_0002";
    return Promise.resolve({ versionId: this.#branch.versionId });
  }

  listTools(): Promise<unknown[]> {
    return Promise.resolve(
      [...this.tools.values()].map((tool) => structuredClone(tool)),
    );
  }

  getToolDependents(toolId: string): Promise<unknown> {
    return Promise.resolve(
      structuredClone(
        this.toolDependents.get(toolId) ?? { agents: [], branches: [] },
      ),
    );
  }

  createTool(input: JsonRecord): Promise<unknown> {
    this.createToolCalls.push(structuredClone(input));
    const toolConfig = asRecord(input.toolConfig);
    const name = String(toolConfig.name);
    const created = {
      id: `tool_resource_${String(this.tools.size + 1).padStart(4, "0")}`,
      toolConfig: structuredClone(toolConfig),
      responseMocks: structuredClone(input.responseMocks),
    };
    this.tools.set(name, created);
    return Promise.resolve(structuredClone(created));
  }

  updateTool(toolId: string, input: JsonRecord): Promise<unknown> {
    this.updateToolCalls.push({ id: toolId, input: structuredClone(input) });
    const toolConfig = asRecord(input.toolConfig);
    const name = String(toolConfig.name);
    const updated = {
      id: toolId,
      toolConfig: structuredClone(toolConfig),
      responseMocks: structuredClone(input.responseMocks),
    };
    this.tools.set(name, updated);
    return Promise.resolve(structuredClone(updated));
  }

  listTests(): Promise<unknown[]> {
    return Promise.resolve(
      [...this.tests.values()].map(({ id, name, type }) => ({
        id,
        name,
        type,
      })),
    );
  }

  getTest(testId: string): Promise<unknown> {
    const test = [...this.tests.values()].find((value) => value.id === testId);
    if (!test) throw new Error("Unknown test resource");
    return Promise.resolve(structuredClone(test.detail));
  }

  createTest(input: JsonRecord): Promise<unknown> {
    this.createTestCalls.push(structuredClone(input));
    const name = String(input.name);
    const type = String(input.type) as "llm" | "tool" | "simulation";
    const id = `test_resource_${String(this.tests.size + 1).padStart(4, "0")}`;
    const detail: JsonRecord = { id, ...structuredClone(input) };
    if (this.corruptCreatedTestReadback) {
      delete detail.chatHistory;
    }
    this.tests.set(name, { id, name, type, detail });
    return Promise.resolve(structuredClone(detail));
  }

  updateTest(testId: string, input: JsonRecord): Promise<unknown> {
    this.updateTestCalls.push({ id: testId, input: structuredClone(input) });
    const name = String(input.name);
    const type = String(input.type) as "llm" | "tool" | "simulation";
    const detail = { id: testId, ...structuredClone(input) };
    this.tests.set(name, { id: testId, name, type, detail });
    return Promise.resolve(structuredClone(detail));
  }

  listWebhooks(): Promise<unknown[]> {
    return Promise.resolve(structuredClone(this.webhooks));
  }

  seedTool(name: string, toolConfig: JsonRecord) {
    const id = "tool_existing_managed_0001";
    this.tools.set(name, {
      id,
      toolConfig: structuredClone(toolConfig),
    });
    return id;
  }

  setBranchTraffic(currentLivePercentage: number) {
    if (!this.#branch) throw new Error("Managed branch is not configured");
    this.#branch.currentLivePercentage = currentLivePercentage;
  }
}

describe("ElevenLabs governed agent manifest", () => {
  it("accepts the repository manifest and rejects unsafe or ambiguous shapes", () => {
    expect(
      ElevenLabsAgentManifestSchema.parse(BUILDLABS_ELEVENLABS_AGENT_MANIFEST),
    ).toEqual(BUILDLABS_ELEVENLABS_AGENT_MANIFEST);

    const duplicateToolManifest = structuredClone(
      BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
    );
    const firstTool = duplicateToolManifest.tools[0];
    if (!firstTool) throw new Error("Repository manifest has no tools");
    duplicateToolManifest.tools.push(structuredClone(firstTool));
    expect(
      ElevenLabsAgentManifestSchema.safeParse(duplicateToolManifest).success,
    ).toBe(false);

    const unsafeDeployment = structuredClone(
      BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
    ) as unknown as JsonRecord;
    asRecord(unsafeDeployment.deployment).productionTrafficPercent = 1;
    expect(
      ElevenLabsAgentManifestSchema.safeParse(unsafeDeployment).success,
    ).toBe(false);

    expect(
      ElevenLabsManifestBindingsSchema.safeParse({
        ...BINDINGS,
        publicBaseUrl: "http://voice.buildlabs.example",
      }).success,
    ).toBe(false);
    expect(
      ElevenLabsManifestBindingsSchema.safeParse({
        ...BINDINGS,
        publicBaseUrl:
          "https://operator:secret@voice.buildlabs.example?token=secret",
      }).success,
    ).toBe(false);
  });
});

describe("ElevenLabs agent reconciliation", () => {
  it("defaults to a read-only drift plan", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const reconciler = new ElevenLabsAgentReconciler(provider);

    const plan = await reconciler.plan(BINDINGS);

    expect(plan).toMatchObject({
      mode: "plan",
      status: "drifted",
      agentId: BINDINGS.agentId,
      expectedBaseVersion: MAIN_VERSION,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    });
    expect(plan.branchId).toBeUndefined();
    expect(plan.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "agent", action: "update" }),
        expect.objectContaining({ resource: "branch", action: "create" }),
        expect.objectContaining({
          resource: "tool",
          key: "capture_contact",
          action: "create",
        }),
      ]),
    );
    expect(provider.mutationCount).toBe(0);
  });

  it("rejects a stale expected base version before any mutation", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const reconciler = new ElevenLabsAgentReconciler(provider);

    await expect(
      reconciler.apply(BINDINGS, "version_stale_0001"),
    ).rejects.toMatchObject({
      name: "ElevenLabsCasConflictError",
      expectedVersion: "version_stale_0001",
      actualVersion: MAIN_VERSION,
    });
    expect(provider.mutationCount).toBe(0);
  });

  it("never enables irreversible agent versioning implicitly", async () => {
    const provider = new InMemoryElevenLabsAdmin(BINDINGS.agentId, false);
    const reconciler = new ElevenLabsAgentReconciler(provider);

    await expect(reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "ElevenLabsVersioningDisabledError",
    });
    await expect(
      reconciler.apply(BINDINGS, MAIN_VERSION),
    ).rejects.toMatchObject({
      name: "ElevenLabsVersioningDisabledError",
    });
    expect(provider.mutationCount).toBe(0);
  });

  it("creates and reads back only a zero-traffic development branch", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const reconciler = new ElevenLabsAgentReconciler(provider);

    const result = await reconciler.apply(BINDINGS, MAIN_VERSION);

    expect(result).toMatchObject({
      mode: "apply",
      status: "configured",
      agentId: BINDINGS.agentId,
      branchId: MANAGED_BRANCH_ID,
      versionId: MANAGED_BRANCH_VERSION,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    });
    expect(result.readbackDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(provider.createBranchCalls).toHaveLength(1);
    expect(provider.createBranchCalls[0]).toMatchObject({
      agentId: BINDINGS.agentId,
      input: {
        parentVersionId: MAIN_VERSION,
        name: BUILDLABS_ELEVENLABS_AGENT_MANIFEST.versioning.developmentBranch,
      },
    });
    expect(provider.createBranchCalls[0]?.input).not.toHaveProperty(
      "currentLivePercentage",
    );
    expect(provider.createBranchCalls[0]?.input).not.toHaveProperty(
      "productionTrafficPercent",
    );
    expect(provider.createBranchCalls[0]?.input.platformSettings).toMatchObject(
      {
        overrides: {
          conversationConfigOverride: {
            agent: {
              firstMessage: false,
              language: false,
              prompt: false,
            },
            tts: { voiceId: false },
          },
          customLlmExtraBody: false,
          enableConversationInitiationClientDataFromWebhook: true,
          enableStartingWorkflowNodeIdFromClient: false,
        },
        workspaceOverrides: {
          conversationInitiationClientDataWebhook: {
            url: "https://voice.buildlabs.example/api/telephony/elevenlabs/init",
            requestHeaders: {
              authorization: {
                secretId: BINDINGS.preCallSecretId,
              },
            },
          },
        },
      },
    );
    expect(
      JSON.stringify(provider.createBranchCalls[0]?.input.platformSettings),
    ).not.toContain("ELEVENLABS_PRECALL_SECRET");
    expect(provider.updateAgentCalls).toHaveLength(0);
    expect(
      await provider.getBranch(BINDINGS.agentId, MANAGED_BRANCH_ID),
    ).toMatchObject({
      currentLivePercentage: 0,
      mostRecentVersions: [
        {
          id: MANAGED_BRANCH_VERSION,
        },
      ],
    });

    const converged = await reconciler.plan(BINDINGS);
    expect(converged.status).toBe("configured");
    expect(converged.changes.every((change) => change.action === "none")).toBe(
      true,
    );
  });

  it("fails plan and apply before mutation when the managed branch has traffic", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const reconciler = new ElevenLabsAgentReconciler(provider);
    const configured = await reconciler.apply(BINDINGS, MAIN_VERSION);
    provider.setBranchTraffic(5);
    const mutationCount = provider.mutationCount;

    await expect(reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "ElevenLabsManagedBranchTrafficError",
      branchId: MANAGED_BRANCH_ID,
      livePercentage: 5,
    });
    await expect(
      reconciler.apply(BINDINGS, configured.versionId),
    ).rejects.toMatchObject({
      name: "ElevenLabsManagedBranchTrafficError",
    });
    expect(provider.mutationCount).toBe(mutationCount);
  });

  it("plans webhook drift and refuses apply without mutating it", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    provider.webhooks.splice(0);
    const reconciler = new ElevenLabsAgentReconciler(provider);

    const plan = await reconciler.plan(BINDINGS);
    expect(plan.status).toBe("drifted");
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        resource: "webhook",
        key: BINDINGS.webhookId,
        action: "update",
      }),
    );
    await expect(
      reconciler.apply(BINDINGS, MAIN_VERSION),
    ).rejects.toMatchObject({
      name: "ElevenLabsWebhookDriftError",
      webhookId: BINDINGS.webhookId,
    });
    expect(provider.mutationCount).toBe(0);
    expect(provider.webhooks).toHaveLength(0);
  });

  it("requires exact HMAC webhook URL, status, and transcription subscription", async () => {
    const mutations: Array<(webhook: JsonRecord) => void> = [
      (webhook) => {
        webhook.authType = "basic";
      },
      (webhook) => {
        webhook.isDisabled = true;
      },
      (webhook) => {
        webhook.isAutoDisabled = true;
      },
      (webhook) => {
        webhook.webhookUrl = "https://voice.buildlabs.example/wrong";
      },
      (webhook) => {
        webhook.events = [];
      },
    ];

    for (const mutate of mutations) {
      const provider = new InMemoryElevenLabsAdmin();
      const webhook = provider.webhooks[0];
      if (!webhook) throw new Error("Missing webhook test fixture");
      mutate(webhook);
      const reconciler = new ElevenLabsAgentReconciler(provider);
      const plan = await reconciler.plan(BINDINGS);
      expect(plan.changes).toContainEqual(
        expect.objectContaining({
          resource: "webhook",
          action: "update",
        }),
      );
      await expect(
        reconciler.apply(BINDINGS, MAIN_VERSION),
      ).rejects.toMatchObject({
        name: "ElevenLabsWebhookDriftError",
      });
      expect(provider.mutationCount).toBe(0);
    }
  });

  it("fails a complete readback when a created test is normalized incorrectly", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    provider.corruptCreatedTestReadback = true;

    await expect(
      new ElevenLabsAgentReconciler(provider).apply(BINDINGS, MAIN_VERSION),
    ).rejects.toThrow("ElevenLabs managed readback drifted for");
  });

  it("rejects an unowned account tool that collides with a managed function name", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    provider.seedTool("capture_contact", {
      name: "capture_contact",
      description: "Third-party contact capture",
    });
    const reconciler = new ElevenLabsAgentReconciler(provider);

    await expect(reconciler.plan(BINDINGS)).rejects.toMatchObject({
      name: "ElevenLabsUnownedToolConflictError",
      toolName: "capture_contact",
    });
    expect(provider.mutationCount).toBe(0);
  });

  it("rechecks the expected base version immediately before mutation", async () => {
    class ConcurrentVersionProvider extends InMemoryElevenLabsAdmin {
      mainReads = 0;

      override async getAgent(agentId: string, branchId?: string) {
        const response = asRecord(await super.getAgent(agentId, branchId));
        if (!branchId && (this.mainReads += 1) === 2) {
          response.versionId = "version_concurrent_0002";
        }
        return response;
      }
    }
    const provider = new ConcurrentVersionProvider();

    await expect(
      new ElevenLabsAgentReconciler(provider).apply(BINDINGS, MAIN_VERSION),
    ).rejects.toMatchObject({
      name: "ElevenLabsCasConflictError",
      expectedVersion: MAIN_VERSION,
      actualVersion: "version_concurrent_0002",
    });
    expect(provider.mutationCount).toBe(0);
  });

  it("refuses to update a tool with direct agent dependents", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const desired = buildDesiredState(
      BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
      BINDINGS,
      new Map(),
    );
    const toolName = "request_clarification";
    const desiredTool = desired.tools.get(toolName);
    if (!desiredTool) throw new Error("Missing repository-managed test tool");
    const driftedConfig = structuredClone(asRecord(desiredTool.toolConfig));
    driftedConfig.description = `${String(driftedConfig.description)} drift`;
    const toolId = provider.seedTool(toolName, driftedConfig);
    provider.toolDependents.set(toolId, {
      agents: [{ agentId: "agent_other_production_0001" }],
      branches: [],
    });

    await expect(
      new ElevenLabsAgentReconciler(provider).apply(BINDINGS, MAIN_VERSION),
    ).rejects.toThrow(
      "Refusing to update a tool attached directly to an agent configuration",
    );
    expect(provider.updateToolCalls).toHaveLength(0);
    expect(provider.createBranchCalls).toHaveLength(0);
  });

  it("fails closed when tool-dependent pagination is incomplete", async () => {
    const provider = new InMemoryElevenLabsAdmin();
    const desired = buildDesiredState(
      BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
      BINDINGS,
      new Map(),
    );
    const toolName = "request_clarification";
    const desiredTool = desired.tools.get(toolName);
    if (!desiredTool) throw new Error("Missing repository-managed test tool");
    const driftedConfig = structuredClone(asRecord(desiredTool.toolConfig));
    driftedConfig.description = `${String(driftedConfig.description)} drift`;
    const toolId = provider.seedTool(toolName, driftedConfig);
    provider.toolDependents.set(toolId, {
      agents: [],
      branches: [],
      hasMore: true,
    });

    await expect(
      new ElevenLabsAgentReconciler(provider).apply(BINDINGS, MAIN_VERSION),
    ).rejects.toThrow(
      "Refusing to update a tool with incomplete dependent pagination",
    );
    expect(provider.mutationCount).toBe(0);
  });

  it("refuses manifests that enable traffic or irreversible account actions", async () => {
    const unsafeManifests = [
      mutateManifest((manifest) => {
        asRecord(manifest.deployment).allowTrafficMutation = true;
      }),
      mutateManifest((manifest) => {
        asRecord(manifest.deployment).productionTrafficPercent = 1;
      }),
      mutateManifest((manifest) => {
        asRecord(manifest.deployment).allowIrreversibleAccountFeatures = true;
      }),
      mutateManifest((manifest) => {
        asRecord(manifest.versioning).allowMergeToMain = true;
      }),
    ];

    for (const unsafeManifest of unsafeManifests) {
      const provider = new InMemoryElevenLabsAdmin();
      const reconciler = new ElevenLabsAgentReconciler(
        provider,
        unsafeManifest,
      );
      await expect(reconciler.apply(BINDINGS, MAIN_VERSION)).rejects.toThrow(
        "The repository manifest permits an unsafe provider action",
      );
      expect(provider.mutationCount).toBe(0);
    }
  });
});

function mutateManifest(
  mutation: (manifest: JsonRecord) => void,
): ElevenLabsAgentManifest {
  const manifest = structuredClone(
    BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
  ) as unknown as JsonRecord;
  mutation(manifest);
  return manifest as unknown as ElevenLabsAgentManifest;
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "Expected an object in the ElevenLabs provider test double",
    );
  }
  return value as JsonRecord;
}
