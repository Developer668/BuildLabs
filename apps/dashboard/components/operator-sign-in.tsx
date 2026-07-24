"use client";

import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

export function OperatorSignIn() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/operator/session", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setError("The operator token was not accepted.");
        return;
      }
      const receipt = (await response.json()) as {
        authenticated?: unknown;
        redirectTo?: unknown;
      };
      if (
        receipt.authenticated !== true ||
        receipt.redirectTo !== "/operator"
      ) {
        setError("The operator session endpoint returned an invalid receipt.");
        return;
      }
      window.location.assign("/operator");
    } catch {
      setError("The operator session endpoint is unavailable.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="operator-sign-in-title">
        <div className="auth-panel-top">
          <ShieldCheck aria-hidden="true" size={24} />
          <h1 id="operator-sign-in-title">Operator studio</h1>
          <p>Internal evidence, provider operations, and candidate control.</p>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label>
            Operator access token
            <input
              autoComplete="current-password"
              autoFocus
              name="token"
              onChange={(event) => setToken(event.currentTarget.value)}
              required
              type="password"
              value={token}
            />
          </label>
          {error ? (
            <div className="notice-banner error" role="alert">
              <KeyRound aria-hidden="true" />
              <span>{error}</span>
              <span />
            </div>
          ) : null}
          <button
            className="primary-button"
            disabled={pending || token.length === 0}
            type="submit"
          >
            {pending ? "Opening studio..." : "Open studio"}
            <ArrowRight aria-hidden="true" />
          </button>
        </form>
      </section>
    </main>
  );
}
