import { SearchX } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-panel-top">
          <SearchX aria-hidden="true" size={24} />
          <h1>Workspace unavailable</h1>
          <p>The requested project or route was not found.</p>
        </div>
        <div className="empty-state">
          <strong>No project state was disclosed</strong>
          <p>
            Project routes are opaque and authorization is checked separately
            from route possession.
          </p>
          <Link className="secondary-button" href="/operator/sign-in">
            Operator sign in
          </Link>
        </div>
      </section>
    </main>
  );
}
