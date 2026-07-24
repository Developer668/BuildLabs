import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { FireworksModel } from "../src/adapters/fireworks/fireworks-model.js";
import { loadConfig } from "../src/config.js";
import { sha256 } from "../src/lib/canonical-json.js";
import type {
  AgentMessage,
  AgentToolDefinition,
  ModelRequestContext,
} from "../src/ports/index.js";
import { assignment } from "./fixtures.js";

describe("FireworksModel", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          }),
      ),
    );
    servers.length = 0;
  });

  it("uses trajectory affinity and preserves bounded Fireworks reasoning telemetry", async () => {
    let captured:
      | {
          body: Record<string, unknown>;
          headers: IncomingMessage["headers"];
        }
      | undefined;
    const handleRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        if (typeof chunk !== "string") {
          throw new Error("Expected a UTF-8 request body");
        }
        body += chunk;
      }
      captured = {
        body: JSON.parse(body) as Record<string, unknown>,
        headers: request.headers,
      };
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "chatcmpl-buildlabs",
          object: "chat.completion",
          created: 1,
          model: "accounts/fireworks/models/kimi-k2p6",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "private next-step reasoning",
                tool_calls: [
                  {
                    id: "call-write",
                    type: "function",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"index.ts","contents":"ok"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 1_200,
            completion_tokens: 80,
            total_tokens: 1_280,
            prompt_tokens_details: { cached_tokens: 900 },
          },
          perf_metrics: {
            "server-time-to-first-token": "0.25",
            "server-processing-time": 1.75,
            "ignored-unbounded-field": "not propagated",
          },
        }),
      );
    };
    const server = createServer((request, response) => {
      void handleRequest(request, response).catch(() => {
        response.writeHead(500).end();
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }

    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );
    const context: ModelRequestContext = {
      trajectoryId: "a".repeat(64),
      promptCacheIsolationKey: "b".repeat(64),
    };
    const messages: AgentMessage[] = [
      { role: "system", content: "Build the candidate." },
      { role: "user", content: "Start." },
      {
        role: "assistant",
        content: null,
        reasoningContent: "private prior reasoning",
        toolCalls: [
          {
            id: "call-read",
            name: "read_file",
            argumentsJson: '{"path":',
          },
        ],
      },
      { role: "tool", toolCallId: "call-read", content: '{"ok":true}' },
    ];
    const tools: AgentToolDefinition[] = [
      {
        name: "write_file",
        description: "Write a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];

    const turn = await model.complete(messages, tools, context);

    expect(captured?.headers["x-multi-turn-session-id"]).toBe(
      context.trajectoryId,
    );
    expect(captured?.headers["x-session-affinity"]).toBe(context.trajectoryId);
    expect(captured?.body).toMatchObject({
      model: "accounts/fireworks/models/glm-5p2",
      max_tokens: 8_192,
      reasoning_history: "interleaved",
      safe_tokenization: true,
      prompt_cache_key: context.trajectoryId,
      prompt_cache_isolation_key: context.promptCacheIsolationKey,
      perf_metrics_in_response: true,
    });
    expect(captured?.body.messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: null,
          reasoning_content: "private prior reasoning",
          tool_calls: [
            {
              id: "call-read",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{}",
              },
            },
          ],
        },
      ]),
    );
    expect(turn).toMatchObject({
      reasoningContent: "private next-step reasoning",
      usage: {
        promptTokens: 1_200,
        completionTokens: 80,
        totalTokens: 1_280,
        cachedPromptTokens: 900,
      },
      performance: {
        serverTimeToFirstTokenMs: 250,
        serverProcessingTimeMs: 1_750,
      },
    });
    expect(turn.performance).not.toHaveProperty("ignored-unbounded-field");
  });

  it("routes studio turns to the low-latency model with a bounded response", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        request.setEncoding("utf8");
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        capturedBody = JSON.parse(body) as Record<string, unknown>;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: "chatcmpl-studio",
            object: "chat.completion",
            created: 1,
            model: "accounts/fireworks/models/kimi-k2p6",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Ready." },
              },
            ],
          }),
        );
      })();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );

    await model.complete(
      [{ role: "user", content: "Summarize the candidate." }],
      [],
      {
        trajectoryId: "a".repeat(64),
        promptCacheIsolationKey: "b".repeat(64),
        modelRole: "studio",
      },
    );

    expect(capturedBody).toMatchObject({
      model: "accounts/fireworks/models/kimi-k2p6",
      max_tokens: 1_024,
      parallel_tool_calls: false,
    });
  });

  it("rejects non-opaque model request identifiers before sending", async () => {
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: "http://127.0.0.1:1/inference/v1",
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );

    await expect(
      model.complete([{ role: "user", content: "hello" }], [], {
        trajectoryId: "project-readable-id",
        promptCacheIsolationKey: "b".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("enables safe tokenization for untrusted contract evidence", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      void (async () => {
        request.setEncoding("utf8");
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        capturedBody = JSON.parse(body) as Record<string, unknown>;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: "chatcmpl-evaluation",
            object: "chat.completion",
            created: 1,
            model: "accounts/fireworks/models/kimi-k2p6",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "evaluation",
                      type: "function",
                      function: {
                        name: "submit_contract_evaluation",
                        arguments: JSON.stringify({
                          requirements: [],
                          unsupportedClaims: [],
                          summary: "Evidence remains unverified.",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      })();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );
    const contract = assignment("fireworks-safe-tokenization").contract;

    await model.evaluateContract({
      contract,
      revision: {
        sourceDigest: "a".repeat(64),
        commitSha: "b".repeat(40),
        frozenAt: "2026-07-23T12:00:00.000Z",
      },
      pages: [],
      sourceFiles: [],
      commandEvidence: [],
      availableEvidenceRefs: [],
      requiredEvidenceRefsByRequirement: {},
    });

    expect(capturedBody?.safe_tokenization).toBe(true);
    const messages = capturedBody?.messages as
      Array<{ role?: string; content?: string }> | undefined;
    const system = messages?.find((message) => message.role === "system");
    const user = messages?.find((message) => message.role === "user");
    expect(system?.content).toContain("untrusted quoted data");
    expect(user?.content).toContain("untrustedCandidateEvidence");
  });

  it("live-probes and caches chat/tool capabilities without undocumented model metadata", async () => {
    let capabilityRequests = 0;
    const capabilityBodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        request.setEncoding("utf8");
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        capabilityBodies.push(JSON.parse(body) as Record<string, unknown>);
        capabilityRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: "chatcmpl-health",
            object: "chat.completion",
            created: 1,
            model: "accounts/fireworks/models/kimi-k2p6",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call-readiness",
                      type: "function",
                      function: {
                        name: "buildlabs_readiness",
                        arguments: "{}",
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      })();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );

    await model.health();
    await model.health();

    expect(capabilityRequests).toBe(3);
    expect(capabilityBodies.map((body) => body.model)).toEqual([
      "accounts/fireworks/models/glm-5p2",
      "accounts/fireworks/models/kimi-k2p6",
      "accounts/fireworks/models/kimi-k2p6",
    ]);
    capabilityBodies.slice(0, 2).forEach((capabilityBody) => {
      expect(capabilityBody).toMatchObject({
        max_tokens: 64,
        parallel_tool_calls: false,
        reasoning_effort: "none",
        tool_choice: {
          type: "function",
          function: { name: "buildlabs_readiness" },
        },
        tools: [
          {
            type: "function",
            function: {
              name: "buildlabs_readiness",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
            },
          },
        ],
      });
    });
    expect(capabilityBodies[2]).toMatchObject({
      max_tokens: 512,
      parallel_tool_calls: false,
      reasoning_effort: "none",
      tool_choice: {
        type: "function",
        function: { name: "buildlabs_readiness" },
      },
    });
    const visionMessagesValue: unknown = capabilityBodies[2]?.messages;
    if (!Array.isArray(visionMessagesValue)) {
      throw new Error("Vision probe did not contain a user message");
    }
    const visionMessages = visionMessagesValue as unknown[];
    if (!isRecord(visionMessages[0])) {
      throw new Error("Vision probe did not contain a user message");
    }
    const visionContentValue: unknown = visionMessages[0].content;
    if (!Array.isArray(visionContentValue)) {
      throw new Error("Vision probe did not contain multimodal content");
    }
    const visionContent = visionContentValue as unknown[];
    const imagePart = visionContent.find(
      (part) => isRecord(part) && part.type === "image_url",
    );
    if (!isRecord(imagePart) || !isRecord(imagePart.image_url)) {
      throw new Error("Vision probe did not contain an image URL");
    }
    expect(imagePart.image_url.url).toEqual(
      expect.stringMatching(/^data:image\/png;base64,/),
    );
  });

  it("sends a bounded digest-bound vision request and rejects incomplete tool output", async () => {
    const bodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    const server = createServer((request, response) => {
      void (async () => {
        request.setEncoding("utf8");
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
        }
        bodies.push(JSON.parse(body) as Record<string, unknown>);
        const results =
          requestCount === 0
            ? [
                {
                  assetIndex: 0,
                  status: "MATCH",
                  matchedForbiddenClaimIndices: [0],
                },
              ]
            : [];
        requestCount += 1;
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            id: "chatcmpl-raster-claims",
            object: "chat.completion",
            created: 1,
            model: "accounts/fireworks/models/kimi-k2p6",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "raster-claims",
                      type: "function",
                      function: {
                        name: "submit_raster_claim_inspection",
                        arguments: JSON.stringify({ results }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      })();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const modelName = "accounts/fireworks/models/kimi-k2p6";
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        FIREWORKS_VISION_MODEL: modelName,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );
    const base64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imageDigest = sha256(Buffer.from(base64, "base64"));
    const input = {
      forbiddenClaims: ["24/7 emergency service"],
      approvedFacts: ["The business is named Mission Peak Electric."],
      assets: [
        {
          index: 0,
          sha256: imageDigest,
          imageSha256: imageDigest,
          mimeType: "image/png" as const,
          base64,
        },
      ],
    };

    await expect(model.inspectRasterClaims(input)).resolves.toEqual({
      modelDigest: sha256(modelName),
      results: [
        {
          assetIndex: 0,
          status: "MATCH",
          matchedForbiddenClaimIndices: [0],
        },
      ],
    });
    expect(bodies[0]?.model).toBe(modelName);
    expect(bodies[0]?.safe_tokenization).toBeUndefined();
    expect(bodies[0]?.parallel_tool_calls).toBe(false);
    expect(bodies[0]?.max_tokens).toBe(2_048);
    expect(bodies[0]?.reasoning_effort).toBe("none");
    expect(bodies[0]?.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_raster_claim_inspection" },
    });
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).toContain("24/7 emergency service");
    expect(serialized).toContain("Mission Peak Electric");
    expect(serialized).toContain(`data:image/png;base64,${base64}`);
    expect(serialized).toContain(imageDigest);

    await expect(model.inspectRasterClaims(input)).rejects.toMatchObject({
      name: "RasterClaimInspectionError",
      code: "MODEL_RESPONSE_INVALID",
    });
  });

  it("fails closed when the configured model does not execute the readiness tool", async () => {
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "accounts/fireworks/models/kimi-k2p6",
                object: "model",
                created: 1,
                owned_by: "fireworks",
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "chatcmpl-health",
          object: "chat.completion",
          created: 1,
          model: "accounts/fireworks/models/kimi-k2p6",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "OK" },
            },
          ],
        }),
      );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const model = new FireworksModel(
      loadConfig({
        NODE_ENV: "test",
        DAYTONA_API_KEY: "dtn_test_key_that_is_long_enough",
        FIREWORKS_API_KEY: "fw_test_key_that_is_long_enough",
        FIREWORKS_BASE_URL: `http://127.0.0.1:${address.port}/inference/v1`,
        BRAINTRUST_API_KEY: "bt_test_key_that_is_long_enough",
        CODERABBIT_AUTH_MODE: "oauth",
      }),
    );

    await expect(model.health()).rejects.toThrow(
      "did not execute the readiness tool",
    );
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
