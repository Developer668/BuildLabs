import type { BrowserConversationSession } from "./browser-session";
import type {
  BrowserVoiceEvent,
  BrowserVoiceFailure,
} from "./browser-voice-state";

const MICROPHONE_TIMEOUT_MS = 30_000;
const SESSION_REQUEST_TIMEOUT_MS = 9_000;
const SOCKET_CONNECT_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_MESSAGE_BYTES = 2_500_000;
const MAX_EPHEMERAL_TURNS = 64;

type EphemeralTurn = {
  role: "agent" | "user";
  message: string;
};

type ProviderEvent = {
  type: string;
  conversation_initiation_metadata_event?: unknown;
  audio_event?: unknown;
  ping_event?: unknown;
  interruption_event?: unknown;
  user_transcription_event?: unknown;
  agent_response_event?: unknown;
  client_tool_call?: unknown;
};

type TransportOptions = {
  onEvent: (event: BrowserVoiceEvent) => void;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanEphemeralText(value: unknown) {
  return typeof value === "string"
    ? Array.from(value, (character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
      })
        .join("")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 4_000)
    : "";
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  if (
    !value ||
    value.length > MAX_PROVIDER_MESSAGE_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new Error("invalid audio");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("invalid audio");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function pcmSampleRate(format: string) {
  const match = /^pcm_(8000|16000|22050|24000|44100|48000)$/u.exec(format);
  return match ? Number(match[1]) : null;
}

export function encodePcm16Base64(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
) {
  if (
    !samples.length ||
    !Number.isFinite(sourceRate) ||
    !Number.isFinite(targetRate) ||
    sourceRate <= 0 ||
    targetRate <= 0 ||
    targetRate > sourceRate * 2
  ) {
    return "";
  }
  const outputLength = Math.max(
    1,
    Math.floor((samples.length * targetRate) / sourceRate),
  );
  const bytes = new Uint8Array(outputLength * 2);
  const view = new DataView(bytes.buffer);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * ratio;
    const lower = Math.min(samples.length - 1, Math.floor(sourcePosition));
    const upper = Math.min(samples.length - 1, lower + 1);
    const fraction = sourcePosition - lower;
    const interpolated =
      samples[lower]! * (1 - fraction) + samples[upper]! * fraction;
    const bounded = Math.max(-1, Math.min(1, interpolated));
    const pcm =
      bounded < 0 ? Math.round(bounded * 0x8000) : Math.round(bounded * 0x7fff);
    view.setInt16(index * 2, pcm, true);
  }
  return bytesToBase64(bytes);
}

export function decodePcm16Base64(value: string) {
  const bytes = base64ToBytes(value);
  if (!bytes.length || bytes.length % 2 !== 0) {
    throw new Error("invalid audio");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const pcm = view.getInt16(index * 2, true);
    samples[index] = pcm < 0 ? pcm / 0x8000 : pcm / 0x7fff;
  }
  return samples;
}

export function parseElevenLabsEvent(raw: string): ProviderEvent {
  if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_MESSAGE_BYTES) {
    throw new Error("provider message too large");
  }
  const parsed = JSON.parse(raw) as unknown;
  const event = record(parsed);
  if (typeof event.type !== "string" || !event.type || event.type.length > 80) {
    throw new Error("invalid provider message");
  }
  return event as ProviderEvent;
}

