import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FireworksResponsesCapabilityProbe,
  FireworksResponsesClient,
  createFireworksPromptCacheKey,
  type FireworksResponseInput,
  type FireworksResponseTool,
} from "../src/adapters/fireworks/fireworks-responses.js";
import {
  FireworksCapabilityRouter,
  type ActiveCapabilityProbe,
  type FireworksCatalogModel,
  type FireworksCatalogSnapshot,
  type FireworksCatalogSource,
  type FireworksModelPin,
} from "../src/adapters/fireworks/model-router.js";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.js";

const GLM = "accounts/fireworks/models/glm-5p2";
const KIMI = "accounts/fireworks/models/kimi-k2p6";

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
): FireworksCatalogSnapshot {
  const inferenceModelIds = models.map(({ name }) => name);
  return {
    models,
    inferenceModelIds,
    digest: sha256(canonicalJson({ models, inferenceModelIds })),
  };
}

function routerFor(
  models: readonly FireworksCatalogModel[] = [catalogModel(GLM)],
): FireworksCapabilityRouter {
  const source: FireworksCatalogSource = {
    load: () => Promise.resolve(snapshot(models)),
  };
  const probe: ActiveCapabilityProbe = {
    probe: (modelId, requirements) =>
      Promise.resolve({
        returnedModelId: modelId,
        tools: true,
        reasoning: requirements.reasoning,
        structuredOutput: true,
        vision: requirements.vision,
      }),
  };
  return new FireworksCapabilityRouter(source, probe);
}

function completedEnvelope(
  model: string,
  output: readonly unknown[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: null,
    object: "response",
    previous_response_id: null,
    store: false,
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: 30,
      output_tokens: 7,
      total_tokens: 37,
      input_tokens_details: { cached_tokens: 20 },
    },
    ...overrides,
  };
}

function message(text: string): Record<string, unknown> {
  return {
    id: "message-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function echoedUserMessage(text: string): Record<string, unknown> {
  return {
    id: "echoed-user-1",
    type: "message",
    role: "user",
    status: "completed",
    content: [{ type: "input_text", text }],
  };
}

function reasoningItem(
  text: string,
  id = "reasoning-1",
): Record<string, unknown> {
  return {
    id,
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
  };
}

function functionCall(
  name: string,
  argumentsJson: string,
  id = "call-1",
): Record<string, unknown> {
  return {
    id: `item-${id}`,
    type: "function_call",
    call_id: id,
    name,
    arguments: argumentsJson,
    status: "completed",
  };
}

function chatToolCall(
  argumentsJson = '{"answer":42}',
): Record<string, unknown> {
  return {
    id: "reasoning-call-1",
    type: "function",
    function: {
      name: "buildlabs_reasoning_probe",
      arguments: argumentsJson,
    },
  };
}

function chatCompletion(
  model: string,
  reasoningContent: string | null,
  toolCalls: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content: toolCalls.length === 0 ? "ready" : null,
          reasoning_content: reasoningContent,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
      },
    ],
  };
}

function sseResponse(
  events: readonly Readonly<Record<string, unknown>>[],
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", ...headers },
  });
}

function terminalStream(
  response: Readonly<Record<string, unknown>>,
  preceding: readonly Readonly<Record<string, unknown>>[] = [],
  headers?: Readonly<Record<string, string>>,
): Response {
  return sseResponse(
    [
      ...preceding,
      {
        type: "response.completed",
        sequence_number: preceding.length,
        response,
      },
    ],
    headers,
  );
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : input;
}

const readFileTool: FireworksResponseTool = {
  name: "read_file",
  description: "Read one repository file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  argumentsValidator: z.object({ path: z.string().min(1) }).strict(),
};

const writeFileTool: FireworksResponseTool = {
  name: "write_file",
  description: "Write one repository file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  argumentsValidator: z
    .object({ path: z.string().min(1), content: z.string() })
    .strict(),
};

async function builderPin(
  router: FireworksCapabilityRouter,
  trajectoryId = "a".repeat(64),
): Promise<FireworksModelPin> {
  return router.route("builder", trajectoryId);
}

