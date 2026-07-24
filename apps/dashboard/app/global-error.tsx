"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="auth-page">
          <section className="auth-panel">
            <div className="auth-panel-top">
              <TriangleAlert aria-hidden="true" size={24} />
              <h1>Workspace interrupted</h1>
              <p>The last durable server state has not been changed.</p>
            </div>
            <div className="error-state">
              <strong>This view could not be rendered</strong>
              <p>
                Retry the authenticated projection. No build, proof, or delivery
                action is performed by this control.
              </p>
              <button
                className="secondary-button"
                onClick={reset}
                type="button"
              >
                <RefreshCw aria-hidden="true" />
                Retry view
              </button>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
}