function validSession(value: unknown): value is BrowserConversationSession {
  const session = record(value);
  const initiation = record(session.initiation);
  const variables = record(initiation.dynamic_variables);
  let signedUrl: URL;
  try {
    signedUrl = new URL(
      typeof session.signedUrl === "string" ? session.signedUrl : "",
    );
  } catch {
    return false;
  }
  const expiresAt = Date.parse(
    typeof session.expiresAt === "string" ? session.expiresAt : "",
  );
  return (
    signedUrl.protocol === "wss:" &&
    signedUrl.hostname === "api.elevenlabs.io" &&
    signedUrl.pathname === "/v1/convai/conversation" &&
    !signedUrl.username &&
    !signedUrl.password &&
    !signedUrl.hash &&
    (signedUrl.searchParams.has("token") ||
      signedUrl.searchParams.has("conversation_signature")) &&
    typeof session.conversationId === "string" &&
    /^conv_[A-Za-z0-9_-]{8,160}$/u.test(session.conversationId) &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    expiresAt <= Date.now() + 11 * 60 * 1_000 &&
    typeof session.reconnectToken === "string" &&
    session.reconnectToken.length >= 80 &&
    session.reconnectToken.length <= 4_096 &&
    Number.isInteger(session.reconnectAttempt) &&
    Number(session.reconnectAttempt) >= 0 &&
    Number(session.reconnectAttempt) <= 2 &&
    initiation.type === "conversation_initiation_client_data" &&
    typeof variables.secret__buildlabs_capability === "string" &&
    variables.secret__buildlabs_capability.length >= 80 &&
    typeof variables.buildlabs_project_id === "string" &&
    /^intake_[A-Za-z0-9_-]{16,80}$/u.test(variables.buildlabs_project_id) &&
    variables.buildlabs_contract_version === 0 &&
    typeof variables.buildlabs_agent_version === "string" &&
    variables.buildlabs_agent_version.length >= 8
  );
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("Microphone unavailable", "NotSupportedError");
  }
  let settled = false;
  const pending = navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  return new Promise<MediaStream>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      settled = true;
      reject(new DOMException("Microphone request timed out", "TimeoutError"));
    }, MICROPHONE_TIMEOUT_MS);
    void pending.then(
      (stream) => {
        if (settled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        resolve(stream);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export class BrowserVoiceTransport {
  private readonly onEvent: TransportOptions["onEvent"];
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private captureSilence: GainNode | null = null;
  private outputSources = new Set<AudioBufferSourceNode>();
  private nextPlaybackAt = 0;
  private playbackGeneration = 0;
  private inputSampleRate: number | null = null;
  private reconnectToken = "";
  private reconnectAttempt = 0;
  private expectedConversationId = "";
  private expiresAt = 0;
  private expiryTimer: number | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private ephemeralTranscript: EphemeralTurn[] = [];
  private ending = false;
  private terminal = false;
  private muted = false;
  private started = false;

  constructor(options: TransportOptions) {
    this.onEvent = options.onEvent;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.ending = false;
    this.terminal = false;
    this.onEvent({ type: "start" });
    try {
      this.stream = await requestMicrophone();
      if (this.ending) {
        this.stopMicrophone();
        return;
      }
      this.onEvent({ type: "microphone_granted" });
      await this.prepareCapture();
      await this.connect("");
    } catch (error) {
      if (this.ending) return;
      const name =
        error && typeof error === "object" && "name" in error
          ? String(error.name)
          : "";
      this.fail(
        name === "NotAllowedError" || name === "SecurityError"
          ? "microphone_denied"
          : name === "NotSupportedError" || name === "TimeoutError"
            ? "microphone_unavailable"
            : "session_unavailable",
      );
    }
  }

  setMuted(nextMuted: boolean) {
    if (this.terminal || this.ending || this.muted === nextMuted) return;
    this.muted = nextMuted;
    this.onEvent({ type: nextMuted ? "mute" : "unmute" });
  }

  complete() {
    if (!this.started || this.ending) return;
    this.ending = true;
    this.onEvent({ type: "complete" });
    this.cleanup();
  }

  dispose() {
    this.ending = true;
    this.cleanup();
  }

  private async prepareCapture() {
    if (!this.stream) throw new Error("Microphone unavailable");
    const AudioContextConstructor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new DOMException("Audio unavailable", "NotSupportedError");
    }
    this.captureContext = new AudioContextConstructor();
    await this.captureContext.resume();
    this.captureSource = this.captureContext.createMediaStreamSource(
      this.stream,
    );
    this.captureProcessor = this.captureContext.createScriptProcessor(
      4_096,
      1,
      1,
    );
    this.captureSilence = this.captureContext.createGain();
    this.captureSilence.gain.value = 0;
    this.captureProcessor.onaudioprocess = (event) => {
      if (
        this.muted ||
        this.ending ||
        !this.inputSampleRate ||
        this.socket?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      const encoded = encodePcm16Base64(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
        this.inputSampleRate,
      );
      if (encoded) {
        this.send({ user_audio_chunk: encoded });
      }
    };
    this.captureSource.connect(this.captureProcessor);
    this.captureProcessor.connect(this.captureSilence);
    this.captureSilence.connect(this.captureContext.destination);
  }

  private async requestSession(reconnectToken: string) {
    const abort = new AbortController();
    const timeout = window.setTimeout(
      () => abort.abort(),
      SESSION_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch("/api/conversation-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reconnectToken ? { reconnectToken } : {}),
        cache: "no-store",
        credentials: "same-origin",
        signal: abort.signal,
      });
      const raw = await response.text();
      if (
        new TextEncoder().encode(raw).byteLength > 16_384 ||
        !response.headers.get("content-type")?.toLowerCase().includes("json")
      ) {
        throw new Error("Invalid session response");
      }
      const body = JSON.parse(raw) as unknown;
      if (response.status === 410) {
        this.expire();
        return null;
      }
      if (!response.ok || !validSession(body)) {
        throw new Error("Session unavailable");
      }
      return body;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async connect(reconnectToken: string) {
    const session = await this.requestSession(reconnectToken);
    if (!session || this.ending || this.terminal) return;
    this.reconnectToken = session.reconnectToken;
    this.reconnectAttempt = session.reconnectAttempt;
    this.expectedConversationId = session.conversationId;
    this.expiresAt = Date.parse(session.expiresAt);
    this.armExpiry();

    const socket = new WebSocket(session.signedUrl);
    this.socket = socket;
    this.connectTimer = window.setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        socket.close(4_008, "connect_timeout");
      }
    }, SOCKET_CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (this.socket !== socket || this.ending || this.terminal) {
        socket.close(1_000, "stale");
        return;
      }
      this.clearConnectTimer();
      const initiation = session.initiation;
      socket.send(JSON.stringify(initiation));
      initiation.dynamic_variables.secret__buildlabs_capability = "";
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      if (typeof message.data !== "string") {
        this.fail("invalid_provider_message");
        return;
      }
      try {
        this.handleProviderEvent(parseElevenLabsEvent(message.data), socket);
      } catch {
        this.fail("invalid_provider_message");
      }
    };
    socket.onerror = () => {
      if (this.socket === socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(4_011, "provider_error");
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearConnectTimer();
      this.clearPlayback();
      this.inputSampleRate = null;
      this.clearEphemeralTranscript();
      if (this.ending || this.terminal) return;
      if (event.code === 1_000) {
        this.ending = true;
        this.onEvent({ type: "complete" });
        this.cleanup();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handleProviderEvent(event: ProviderEvent, socket: WebSocket) {
    if (event.type === "conversation_initiation_metadata") {
      const metadata = record(event.conversation_initiation_metadata_event);
      const inputRate = pcmSampleRate(
        typeof metadata.user_input_audio_format === "string"
          ? metadata.user_input_audio_format
          : "",
      );
      const outputRate = pcmSampleRate(
        typeof metadata.agent_output_audio_format === "string"
          ? metadata.agent_output_audio_format
          : "",
      );
      const conversationId =
        typeof metadata.conversation_id === "string"
          ? metadata.conversation_id
          : "";
      if (
        !inputRate ||
        !outputRate ||
        conversationId !== this.expectedConversationId
      ) {
        this.fail("unsupported_audio");
        return;
      }
      this.inputSampleRate = inputRate;
      this.playbackSampleRate = outputRate;
      this.onEvent({
        type: "connected",
        reconnectAttempt: this.reconnectAttempt,
      });
      return;
    }
    if (event.type === "ping") {
      const ping = record(event.ping_event);
      const eventId = Number(ping.event_id);
      const delay = Math.max(0, Math.min(1_000, Number(ping.ping_ms) || 0));
      if (Number.isSafeInteger(eventId)) {
        window.setTimeout(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
            this.send({ type: "pong", event_id: eventId });
          }
        }, delay);
      }
      return;
    }
    if (event.type === "audio") {
      const audio = record(event.audio_event);
      if (typeof audio.audio_base_64 !== "string") {
        throw new Error("invalid audio");
      }
      this.playAudio(audio.audio_base_64);
      return;
    }
    if (event.type === "interruption") {
      this.clearPlayback();
      this.onEvent({ type: "interrupted" });
      return;
    }
    if (event.type === "user_transcript") {
      this.addEphemeralTurn(
        "user",
        record(event.user_transcription_event).user_transcript,
      );
      return;
    }
    if (event.type === "agent_response") {
      this.addEphemeralTurn(
        "agent",
        record(event.agent_response_event).agent_response,
      );
      return;
    }
    if (event.type === "client_tool_call") {
      const call = record(event.client_tool_call);
      const toolCallId =
        typeof call.tool_call_id === "string"
          ? call.tool_call_id.slice(0, 200)
          : "";
      if (toolCallId && call.expects_response !== false) {
        this.send({
          type: "client_tool_result",
          tool_call_id: toolCallId,
          result: "client_tools_disabled",
          is_error: true,
        });
      }
      this.fail("client_tool_blocked");
      return;
    }
    if (event.type === "client_error") {
      socket.close(4_011, "provider_error");
    }
  }

  private playbackSampleRate: number | null = null;

  private playAudio(encoded: string) {
    if (!this.playbackSampleRate) {
      throw new Error("missing audio metadata");
    }
    const samples = decodePcm16Base64(encoded);
    const AudioContextConstructor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextConstructor) {
      this.fail("unsupported_audio");
      return;
    }
    this.playbackContext ??= new AudioContextConstructor();
    void this.playbackContext.resume();
    const buffer = this.playbackContext.createBuffer(
      1,
      samples.length,
      this.playbackSampleRate,
    );
    buffer.copyToChannel(samples, 0);
    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    const generation = this.playbackGeneration;
    const startsAt = Math.max(
      this.playbackContext.currentTime,
      this.nextPlaybackAt,
    );
    this.nextPlaybackAt = startsAt + buffer.duration;
    this.outputSources.add(source);
    source.onended = () => {
      this.outputSources.delete(source);
      if (
        generation === this.playbackGeneration &&
        this.outputSources.size === 0 &&
        !this.ending &&
        !this.terminal
      ) {
        this.onEvent({ type: "agent_audio_ended" });
      }
    };
    source.start(startsAt);
    this.onEvent({ type: "agent_audio" });
  }

  private send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private addEphemeralTurn(role: EphemeralTurn["role"], raw: unknown) {
    const message = cleanEphemeralText(raw);
    if (!message) return;
    this.ephemeralTranscript.push({ role, message });
    if (this.ephemeralTranscript.length > MAX_EPHEMERAL_TURNS) {
      this.ephemeralTranscript.splice(
        0,
        this.ephemeralTranscript.length - MAX_EPHEMERAL_TURNS,
      );
    }
  }

  private clearEphemeralTranscript() {
    this.ephemeralTranscript.splice(0);
  }

  private scheduleReconnect() {
    if (
      this.reconnectAttempt >= 2 ||
      !this.reconnectToken ||
      Date.now() >= this.expiresAt
    ) {
      if (Date.now() >= this.expiresAt) this.expire();
      else this.fail("connection_failed");
      return;
    }
    const nextAttempt = this.reconnectAttempt + 1;
    this.onEvent({ type: "reconnecting", reconnectAttempt: nextAttempt });
    const delay = nextAttempt === 1 ? 400 : 900;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(this.reconnectToken).catch(() => {
        this.fail("connection_failed");
      });
    }, delay);
  }

  private armExpiry() {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) {
      this.expire();
      return;
    }
    this.expiryTimer = window.setTimeout(
      () => this.expire(),
      Math.min(remaining, 2_147_483_647),
    );
  }

  private expire() {
    if (this.terminal || this.ending) return;
    this.terminal = true;
    this.onEvent({ type: "expire" });
    this.cleanup();
  }

  private fail(failure: Exclude<BrowserVoiceFailure, null>) {
    if (this.terminal || this.ending) return;
    this.terminal = true;
    this.onEvent({ type: "unavailable", failure });
    this.cleanup();
  }

  private clearPlayback() {
    this.playbackGeneration += 1;
    this.nextPlaybackAt = 0;
    for (const source of this.outputSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that already ended needs no further cleanup.
      }
      source.disconnect();
    }
    this.outputSources.clear();
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private stopMicrophone() {
    this.inputSampleRate = null;
    if (this.captureProcessor) {
      this.captureProcessor.onaudioprocess = null;
      this.captureProcessor.disconnect();
    }
    this.captureSource?.disconnect();
    this.captureSilence?.disconnect();
    this.captureProcessor = null;
    this.captureSource = null;
    this.captureSilence = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.captureContext) void this.captureContext.close();
    this.captureContext = null;
  }

  private cleanup() {
    this.clearConnectTimer();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.expiryTimer !== null) {
      window.clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close(1_000, "client_end");
    }
    this.stopMicrophone();
    this.clearPlayback();
    if (this.playbackContext) void this.playbackContext.close();
    this.playbackContext = null;
    this.playbackSampleRate = null;
    this.reconnectToken = "";
    this.expectedConversationId = "";
    this.clearEphemeralTranscript();
  }
}
