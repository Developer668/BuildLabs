import { describe, expect, it } from "vitest";

import {
  initialBrowserVoiceState,
  reduceBrowserVoiceState,
  type BrowserVoiceEvent,
} from "../lib/browser-voice-state";
import {
  decodePcm16Base64,
  encodePcm16Base64,
  parseElevenLabsEvent,
  pcmSampleRate,
} from "../lib/browser-voice-transport";

function apply(events: BrowserVoiceEvent[]) {
  return events.reduce(reduceBrowserVoiceState, initialBrowserVoiceState);
}

describe("browser voice state", () => {
  it("models consent, connection, interruption, mute, reconnect, and completion", () => {
    const state = apply([
      { type: "start" },
      { type: "microphone_granted" },
      { type: "connected", reconnectAttempt: 0 },
      { type: "agent_audio" },
      { type: "interrupted" },
      { type: "mute" },
      { type: "unmute" },
      { type: "reconnecting", reconnectAttempt: 1 },
      { type: "connected", reconnectAttempt: 1 },
      { type: "complete" },
    ]);

    expect(state).toEqual({
      mode: "completed",
      reconnectAttempt: 0,
      interruptionCount: 0,
      failure: null,
    });
  });

  it("keeps the reconnect attempt visible while recovery is in progress", () => {
    const reconnecting = apply([
      { type: "start" },
      { type: "microphone_granted" },
      { type: "connected", reconnectAttempt: 0 },
      { type: "reconnecting", reconnectAttempt: 2 },
    ]);
    expect(reconnecting.mode).toBe("reconnecting");
    expect(reconnecting.reconnectAttempt).toBe(2);

    const unavailable = reduceBrowserVoiceState(reconnecting, {
      type: "unavailable",
      failure: "connection_failed",
    });
    expect(unavailable).toMatchObject({
      mode: "provider_unavailable",
      failure: "connection_failed",
      reconnectAttempt: 2,
    });
  });

  it("moves an active session to an explicit expiry state", () => {
    const state = apply([
      { type: "start" },
      { type: "microphone_granted" },
      { type: "connected", reconnectAttempt: 0 },
      { type: "expire" },
    ]);
    expect(state.mode).toBe("expired");
  });
});

describe("native ElevenLabs audio protocol", () => {
  it("resamples browser floats into little-endian PCM16 and decodes them", () => {
    const source = new Float32Array([-1, -0.5, 0, 0.5, 1]);
    const encoded = encodePcm16Base64(source, 16_000, 8_000);
    const decoded = decodePcm16Base64(encoded);

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toBeCloseTo(-1, 3);
    expect(decoded[1]).toBeCloseTo(0, 3);
  });

  it("accepts only explicit PCM formats and bounded JSON events", () => {
    expect(pcmSampleRate("pcm_16000")).toBe(16_000);
    expect(pcmSampleRate("ulaw_8000")).toBeNull();
    expect(
      parseElevenLabsEvent(
        JSON.stringify({
          type: "interruption",
          interruption_event: { reason: "user_speech" },
        }),
      ),
    ).toMatchObject({ type: "interruption" });
    expect(() => parseElevenLabsEvent("{")).toThrow();
    expect(() =>
      parseElevenLabsEvent(JSON.stringify({ event: "missing type" })),
    ).toThrow();
  });
});
