import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { z } from "zod";

import { digestJson } from "../../lib/canonical-json.js";
import {
  BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
  type ElevenLabsAgentManifest,
} from "./agent-manifest.js";

type JsonRecord = Record<string, unknown>;

const IdentifierSchema = z.string().min(8).max(200);
const AgentSnapshotSchema = z
  .object({
    agentId: IdentifierSchema,
    name: z.string(),
    conversationConfig: z.record(z.string(), z.unknown()),
    platformSettings: z.record(z.string(), z.unknown()).optional(),
    versionId: IdentifierSchema.optional(),
    branchId: IdentifierSchema.optional(),
    mainBranchId: IdentifierSchema.optional(),
  })
  .passthrough();
const BranchSummarySchema = z
  .object({
    id: IdentifierSchema,
    name: z.string(),
    isArchived: z.boolean(),
    currentLivePercentage: z.number().min(0).max(100).optional(),
  })
  .passthrough();
const BranchSnapshotSchema = BranchSummarySchema.extend({
  mostRecentVersions: z
    .array(
      z
        .object({
          id: IdentifierSchema,
          seqNoInBranch: z.number().int().nonnegative(),
        })
        .passthrough(),
    )
    .optional(),
}).passthrough();
const ToolSnapshotSchema = z
  .object({
    id: IdentifierSchema,
    toolConfig: z.record(z.string(), z.unknown()),
    responseMocks: z.array(z.unknown()).optional(),
  })
  .passthrough();
const TestSummarySchema = z
  .object({
    id: IdentifierSchema,
    name: z.string(),
    type: z.enum(["llm", "tool", "simulation"]),
  })
  .passthrough();
const WebhookSnapshotSchema = z
  .object({
    webhookId: IdentifierSchema,
    webhookUrl: z.url(),
    authType: z.string(),
    isDisabled: z.boolean(),
    isAutoDisabled: z.boolean(),
    events: z.array(z.string()).optional(),
  })
  .passthrough();

export const ElevenLabsManifestBindingsSchema = z
  .object({
    agentId: z.string().regex(/^agent_[A-Za-z0-9_-]{8,180}$/u),
    voiceId: z.string().min(8).max(160),
    publicBaseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "The provider-facing voice URL must be a credential-free HTTPS origin"),
    customLlmSecretId: IdentifierSchema,
    toolBearerSecretId: IdentifierSchema,
    preCallSecretId: IdentifierSchema,
    webhookId: IdentifierSchema,
  })
  .strict();

export type ElevenLabsManifestBindings = z.infer<
  typeof ElevenLabsManifestBindingsSchema
>;

export type ElevenLabsResourceChange = {
  resource: "agent" | "branch" | "test" | "tool" | "webhook";
  key: string;
  action: "create" | "none" | "update";
  currentDigest?: string;
  desiredDigest: string;
};

export type ElevenLabsReconciliationPlan = {
  mode: "plan";
  status: "configured" | "drifted";
  agentId: string;
  branchId?: string;
  expectedBaseVersion: string;
  manifestDigest: string;
  changes: ElevenLabsResourceChange[];
  productionTrafficMutation: false;
  irreversibleAccountMutation: false;
};

export type ElevenLabsReconciliationResult = {
  mode: "apply";
  status: "configured";
  agentId: string;
  branchId: string;
  versionId: string;
  manifestDigest: string;
  appliedChanges: number;
  readbackDigest: string;
  productionTrafficMutation: false;
  irreversibleAccountMutation: false;
};

export interface ElevenLabsAgentAdminPort {
  getAgent(agentId: string, branchId?: string): Promise<unknown>;
  listBranches(agentId: string): Promise<unknown[]>;
  getBranch(agentId: string, branchId: string): Promise<unknown>;
  createBranch(
    agentId: string,
    input: {
      parentVersionId: string;
      name: string;
      description: string;
      conversationConfig: JsonRecord;
      platformSettings: JsonRecord;
    },
  ): Promise<{ createdBranchId: string; createdVersionId: string }>;
  updateAgent(
    agentId: string,
    input: {
      branchId: string;
      name: string;
      conversationConfig: JsonRecord;
      platformSettings: JsonRecord;
      versionDescription: string;
    },
  ): Promise<unknown>;
  updateAgentGlobalSettings(
    agentId: string,
    input: {
      name: string;
      platformSettings: JsonRecord;
    },
  ): Promise<unknown>;
  listTools(): Promise<unknown[]>;
  getToolDependents(toolId: string): Promise<unknown>;
  createTool(input: JsonRecord): Promise<unknown>;
  updateTool(toolId: string, input: JsonRecord): Promise<unknown>;
  listTests(): Promise<unknown[]>;
  getTest(testId: string): Promise<unknown>;
  createTest(input: JsonRecord): Promise<unknown>;
  updateTest(testId: string, input: JsonRecord): Promise<unknown>;
  listWebhooks(): Promise<unknown[]>;
}

export class ElevenLabsSdkAgentAdmin implements ElevenLabsAgentAdminPort {
  readonly #client: ElevenLabsClient;

