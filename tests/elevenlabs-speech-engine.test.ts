import { createServer } from "node:http";

import type {
  SpeechEngineCallbacks,
  SpeechEngineSession,
} from "@elevenlabs/elevenlabs-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioSubagent } from "../src/application/studio-subagent.js";
import type { AppConfig } from "../src/config.js";
import {
  ELEVENLABS_SPEECH_ENGINE_PATH,
  ElevenLabsSpeechEngine,
  type ElevenLabsSpeechEngineClient,
} from "../src/adapters/elevenlabs/elevenlabs-speech-engine.js";

const CONFIG = {
  ELEVENLABS_API_KEY: "elevenlabs-test-key-000000000",
  ELEVENLABS_SPEECH_ENGINE_ID: "seng_test",
} as AppConfig;

afterEach(() => {
  vi.useRealTimers();
});

describe("ElevenLabsSpeechEngine", () => {
  it("mints a bounded WebRTC token for the configured Speech Engine", async () => {
    const fixture = createFixture();

    await expect(fixture.engine.createWebRtcToken()).resolves.toEqual({
      token: "webrtc-test",
    });
    expect(fixture.getWebrtcToken).toHaveBeenCalledWith(
      { agentId: "seng_test" },
      { timeoutInSeconds: 20 },
    );
  });

  it("suppresses a stale response after the turn is interrupted", async () => {
    const pendingResponse = deferred<string>();
    const respond = vi.fn(() => pendingResponse.promise);
    const fixture = createFixture({ respond });
    const session = fakeSession();
    const controller = new AbortController();

    fixture.callbacks.onInit?.("conversation-1", session.value);
    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Show the first candidate." }],
      controller.signal,
      session.value,
    );
    controller.abort();
    pendingResponse.resolve("This response belongs to the interrupted turn.");

    await nextEventLoopTurn();
    expect(respond).toHaveBeenCalledOnce();
    expect(session.sendResponse).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "close"] as const)(
    "aborts an active response when its session receives %s",
    async (event) => {
      let turnSignal: AbortSignal | undefined;
      const respond = vi.fn<StudioSubagent["respond"]>(
        (_transcript, _conversationId, signal) => {
          turnSignal = signal;
          return new Promise<string>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => resolve("This response belongs to a closed session."),
              { once: true },
            );
          });
        },
      );
      const fixture = createFixture({ respond });
      const session = fakeSession();

      fixture.callbacks.onTranscript?.(
        [{ role: "user", content: "Read the candidate." }],
        new AbortController().signal,
        session.value,
      );
      await vi.waitFor(() => {
        expect(turnSignal).toBeDefined();
      });
      if (event === "disconnect") {
        fixture.callbacks.onDisconnect?.(session.value);
      } else {
        fixture.callbacks.onClose?.(session.value);
      }
      await nextEventLoopTurn();

      expect(turnSignal?.aborted).toBe(true);
      expect(session.sendResponse).not.toHaveBeenCalled();
    },
  );

  it("aborts a superseded response before sending the replacement", async () => {
    let firstTurnSignal: AbortSignal | undefined;
    let turn = 0;
    const respond = vi.fn<StudioSubagent["respond"]>(
      (_transcript, _conversationId, signal) => {
        turn += 1;
        if (turn === 1) {
          firstTurnSignal = signal;
          return new Promise<string>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => resolve("This response was superseded."),
              { once: true },
            );
          });
        }
        return Promise.resolve("This is the current response.");
      },
    );
    const fixture = createFixture({ respond });
    const session = fakeSession();
    const providerSignal = new AbortController().signal;

    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read the old state." }],
      providerSignal,
      session.value,
    );
    await vi.waitFor(() => {
      expect(firstTurnSignal).toBeDefined();
    });
    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read the latest state." }],
      providerSignal,
      session.value,
    );
    await vi.waitFor(() => {
      expect(session.sendResponse).toHaveBeenCalledOnce();
    });

    expect(firstTurnSignal?.aborted).toBe(true);
    expect(session.sendResponse).toHaveBeenCalledWith(
      "This is the current response.",
    );
  });

  it("sends the bounded fallback only while the turn is still active", async () => {
    const fixture = createFixture({
      respond: vi.fn().mockRejectedValue(new Error("build was not found")),
    });
    const session = fakeSession();

    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read that build." }],
      new AbortController().signal,
      session.value,
    );
    await vi.waitFor(() => {
      expect(session.sendResponse).toHaveBeenCalledOnce();
    });

    expect(session.sendResponse).toHaveBeenCalledWith(
      "I could not find that build run. Please check the run ID.",
    );
  });

  it("isolates sessions that have not received a provider conversation ID", async () => {
    const conversationIds: string[] = [];
    const respond = vi.fn<StudioSubagent["respond"]>(
      (_transcript, conversationId) => {
        conversationIds.push(conversationId);
        return Promise.resolve("Acknowledged.");
      },
    );
    const fixture = createFixture({ respond });
    const first = fakeSession({ conversationId: undefined });
    const second = fakeSession({ conversationId: undefined });
    const signal = new AbortController().signal;

    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read candidate one." }],
      signal,
      first.value,
    );
    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read candidate one again." }],
      signal,
      first.value,
    );
    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read candidate two." }],
      signal,
      second.value,
    );
    await vi.waitFor(() => {
      expect(conversationIds).toHaveLength(3);
    });

    expect(conversationIds[0]).toMatch(/^speech-session:[0-9a-f-]{36}$/u);
    expect(conversationIds[1]).toBe(conversationIds[0]);
    expect(conversationIds[2]).not.toBe(conversationIds[0]);
  });

  it("registers a bounded non-throwing error handler", async () => {
    const reports: string[] = [];
    const fixture = createFixture({
      reportError: (message) => {
        reports.push(message);
        throw new Error("reporter failed");
      },
    });
    const session = fakeSession({
      close: () => {
        throw new Error("session close failed");
      },
    });
    const secret = `fw_${"x".repeat(32)}`;

    fixture.callbacks.onInit?.("conversation-error", session.value);
    expect(() =>
      fixture.callbacks.onError?.(
        new Error(`${secret} ${"failure ".repeat(300)}`),
        session.value,
      ),
    ).not.toThrow();
    await fixture.attachment.close();

    expect(session.close).toHaveBeenCalledOnce();
    expect(reports.join("\n")).not.toContain(secret);
    expect(reports).toContain("ElevenLabs Speech Engine session failed");
    expect(Math.max(...reports.map((message) => message.length))).toBeLessThan(
      1_100,
    );
  });

  it("closes every active session before closing the SDK attachment", async () => {
    const order: string[] = [];
    const fixture = createFixture({
      attachmentClose: vi.fn(() => {
        order.push("attachment");
        return Promise.resolve();
      }),
    });
    const first = fakeSession({ close: () => order.push("session-1") });
    const second = fakeSession({ close: () => order.push("session-2") });

    fixture.callbacks.onInit?.("conversation-1", first.value);
    fixture.callbacks.onInit?.("conversation-2", second.value);
    await Promise.all([fixture.attachment.close(), fixture.attachment.close()]);

    expect(order).toEqual(["session-1", "session-2", "attachment"]);
    expect(fixture.attachmentClose).toHaveBeenCalledOnce();
  });

  it("aborts and drains an active response before attachment shutdown completes", async () => {
    let responseDrained = false;
    let turnSignal: AbortSignal | undefined;
    const respond = vi.fn<StudioSubagent["respond"]>(
      (_transcript, _conversationId, signal) => {
        turnSignal = signal;
        return new Promise<string>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              queueMicrotask(() => {
                responseDrained = true;
                resolve("A stale response.");
              });
            },
            { once: true },
          );
        });
      },
    );
    const fixture = createFixture({ respond });
    const session = fakeSession();

    fixture.callbacks.onTranscript?.(
      [{ role: "user", content: "Read the candidate." }],
      new AbortController().signal,
      session.value,
    );
    await vi.waitFor(() => {
      expect(turnSignal).toBeDefined();
    });
    await fixture.attachment.close();

    expect(turnSignal?.aborted).toBe(true);
    expect(responseDrained).toBe(true);
    expect(session.sendResponse).not.toHaveBeenCalled();
    expect(fixture.attachmentClose).toHaveBeenCalledOnce();
  });

  it("bounds shutdown when the SDK attachment never closes", async () => {
    vi.useFakeTimers();
    const reports: string[] = [];
    const fixture = createFixture({
      attachmentClose: vi.fn(() => new Promise<void>(() => undefined)),
      reportError: (message) => reports.push(message),
      shutdownTimeoutMs: 25,
    });

    const close = fixture.attachment.close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(close).resolves.toBeUndefined();

    expect(reports).toContain(
      "ElevenLabs Speech Engine attachment close exceeded 25ms",
    );
  });
});

