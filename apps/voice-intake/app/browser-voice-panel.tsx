"use client";

import {
  AudioLines,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  initialBrowserVoiceState,
  reduceBrowserVoiceState,
  type BrowserVoiceMode,
} from "../lib/browser-voice-state";
import { BrowserVoiceTransport } from "../lib/browser-voice-transport";

type BrowserVoicePanelProps = {
  configured: boolean | null;
};

const STATUS: Record<BrowserVoiceMode, { label: string; detail: string }> = {
  consent: {
    label: "Start a conversation",
    detail: "Tell us what you want to build.",
  },
  requesting: {
    label: "Microphone requested",
    detail: "Complete the browser microphone prompt.",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening a signed voice session.",
  },
  listening: {
    label: "Listening",
    detail: "Describe the outcome and requirements.",
  },
  speaking: {
    label: "BuildLabs is speaking",
    detail: "You can speak to interrupt at any time.",
  },
  reconnecting: {
    label: "Reconnecting",
    detail: "Restoring the voice session.",
  },
  muted: {
    label: "Microphone muted",
    detail: "Unmute when you are ready to continue.",
  },
  provider_unavailable: {
    label: "Voice unavailable",
    detail: "A secure session could not be opened.",
  },
  completed: {
    label: "Conversation complete",
    detail: "The completed intake will appear below.",
  },
  expired: {
    label: "Session expired",
    detail: "Start a new conversation to continue.",
  },
};

const ACTIVE_MODES = new Set<BrowserVoiceMode>([
  "requesting",
  "connecting",
  "listening",
  "speaking",
  "reconnecting",
  "muted",
]);

export function BrowserVoicePanel({ configured }: BrowserVoicePanelProps) {
  const [state, dispatch] = useReducer(
    reduceBrowserVoiceState,
    initialBrowserVoiceState,
  );
  const transport = useRef<BrowserVoiceTransport | null>(null);

  useEffect(() => {
    if (configured === false) {
      dispatch({ type: "unavailable", failure: "session_unavailable" });
    } else if (
      configured === true &&
      state.mode === "provider_unavailable" &&
      state.failure === "session_unavailable" &&
      !transport.current
    ) {
      dispatch({ type: "reset" });
    }
  }, [configured, state.failure, state.mode]);

  useEffect(
    () => () => {
      transport.current?.dispose();
      transport.current = null;
    },
    [],
  );

  const start = useCallback(() => {
    if (!configured) return;
    transport.current?.dispose();
    const next = new BrowserVoiceTransport({ onEvent: dispatch });
    transport.current = next;
    void next.start();
  }, [configured]);

  const finish = useCallback(() => {
    transport.current?.complete();
    transport.current = null;
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = state.mode !== "muted";
    transport.current?.setMuted(nextMuted);
  }, [state.mode]);

  const displayed =
    configured === null
      ? {
          label: "Checking voice",
          detail: "Reading the test deployment state.",
        }
      : STATUS[state.mode];
  const active = ACTIVE_MODES.has(state.mode);
  const animated = state.mode === "listening" || state.mode === "speaking";

  return (
    <section
      aria-label="Browser voice intake"
      className={`voiceConsole voice-${state.mode}`}
    >
      <div className="voiceConsoleMain">
        <div
          aria-hidden="true"
          className={`voiceSignal ${animated ? "voiceSignalActive" : ""}`}
        >
          {Array.from({ length: 7 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
        <div className="voiceStatus" aria-live="polite">
          <span className="voiceKicker">
            <ShieldCheck aria-hidden="true" />
            ELEVENAGENTS TEST BRANCH
          </span>
          <strong>{displayed.label}</strong>
          <p>{displayed.detail}</p>
          {state.mode === "reconnecting" && (
            <small>Attempt {state.reconnectAttempt} of 2</small>
          )}
        </div>
      </div>

      <div className="voiceActions">
        {active ? (
          <>
            {(state.mode === "listening" ||
              state.mode === "speaking" ||
              state.mode === "muted") && (
              <button
                className="voiceSecondaryButton"
                onClick={toggleMute}
                type="button"
              >
                {state.mode === "muted" ? (
                  <Mic aria-hidden="true" />
                ) : (
                  <MicOff aria-hidden="true" />
                )}
                {state.mode === "muted" ? "Unmute" : "Mute"}
              </button>
            )}
            <button className="voiceEndButton" onClick={finish} type="button">
              <PhoneOff aria-hidden="true" />
              {state.mode === "requesting" ? "Cancel" : "End"}
            </button>
          </>
        ) : (
          <button
            className="voiceStartButton"
            disabled={!configured}
            onClick={start}
            type="button"
          >
            {state.mode === "consent" ? (
              <Mic aria-hidden="true" />
            ) : configured === null ? (
              <RefreshCw aria-hidden="true" className="spinning" />
            ) : (
              <AudioLines aria-hidden="true" />
            )}
            {state.mode === "consent" ? "Use microphone" : "Start new intake"}
          </button>
        )}
      </div>
    </section>
  );
}
