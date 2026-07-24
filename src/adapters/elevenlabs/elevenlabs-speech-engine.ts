import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

import {
  ElevenLabsClient,
  type SpeechEngineCallbacks,
  type SpeechEngineSession,
} from "@elevenlabs/elevenlabs-js";

import type { AppConfig } from "../../config.js";
import { boundText } from "../../lib/redaction.js";
import type { StudioSubagent } from "../../application/studio-subagent.js";

export const ELEVENLABS_SPEECH_ENGINE_PATH =
  "/v1/integrations/elevenlabs/speech-engine";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_ERROR_REPORT_BYTES = 1_000;

export interface ElevenLabsSpeechEngineAttachment {
  close(): Promise<void>;
}

export interface ElevenLabsSpeechEngineClient {
  conversationalAi: {
    conversations: {
      getWebrtcToken(
        request: { agentId: string },
        options: {
          abortSignal?: AbortSignal;
          timeoutInSeconds: number;
        },
      ): Promise<{ token: string }>;
    };
  };
  speechEngine: {
    attach(
      engineId: string,
      server: Server,
      path: string,
      callbacks: SpeechEngineCallbacks,
    ): ElevenLabsSpeechEngineAttachment;
    get(
      engineId: string,
      options: {
        abortSignal?: AbortSignal;
        timeoutInSeconds: number;
      },
    ): Promise<{ engineId: string }>;
  };
}

export interface ElevenLabsSpeechEngineOptions {
  client?: ElevenLabsSpeechEngineClient;
  shutdownTimeoutMs?: number;
  reportError?: (message: string) => void;
}

export class ElevenLabsSpeechEngine {
  readonly #client: ElevenLabsSpeechEngineClient;
  readonly #speechEngineId: string;
  readonly #shutdownTimeoutMs: number;
  readonly #reportError: (message: string) => void;