interface FixtureOptions {
  respond?: StudioSubagent["respond"];
  attachmentClose?: () => Promise<void>;
  reportError?: (message: string) => void;
  shutdownTimeoutMs?: number;
}

function createFixture(options: FixtureOptions = {}) {
  let callbacks: SpeechEngineCallbacks | undefined;
  const attachmentClose =
    options.attachmentClose ?? vi.fn().mockResolvedValue(undefined);
  const getWebrtcToken = vi.fn().mockResolvedValue({ token: "webrtc-test" });
  const client: ElevenLabsSpeechEngineClient = {
    conversationalAi: {
      conversations: {
        getWebrtcToken,
      },
    },
    speechEngine: {
      attach: (_engineId, _server, path, nextCallbacks) => {
        expect(path).toBe(ELEVENLABS_SPEECH_ENGINE_PATH);
        callbacks = nextCallbacks;
        return { close: attachmentClose };
      },
      get: vi.fn().mockResolvedValue({ engineId: "seng_test" }),
    },
  };
  const engine = new ElevenLabsSpeechEngine(CONFIG, {
    client,
    ...(options.reportError ? { reportError: options.reportError } : {}),
    ...(options.shutdownTimeoutMs === undefined
      ? {}
      : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
  });
  const attachment = engine.attach(createServer(), {
    respond:
      options.respond ??
      vi.fn().mockResolvedValue("The candidate is still running."),
  } as StudioSubagent);
  if (!callbacks) {
    throw new Error("Speech Engine callbacks were not registered");
  }
  return {
    attachment,
    attachmentClose,
    callbacks,
    engine,
    getWebrtcToken,
  };
}

interface FakeSessionOptions {
  close?: () => void;
  conversationId?: string | undefined;
}

function fakeSession(options: FakeSessionOptions = {}) {
  const session = {
    conversationId:
      "conversationId" in options
        ? options.conversationId
        : "conversation-test",
    isOpen: true,
    sendResponse: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(options.close ?? (() => undefined)),
  };
  return {
    value: session as unknown as SpeechEngineSession,
    close: session.close,
    sendResponse: session.sendResponse,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
