import { describe, expect, it } from "vitest";

import {
  FireworksRolloutTraceClient,
  createFireworksRolloutId,
  type FireworksRolloutInitCorrelation,
  type FireworksRolloutMetrics,
  type FireworksRolloutTraceTransport,
} from "../src/adapters/fireworks/fireworks-rollout-trace.js";

const ROLLOUT_ID = "a".repeat(64);

function correlation(
  overrides: Partial<FireworksRolloutInitCorrelation["metadata"]> = {},
): FireworksRolloutInitCorrelation {
  const metadata = {
    invocation_id: "invocation-01",
    experiment_id: "experiment-01",
    rollout_id: ROLLOUT_ID,
    run_id: "run-01",
    row_id: "row-01",
    ...overrides,
  };
  return {
    model_base_url:
      "https://tracing.fireworks.ai" +
      `/rollout_id/${metadata.rollout_id}` +
      `/invocation_id/${metadata.invocation_id}` +
      `/experiment_id/${metadata.experiment_id}` +
      `/run_id/${metadata.run_id}` +
      `/row_id/${metadata.row_id}`,
    metadata,
  };
}

function metrics(
  overrides: Partial<FireworksRolloutMetrics> = {},
): FireworksRolloutMetrics {
  return {
    modelDigest: "b".repeat(64),
    datasetDigest: "c".repeat(64),
    policyDigest: "d".repeat(64),
    capabilitySnapshotDigest: "e".repeat(64),
    inputTokenCount: 100,
    outputTokenCount: 20,
    toolCallCount: 1,
    retryCount: 0,
    durationMs: 500,
    ...overrides,
  };
}

function capturingTransport(statuses: number[] = []): {
  transport: FireworksRolloutTraceTransport;
  requests: Parameters<FireworksRolloutTraceTransport["post"]>[0][];
} {
  const requests: Parameters<FireworksRolloutTraceTransport["post"]>[0][] = [];
  return {
    requests,
    transport: {
      post(input) {
        requests.push(input);
        return Promise.resolve({ status: statuses.shift() ?? 202 });
      },
    },
  };
}

describe("Fireworks rollout tracing", () => {
  it("emits acknowledged running heartbeats and a bounded finish event", async () => {
    let now = 1_000;
    const { transport, requests } = capturingTransport();
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
      now: () => now,
    });

    await session.start(metrics());
    now += 1_000;
    await session.heartbeat(metrics({ durationMs: 1_500 }));
    now += 1_000;
    const receipt = await session.finish(metrics({ durationMs: 2_500 }), 0.9);

    expect(receipt.event).toBe("rollout_finished");
    expect(requests).toHaveLength(3);
    const payloads = requests.map(
      ({ body }) =>
        JSON.parse(body) as {
          status: { code: number; message: string; details: unknown[] };
          message: string;
          extras: Record<string, unknown>;
        },
    );
    expect(payloads.map(({ status }) => status.code)).toEqual([101, 101, 100]);
    expect(payloads[2]?.status).toEqual({
      code: 100,
      message: "Rollout finished",
      details: [],
    });
    expect(payloads.map(({ message }) => message)).toEqual([
      "rollout_started",
      "rollout_heartbeat",
      "rollout_finished",
    ]);
    expect(payloads[2]?.extras).toEqual(
      expect.objectContaining({ reward: 0.9 }),
    );
    expect(requests[0]?.headers.Authorization).toBe("Bearer fireworks-secret");
  });

  it("fails closed when no acknowledged heartbeat exists or it is stale", async () => {
    let now = 1_000;
    const { transport, requests } = capturingTransport();
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const session = client.createSession({
      correlation: correlation(),
      phase: "evaluation",
      heartbeatTimeoutMs: 1_000,
      now: () => now,
    });
    await session.start(metrics());
    await expect(session.finish(metrics(), 1)).rejects.toThrow(
      /no acknowledged heartbeat/u,
    );
    await session.heartbeat(metrics());
    now += 1_001;
    await expect(session.finish(metrics(), 1)).rejects.toThrow(
      /heartbeat deadline was missed/u,
    );
    expect(requests).toHaveLength(2);
  });

  it("does not count an unacknowledged heartbeat", async () => {
    const { transport } = capturingTransport([202, 503]);
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
    });
    await session.start(metrics());
    await expect(session.heartbeat(metrics())).rejects.toThrow(
      /not acknowledged/u,
    );
    expect(() => session.assertHeartbeatFresh()).toThrow(
      /no acknowledged heartbeat/u,
    );
  });

  it("uses the documented fallback endpoint only for an absent primary route", async () => {
    const { transport, requests } = capturingTransport([404, 202]);
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
    });
    const receipt = await session.start(metrics());
    expect(receipt.endpoint).toBe("v1-logs");
    expect(requests.map(({ url }) => url)).toEqual([
      "https://tracing.fireworks.ai/logs",
      "https://tracing.fireworks.ai/v1/logs",
    ]);
  });

  it("rejects arbitrary trace fields and out-of-range rewards", async () => {
    const { transport, requests } = capturingTransport();
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    await expect(
      client.post(correlation(), "rollout_started", {
        schemaVersion: 1,
        event: "rollout_started",
        sequence: 1,
        phase: "training",
        metrics: {
          ...metrics(),
          rawPrompt: "customer@example.com",
        },
      } as never),
    ).rejects.toThrow();

    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
    });
    await session.start(metrics());
    await session.heartbeat(metrics());
    await expect(session.finish(metrics(), 1.01)).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("records only an allowlisted error code and makes ids opaque", async () => {
    const { transport, requests } = capturingTransport();
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
    });
    await session.start(metrics());
    await session.fail(metrics(), "provider_unavailable");
    const payload = JSON.parse(requests[1]!.body) as {
      status: { code: number; message: string; details: unknown[] };
      extras: Record<string, unknown>;
    };
    expect(payload.status).toEqual({
      code: 14,
      message: "Rollout failed",
      details: [],
    });
    expect(payload.extras).toEqual(
      expect.objectContaining({ errorCode: "provider_unavailable" }),
    );
    expect(payload.extras).not.toHaveProperty("error");
    expect(createFireworksRolloutId()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires exact trainer-provided model-base correlation", () => {
    const { transport } = capturingTransport();
    const client = new FireworksRolloutTraceClient({
      apiKey: "fireworks-secret",
      transport,
    });
    const mismatched = correlation();
    mismatched.model_base_url = mismatched.model_base_url.replace(
      `/rollout_id/${ROLLOUT_ID}`,
      "/rollout_id/different-rollout",
    );
    expect(() =>
      client.createSession({
        correlation: mismatched,
        phase: "training",
        heartbeatTimeoutMs: 5_000,
      }),
    ).toThrow(/does not bind rollout_id/u);

    const session = client.createSession({
      correlation: correlation(),
      phase: "training",
      heartbeatTimeoutMs: 5_000,
    });
    expect(session.modelBaseUrl).toContain(`/rollout_id/${ROLLOUT_ID}`);
  });
});