describe("Fireworks Responses capability probe", () => {
  it("uses only documented non-stored Responses fields", async () => {
    const responseBodies: Record<string, unknown>[] = [];
    const chatBodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const url = requestUrl(input);
      if (url.endsWith("/chat/completions")) {
        chatBodies.push(body);
        return Promise.resolve(
          Response.json(
            chatBodies.length === 1
              ? chatCompletion(GLM, "bounded first-turn reasoning", [
                  chatToolCall(),
                ])
              : chatCompletion(GLM, "bounded interleaved reasoning"),
          ),
        );
      }
      responseBodies.push(body);
      if (responseBodies.length === 1) {
        return Promise.resolve(
          Response.json(
            completedEnvelope(
              GLM,
              [
                echoedUserMessage("Use the required capability probe tool."),
                functionCall("buildlabs_capability_probe", "{}"),
              ],
              {
                id: "opaque-unpersisted-response-id",
                reasoning: {},
              },
            ),
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          completedEnvelope(
            GLM,
            [
              echoedUserMessage("Return ready=true."),
              message('{"ready":true}'),
            ],
            { id: "opaque-unpersisted-structured-response-id" },
          ),
        ),
      );
    };
    const probe = new FireworksResponsesCapabilityProbe({
      apiKey: "test",
      baseUrl: "https://fireworks.test/inference/v1",
      fetchImpl,
    });

    await expect(
      probe.probe(GLM, {
        minimumContextLength: 262_144,
        minimumTrainingContextLength: 0,
        tools: true,
        reasoning: true,
        structuredOutput: true,
        vision: false,
        training: false,
      }),
    ).resolves.toMatchObject({
      returnedModelId: GLM,
      tools: true,
      reasoning: true,
      structuredOutput: true,
      vision: false,
    });

    expect(responseBodies).toHaveLength(2);
    expect(chatBodies).toHaveLength(2);
    expect(responseBodies[0]?.tool_choice).toBe("required");
    expect(responseBodies[0]?.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "buildlabs_capability_probe",
      }),
    ]);
    for (const body of responseBodies) {
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("previous_response_id");
      expect(body).not.toHaveProperty("service_tier");
      expect(body).not.toHaveProperty("reasoning_history");
      expect(body).not.toHaveProperty("safe_tokenization");
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(body).not.toHaveProperty("performance_metrics");
    }
    expect(chatBodies[0]).toMatchObject({
      model: GLM,
      tool_choice: "required",
      parallel_tool_calls: false,
      max_completion_tokens: 256,
    });
    expect(chatBodies[1]).toMatchObject({
      model: GLM,
      tool_choice: "none",
      parallel_tool_calls: false,
    });
    expect(chatBodies[1]).not.toHaveProperty("store");
    expect(
      (chatBodies[1]?.messages as readonly Record<string, unknown>[])?.[2],
    ).toMatchObject({
      role: "assistant",
      reasoning_content: "bounded first-turn reasoning",
    });
  });

  it("rejects missing reasoning evidence and ignored image order", async () => {
    const missingReasoning = new FireworksResponsesCapabilityProbe({
      apiKey: "test",
      fetchImpl: (input) =>
        Promise.resolve(
          Response.json(
            requestUrl(input).endsWith("/chat/completions")
              ? chatCompletion(GLM, "", [chatToolCall()])
              : completedEnvelope(GLM, [
                  functionCall("buildlabs_capability_probe", "{}"),
                ]),
          ),
        ),
    });
    await expect(
      missingReasoning.probe(GLM, {
        minimumContextLength: 262_144,
        minimumTrainingContextLength: 0,
        tools: true,
        reasoning: true,
        structuredOutput: true,
        vision: false,
        training: false,
      }),
    ).rejects.toMatchObject({ code: "capability_mismatch" });

    const ignoredVision = new FireworksResponsesCapabilityProbe({
      apiKey: "test",
      fetchImpl: () =>
        Promise.resolve(
          Response.json(
            completedEnvelope(
              KIMI,
              [
                functionCall(
                  "buildlabs_capability_probe",
                  '{"first":"blue","second":"red"}',
                ),
              ],
              { reasoning: { content: "bounded probe" } },
            ),
          ),
        ),
    });
    await expect(
      ignoredVision.probe(KIMI, {
        minimumContextLength: 131_072,
        minimumTrainingContextLength: 0,
        tools: true,
        reasoning: false,
        structuredOutput: true,
        vision: true,
        training: false,
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it("rejects a silent Chat reasoning-probe fallback", async () => {
    const probe = new FireworksResponsesCapabilityProbe({
      apiKey: "test",
      fetchImpl: () =>
        Promise.resolve(
          Response.json(
            chatCompletion(KIMI, "bounded reasoning", [chatToolCall()]),
          ),
        ),
    });

    await expect(
      probe.probe(GLM, {
        minimumContextLength: 262_144,
        minimumTrainingContextLength: 0,
        tools: true,
        reasoning: true,
        structuredOutput: true,
        vision: false,
        training: false,
      }),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
  });

  it("rejects provider conversation state", async () => {
    for (const storedState of [
      { previous_response_id: "resp-previous" },
      { store: true },
    ]) {
      const probe = new FireworksResponsesCapabilityProbe({
        apiKey: "test",
        fetchImpl: () =>
          Promise.resolve(
            Response.json({
              ...completedEnvelope(GLM, []),
              ...storedState,
            }),
          ),
      });

      await expect(
        probe.probe(GLM, {
          minimumContextLength: 262_144,
          minimumTrainingContextLength: 0,
          tools: true,
          reasoning: false,
          structuredOutput: true,
          vision: false,
          training: false,
        }),
      ).rejects.toMatchObject({ code: "stored_state" });
    }
  });
});

describe("Fireworks Responses inference", () => {
  it("streams bounded tools with transient reasoning and safe metrics", async () => {
    const router = routerFor();
    const pin = await builderPin(router);
    const priorReasoning = {
      id: "reasoning-read-1",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "Inspect the current file first." },
      ],
    } as const;
    const input: readonly FireworksResponseInput[] = [
      { role: "system", content: "Apply the smallest verified patch." },
      {
        role: "assistant",
        content: null,
        transientReasoningItems: [priorReasoning],
        toolCalls: [
          {
            id: "read-1",
            name: "read_file",
            argumentsJson: '{"path":"src/a.ts"}',
          },
        ],
      },
      { role: "tool", toolCallId: "read-1", content: "export const a = 1;" },
      { role: "user", content: "Finish the requested change." },
    ];
    const tools = [readFileTool, writeFileTool] as const;
    const terminalCall = functionCall(
      "write_file",
      '{"path":"src/a.ts","content":"export const a = 2;"}',
      "write-1",
    );
    const outputReasoning = reasoningItem(
      "Apply the smallest bounded edit.",
      "reasoning-write-1",
    );
    const terminal = completedEnvelope(
      GLM,
      [outputReasoning, message("Done."), terminalCall],
      {
        id: "opaque-unpersisted-stream-response-id",
        reasoning: {},
      },
    );
    const requests: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const client = new FireworksResponsesClient(router, {
      apiKey: "test",
      now: (() => {
        let now = 100;
        return () => (now += 5);
      })(),
      fetchImpl: (_request, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        requests.push(JSON.parse(init.body) as Record<string, unknown>);
        headers.push(new Headers(init?.headers));
        return Promise.resolve(
          terminalStream(
            terminal,
            [
              {
                type: "response.reasoning_text.delta",
                sequence_number: 0,
                delta: "private",
              },
              {
                type: "response.output_text.delta",
                sequence_number: 1,
                delta: "Done.",
              },
              {
                type: "response.output_item.done",
                sequence_number: 2,
                item: terminalCall,
              },
            ],
            {
              "fireworks-prompt-tokens": "30",
              "fireworks-cached-prompt-tokens": "20",
            },
          ),
        );
      },
    });

    const result = await client.create({
      pin,
      trajectoryId: pin.trajectoryId,
      promptCacheKey: createFireworksPromptCacheKey(input, tools),
      promptCacheIsolationKey: pin.cacheIsolationKey,
      input,
      tools,
      maxParallelTools: 2,
    });

    expect(result.text).toBe("Done.");
    expect(result.transientReasoning).toEqual([outputReasoning]);
    expect(result.transientReasoningItems).toEqual([outputReasoning]);
    expect(result.toolCalls).toEqual([
      {
        id: "write-1",
        name: "write_file",
        arguments: {
          path: "src/a.ts",
          content: "export const a = 2;",
        },
        argumentsJson: '{"path":"src/a.ts","content":"export const a = 2;"}',
      },
    ]);
    expect(result.metrics).toMatchObject({
      inputTokens: 30,
      outputTokens: 7,
      totalTokens: 37,
      cachedInputTokens: 20,
      toolCallCount: 1,
      timeToFirstTokenMs: 5,
    });
    expect(requests[0]).toMatchObject({
      model: GLM,
      store: false,
      stream: true,
      reasoning: {},
      parallel_tool_calls: true,
      max_tool_calls: 2,
    });
    expect(requests[0]).not.toHaveProperty("service_tier");
    expect(requests[0]).not.toHaveProperty("reasoning_history");
    expect(requests[0]).not.toHaveProperty("prompt_cache_key");
    expect(requests[0]?.input).toContainEqual({
      id: "reasoning-read-1",
      type: "reasoning",
      summary: [
        { type: "summary_text", text: "Inspect the current file first." },
      ],
    });
    expect(requests[0]?.input).toContainEqual({
      type: "tool_output",
      tool_call_id: "read-1",
      output: "export const a = 1;",
    });
    expect(headers[0]?.get("x-multi-turn-session-id")).toBe(pin.trajectoryId);
    expect(headers[0]?.get("x-prompt-cache-isolation-key")).toBe(
      pin.cacheIsolationKey,
    );
  });

  it("validates structured output only on a non-reasoning pin", async () => {
    const router = routerFor([
      catalogModel(KIMI, {
        supportsImageInput: true,
        supportsSupervisedTraining: true,
        supportsReinforcementTraining: true,
      }),
    ]);
    const pin = await router.route("voice", "c".repeat(64));
    const input: readonly FireworksResponseInput[] = [
      { role: "system", content: "Return only the requested JSON." },
      { role: "user", content: "Is the intake ready?" },
    ];
    const client = new FireworksResponsesClient(router, {
      apiKey: "test",
      fetchImpl: () =>
        Promise.resolve(
          terminalStream(completedEnvelope(KIMI, [message('{"ready":true}')]), [
            {
              type: "response.output_text.delta",
              sequence_number: 0,
              delta: '{"ready":true}',
            },
          ]),
        ),
    });

    await expect(
      client.create(
        {
          pin,
          trajectoryId: pin.trajectoryId,
          promptCacheKey: createFireworksPromptCacheKey(input),
          promptCacheIsolationKey: pin.cacheIsolationKey,
          input,
          responseJsonSchema: {
            name: "voice_ready",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { ready: { type: "boolean" } },
              required: ["ready"],
            },
          },
        },
        z.object({ ready: z.literal(true) }).strict(),
      ),
    ).resolves.toMatchObject({ structured: { ready: true } });
  });

  it("rejects malformed or excessive transient reasoning before fetch", async () => {
    const router = routerFor();
    const pin = await builderPin(router);
    let fetches = 0;
    const client = new FireworksResponsesClient(router, {
      apiKey: "test",
      fetchImpl: () => {
        fetches += 1;
        return Promise.reject(new Error("Unexpected provider call"));
      },
    });
    const invalidReasoning: readonly unknown[][] = [
      [{ id: "reasoning-empty", type: "reasoning", summary: [] }],
      [
        {
          id: "reasoning-extra",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "bounded" }],
          raw_content: "not allowlisted",
        },
      ],
      Array.from({ length: 9 }, (_, index) => ({
        id: `reasoning-${index}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: "bounded" }],
      })),
    ];

    for (const transientReasoningItems of invalidReasoning) {
      const input = [
        { role: "system", content: "Use only transient provider reasoning." },
        {
          role: "assistant",
          content: null,
          transientReasoningItems,
        },
      ] as unknown as readonly FireworksResponseInput[];
      await expect(
        client.create({
          pin,
          trajectoryId: pin.trajectoryId,
          promptCacheKey: createFireworksPromptCacheKey(input),
          promptCacheIsolationKey: pin.cacheIsolationKey,
          input,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(fetches).toBe(0);
  });

  it("rejects malformed and undeclared provider tool calls", async () => {
    for (const call of [
      functionCall("read_file", "{}"),
      functionCall("undeclared", '{"path":"src/a.ts"}'),
    ]) {
      const router = routerFor();
      const pin = await builderPin(router, sha256(canonicalJson(call)));
      const input: readonly FireworksResponseInput[] = [
        { role: "system", content: "Use the bounded repository tool." },
        { role: "user", content: "Read the file." },
      ];
      const client = new FireworksResponsesClient(router, {
        apiKey: "test",
        fetchImpl: () =>
          Promise.resolve(
            terminalStream(
              completedEnvelope(GLM, [call], {
                reasoning: { content: "bounded probe" },
              }),
            ),
          ),
      });

      await expect(
        client.create({
          pin,
          trajectoryId: pin.trajectoryId,
          promptCacheKey: createFireworksPromptCacheKey(input, [readFileTool]),
          promptCacheIsolationKey: pin.cacheIsolationKey,
          input,
          tools: [readFileTool],
        }),
      ).rejects.toMatchObject({ code: "malformed_tool" });
    }
  });

  it("rejects forged pins and stored terminal state", async () => {
    const router = routerFor();
    const pin = await builderPin(router);
    const input: readonly FireworksResponseInput[] = [
      { role: "system", content: "Return a concise answer." },
      { role: "user", content: "Continue." },
    ];
    const client = new FireworksResponsesClient(router, {
      apiKey: "test",
      fetchImpl: () =>
        Promise.resolve(
          terminalStream({
            ...completedEnvelope(GLM, [message("Done.")], {
              reasoning: { content: "bounded" },
            }),
            store: true,
          }),
        ),
    });
    const request = {
      pin,
      trajectoryId: pin.trajectoryId,
      promptCacheKey: createFireworksPromptCacheKey(input),
      promptCacheIsolationKey: pin.cacheIsolationKey,
      input,
    } as const;

    await expect(
      client.create({
        ...request,
        pin: { ...pin, serviceTier: "priority" },
      }),
    ).rejects.toThrow("does not match");
    await expect(client.create(request)).rejects.toMatchObject({
      code: "stored_state",
    });
  });

  it("rejects cache-isolation drift and unsupported output content", async () => {
    const router = routerFor();
    const pin = await builderPin(router);
    const input: readonly FireworksResponseInput[] = [
      { role: "system", content: "Return a concise answer." },
      { role: "user", content: "Continue." },
    ];
    let fetches = 0;
    const client = new FireworksResponsesClient(router, {
      apiKey: "test",
      fetchImpl: () => {
        fetches += 1;
        return Promise.resolve(
          terminalStream(
            completedEnvelope(
              GLM,
              [
                {
                  id: "message-1",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "refusal", refusal: "No." }],
                },
              ],
              { reasoning: { content: "bounded" } },
            ),
            [],
          ),
        );
      },
    });
    const request = {
      pin,
      trajectoryId: pin.trajectoryId,
      promptCacheKey: createFireworksPromptCacheKey(input),
      promptCacheIsolationKey: pin.cacheIsolationKey,
      input,
    } as const;

    await expect(
      client.create({
        ...request,
        promptCacheIsolationKey: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetches).toBe(0);
    await expect(client.create(request)).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("rejects stream sequence, terminal text, and usage inconsistencies", async () => {
    const cases = [
      terminalStream(
        completedEnvelope(GLM, [message("Done.")], {
          reasoning: { content: "bounded" },
        }),
        [
          {
            type: "response.output_text.delta",
            sequence_number: 0,
            delta: "Done.",
          },
          {
            type: "response.reasoning_text.delta",
            sequence_number: 0,
            delta: "bounded",
          },
        ],
      ),
      terminalStream(
        completedEnvelope(GLM, [message("Terminal.")], {
          reasoning: { content: "bounded" },
        }),
        [
          {
            type: "response.output_text.delta",
            sequence_number: 0,
            delta: "Streamed.",
          },
        ],
      ),
      terminalStream(
        completedEnvelope(GLM, [message("Done.")], {
          reasoning: { content: "bounded" },
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            total_tokens: 3,
          },
        }),
        [
          {
            type: "response.output_text.delta",
            sequence_number: 0,
            delta: "Done.",
          },
        ],
      ),
    ];

    for (const [index, response] of cases.entries()) {
      const router = routerFor();
      const pin = await builderPin(router, String(index + 7).repeat(64));
      const input: readonly FireworksResponseInput[] = [
        { role: "system", content: "Return a concise answer." },
        { role: "user", content: "Continue." },
      ];
      const client = new FireworksResponsesClient(router, {
        apiKey: "test",
        fetchImpl: () => Promise.resolve(response.clone()),
      });
      await expect(
        client.create({
          pin,
          trajectoryId: pin.trajectoryId,
          promptCacheKey: createFireworksPromptCacheKey(input),
          promptCacheIsolationKey: pin.cacheIsolationKey,
          input,
        }),
      ).rejects.toMatchObject({
        code: index === 2 ? "provider_error" : "malformed_stream",
      });
    }
  });
});
