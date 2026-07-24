import {
  Activity,
  Blocks,
  FileCheck2,
  Gauge,
  ListTree,
  MessageSquareText,
  PanelsTopLeft,
  ReceiptText,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

import { SessionButton } from "./session-button";

export type WorkspaceSection =
  "overview" | "build" | "requirements" | "proof" | "updates" | "operations" | "voice";

const sectionIcons = {
  overview: Gauge,
  build: PanelsTopLeft,
  requirements: ReceiptText,
  proof: ShieldCheck,
  updates: MessageSquareText,
  operations: ListTree,
  voice: MessageSquareText,
} satisfies Record<WorkspaceSection, typeof Gauge>;

export function WorkspaceShell({
  children,
  fixture,
  projectTitle,
  role,
  section = "overview",
  status,
  statusTone = "active",
  transport = "live",
}: {
  children: React.ReactNode;
  fixture: boolean;
  projectTitle: string;
  role: "Customer workspace" | "Operator studio";
  section?: WorkspaceSection;
  status: string;
  statusTone?: string;
  transport?:
    | "connecting"
    | "live"
    | "reconnecting"
    | "delayed"
    | "offline"
    | "snapshot"
    | "fixture";
}) {
  const operator = role === "Operator studio";
  const sections: WorkspaceSection[] = operator
    ? ["overview", "build", "proof", "operations", "updates"]
    : ["overview", "build", "requirements", "proof", "updates", "voice"];
  const base = operator ? "/operator" : "";
  const signOutEndpoint = operator ? "/api/operator/session" : "/logout";

  return (
    <div className="app-shell">
      <header className="topbar">
        {operator ? (
          <Link
            aria-label="BuildLabs operator home"
            className="brand"
            href="/operator"
            prefetch={false}
          >
            <span className="brand-mark" aria-hidden="true" />
            <span>BuildLabs</span>
          </Link>
        ) : (
          <a
            aria-label="BuildLabs project overview"
            className="brand"
            href="#overview"
          >
            <span className="brand-mark" aria-hidden="true" />
            <span>BuildLabs</span>
          </a>
        )}
        <div className="topbar-tools">
          {fixture ? (
            <span className="fixture-flag">
              <Blocks aria-hidden="true" size={13} />
              Deterministic fixture
            </span>
          ) : null}
          <span className="role-flag">
            {operator ? (
              <Activity aria-hidden="true" size={13} />
            ) : (
              <FileCheck2 aria-hidden="true" size={13} />
            )}
            {role}
          </span>
          <SessionButton
            csrfCookie={operator ? undefined : "buildlabs_dashboard_csrf"}
            endpoint={signOutEndpoint}
            label="End this browser session"
            method={operator ? "DELETE" : "POST"}
            redirectTo={operator ? "/operator/sign-in" : "/"}
          />
        </div>
      </header>

      <aside className="side-rail" aria-label="Workspace navigation">
        <div className="project-chip">
          <span>ACTIVE PROJECT</span>
          <strong title={projectTitle}>{projectTitle}</strong>
        </div>
        <span className="rail-label">WORKSPACE</span>
        <nav className="rail-nav">{renderLinks(sections, section, base)}</nav>
        <div className="rail-footer">
          <span>Durable state only</span>
          <span>No manual ship override</span>
        </div>
      </aside>

      <main className="main-region">
        <header className="project-header">
          <div>
            <span className="section-kicker">
              {operator ? "PROJECT CONTROL" : "PRIVATE PROJECT"}
            </span>
            <h1>{projectTitle}</h1>
          </div>
          <div className="project-header-meta">
            <span className={`status-pill ${statusTone}`}>
              <span className="status-dot" aria-hidden="true" />
              {status}
            </span>
            <span className={`transport-pill ${transport}`}>
              <span className="status-dot" aria-hidden="true" />
              {transportLabel(transport)}
            </span>
          </div>
        </header>

        <nav className="mobile-tabs" aria-label="Workspace sections">
          {renderLinks(sections, section, base)}
        </nav>
        {children}
        <nav className="bottom-nav" aria-label="Mobile workspace sections">
          {renderLinks(
            operator
              ? ["overview", "build", "proof", "operations"]
              : ["overview", "build", "proof", "updates"],
            section,
            base,
          )}
        </nav>
      </main>
    </div>
  );
}

function renderLinks(
  sections: WorkspaceSection[],
  active: WorkspaceSection,
  base: string,
): React.ReactNode {
  return sections.map((item) => {
    const Icon = sectionIcons[item];
    const href = `${base}#${item}`;
    return (
      <a
        aria-current={item === active ? "page" : undefined}
        className="rail-link"
        href={href}
        key={item}
      >
        <Icon aria-hidden="true" />
        <span>{sectionLabel(item)}</span>
      </a>
    );
  });
}

function sectionLabel(section: WorkspaceSection): string {
  return section[0]!.toUpperCase() + section.slice(1);
}

function transportLabel(
  value:
    | "connecting"
    | "live"
    | "reconnecting"
    | "delayed"
    | "offline"
    | "snapshot"
    | "fixture",
): string {
  switch (value) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Durable stream live";
    case "reconnecting":
      return "Reconnecting";
    case "delayed":
      return "Updates delayed";
    case "offline":
      return "Browser offline";
    case "snapshot":
      return "Durable snapshot";
    case "fixture":
      return "Fixture snapshot";
  }
}
