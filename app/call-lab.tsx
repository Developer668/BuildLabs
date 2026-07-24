"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type TranscriptTurn = {
  role: "agent" | "user";
  message: string;
  timeInCallSecs?: number;
};

type CallRecord = {
  id: string;
  toNumber: string;
  contactName: string;
  businessName: string;
  websiteGoal: string;
  status:
    | "queued"
    | "dialing"
    | "in_progress"
    | "completed"
    | "successful"
    | "failed";
  provider: string;
  conversationId: string;
  sipCallId: string;
  transcript: TranscriptTurn[];
  summary: string;
  error: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
};

type PublicConfig = {
  phoneDisplay: string;
  phoneHref: string;
};

function formatTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Just now"
    : new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(parsed);
}

function formatDuration(seconds: number) {
  if (!seconds) return "Duration unavailable";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function callTitle(call: CallRecord) {
  if (call.businessName) return call.businessName;
  if (call.contactName) return call.contactName;
  if (call.toNumber) return `Caller ${call.toNumber.slice(-4)}`;
  return "Inbound call";
}

export function CallLab() {
  const [config, setConfig] = useState<PublicConfig>({
    phoneDisplay: "Phone number not configured",
    phoneHref: "",
  });
  const [accessCode, setAccessCode] = useState("");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Enter the dashboard access code to load transcripts.");
  const [copied, setCopied] = useState(false);

  const totals = useMemo(() => {
    const callerTurns = calls.reduce(
      (sum, call) => sum + call.transcript.filter((turn) => turn.role === "user").length,
      0,
    );
    return {
      calls: calls.length,
      successful: calls.filter((call) => call.status === "successful").length,
      callerTurns,
    };
  }, [calls]);

  const loadCalls = useCallback(async (quiet = false) => {
    if (!accessCode) {
      setCalls([]);
      setMessage("Enter the dashboard access code to load transcripts.");
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/calls", {
        headers: { "x-call-lab-key": accessCode },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as {
        calls?: CallRecord[];
        error?: string;
      };
      if (!response.ok) {
        setCalls([]);
        setMessage(body.error || "Transcripts could not be loaded.");
        return;
      }
      setCalls(body.calls ?? []);
      setMessage(body.calls?.length ? "" : "No transcripts yet. Call the number above, finish the intake, then refresh.");
    } catch {
      setMessage("Transcripts could not be loaded.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [accessCode]);

  useEffect(() => {
    void fetch("/api/public-config", { cache: "no-store" })
      .then(async (response) => (await response.json()) as PublicConfig)
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  async function copyPhone() {
    if (!config.phoneHref) return;
    await navigator.clipboard.writeText(config.phoneDisplay).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <main className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">VOICE INTAKE</p>
          <h1>Call transcripts</h1>
          <p className="description">
            Call the BuildStax number from your phone. The AI asks one question at a
            time about the website, then the transcript appears here when the call ends.
          </p>
        </div>
        <button className="refreshButton" disabled={loading} onClick={() => void loadCalls()} type="button">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <section className="phonePanel">
        <div>
          <span>CALL FROM YOUR PHONE</span>
          <strong>{config.phoneDisplay}</strong>
          <small>ElevenLabs voice agent · calls may be transcribed</small>
        </div>
        <button disabled={!config.phoneHref} onClick={() => void copyPhone()} type="button">
          {copied ? "Copied" : "Copy number"}
        </button>
      </section>

      <section className="accessRow">
        <label htmlFor="access-code">Dashboard access</label>
        <input
          id="access-code"
          onChange={(event) => setAccessCode(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void loadCalls();
          }}
          placeholder="Access code"
          type="password"
          value={accessCode}
        />
      </section>

      <section className="stats" aria-label="Transcript totals">
        <div><strong>{totals.calls}</strong><span>Calls</span></div>
        <div><strong>{totals.successful}</strong><span>Successful</span></div>
        <div><strong>{totals.callerTurns}</strong><span>Caller answers</span></div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Voice conversations</h2>
            <p>Newest calls first. Transcripts are saved after the call finishes.</p>
          </div>
          <span className="readOnly">READ ONLY</span>
        </div>

        {message ? (
          <div className="emptyState">
            <div className="emptyIcon">•••</div>
            <strong>{message}</strong>
          </div>
        ) : (
          <div className="callArchive">
            {calls.map((call, index) => (
              <details className="call" key={call.id} open={index === 0}>
                <summary>
                  <div className="callIcon">☎</div>
                  <div className="callInfo">
                    <div>
                      <strong>{callTitle(call)}</strong>
                      <span className={`status ${call.status}`}>
                        {call.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p>
                      {formatTime(call.updatedAt)} · {formatDuration(call.durationSeconds)} ·{" "}
                      {call.transcript.length} turns
                    </p>
                  </div>
                  <span className="chevron">⌄</span>
                </summary>
                <div className="callBody">
                  {call.error && <p className="callError">{call.error}</p>}
                  {call.summary && <p className="callSummary">{call.summary}</p>}
                  {call.transcript.length ? (
                    <div className="turns">
                      {call.transcript.map((turn, turnIndex) => (
                        <article className={`turn ${turn.role}`} key={`${call.id}-${turnIndex}`}>
                          <div>
                            <span>{turn.role === "user" ? "Caller" : "BuildStax AI"}</span>
                            <p>{turn.message}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="noTranscript">This call ended before a transcript was saved.</p>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