  constructor(config: AppConfig, options: ElevenLabsSpeechEngineOptions = {}) {
    if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_SPEECH_ENGINE_ID) {
      throw new Error(
        "ElevenLabs Speech Engine requires both an API key and a speech engine ID",
      );
    }
    this.#client =
      options.client ??
      new ElevenLabsClient({
        apiKey: config.ELEVENLABS_API_KEY,
      });
    this.#speechEngineId = config.ELEVENLABS_SPEECH_ENGINE_ID;
    this.#shutdownTimeoutMs = normalizeShutdownTimeout(
      options.shutdownTimeoutMs,
    );
    this.#reportError =
      options.reportError ??
      ((message) => {
        console.error(message);
      });
  }

  attach(
    server: Server,
    subagent: StudioSubagent,
  ): ElevenLabsSpeechEngineAttachment {
    const sessions = new Set<SpeechEngineSession>();
    const conversationIds = new WeakMap<SpeechEngineSession, string>();
    const pendingResponses = new Set<Promise<void>>();
    const turnControllers = new Set<AbortController>();
    let closing = false;

    const reportError = (message: string): void => {
      try {
        this.#reportError(boundText(message, MAX_ERROR_REPORT_BYTES));
      } catch {
        // Error reporting must never destabilize the Speech Engine callback.
      }
    };
    const closeSession = (session: SpeechEngineSession): void => {
      sessions.delete(session);
      try {
        session.close();
      } catch {
        reportError("ElevenLabs Speech Engine session close failed");
      }
    };
    const trackSession = (session: SpeechEngineSession): boolean => {
      if (closing) {
        closeSession(session);
        return false;
      }
      sessions.add(session);
      return true;
    };
    const conversationIdFor = (session: SpeechEngineSession): string => {
      const existing = conversationIds.get(session);
      if (existing) {
        return existing;
      }
      const providerId =
        typeof session.conversationId === "string" &&
        session.conversationId.length > 0 &&
        session.conversationId.length <= 256
          ? session.conversationId
          : undefined;
      const conversationId = providerId ?? `speech-session:${randomUUID()}`;
      conversationIds.set(session, conversationId);
      return conversationId;
    };
    const handleSessionError = (
      _error: unknown,
      session: SpeechEngineSession,
    ): void => {
      closeSession(session);
      reportError("ElevenLabs Speech Engine session failed");
    };
    const respondToTranscript = async (
      ...[transcript, signal, session]: Parameters<
        NonNullable<SpeechEngineCallbacks["onTranscript"]>
      >
    ): Promise<void> => {
      if (!trackSession(session)) {
        return;
      }
      const turnController = new AbortController();
      turnControllers.add(turnController);
      const turnSignal = AbortSignal.any([signal, turnController.signal]);

      try {
        let response: string;
        try {
          response = await subagent.respond(
            transcript,
            conversationIdFor(session),
            turnSignal,
          );
        } catch (error) {
          if (turnSignal.aborted || !session.isOpen || closing) {
            return;
          }
          response =
            error instanceof Error && error.message.includes("was not found")
              ? "I could not find that build run. Please check the run ID."
              : "I could not complete that studio operation.";
        }

        if (turnSignal.aborted || !session.isOpen || closing) {
          return;
        }
        await session.sendResponse(response);
      } finally {
        turnControllers.delete(turnController);
      }
    };

    const attachment = this.#client.speechEngine.attach(
      this.#speechEngineId,
      server,
      ELEVENLABS_SPEECH_ENGINE_PATH,
      {
        onInit: (conversationId, session) => {
          if (conversationId.length > 0 && conversationId.length <= 256) {
            conversationIds.set(session, conversationId);
          }
          trackSession(session);
        },
        onTranscript: (transcript, signal, session) => {
          const response = respondToTranscript(
            transcript,
            signal,
            session,
          ).catch((error: unknown) => {
            handleSessionError(error, session);
          });
          pendingResponses.add(response);
          void response.finally(() => {
            pendingResponses.delete(response);
          });
        },
        onClose: (session) => {
          closeSession(session);
        },
        onDisconnect: (session) => {
          sessions.delete(session);
        },
        onError: (error, session) => {
          handleSessionError(error, session);
        },
      },
    );

    let closePromise: Promise<void> | undefined;
    return {
      close: () => {
        closePromise ??= (async () => {
          closing = true;
          for (const controller of turnControllers) {
            controller.abort(
              new Error("ElevenLabs Speech Engine is shutting down"),
            );
          }
          for (const session of [...sessions]) {
            closeSession(session);
          }

          const shutdown = Promise.all([
            Promise.resolve().then(() => attachment.close()),
            Promise.allSettled([...pendingResponses]),
          ]).then(() => undefined);
          const outcome = await settleWithin(shutdown, this.#shutdownTimeoutMs);
          if (outcome.status === "rejected") {
            reportError("ElevenLabs Speech Engine attachment close failed");
          } else if (outcome.status === "timed-out") {
            reportError(
              `ElevenLabs Speech Engine attachment close exceeded ${this.#shutdownTimeoutMs}ms`,
            );
          }
        })();
        return closePromise;
      },
    };
  }

  async health(signal?: AbortSignal): Promise<void> {
    const engine = await this.#client.speechEngine.get(this.#speechEngineId, {
      ...(signal ? { abortSignal: signal } : {}),
      timeoutInSeconds: 20,
    });
    if (engine.engineId !== this.#speechEngineId) {
      throw new Error("ElevenLabs returned the wrong Speech Engine resource");
    }
  }

  async createWebRtcToken(signal?: AbortSignal): Promise<{ token: string }> {
    const response =
      await this.#client.conversationalAi.conversations.getWebrtcToken(
        {
          agentId: this.#speechEngineId,
        },
        {
          ...(signal ? { abortSignal: signal } : {}),
          timeoutInSeconds: 20,
        },
      );
    if (
      typeof response.token !== "string" ||
      response.token.length === 0 ||
      Buffer.byteLength(response.token, "utf8") > 16 * 1_024
    ) {
      throw new Error("ElevenLabs returned an invalid WebRTC session token");
    }
    return { token: response.token };
  }
}

type Settlement =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
  | { status: "timed-out" };

function settleWithin(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<Settlement> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: Settlement): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ status: "timed-out" });
    }, timeoutMs);
    timer.unref();

    void promise.then(
      () => {
        finish({ status: "fulfilled" });
      },
      (reason: unknown) => {
        finish({ status: "rejected", reason });
      },
    );
  });
}

function normalizeShutdownTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.trunc(value)), MAX_SHUTDOWN_TIMEOUT_MS);
}
