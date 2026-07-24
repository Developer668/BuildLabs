export type BrowserVoiceMode =
  | "consent"
  | "requesting"
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "muted"
  | "provider_unavailable"
  | "completed"
  | "expired";

export type BrowserVoiceFailure =
  | "microphone_denied"
  | "microphone_unavailable"
  | "session_unavailable"
  | "connection_failed"
  | "unsupported_audio"
  | "invalid_provider_message"
  | "client_tool_blocked"
  | null;

export type BrowserVoiceState = {
  mode: BrowserVoiceMode;
  reconnectAttempt: number;
  interruptionCount: number;
  failure: BrowserVoiceFailure;
};

export type BrowserVoiceEvent =
  | { type: "start" }
  | { type: "microphone_granted" }
  | { type: "connected"; reconnectAttempt: number }
  | { type: "agent_audio" }
  | { type: "agent_audio_ended" }
  | { type: "interrupted" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "reconnecting"; reconnectAttempt: number }
  | { type: "unavailable"; failure: Exclude<BrowserVoiceFailure, null> }
  | { type: "complete" }
  | { type: "expire" }
  | { type: "reset" };

export const initialBrowserVoiceState: BrowserVoiceState = {
  mode: "consent",
  reconnectAttempt: 0,
  interruptionCount: 0,
  failure: null,
};

function reset(mode: BrowserVoiceMode): BrowserVoiceState {
  return { ...initialBrowserVoiceState, mode };
}

export function reduceBrowserVoiceState(
  state: BrowserVoiceState,
  event: BrowserVoiceEvent,
): BrowserVoiceState {
  switch (event.type) {
    case "start":
      return state.mode === "consent" ||
        state.mode === "provider_unavailable" ||
        state.mode === "completed" ||
        state.mode === "expired"
        ? reset("requesting")
        : state;
    case "microphone_granted":
      return state.mode === "requesting"
        ? { ...state, mode: "connecting", failure: null }
        : state;
    case "connected":
      return state.mode === "connecting" || state.mode === "reconnecting"
        ? {
            ...state,
            mode: "listening",
            reconnectAttempt: event.reconnectAttempt,
            failure: null,
          }
        : state;
    case "agent_audio":
      return state.mode === "listening"
        ? { ...state, mode: "speaking" }
        : state;
    case "agent_audio_ended":
      return state.mode === "speaking"
        ? { ...state, mode: "listening" }
        : state;
    case "interrupted":
      return state.mode === "speaking" ||
        state.mode === "listening" ||
        state.mode === "muted"
        ? {
            ...state,
            mode: state.mode === "muted" ? "muted" : "listening",
            interruptionCount: state.interruptionCount + 1,
          }
        : state;
    case "mute":
      return state.mode === "listening" || state.mode === "speaking"
        ? { ...state, mode: "muted" }
        : state;
    case "unmute":
      return state.mode === "muted" ? { ...state, mode: "listening" } : state;
    case "reconnecting":
      return state.mode === "listening" ||
        state.mode === "speaking" ||
        state.mode === "muted" ||
        state.mode === "connecting" ||
        state.mode === "reconnecting"
        ? {
            ...state,
            mode: "reconnecting",
            reconnectAttempt: event.reconnectAttempt,
            failure: null,
          }
        : state;
    case "unavailable":
      return {
        ...state,
        mode: "provider_unavailable",
        failure: event.failure,
      };
    case "complete":
      return state.mode === "consent" ? state : reset("completed");
    case "expire":
      return state.mode === "completed" ? state : reset("expired");
    case "reset":
      return initialBrowserVoiceState;
  }
}
