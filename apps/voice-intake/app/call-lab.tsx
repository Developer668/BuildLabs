"use client";

import { AudioLines, ChevronDown, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type TranscriptTurn = {
  role: "agent" | "user";
  message: string;
  timeInCallSecs?: number;
};

type CallRecord = {
  id: string;
  contactName: string;
  businessName: string;
  projectGoal: string;
  status: "successful" | "failed";
  provider: "ElevenLabs";
  conversationId: string;
  transcript: TranscriptTurn[];
  summary: string;
  error: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
};

type PublicConfig = {
  agentConfigured: boolean;
  accessConfigured: boolean;
  accessRequired: boolean;
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
  return `Conversation ${call.conversationId.slice(-8)}`;
}

export function CallLab() {
  const [config, setConfig] = useState<PublicConfig>({
    agentConfigured: false,
    accessConfigured: false,
    accessRequired: true,
  });
  const [accessCode, setAccessCode] = useState("");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Loading voice conversations...");
  const [warning, setWarning] = useState("");

  const totals = useMemo(() => {
    const customerTurns = calls.reduce(
      (sum, call) =>
        sum + call.transcript.filter((turn) => turn.role === "user").length,
      0,
    );
    return {
      calls: calls.length,
      successful: calls.filter((call) => call.status === "successful").length,
      customerTurns,
    };
  }, [calls]);

  const loadCalls = useCallback(
    async (
      quiet = false,
      suppliedAccessCode = "",
      allowWithoutAccess = false,
    ) => {
      if (!suppliedAccessCode && !allowWithoutAccess) {
        setCalls([]);
        setMessage("Enter the operator access code.");
        return;
      }
      if (!quiet) setLoading(true);
      try {
        const response = await fetch("/api/calls", {
          headers: suppliedAccessCode
            ? { "x-call-lab-key": suppliedAccessCode }
            : undefined,
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as {
          calls?: CallRecord[];
          error?: string;
          processing?: number;
        };
        if (!response.ok) {
          setCalls([]);
          setMessage(body.error || "Voice conversations could not be loaded.");
          return;
        }
        setCalls(body.calls ?? []);
        setWarning(
          body.processing
            ? `${body.processing} conversation${body.processing === 1 ? " is" : "s are"} still processing.`
            : "",
        );
        setMessage(
          body.calls?.length ? "" : "No completed voice conversations.",
        );
      } catch {
        setMessage("Voice conversations could not be loaded.");
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetch("/api/public-config", { cache: "no-store" })
      .then(async (response) => (await response.json()) as PublicConfig)
      .then((nextConfig) => {
        setConfig(nextConfig);
        if (!nextConfig.agentConfigured) {
          setMessage("ElevenLabs voice archive access is not configured.");
        } else if (!nextConfig.accessConfigured) {
          setMessage("Operator access is not configured.");
        } else if (nextConfig.accessRequired) {
          setMessage("Enter the operator access code.");
        } else {
          void loadCalls(false, "", true);
        }
      })
      .catch(() => undefined);
  }, [loadCalls]);

  return (
    <main className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">BUILDLABS VOICE</p>
          <h1>Intake archive</h1>
          <p className="description">
            Completed ElevenLabs intake sessions, loaded directly from the
            provider for local operator review.
          </p>
        </div>
        <button
          aria-label="Refresh conversations"
          className="refreshButton"
          disabled={
            loading || !config.agentConfigured || !config.accessConfigured
          }
          onClick={() =>
            void loadCalls(false, accessCode, !config.accessRequired)
          }
          type="button"
        >
          <RefreshCw aria-hidden="true" className={loading ? "spinning" : ""} />
          <span>{loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      <section className="connectionPanel">
        <div className="connectionIcon">
          <ShieldCheck aria-hidden="true" />
        </div>
        <div>
          <span>ELEVENLABS AGENT</span>
          <strong>
            {config.agentConfigured ? "Configured" : "Not configured"}
          </strong>
          <small>
            {config.agentConfigured
              ? "Provider archive available"
              : "Voice archive unavailable"}
          </small>
        </div>
      </section>

      {config.accessRequired && (
        <section className="accessRow">
          <label htmlFor="access-code">Operator access</label>
          <input
            autoComplete="current-password"
            id="access-code"
            onChange={(event) => setAccessCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadCalls(false, accessCode);
            }}
            placeholder="Access code"
            type="password"
            value={accessCode}
          />
        </section>
      )}

      <section className="stats" aria-label="Conversation totals">
        <div>
          <strong>{totals.calls}</strong>
          <span>Conversations</span>
        </div>
        <div>
          <strong>{totals.successful}</strong>
          <span>Complete intakes</span>
        </div>
        <div>
          <strong>{totals.customerTurns}</strong>
          <span>Customer turns</span>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Voice conversations</h2>
            <p>Newest completed sessions first</p>
          </div>
          <span className="readOnly">READ ONLY</span>
        </div>

        {message ? (
          <div className="emptyState">
            <div className="emptyIcon">
              <AudioLines aria-hidden="true" />
            </div>
            <strong>{message}</strong>
          </div>
        ) : (
          <div className="callArchive">
            {warning && <p className="callWarning">{warning}</p>}
            {calls.map((call, index) => (
              <details className="call" key={call.id} open={index === 0}>
                <summary>
                  <div className="callIcon">
                    <AudioLines aria-hidden="true" />
                  </div>
                  <div className="callInfo">
                    <div>
                      <strong>{callTitle(call)}</strong>
                      <span className={`status ${call.status}`}>
                        {call.status}
                      </span>
                    </div>
                    <p>
                      {formatTime(call.updatedAt)} ·{" "}
                      {formatDuration(call.durationSeconds)} ·{" "}
                      {call.transcript.length} turns
                    </p>
                  </div>
                  <ChevronDown
                    aria-hidden="true"
                    className="chevron"
                    size={18}
                  />
                </summary>
                <div className="callBody">
                  {call.error && <p className="callError">{call.error}</p>}
                  {call.projectGoal && (
                    <p className="callGoal">{call.projectGoal}</p>
                  )}
                  {call.summary && (
                    <p className="callSummary">{call.summary}</p>
                  )}
                  {call.transcript.length ? (
                    <div className="turns">
                      {call.transcript.map((turn, turnIndex) => (
                        <article
                          className={`turn ${turn.role}`}
                          key={`${call.id}-${turnIndex}`}
                        >
                          <div>
                            <span>
                              {turn.role === "user"
                                ? "Customer"
                                : "BuildLabs AI"}
                            </span>
                            <p>{turn.message}</p>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="noTranscript">
                      No transcript was returned for this session.
                    </p>
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