  constructor(apiKey: string) {
    if (apiKey.trim().length < 20) {
      throw new Error("A configured ElevenLabs API key is required");
    }
    this.#client = new ElevenLabsClient({
      apiKey,
      timeoutInSeconds: 20,
    });
  }

  async getAgent(agentId: string, branchId?: string): Promise<unknown> {
    return this.#client.conversationalAi.agents.get(
      agentId,
      branchId ? { branchId } : undefined,
    );
  }

  async listBranches(agentId: string): Promise<unknown[]> {
    const response = await this.#client.conversationalAi.agents.branches.list(
      agentId,
      {
        includeArchived: true,
        limit: 100,
      },
    );
    if (
      response.meta?.total !== undefined &&
      response.results.length < response.meta.total
    ) {
      throw new Error("ElevenLabs returned an incomplete branch listing");
    }
    return response.results;
  }

  async getBranch(agentId: string, branchId: string): Promise<unknown> {
    return this.#client.conversationalAi.agents.branches.get(agentId, branchId);
  }

  async createBranch(
    agentId: string,
    input: {
      parentVersionId: string;
      name: string;
      description: string;
      conversationConfig: JsonRecord;
      platformSettings: JsonRecord;
    },
  ): Promise<{ createdBranchId: string; createdVersionId: string }> {
    return this.#client.conversationalAi.agents.branches.create(agentId, {
      ...input,
      conversationConfig: providerWireRecord(input.conversationConfig),
      platformSettings: providerWireRecord(input.platformSettings),
    });
  }

  async updateAgent(
    agentId: string,
    input: {
      branchId: string;
      name: string;
      conversationConfig: JsonRecord;
      platformSettings: JsonRecord;
      versionDescription: string;
    },
  ): Promise<unknown> {
    return this.#client.conversationalAi.agents.update(agentId, input);
  }

  async updateAgentGlobalSettings(
    agentId: string,
    input: {
      name: string;
      platformSettings: JsonRecord;
    },
  ): Promise<unknown> {
    return this.#client.conversationalAi.agents.update(agentId, input);
  }

  async listTools(): Promise<unknown[]> {
    const tools: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.#client.conversationalAi.tools.list({
        pageSize: 100,
        ...(cursor ? { cursor } : {}),
      });
      tools.push(...response.tools);
      if (!response.hasMore) return tools;
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error("ElevenLabs returned an incomplete tool listing");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("ElevenLabs tool pagination exceeded its bound");
  }

  async getToolDependents(toolId: string): Promise<unknown> {
    const agents: unknown[] = [];
    const branches: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response =
        await this.#client.conversationalAi.tools.getDependentAgents(toolId, {
          pageSize: 100,
          ...(cursor ? { cursor } : {}),
        });
      agents.push(...response.agents);
      branches.push(...(response.branches ?? []));
      if (!response.hasMore) {
        return { agents, branches, hasMore: false };
      }
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error(
          "ElevenLabs returned an incomplete tool-dependent page",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("ElevenLabs tool-dependent pagination exceeded its bound");
  }

  async createTool(input: JsonRecord): Promise<unknown> {
    return this.#client.conversationalAi.tools.create(input as never);
  }

  async updateTool(toolId: string, input: JsonRecord): Promise<unknown> {
    return this.#client.conversationalAi.tools.update(toolId, input as never);
  }

  async listTests(): Promise<unknown[]> {
    const tests: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.#client.conversationalAi.tests.list({
        pageSize: 100,
        ...(cursor ? { cursor } : {}),
      });
      tests.push(...response.tests);
      if (!response.hasMore) return tests;
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error("ElevenLabs returned an incomplete test listing");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("ElevenLabs test pagination exceeded its bound");
  }

  async getTest(testId: string): Promise<unknown> {
    return this.#client.conversationalAi.tests.get(testId);
  }

  async createTest(input: JsonRecord): Promise<unknown> {
    return this.#client.conversationalAi.tests.create(input as never);
  }

  async updateTest(testId: string, input: JsonRecord): Promise<unknown> {
    return this.#client.conversationalAi.tests.update(testId, input as never);
  }

  async listWebhooks(): Promise<unknown[]> {
    const response = await this.#client.webhooks.list({ includeUsages: true });
    return response.webhooks;
  }
}

type DesiredState = {
  branchName: string;
  agent: {
    name: string;
    conversationConfig: JsonRecord;
    platformSettings: JsonRecord;
  };
  tools: Map<string, JsonRecord>;
  tests: Map<string, JsonRecord>;
  webhook: JsonRecord;
};

type RemoteState = {
  agent: z.infer<typeof AgentSnapshotSchema>;
  branch?: z.infer<typeof BranchSummarySchema>;
  branchVersion: string;
  tools: Map<string, z.infer<typeof ToolSnapshotSchema>>;
  tests: Map<string, z.infer<typeof TestSummarySchema>>;
  testDetails: Map<string, JsonRecord>;
  webhook?: z.infer<typeof WebhookSnapshotSchema>;
};

const TEST_NAME_PREFIX = "BuildLabs Voice / ";
const MANAGED_TOOL_DESCRIPTION_PREFIX = "[BuildLabs managed voice intake v1] ";

export class ElevenLabsAgentReconciler {
  readonly #provider: ElevenLabsAgentAdminPort;
  readonly #manifest: ElevenLabsAgentManifest;

  constructor(
    provider: ElevenLabsAgentAdminPort,
    manifest: ElevenLabsAgentManifest = BUILDLABS_ELEVENLABS_AGENT_MANIFEST,
  ) {
    this.#provider = provider;
    this.#manifest = manifest;
  }

