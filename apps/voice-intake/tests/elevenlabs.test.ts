import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as receiveElevenLabsWebhook } from "../app/api/webhooks/elevenlabs/route";
import {
  cleanTranscript,
  formatVoiceTranscript,
  intakeEvaluationSucceeded,
  verifyElevenLabsWebhook,
} from "../lib/elevenlabs";
import {
  buildVoiceIntakeRequest,
  forwardVoiceIntake,
} from "../lib/orchestration";

afterEach(() => {
  delete process.env.BUILDLABS_ORCHESTRATION_URL;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  delete process.env.ORCHESTRATION_INTERNAL_TOKEN;
  vi.unstubAllGlobals();
});

describe("ElevenLabs intake normalization", () => {
  it("keeps only bounded customer and agent transcript turns", () => {
    expect(
      cleanTranscript([
        {
          role: "user",
          message: "  Build\u0000 a scheduling app.  ",
          time_in_call_secs: 4.6,
        },
        { role: "tool", message: "hidden tool output" },
        { role: "agent", message: "What should it include?" },
      ]),
    ).toEqual([
      {
        role: "user",
        message: "Build a scheduling app.",
        timeInCallSecs: 5,
      },
      {
        role: "agent",
        message: "What should it include?",
        timeInCallSecs: 0,
      },
    ]);
  });

  it("accepts the explicit intake completion criterion", () => {
    expect(
      intakeEvaluationSucceeded({
        analysis: {
          evaluation_criteria_results: {
            intake_complete: { result: "success" },
          },
        },
      }),
    ).toBe(true);
    expect(
      intakeEvaluationSucceeded({
        analysis: {
          evaluation_criteria_results_list: [
            { criteria_id: "intake_complete", result: "failure" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("bounds the orchestrator transcript by encoded byte size", () => {
    const content = formatVoiceTranscript(
      Array.from({ length: 1_000 }, () => ({
        role: "user" as const,
        message: "x".repeat(12_000),
      })),
    );
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
      1_000_000,
    );
    expect(content).toMatch(/^Customer: /);
  });

  it("builds an idempotent voice intake without asserting identity or consent", () => {
    expect(
      buildVoiceIntakeRequest({
        conversationId: "conv_buildlabs_12345",
        receivedAt: "2026-07-24T12:00:00.000Z",
        transcript: [
          { role: "user", message: "Build a scheduling app." },
          { role: "agent", message: "What should it include?" },
        ],
      }),
    ).toEqual({
      channel: "voice",
      intakeId: "elevenlabs:conv_buildlabs_12345",
      sourceId: "conv_buildlabs_12345",
      receivedAt: "2026-07-24T12:00:00.000Z",
      content:
        "Customer: Build a scheduling app.\n\nBuildLabs: What should it include?",
      emailVerified: false,
      researchConsent: false,
      provider: "elevenlabs",
    });
  });

  it("rejects invalid identifiers and empty transcripts", () => {
    expect(() =>
      buildVoiceIntakeRequest({
        conversationId: "not-a-conversation",
        receivedAt: "2026-07-24T12:00:00.000Z",
        transcript: [{ role: "user", message: "Build an app." }],
      }),
    ).toThrow("conversation ID");
    expect(() =>
      buildVoiceIntakeRequest({
        conversationId: "conv_buildlabs_12345",
        receivedAt: "2026-07-24T12:00:00.000Z",
        transcript: [],
      }),
    ).toThrow("no usable transcript");
  });

  it("validates the signed body and rejects tampering", async () => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = "test-webhook-secret";
    const body = JSON.stringify({ type: "post_call_transcription" });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(process.env.ELEVENLABS_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${body}`),
    );
    const signature = `t=${timestamp},v0=${Buffer.from(digest).toString("hex")}`;

    await expect(verifyElevenLabsWebhook(body, signature)).resolves.toBe(true);
    await expect(verifyElevenLabsWebhook(`${body} `, signature)).resolves.toBe(
      false,
    );
  });

  it("forwards only the normalized intake with server-held authorization", async () => {
    process.env.ORCHESTRATION_INTERNAL_TOKEN = "test-orchestration-token";
    process.env.BUILDLABS_ORCHESTRATION_URL =
      "https://orchestrator.example/internal";
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await forwardVoiceIntake({
      conversationId: "conv_buildlabs_12345",
      receivedAt: "2026-07-24T12:00:00.000Z",
      transcript: [{ role: "user", message: "Build a scheduling app." }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://orchestrator.example/v1/orchestration/intakes",
    );
    expect(options?.headers).toEqual({
      authorization: "Bearer test-orchestration-token",
      "content-type": "application/json",
      "idempotency-key": "elevenlabs:conv_buildlabs_12345",
    });
    expect(JSON.parse(String(options?.body))).toMatchObject({
      emailVerified: false,
      researchConsent: false,
      provider: "elevenlabs",
    });
  });

  it("does not send the internal token over insecure non-loopback HTTP", async () => {
    process.env.ORCHESTRATION_INTERNAL_TOKEN = "test-orchestration-token";
    process.env.BUILDLABS_ORCHESTRATION_URL =
      "http://orchestrator.example/internal";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forwardVoiceIntake({
        conversationId: "conv_buildlabs_12345",
        receivedAt: "2026-07-24T12:00:00.000Z",
        transcript: [{ role: "user", message: "Build a scheduling app." }],
      }),
    ).rejects.toThrow("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed webhook without trusting Content-Length", async () => {
    const response = await receiveElevenLabsWebhook(
      new Request("http://localhost/api/webhooks/elevenlabs", {
        method: "POST",
        body: "x".repeat(1_000_001),
      }),
    );

    expect(response.status).toBe(413);
  });
});
