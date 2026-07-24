"use client";

import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { AudioLines, Mic, MicOff, PhoneOff, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type VoiceSession = {
  signedUrl: string;
  initiation: {
    dynamic_variables: Record<string, string | number | boolean>;
  };
};

type VoiceState = "idle" | "connecting" | "live" | "unavailable" | "error";

const voiceServiceUrl = process.env.NEXT_PUBLIC_BUILDLABS_VOICE_INTAKE_URL?.replace(
  /\/$/u,
  "",
);

function displayFailure(status: number | undefined): string {
  if (status === 403) return "Voice is not available from this workspace origin.";
  if (status === 503) return "The voice agent is not configured right now.";
  return "The voice agent could not start. Please try again.";
}

export function ProjectVoiceAgent({ fixture }: { fixture: boolean }) {
  const conversation = useRef<VoiceConversation | null>(null);
  const [state, setState] = useState<VoiceState>(
    fixture || !voiceServiceUrl ? "unavailable" : "idle",
  );
  const [muted, setMuted] = useState(false);
  const [detail, setDetail] = useState(
    fixture
      ? "Voice is unavailable in the deterministic fixture."
      : voiceServiceUrl
        ? "Talk with the BuildLabs agent about your project."
        : "Voice is not configured for this workspace.",
  );

  useEffect(
    () => () => {
      void conversation.current?.endSession();
      conversation.current = null;
    }, []);

  async function endSession() {
    const active = conversation.current;
    conversation.current = null;
    if (active) await active.endSession();
    setMuted(false);
    setState(voiceServiceUrl ? "idle" : "unavailable");
    setDetail("Voice session ended.");
  }

  async function beginSession() {
    if (!voiceServiceUrl || fixture || state === "connecting") return;
    setState("connecting");
    setDetail("Requesting a secure voice session…");
    try {
      const response = await fetch(`${voiceServiceUrl}/api/conversation-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        cache: "no-store",
      });
      if (!response.ok) {
        setState("error");
        setDetail(displayFailure(response.status));
        return;
      }
      const session = (await response.json()) as VoiceSession;
      if (!session.signedUrl || !session.initiation?.dynamic_variables) {
        throw new Error("voice_session_invalid");
      }
      const active = await Conversation.startSession({
        signedUrl: session.signedUrl,
        dynamicVariables: session.initiation.dynamic_variables,
        onConnect: () => {
          setState("live");
          setDetail("Connected. The agent can hear you.");
        },
        onDisconnect: () => {
          conversation.current = null;
          setMuted(false);
          setState(voiceServiceUrl ? "idle" : "unavailable");
          setDetail("Voice session ended.");
        },
        onError: () => {
          conversation.current = null;
          setState("error");
          setDetail("The voice connection ended unexpectedly.");
        },
      });
      conversation.current = active as VoiceConversation;
    } catch {
      conversation.current = null;
      setState("error");
      setDetail("The voice agent could not start. Check microphone access and try again.");
    }
  }

  function toggleMute() {
    const nextMuted = !muted;
    conversation.current?.setMicMuted(nextMuted);
    setMuted(nextMuted);
  }

  return (
    <section aria-labelledby="voice-agent-title" className="workspace-section" id="voice">
      <div className="section-heading">
        <div>
          <span className="section-kicker">PROJECT CONVERSATION</span>
          <h2 id="voice-agent-title">Talk to your BuildLabs agent</h2>
          <p>Ask a question, clarify scope, or describe a change in a live voice session.</p>
        </div>
        <span className={`status-pill ${state === "live" ? "running" : state === "unavailable" ? "waiting" : "active"}`}>
          <Radio aria-hidden="true" />
          {state === "live" ? "Live" : state === "connecting" ? "Connecting" : state === "unavailable" ? "Unavailable" : "Ready"}
        </span>
      </div>
      <div className="voice-agent-panel">
        <div className="voice-agent-icon"><AudioLines aria-hidden="true" /></div>
        <div className="voice-agent-copy"><strong>{state === "live" ? "Agent is listening" : "Voice agent"}</strong><p>{detail}</p></div>
        <div className="voice-agent-actions">
          {state === "live" ? <>
            <button aria-label={muted ? "Unmute microphone" : "Mute microphone"} className="icon-button" data-tooltip={muted ? "Unmute microphone" : "Mute microphone"} onClick={toggleMute} type="button">{muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}</button>
            <button className="secondary-button" onClick={() => void endSession()} type="button"><PhoneOff aria-hidden="true" />End</button>
          </> : <button className="primary-button" disabled={state === "connecting" || state === "unavailable"} onClick={() => void beginSession()} type="button"><Mic aria-hidden="true" />{state === "connecting" ? "Connecting" : "Start conversation"}</button>}
        </div>
      </div>
    </section>
  );
}