  async plan(
    unsafeBindings: ElevenLabsManifestBindings,
  ): Promise<ElevenLabsReconciliationPlan> {
    const bindings = ElevenLabsManifestBindingsSchema.parse(unsafeBindings);
    const remote = await this.#readRemote(bindings);
    const toolIds = new Map(
      [...remote.tools.entries()].map(([name, tool]) => [name, tool.id]),
    );
    const desired = buildDesiredState(this.#manifest, bindings, toolIds);
    const attachedTestIds = this.#existingManagedTestIds(remote);
    if (attachedTestIds) {
      desired.agent.platformSettings = attachTests(
        desired.agent.platformSettings,
        attachedTestIds,
      );
    }
    const changes = buildChanges(desired, remote);

    return {
      mode: "plan",
      status: changes.every((change) => change.action === "none")
        ? "configured"
        : "drifted",
      agentId: bindings.agentId,
      ...(remote.branch ? { branchId: remote.branch.id } : {}),
      expectedBaseVersion: remote.branchVersion,
      manifestDigest: digestJson(this.#manifest),
      changes,
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    };
  }

  async apply(
    unsafeBindings: ElevenLabsManifestBindings,
    expectedBaseVersion: string,
  ): Promise<ElevenLabsReconciliationResult> {
    const bindings = ElevenLabsManifestBindingsSchema.parse(unsafeBindings);
    IdentifierSchema.parse(expectedBaseVersion);

    if (
      this.#manifest.versioning.allowEnableVersioning ||
      this.#manifest.versioning.allowMergeToMain ||
      this.#manifest.deployment.allowTrafficMutation ||
      this.#manifest.deployment.productionTrafficPercent !== 0 ||
      this.#manifest.deployment.allowIrreversibleAccountFeatures
    ) {
      throw new Error(
        "The repository manifest permits an unsafe provider action",
      );
    }

    const initialRemote = await this.#readRemote(bindings);
    if (initialRemote.branchVersion !== expectedBaseVersion) {
      throw new ElevenLabsCasConflictError(
        expectedBaseVersion,
        initialRemote.branchVersion,
      );
    }
    this.#assertWebhookConfigured(initialRemote, bindings);

    const preMutationRemote = await this.#readRemote(bindings);
    if (preMutationRemote.branchVersion !== expectedBaseVersion) {
      throw new ElevenLabsCasConflictError(
        expectedBaseVersion,
        preMutationRemote.branchVersion,
      );
    }
    this.#assertWebhookConfigured(preMutationRemote, bindings);

    const toolIds = await this.#reconcileTools(bindings, preMutationRemote);
    const desired = buildDesiredState(this.#manifest, bindings, toolIds);
    const testIds = await this.#reconcileTests(
      desired,
      preMutationRemote,
      toolIds,
    );
    desired.agent.platformSettings = attachTests(
      desired.agent.platformSettings,
      testIds,
    );

    const latestRemote = await this.#readRemote(bindings);
    if (latestRemote.branchVersion !== expectedBaseVersion) {
      throw new ElevenLabsCasConflictError(
        expectedBaseVersion,
        latestRemote.branchVersion,
      );
    }
    this.#assertWebhookConfigured(latestRemote, bindings);

    let branchId = latestRemote.branch?.id;
    if (!branchId) {
      const created = await this.#provider.createBranch(bindings.agentId, {
        parentVersionId: expectedBaseVersion,
        name: this.#manifest.versioning.developmentBranch,
        description: this.#manifest.versioning.branchDescription,
        conversationConfig: desired.agent.conversationConfig,
        platformSettings: desired.agent.platformSettings,
      });
      branchId = created.createdBranchId;
    } else if (
      digestJson(
        managedProjection(
          agentVersionedState(latestRemote.agent),
          agentVersionedState(desired.agent),
        ),
      ) !== digestJson(agentVersionedState(desired.agent))
    ) {
      await this.#provider.updateAgent(bindings.agentId, {
        branchId,
        name: desired.agent.name,
        conversationConfig: desired.agent.conversationConfig,
        platformSettings: desired.agent.platformSettings,
        versionDescription: `BuildLabs manifest ${digestJson(this.#manifest).slice(0, 16)}`,
      });
    }

    if (
      digestJson(
        managedProjection(
          agentGlobalState(latestRemote.agent),
          agentGlobalState(desired.agent),
        ),
      ) !== digestJson(agentGlobalState(desired.agent))
    ) {
      await this.#provider.updateAgentGlobalSettings(bindings.agentId, {
        name: desired.agent.name,
        platformSettings: agentGlobalPlatformSettings(
          desired.agent.platformSettings,
        ),
      });
    }

    const readback = await this.#readRemote(bindings);
    if (!readback.branch || readback.branch.id !== branchId) {
      throw new Error(
        "ElevenLabs did not return the reconciled development branch",
      );
    }
    if ((readback.branch.currentLivePercentage ?? 0) !== 0) {
      throw new Error(
        "The reconciled development branch unexpectedly has traffic",
      );
    }

    const readbackToolIds = new Map(
      [...readback.tools.entries()].map(([name, tool]) => [name, tool.id]),
    );
    const readbackDesired = buildDesiredState(
      this.#manifest,
      bindings,
      readbackToolIds,
    );
    readbackDesired.agent.platformSettings = attachTests(
      readbackDesired.agent.platformSettings,
      testIds,
    );
    const readbackChanges = buildChanges(readbackDesired, readback);
    const readbackDrift = readbackChanges.filter(
      (change) => change.action !== "none",
    );
    if (readbackDrift.length > 0) {
      throw new Error(
        `ElevenLabs managed readback drifted for ${readbackDrift
          .map((change) => `${change.resource}:${change.key}`)
          .join(",")}`,
      );
    }

    const branch = BranchSnapshotSchema.parse(
      await this.#provider.getBranch(bindings.agentId, branchId),
    );
    const versionId = latestBranchVersion(branch);
    const initialDesired = buildDesiredState(
      this.#manifest,
      bindings,
      new Map(
        [...initialRemote.tools.entries()].map(([name, tool]) => [
          name,
          tool.id,
        ]),
      ),
    );
    const initialTestIds = this.#existingManagedTestIds(initialRemote);
    if (initialTestIds) {
      initialDesired.agent.platformSettings = attachTests(
        initialDesired.agent.platformSettings,
        initialTestIds,
      );
    }
    const initialPlanChanges = buildChanges(initialDesired, initialRemote);

    return {
      mode: "apply",
      status: "configured",
      agentId: bindings.agentId,
      branchId,
      versionId,
      manifestDigest: digestJson(this.#manifest),
      appliedChanges: initialPlanChanges.filter(
        (change) => change.action !== "none",
      ).length,
      readbackDigest: digestManagedReadback(
        readbackDesired,
        readback,
        versionId,
      ),
      productionTrafficMutation: false,
      irreversibleAccountMutation: false,
    };
  }

  async #readRemote(
    bindings: ElevenLabsManifestBindings,
  ): Promise<RemoteState> {
    const agentId = bindings.agentId;
    const mainAgent = AgentSnapshotSchema.parse(
      await this.#provider.getAgent(agentId),
    );
    const branches = z
      .array(BranchSummarySchema)
      .parse(await this.#provider.listBranches(agentId));
    const matches = branches.filter(
      (branch) =>
        !branch.isArchived &&
        branch.name === this.#manifest.versioning.developmentBranch,
    );
    if (matches.length > 1) {
      throw new Error("ElevenLabs returned duplicate managed branch names");
    }
    const branch = matches[0];
    let agent = mainAgent;
    let branchVersion = mainAgent.versionId;
    if (branch) {
      const branchDetails = BranchSnapshotSchema.parse(
        await this.#provider.getBranch(agentId, branch.id),
      );
      if ((branchDetails.currentLivePercentage ?? 0) !== 0) {
        throw new ElevenLabsManagedBranchTrafficError(
          branch.id,
          branchDetails.currentLivePercentage ?? 0,
        );
      }
      branchVersion = latestBranchVersion(branchDetails);
      agent = AgentSnapshotSchema.parse(
        await this.#provider.getAgent(agentId, branch.id),
      );
      if (agent.versionId && agent.versionId !== branchVersion) {
        throw new Error(
          "ElevenLabs branch and agent version readbacks disagree",
        );
      }
    }
    if (!branchVersion) {
      throw new ElevenLabsVersioningDisabledError();
    }
    if (!agent.mainBranchId) {
      throw new ElevenLabsVersioningDisabledError();
    }

    const tools = new Map<string, z.infer<typeof ToolSnapshotSchema>>();
    for (const rawTool of await this.#provider.listTools()) {
      const tool = ToolSnapshotSchema.parse(rawTool);
      const name = z.string().parse(tool.toolConfig.name);
      if (this.#manifest.tools.some((item) => item.name === name)) {
        const description = z.string().safeParse(tool.toolConfig.description);
        if (
          !description.success ||
          !description.data.startsWith(MANAGED_TOOL_DESCRIPTION_PREFIX)
        ) {
          throw new ElevenLabsUnownedToolConflictError(name, tool.id);
        }
        if (tools.has(name)) {
          throw new Error(`ElevenLabs returned duplicate tool name ${name}`);
        }
        tools.set(name, tool);
      }
    }

    const tests = new Map<string, z.infer<typeof TestSummarySchema>>();
    const testDetails = new Map<string, JsonRecord>();
    for (const rawTest of await this.#provider.listTests()) {
      const test = TestSummarySchema.parse(rawTest);
      if (!test.name.startsWith(TEST_NAME_PREFIX)) continue;
      if (tests.has(test.name)) {
        throw new Error(`ElevenLabs returned duplicate test name ${test.name}`);
      }
      tests.set(test.name, test);
      testDetails.set(test.name, record(await this.#provider.getTest(test.id)));
    }

    const webhookMatches = z
      .array(WebhookSnapshotSchema)
      .parse(await this.#provider.listWebhooks())
      .filter((webhook) => webhook.webhookId === bindings.webhookId);
    if (webhookMatches.length > 1) {
      throw new Error("ElevenLabs returned duplicate webhook identifiers");
    }

    return {
      agent,
      ...(branch ? { branch } : {}),
      branchVersion,
      tools,
      tests,
      testDetails,
      ...(webhookMatches[0] ? { webhook: webhookMatches[0] } : {}),
    };
  }

  #existingManagedTestIds(remote: RemoteState): string[] | undefined {
    const ids: string[] = [];
    for (const test of this.#manifest.tests) {
      const current = remote.tests.get(providerTestName(test.key));
      if (!current) return undefined;
      ids.push(current.id);
    }
    return ids.sort();
  }

  #assertWebhookConfigured(
    remote: RemoteState,
    bindings: ElevenLabsManifestBindings,
  ) {
    const desired = assertableWebhook(
      remote.webhook,
      buildDesiredWebhook(this.#manifest, bindings),
    );
    const current = remote.webhook
      ? managedProjection(remote.webhook, desired)
      : undefined;
    if (!current || digestJson(current) !== digestJson(desired)) {
      throw new ElevenLabsWebhookDriftError(bindings.webhookId);
    }
  }

  async #reconcileTools(
    bindings: ElevenLabsManifestBindings,
    remote: RemoteState,
  ): Promise<Map<string, string>> {
    const desired = buildDesiredTools(this.#manifest, bindings);
    const ids = new Map<string, string>();

    for (const [name, desiredRequest] of desired) {
      const current = remote.tools.get(name);
      if (!current) {
        const created = ToolSnapshotSchema.parse(
          await this.#provider.createTool(desiredRequest),
        );
        const readbackName = z.string().parse(created.toolConfig.name);
        if (readbackName !== name) {
          throw new Error("ElevenLabs created the wrong tool resource");
        }
        ids.set(name, created.id);
        continue;
      }

      const managedCurrent = managedProjection(current, desiredRequest);
      if (digestJson(managedCurrent) !== digestJson(desiredRequest)) {
        await this.#assertToolUpdateIsIsolated(
          current.id,
          bindings.agentId,
          remote.branch?.id,
        );
        const updated = ToolSnapshotSchema.parse(
          await this.#provider.updateTool(current.id, desiredRequest),
        );
        if (
          digestJson(managedProjection(updated, desiredRequest)) !==
          digestJson(desiredRequest)
        ) {
          throw new Error(`ElevenLabs tool ${name} failed readback validation`);
        }
      }
      ids.set(name, current.id);
    }
    return ids;
  }

  async #assertToolUpdateIsIsolated(
    toolId: string,
    agentId: string,
    branchId?: string,
  ) {
    const dependents = record(await this.#provider.getToolDependents(toolId));
    if (dependents.hasMore === true) {
      throw new Error(
        "Refusing to update a tool with incomplete dependent pagination",
      );
    }
    const agents = Array.isArray(dependents.agents) ? dependents.agents : [];
    const branches = Array.isArray(dependents.branches)
      ? dependents.branches
      : [];
    if (agents.length > 0) {
      throw new Error(
        "Refusing to update a tool attached directly to an agent configuration",
      );
    }
    const unsafeBranch = branches.some((value) => {
      const branch = record(value);
      return (
        branch.agentId !== agentId ||
        branch.branchId !== branchId ||
        branch.isMain !== false
      );
    });
    if (unsafeBranch) {
      throw new Error(
        "Refusing to update a tool used outside the managed zero-traffic branch",
      );
    }
  }

  async #reconcileTests(
    desired: DesiredState,
    remote: RemoteState,
    toolIds: Map<string, string>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const test of this.#manifest.tests) {
      const name = providerTestName(test.key);
      const desiredRequest = buildDesiredTest(test, toolIds, this.#manifest);
      desired.tests.set(name, desiredRequest);
      const current = remote.tests.get(name);
      if (!current) {
        const created = record(await this.#provider.createTest(desiredRequest));
        ids.push(IdentifierSchema.parse(created.id));
        continue;
      }

      const currentDetails = remote.testDetails.get(name) ?? {};
      const managedCurrent = managedProjection(currentDetails, desiredRequest);
      if (digestJson(managedCurrent) !== digestJson(desiredRequest)) {
        await this.#provider.updateTest(current.id, desiredRequest);
        const readback = record(await this.#provider.getTest(current.id));
        if (
          digestJson(managedProjection(readback, desiredRequest)) !==
          digestJson(desiredRequest)
        ) {
          throw new Error(`ElevenLabs test ${name} failed readback validation`);
        }
      }
      ids.push(current.id);
    }
    return ids.sort();
  }
}

export class ElevenLabsCasConflictError extends Error {
  readonly expectedVersion: string;
  readonly actualVersion: string;

  constructor(expectedVersion: string, actualVersion: string) {
    super(
      `ElevenLabs expected-base-version conflict: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = "ElevenLabsCasConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class ElevenLabsManagedBranchTrafficError extends Error {
  readonly branchId: string;
  readonly livePercentage: number;

  constructor(branchId: string, livePercentage: number) {
    super("The managed ElevenLabs branch has nonzero live traffic");
    this.name = "ElevenLabsManagedBranchTrafficError";
    this.branchId = branchId;
    this.livePercentage = livePercentage;
  }
}

export class ElevenLabsVersioningDisabledError extends Error {
  constructor() {
    super(
      "ElevenLabs agent versioning must be enabled explicitly before reconciliation",
    );
    this.name = "ElevenLabsVersioningDisabledError";
  }
}

export class ElevenLabsWebhookDriftError extends Error {
  readonly webhookId: string;

  constructor(webhookId: string) {
    super("The configured ElevenLabs webhook failed managed readback");
    this.name = "ElevenLabsWebhookDriftError";
    this.webhookId = webhookId;
  }
}

export class ElevenLabsUnownedToolConflictError extends Error {
  readonly toolName: string;
  readonly toolId: string;

  constructor(toolName: string, toolId: string) {
    super("An unowned ElevenLabs tool conflicts with a managed tool name");
    this.name = "ElevenLabsUnownedToolConflictError";
    this.toolName = toolName;
    this.toolId = toolId;
  }
}

export function bindingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ElevenLabsManifestBindings {
  const manifest = BUILDLABS_ELEVENLABS_AGENT_MANIFEST;
  return ElevenLabsManifestBindingsSchema.parse({
    agentId: environment[manifest.agent.idEnvironmentVariable],
    voiceId: environment[manifest.audio.voiceIdEnvironmentVariable],
    publicBaseUrl:
      environment[manifest.customLlm.publicBaseUrlEnvironmentVariable],
    customLlmSecretId:
      environment[manifest.customLlm.providerSecretIdEnvironmentVariable],
    toolBearerSecretId:
      environment[
        manifest.toolSecurity.providerBearerSecretIdEnvironmentVariable
      ],
    webhookId:
      environment[manifest.webhook.providerWebhookIdEnvironmentVariable],
    preCallSecretId:
      environment[
        manifest.telephony.initializationWebhook
          .providerSecretIdEnvironmentVariable
      ],
  });
}

export function buildDesiredState(
  manifest: ElevenLabsAgentManifest,
  bindings: ElevenLabsManifestBindings,
  toolIds: Map<string, string>,
): DesiredState {
  const customLlmBasePath = manifest.customLlm.endpoint.replace(
    /\/chat\/completions$/u,
    "",
  );
  const customLlmUrl = new URL(
    customLlmBasePath,
    `${bindings.publicBaseUrl.replace(/\/+$/u, "")}/`,
  ).toString();
  const preCallUrl = new URL(
    manifest.telephony.initializationWebhook.endpoint,
    `${bindings.publicBaseUrl.replace(/\/+$/u, "")}/`,
  ).toString();
  const webhookTools = manifest.tools.filter((tool) => tool.kind === "webhook");
  const attachedToolIds = webhookTools
    .map((tool) => toolIds.get(tool.name) ?? `pending:${tool.name}`)
    .sort();
  const endCall = manifest.tools.find(
    (tool) => tool.kind === "system" && tool.name === "end_call",
  );

  const conversationConfig: JsonRecord = {
    asr: {
      quality: manifest.audio.asrQuality,
      provider: manifest.audio.asrProvider,
      userInputAudioFormat: manifest.audio.inputFormat,
    },
    turn: {
      turnTimeout: manifest.turn.timeoutSeconds,
      initialWaitTime: manifest.turn.initialWaitSeconds,
      silenceEndCallTimeout: manifest.turn.silenceEndCallSeconds,
      turnEagerness: manifest.turn.eagerness,
      spellingPatience: manifest.turn.spellingPatience,
      speculativeTurn: manifest.turn.speculative,
      transcribeOnDisabledInterruptions:
        manifest.turn.transcribeDuringNonInterruptibleTurns,
      interruptionIgnoreTerms: manifest.turn.interruptionIgnoreTerms,
      interruptionIgnoreTermLanguages: ["en"],
    },
    tts: {
      modelId: manifest.audio.ttsModel,
      voiceId: bindings.voiceId,
      agentOutputAudioFormat: manifest.audio.outputFormat,
      speed: manifest.audio.speed,
      stability: manifest.audio.stability,
      similarityBoost: manifest.audio.similarityBoost,
      textNormalisationType: "elevenlabs",
    },
    conversation: {
      textOnly: false,
      maxDurationSeconds: manifest.agent.maximumConversationSeconds,
      clientEvents: [
        "conversation_initiation_metadata",
        "ping",
        "audio",
        "interruption",
        "user_transcript",
        "agent_response",
        "agent_response_correction",
        "agent_response_metadata",
        "client_error",
      ],
      monitoringEnabled: false,
    },
    agent: {
      firstMessage: manifest.agent.firstMessage,
      language: manifest.agent.language,
      disableFirstMessageInterruptions:
        !manifest.turn.allowFirstMessageInterruption,
      maxConversationDurationMessage:
        "This session has reached its time limit. Your intake remains incomplete unless requirements finalization succeeded.",
      prompt: {
        prompt: manifest.agent.prompt,
        llm: "custom-llm",
        maxTokens: manifest.customLlm.maximumOutputTokens,
        temperature: 0,
        toolIds: attachedToolIds,
        builtInTools: endCall
          ? {
              endCall: {
                type: "system",
                name: "end_call",
                description: endCall.description,
                responseTimeoutSecs: endCall.responseTimeoutSeconds,
                interruptionMode: endCall.interruptionMode,
                params: {
                  systemToolType: "end_call",
                },
              },
            }
          : {},
        customLlm: {
          url: customLlmUrl,
          modelId: manifest.customLlm.modelId,
          apiKey: { secretId: bindings.customLlmSecretId },
          apiType: manifest.customLlm.apiType,
        },
        backupLlmConfig: {
          preference: manifest.customLlm.backupCascade,
        },
        ignoreDefaultPersonality: true,
      },
    },
  };

  const dataCollection = Object.fromEntries(
    Object.entries(manifest.analysis.dataCollection).map(([key, value]) => [
      key,
      {
        type: value.type === "number" ? "number" : value.type,
        description: value.description,
      },
    ]),
  );
  const platformSettings: JsonRecord = {
    evaluation: {
      criteria: manifest.analysis.successCriteria.map((criterion) => ({
        id: criterion.id,
        name: criterion.id.replaceAll("_", " "),
        type: "prompt",
        conversationGoalPrompt: criterion.prompt,
        useKnowledgeBase: false,
        scope: "conversation",
        scoringMode: "binary",
      })),
    },
    dataCollection,
    overrides: {
      conversationConfigOverride: {
        agent: {
          firstMessage: false,
          language: false,
          prompt: {
            prompt: false,
            llm: false,
            toolIds: false,
            nativeMcpServerIds: false,
            knowledgeBase: false,
          },
        },
        tts: { voiceId: false },
      },
      customLlmExtraBody: false,
      enableConversationInitiationClientDataFromWebhook: true,
      enableStartingWorkflowNodeIdFromClient: false,
    },
    auth: {
      enableAuth: manifest.authentication.signedUrlRequired,
      allowlist: [],
      requireOriginHeader: false,
    },
    privacy: {
      recordVoice: manifest.privacy.recordVoice,
      retentionDays: manifest.privacy.retentionDays,
      deleteTranscriptAndPii:
        manifest.privacy.deleteTranscriptAndPiiAfterRetention,
      deleteAudio: manifest.privacy.deleteAudioAfterRetention,
      applyToExistingConversations:
        manifest.privacy.applyToExistingConversations,
      zeroRetentionMode: false,
    },
    callLimits: {
      agentConcurrencyLimit: 4,
      dailyLimit: 200,
      burstingEnabled: false,
    },
    workspaceOverrides: {
      conversationInitiationClientDataWebhook: {
        url: preCallUrl,
        requestHeaders: {
          authorization: { secretId: bindings.preCallSecretId },
        },
      },
      webhooks: {
        postCallWebhookId: bindings.webhookId,
        events: ["transcript"],
        transcriptFormat: "json",
        sendAudio: false,
      },
    },
    archived: false,
    autoTranslateTranscriptToAppLanguage: false,
    summaryLanguage: "en",
  };

  const tests = new Map<string, JsonRecord>();
  for (const test of manifest.tests) {
    tests.set(
      providerTestName(test.key),
      buildDesiredTest(test, toolIds, manifest),
    );
  }

  return {
    branchName: manifest.versioning.developmentBranch,
    agent: {
      name: manifest.agent.name,
      conversationConfig,
      platformSettings,
    },
    tools: buildDesiredTools(manifest, bindings),
    tests,
    webhook: buildDesiredWebhook(manifest, bindings),
  };
}

function buildDesiredWebhook(
  manifest: ElevenLabsAgentManifest,
  bindings: ElevenLabsManifestBindings,
): JsonRecord {
  return {
    webhookId: bindings.webhookId,
    webhookUrl: new URL(
      manifest.webhook.endpoint,
      `${bindings.publicBaseUrl.replace(/\/+$/u, "")}/`,
    ).toString(),
    authType: "hmac",
    isDisabled: false,
    isAutoDisabled: false,
    events: [...manifest.webhook.eventTypes].sort(),
  };
}

// The provider omits `events` from some webhook reads. Assert event
// subscriptions only when the remote actually reports them: this reconciler
// never writes the webhook resource, so an unconditional assertion would
// report permanent drift that no apply could ever repair.
function assertableWebhook(
  remote: JsonRecord | undefined,
  desired: JsonRecord,
): JsonRecord {
  if (remote && "events" in remote) {
    return desired;
  }
  return Object.fromEntries(
    Object.entries(desired).filter(([key]) => key !== "events"),
  );
}

function buildDesiredTools(
  manifest: ElevenLabsAgentManifest,
  bindings: ElevenLabsManifestBindings,
) {
  const result = new Map<string, JsonRecord>();
  const origin = bindings.publicBaseUrl.replace(/\/+$/u, "");
  for (const tool of manifest.tools) {
    if (tool.kind !== "webhook") continue;
    const request = tool.request ?? {};
    const required = Object.entries(request)
      .filter(([, field]) => field.required)
      .map(([name]) => name);
    const properties = Object.fromEntries(
      Object.entries(request).map(([name, field]) => [
        name,
        providerJsonSchemaField(field),
      ]),
    );
    const assignments = Object.entries(tool.assignments ?? {}).map(
      ([dynamicVariable, valuePath]) => ({
        source: "response",
        dynamicVariable,
        valuePath,
        sanitize: false,
        preserveNativeType: false,
      }),
    );
    const assignmentResponseProperties = Object.fromEntries(
      Object.values(tool.assignments ?? {})
        .filter(
          (valuePath) =>
            valuePath !== "accepted" &&
            valuePath !== "code" &&
            valuePath !== "receipt_digest",
        )
        .map((valuePath) => [
          valuePath,
          {
            type: valuePath === "consent" ? "boolean" : "string",
            description:
              valuePath === "consent"
                ? "Controller-validated explicit research-consent state."
                : "Controller-validated bounded response value.",
          },
        ]),
    );
    const mockResult = {
      accepted: true,
      code: "simulation_accepted",
      receipt_digest: "0".repeat(64),
      ...(Object.values(tool.assignments ?? {}).includes("consent")
        ? { consent: false }
        : {}),
      ...(Object.values(tool.assignments ?? {}).includes("email_verification")
        ? { email_verification: "unverified" }
        : {}),
    };
    result.set(tool.name, {
      toolConfig: {
        type: "webhook",
        name: tool.name,
        description: `${MANAGED_TOOL_DESCRIPTION_PREFIX}${tool.description}`,
        responseTimeoutSecs: tool.responseTimeoutSeconds,
        interruptionMode: tool.interruptionMode,
        preToolSpeech: "auto",
        executionMode: "immediate",
        toolErrorHandlingMode: "hide",
        assignments,
        apiSchema: {
          url: `${origin}${tool.endpoint}`,
          method: tool.method,
          requestHeaders: {
            authorization: { secretId: bindings.toolBearerSecretId },
            "x-buildlabs-capability": {
              variableName: "secret__buildlabs_capability",
            },
          },
          requestBodySchema: {
            type: "object",
            required,
            properties,
          },
          responseBodySchema: {
            type: "object",
            properties: {
              accepted: {
                type: "boolean",
                description:
                  "Whether deterministic controller validation accepted the request.",
              },
              code: {
                type: "string",
                description: "Bounded machine-readable controller result code.",
              },
              receipt_digest: {
                type: "string",
                description: "Controller-keyed receipt digest.",
              },
              ...assignmentResponseProperties,
            },
          },
          responseFilter: {
            mode: "allow",
            filters: [
              "accepted",
              "code",
              "receipt_digest",
              ...Object.values(tool.assignments ?? {}),
            ],
            contentType: "application/json",
          },
          contentType: "application/json",
        },
      },
      responseMocks: [
        {
          parameterConditions: [],
          mockResult: JSON.stringify(mockResult),
        },
      ],
    });
  }
  return result;
}

function providerJsonSchemaField(
  field: ElevenLabsAgentManifest["tools"][number]["request"] extends
    Record<string, infer Field> | undefined
    ? Field
    : never,
): JsonRecord {
  if (field.source !== "model") {
    return {
      type: field.type,
      dynamicVariable: field.dynamicVariable,
    };
  }
  if (field.type === "array") {
    return {
      type: "array",
      description: "A bounded list supplied from the current caller turn.",
      items: {
        type: "string",
        description: "One caller-supported value.",
      },
    };
  }
  if (field.type === "object") {
    return {
      type: "object",
      description: "A bounded structured value supplied from the current turn.",
      properties: {},
      required: [],
    };
  }
  return {
    type: field.type,
    description: "A bounded value supported by the current conversation.",
    ...(field.enum ? { enum: field.enum } : {}),
  };
}

function buildDesiredTest(
  test: ElevenLabsAgentManifest["tests"][number],
  toolIds: Map<string, string>,
  manifest: ElevenLabsAgentManifest,
): JsonRecord {
  const common = {
    name: providerTestName(test.key),
    chatHistory: [
      {
        role: "user",
        message: test.scenario,
        timeInCallSecs: 0,
      },
    ],
    conversationInitiationSource: "unknown",
    dynamicVariables: {
      secret__buildlabs_capability: "test-capability",
      buildlabs_project_id: "intake_test_project",
      buildlabs_contract_version: 0,
      buildlabs_agent_version: "test-version",
    },
  };
  if (test.type === "simulation") {
    return {
      type: "simulation",
      ...common,
      simulationScenario: test.scenario,
      simulationMaxTurns: test.maximumTurns,
      successConditions: test.successConditions,
      simulationEnvironment: "testing",
      toolMockConfig: {
        mockingStrategy: "all",
        fallbackStrategy: "raise_error",
        mockedToolIds: [...toolIds.values()].sort(),
      },
    };
  }
  if (test.type === "next_reply") {
    return {
      type: "llm",
      ...common,
      successCondition: test.successConditions.join("\n"),
      successExamples: [
        {
          type: "success",
          response: "The reply satisfies every asserted policy condition.",
        },
      ],
      failureExamples: [
        {
          type: "failure",
          response:
            "The reply violates one or more asserted policy conditions.",
        },
      ],
    };
  }

  const referencedName = test.expectedTool ?? test.verifyToolAbsence;
  if (!referencedName) {
    throw new Error(`Tool test ${test.key} has no referenced tool`);
  }
  const manifestTool = manifest.tools.find(
    (tool) => tool.name === referencedName,
  );
  const toolId =
    manifestTool?.kind === "system"
      ? referencedName
      : (toolIds.get(referencedName) ?? `pending:${referencedName}`);
  if (!toolId) {
    throw new Error(`Tool ${referencedName} has no reconciled provider ID`);
  }
  return {
    type: "tool",
    ...common,
    toolCallParameters: {
      referencedTool: {
        id: toolId,
        type: manifestTool?.kind === "system" ? "system" : "webhook",
      },
      verifyAbsence: Boolean(test.verifyToolAbsence),
      parameters: Object.entries(test.expectedToolParameters ?? {}).map(
        ([path, value]) => ({
          path,
          eval: {
            type: "exact",
            expectedValue:
              typeof value === "string" ? value : JSON.stringify(value),
          },
        }),
      ),
    },
    checkAnyToolMatches: false,
  };
}

function attachTests(
  platformSettings: JsonRecord,
  testIds: string[],
): JsonRecord {
  return {
    ...platformSettings,
    testing: {
      attachedTests: testIds.map((testId) => ({ testId })),
    },
  };
}

function buildChanges(
  desired: DesiredState,
  remote: RemoteState,
): ElevenLabsResourceChange[] {
  const changes: ElevenLabsResourceChange[] = [];
  const desiredAgentDigest = digestJson(desired.agent);
  const currentAgent = managedProjection(
    {
      name: remote.agent.name,
      conversationConfig: remote.agent.conversationConfig,
      platformSettings: remote.agent.platformSettings ?? {},
    },
    desired.agent,
  );
  changes.push({
    resource: "agent",
    key: remote.agent.agentId,
    action: digestJson(currentAgent) === desiredAgentDigest ? "none" : "update",
    currentDigest: digestJson(currentAgent),
    desiredDigest: desiredAgentDigest,
  });
  changes.push({
    resource: "branch",
    key: desired.branchName,
    action: remote.branch ? "none" : "create",
    ...(remote.branch ? { currentDigest: digestJson(remote.branch) } : {}),
    desiredDigest: digestJson({
      name: desired.branchName,
      traffic: 0,
    }),
  });
  const desiredWebhook = assertableWebhook(remote.webhook, desired.webhook);
  const currentWebhook = remote.webhook
    ? managedProjection(remote.webhook, desiredWebhook)
    : undefined;
  changes.push({
    resource: "webhook",
    key: String(desiredWebhook.webhookId),
    action:
      currentWebhook &&
      digestJson(currentWebhook) === digestJson(desiredWebhook)
        ? "none"
        : "update",
    ...(currentWebhook ? { currentDigest: digestJson(currentWebhook) } : {}),
    desiredDigest: digestJson(desiredWebhook),
  });
  for (const [name, desiredTool] of desired.tools) {
    const current = remote.tools.get(name);
    const currentManaged = current
      ? managedProjection(current, desiredTool)
      : undefined;
    changes.push({
      resource: "tool",
      key: name,
      action: !current
        ? "create"
        : digestJson(currentManaged) === digestJson(desiredTool)
          ? "none"
          : "update",
      ...(currentManaged ? { currentDigest: digestJson(currentManaged) } : {}),
      desiredDigest: digestJson(desiredTool),
    });
  }
  for (const [name, desiredTest] of desired.tests) {
    const current = remote.tests.get(name);
    const currentManaged = current
      ? managedProjection(remote.testDetails.get(name) ?? {}, desiredTest)
      : undefined;
    changes.push({
      resource: "test",
      key: name,
      action: !current
        ? "create"
        : digestJson(currentManaged) === digestJson(desiredTest)
          ? "none"
          : "update",
      ...(currentManaged ? { currentDigest: digestJson(currentManaged) } : {}),
      desiredDigest: digestJson(desiredTest),
    });
  }
  return changes.sort(
    (left, right) =>
      left.resource.localeCompare(right.resource) ||
      left.key.localeCompare(right.key),
  );
}

function digestManagedReadback(
  desired: DesiredState,
  remote: RemoteState,
  versionId: string,
) {
  const agent = managedProjection(
    {
      name: remote.agent.name,
      conversationConfig: remote.agent.conversationConfig,
      platformSettings: remote.agent.platformSettings ?? {},
    },
    desired.agent,
  );
  const tools = Object.fromEntries(
    [...desired.tools.entries()].map(([name, expected]) => [
      name,
      managedProjection(remote.tools.get(name), expected),
    ]),
  );
  const tests = Object.fromEntries(
    [...desired.tests.entries()].map(([name, expected]) => [
      name,
      managedProjection(remote.testDetails.get(name), expected),
    ]),
  );
  return digestJson({
    agent,
    branch: {
      id: remote.branch?.id,
      name: remote.branch?.name,
      currentLivePercentage: remote.branch?.currentLivePercentage ?? 0,
      versionId,
    },
    webhook: managedProjection(
      remote.webhook,
      assertableWebhook(remote.webhook, desired.webhook),
    ),
    tools,
    tests,
  });
}

function managedProjection(current: unknown, desired: unknown): unknown {
  if (Array.isArray(desired)) {
    if (!Array.isArray(current) || current.length !== desired.length) {
      return current;
    }
    return desired.map((value, index) =>
      managedProjection(current[index], value),
    );
  }
  if (desired && typeof desired === "object") {
    const currentRecord = record(current);
    return Object.fromEntries(
      Object.entries(desired as JsonRecord).map(([key, value]) => [
        key,
        managedProjection(currentRecord[key], value),
      ]),
    );
  }
  return current;
}

const GLOBAL_PLATFORM_SETTING_KEYS = ["auth", "privacy", "callLimits"] as const;

function agentGlobalPlatformSettings(platformSettings: JsonRecord): JsonRecord {
  return Object.fromEntries(
    GLOBAL_PLATFORM_SETTING_KEYS.flatMap((key) =>
      key in platformSettings ? [[key, platformSettings[key]]] : [],
    ),
  );
}

function agentGlobalState(agent: {
  name: string;
  platformSettings?: JsonRecord | undefined;
}): JsonRecord {
  return {
    name: agent.name,
    platformSettings: agentGlobalPlatformSettings(agent.platformSettings ?? {}),
  };
}

function agentVersionedState(agent: {
  conversationConfig: JsonRecord;
  platformSettings?: JsonRecord | undefined;
}): JsonRecord {
  const globalKeys = new Set<string>(GLOBAL_PLATFORM_SETTING_KEYS);
  return {
    conversationConfig: agent.conversationConfig,
    platformSettings: Object.fromEntries(
      Object.entries(agent.platformSettings ?? {}).filter(
        ([key]) => !globalKeys.has(key),
      ),
    ),
  };
}

function latestBranchVersion(
  branch: z.infer<typeof BranchSnapshotSchema>,
): string {
  const versions = [...(branch.mostRecentVersions ?? [])].sort(
    (left, right) => right.seqNoInBranch - left.seqNoInBranch,
  );
  const version = versions[0]?.id;
  if (!version) {
    throw new Error("ElevenLabs branch has no immutable version");
  }
  return version;
}

function providerTestName(key: string) {
  return `${TEST_NAME_PREFIX}${key}`;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function providerWireRecord(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/[A-Z]/gu, (character) => `_${character.toLowerCase()}`),
      Array.isArray(entry)
        ? (entry as unknown[]).map((item: unknown) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? providerWireRecord(item as JsonRecord)
              : item,
          )
        : entry && typeof entry === "object"
          ? providerWireRecord(entry as JsonRecord)
          : entry,
    ]),
  );
}
