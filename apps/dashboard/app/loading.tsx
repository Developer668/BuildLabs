import { LoaderCircle } from "lucide-react";

export default function Loading() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-busy="true" aria-live="polite">
        <div className="auth-panel-top">
          <LoaderCircle aria-hidden="true" size={24} />
          <h1>Opening workspace</h1>
          <p>Waiting for an authenticated durable projection.</p>
        </div>
        <div className="loading-state">
          <span className="skeleton project-skeleton" />
          <strong>Loading project state</strong>
          <p>
            No activity or provider health is inferred while data is absent.
          </p>
        </div>
      </section>
    </main>
  );
}
