import {
  Activity,
  Bell,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Columns2,
  Command,
  ExternalLink,
  FileCode2,
  FileDiff,
  FileText,
  Folder,
  Gauge,
  Grid2X2,
  Home,
  ListChecks,
  Maximize2,
  Menu,
  Monitor,
  Mountain,
  PanelLeft,
  PanelsTopLeft,
  Pause,
  Play,
  PlugZap,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TestTube2,
  Unplug,
  User,
  Users,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  loadConnection,
  loadStudioRuns,
  loadStudioSelection,
  StudioApiError,
} from "./api";
import { demoRuns, demoSelection } from "./demo";
import type {
  EvidenceReceipt,
  RunEvent,
  RunStage,
  RunStatus,
  StudioConnection,
  StudioRun,
  StudioSelection,
} from "./types";

type DataMode = "connecting" | "live" | "demo";
type LayoutMode = "focus" | "two" | "four";
type InspectorTab = "activity" | "contract" | "proof" | "diff" | "tree";
type MonitorTab = "preview" | "code" | "diff" | "terminal" | "components";
type NavView =
  | "home"
  | "studio"
  | "runs"
  | "projects"
  | "delivery"
  | "people"
  | "integrations";

const stageOrder: RunStage[] = [
  "queued",
  "provisioning",
  "generating",
  "verifying",
  "reviewing",
  "evaluating",
  "finalizing",
  "complete",
];

const inspectorTabs: Array<{
  id: InspectorTab;
  label: string;
}> = [
  { id: "activity", label: "Activity" },
  { id: "contract", label: "Contract" },
  { id: "proof", label: "Proof" },
  { id: "diff", label: "Diff" },
  { id: "tree", label: "Tree" },
];

const monitorTabs: Array<{
  id: MonitorTab;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}> = [
  { id: "preview", label: "Preview", icon: Monitor },
  { id: "code", label: "Code", icon: Code2 },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "components", label: "Components", icon: Boxes },
];

export function App() {
  const [connection] = useState<StudioConnection>(loadConnection);
  const [mode, setMode] = useState<DataMode>("connecting");
  const [runs, setRuns] = useState<StudioRun[]>(demoRuns);
  const [selectedId, setSelectedId] = useState(demoRuns[1]!.run.id);
  const [selection, setSelection] = useState<StudioSelection>(
    demoSelection(demoRuns[1]!),
  );
  const [connectionMessage, setConnectionMessage] = useState(
    "Connecting to the BuildLabs backend…",
  );
  const [layout, setLayout] = useState<LayoutMode>("focus");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("activity");
  const [monitorTab, setMonitorTab] = useState<MonitorTab>("preview");
  const [paused, setPaused] = useState(false);
  const [navView, setNavView] = useState<NavView>("studio");
  const [profileOpen, setProfileOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [reviewDraft, setReviewDraft] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState(430);
  const [candidateHeight, setCandidateHeight] = useState(207);
  const [toast, setToast] = useState<{
    id: number;
    icon: "search" | "bell" | "contract" | "evidence";
    title: string;
    body: string;
  } | null>(null);

  const selectedRun =
    runs.find((item) => item.run.id === selectedId) ?? runs[0] ?? demoRuns[0]!;

  const showToast = useCallback(
    (
      icon: "search" | "bell" | "contract" | "evidence",
      title: string,
      body: string,
    ) => {
      const id = Date.now();
      setToast({ id, icon, title, body });
      window.setTimeout(() => {
        setToast((current) => (current && current.id === id ? null : current));
      }, 3200);
    },
    [],
  );

  const refreshRuns = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await loadStudioRuns(connection, signal);
        if (response.runs.length === 0) {
          setMode("demo");
          setRuns(demoRuns);
          setConnectionMessage(
            "Backend connected; no build runs yet. Waiting for work to arrive.",
          );
          return;
        }
        setRuns(response.runs);
        setMode("live");
        setConnectionMessage("Live backend connected");
        setSelectedId((current) =>
          response.runs.some((item) => item.run.id === current)
            ? current
            : response.runs[0]!.run.id,
        );
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        setMode("demo");
        setRuns(demoRuns);
        setConnectionMessage(
          error instanceof StudioApiError && error.status === 401
            ? "Backend token required. Disconnected."
            : "Backend unavailable. Disconnected.",
        );
      }
    },
    [connection],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshRuns(controller.signal);
    return () => controller.abort();
  }, [refreshRuns]);

  useEffect(() => {
    if (paused) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshRuns();
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [paused, refreshRuns]);

  useEffect(() => {
    if (mode !== "live") {
      setSelection(demoSelection(selectedRun));
      return;
    }
    const controller = new AbortController();
    void loadStudioSelection(connection, selectedRun, controller.signal)
      .then(setSelection)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnectionMessage(
            error instanceof Error
              ? `Candidate detail unavailable: ${error.message}`
              : "Candidate detail unavailable",
          );
        }
      });
    return () => controller.abort();
  }, [connection, mode, selectedRun]);

  const projectName = formatProjectName(selectedRun.run.projectId);
  const projectRuns = useMemo(
    () =>
      runs.filter((item) => item.run.projectId === selectedRun.run.projectId),
    [runs, selectedRun.run.projectId],
  );
  const completedSlots = projectRuns.filter((item) =>
    ["passed", "rejected", "failed", "cancelled"].includes(item.run.status),
  ).length;
  const activeSlots = projectRuns.filter(
    (item) => item.run.status === "running",
  ).length;

  const requestReview = () => {
    const normalized = draft.trim();
    if (!normalized) {
      return;
    }
    setReviewDraft(normalized);
    setDraft("");
  };

  const beginWorkspaceResize = (
    axis: "columns" | "rows",
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startInspectorWidth = inspectorWidth;
    const startCandidateHeight = candidateHeight;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor =
      axis === "columns" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (axis === "columns") {
        setInspectorWidth(
          Math.min(
            620,
            Math.max(310, startInspectorWidth + startX - moveEvent.clientX),
          ),
        );
        return;
      }

      setCandidateHeight(
        Math.min(
          340,
          Math.max(118, startCandidateHeight + startY - moveEvent.clientY),
        ),
      );
    };

    const stopResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  };

  return (
    <div className="app-shell">
      <IconRail
        view={navView}
        onViewChange={setNavView}
        profileOpen={profileOpen}
        onProfileToggle={() => setProfileOpen((value) => !value)}
        onProfileClose={() => setProfileOpen(false)}
      />

      <header className="topbar">
        <div className="topbar-project">
          <span className="studio-label">Admin Studio</span>
          <span className="topbar-divider" />
          <button className="project-switcher" type="button">
            <User size={15} className="project-icon" />
            {projectName}
            <ChevronDown size={14} />
          </button>
        </div>
        <LifecycleBar run={selectedRun} />
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Search"
            onClick={() =>
              showToast(
                "search",
                "Search",
                "Search across runs, projects, and evidence is not connected to live data yet.",
              )
            }
          >
            <Search size={18} />
          </button>
          <span className="slot-count">
            {activeSlots + completedSlots} / 4 slots
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Notifications"
            onClick={() =>
              showToast(
                "bell",
                "No new notifications",
                "Run status changes and proven-candidate alerts will appear here once the backend is connected.",
              )
            }
          >
            <Bell size={18} />
          </button>
        </div>
      </header>

      {navView === "studio" ? (
        <main className="studio">
          <section className="studio-toolbar">
            <div>
              <strong>
                Run {String(selectedRun.run.slotId ?? 1).padStart(2, "0")}
              </strong>
              <span className="muted-dot">•</span>
              <span>{timeAgo(selectedRun.run.createdAt)}</span>
              <StatusPill mode={mode} message={connectionMessage} />
            </div>
            <LayoutControl value={layout} onChange={setLayout} />
            <div className="toolbar-end">
              <button
                className="quiet-button"
                type="button"
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
                {paused ? "Resume live updates" : "Pause live updates"}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setInspectorTab("proof")}
              >
                <ShieldCheck size={15} />
                Open evidence
              </button>
            </div>
          </section>

          <div
            className="studio-grid"
            style={
              {
                "--inspector-width": `${inspectorWidth}px`,
                "--candidate-height": `${candidateHeight}px`,
              } as CSSProperties
            }
          >
            <section className="workbench">
              <MonitorArea
                layout={layout}
                runs={projectRuns}
                selected={selectedRun}
                selection={selection}
                mode={mode}
                monitorTab={monitorTab}
                onSelect={(run) => setSelectedId(run.run.id)}
                onTabChange={setMonitorTab}
                onExpand={() =>
                  setLayout(layout === "focus" ? "four" : "focus")
                }
              />
              <MonitorTabs
                value={monitorTab}
                onChange={setMonitorTab}
                previewUrl={selection.preview?.url}
              />
              <button
                className="workspace-resizer workspace-resizer-horizontal"
                type="button"
                aria-label="Resize monitor and candidate areas"
                title="Drag to resize monitor and candidate areas"
                onPointerDown={(event) => beginWorkspaceResize("rows", event)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp") {
                    setCandidateHeight((height) => Math.min(340, height + 16));
                  } else if (event.key === "ArrowDown") {
                    setCandidateHeight((height) => Math.max(118, height - 16));
                  }
                }}
              />
              <CandidateStrip
                runs={projectRuns}
                selectedId={selectedRun.run.id}
                mode={mode}
                onSelect={(run) => {
                  setSelectedId(run.run.id);
                  setLayout("focus");
                }}
              />
            </section>

            <button
              className="workspace-resizer workspace-resizer-vertical"
              type="button"
              aria-label="Resize workspace and activity panel"
              title="Drag to resize workspace and activity panel"
              onPointerDown={(event) => beginWorkspaceResize("columns", event)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  setInspectorWidth((width) => Math.min(620, width + 20));
                } else if (event.key === "ArrowRight") {
                  setInspectorWidth((width) => Math.max(310, width - 20));
                }
              }}
            />

            <Inspector
              activeTab={inspectorTab}
              onTabChange={setInspectorTab}
              selection={selection}
              allRuns={projectRuns}
              mode={mode}
              onNotice={showToast}
            />
          </div>
        </main>
      ) : (
        <NavPage
          view={navView}
          runs={runs}
          mode={mode}
          onSelectRun={(run) => {
            setSelectedId(run.run.id);
            setNavView("studio");
          }}
        />
      )}

      {navView === "studio" ? (
        <AssistantBar
          value={draft}
          onChange={setDraft}
          onSubmit={requestReview}
          reviewDraft={reviewDraft}
          onClearReview={() => setReviewDraft("")}
        />
      ) : (
        <div className="assistant-spacer" />
      )}
      {toast ? (
        <div className="toast" role="status" key={toast.id}>
          <span className="toast-icon">
            {toast.icon === "search" ? (
              <Search size={15} />
            ) : toast.icon === "bell" ? (
              <Bell size={15} />
            ) : toast.icon === "contract" ? (
              <FileText size={15} />
            ) : (
              <ShieldCheck size={15} />
            )}
          </span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            <span>{toast.body}</span>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IconRail({
  view,
  onViewChange,
  profileOpen,
  onProfileToggle,
  onProfileClose,
}: {
  view: NavView;
  onViewChange: (view: NavView) => void;
  profileOpen: boolean;
  onProfileToggle: () => void;
  onProfileClose: () => void;
}) {
  const navItems: Array<{
    id: NavView;
    label: string;
    icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  }> = [
    { id: "home", label: "Home", icon: Home },
    { id: "studio", label: "Studio", icon: Monitor },
    { id: "runs", label: "Runs", icon: ListChecks },
    { id: "projects", label: "Projects", icon: Folder },
    { id: "delivery", label: "Delivery", icon: PanelsTopLeft },
    { id: "people", label: "People", icon: Users },
    { id: "integrations", label: "Integrations", icon: PlugZap },
  ];
  return (
    <nav className="icon-rail" aria-label="Primary navigation">
      <div className="brand-mark" aria-label="BuildLabs">
        <img
          src={`${import.meta.env.BASE_URL}buildlabs-logo.png`}
          alt=""
          aria-hidden="true"
        />
      </div>
      <div className="rail-items">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            className={`rail-button ${view === id ? "active" : ""}`}
            type="button"
            key={id}
            aria-label={label}
            aria-current={view === id ? "page" : undefined}
            title={label}
            onClick={() => onViewChange(id)}
          >
            <Icon size={19} strokeWidth={1.7} />
          </button>
        ))}
      </div>
      <div className="rail-bottom">
        <button
          className="avatar"
          type="button"
          aria-label="Operator profile"
          aria-expanded={profileOpen}
          onClick={onProfileToggle}
        >
          JM
        </button>
        {profileOpen ? (
          <>
            <button
              className="profile-backdrop"
              type="button"
              aria-label="Close profile menu"
              onClick={onProfileClose}
            />
            <div className="profile-menu" role="menu">
              <div className="profile-head">
                <span className="avatar static">JM</span>
                <div>
                  <strong>Jordan Mills</strong>
                  <small>Operator</small>
                </div>
              </div>
              <button type="button" role="menuitem" onClick={onProfileClose}>
                <ExternalLink size={15} />
                Sign out
              </button>
            </div>
          </>
        ) : null}
      </div>
    </nav>
  );
}

function LifecycleBar({ run }: { run: StudioRun }) {
  const currentIndex = stageOrder.indexOf(run.run.stage);
  const items = [
    { label: "Paid", complete: true },
    { label: "Contract v2", complete: true },
    {
      label: titleCase(run.run.stage),
      complete: run.run.status === "passed",
      active: run.run.status === "running",
    },
    {
      label: run.run.status === "passed" ? "Proof passed" : "Proof pending",
      complete: run.run.status === "passed",
    },
    {
      label: run.artifactAvailable ? "Delivery ready" : "Deploy locked",
      complete: run.artifactAvailable,
    },
  ];
  return (
    <div className="lifecycle" aria-label="Run lifecycle">
      <ol className="lifecycle-track">
        {items.map((item, index) => (
          <li
            className={`lifecycle-step ${
              item.complete ? "complete" : item.active ? "active" : "pending"
            }`}
            key={`${item.label}-${index}`}
          >
            <span className="lifecycle-dot">
              {item.complete ? (
                <Check size={11} strokeWidth={2.5} />
              ) : item.active ? (
                <span className="lifecycle-pulse" />
              ) : null}
            </span>
            <span className="lifecycle-name">{item.label}</span>
            {index < items.length - 1 ? (
              <span
                className={`lifecycle-link ${item.complete ? "complete" : ""}`}
                aria-hidden
              />
            ) : null}
          </li>
        ))}
      </ol>
      <span className="sr-only">Current stage index {currentIndex}</span>
    </div>
  );
}

function StatusPill({ mode, message }: { mode: DataMode; message: string }) {
  return (
    <button className={`connection-pill ${mode}`} type="button" title={message}>
      <span />
      {mode === "live"
        ? "Live"
        : mode === "connecting"
          ? "Connecting"
          : "Disconnected"}
    </button>
  );
}

function LayoutControl({
  value,
  onChange,
}: {
  value: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}) {
  return (
    <div className="segmented-control" aria-label="Monitor layout">
      <button
        type="button"
        className={value === "focus" ? "active" : ""}
        onClick={() => onChange("focus")}
      >
        <PanelLeft size={14} />
        Focus
      </button>
      <button
        type="button"
        className={value === "two" ? "active" : ""}
        onClick={() => onChange("two")}
      >
        <Columns2 size={14} />
        2-up
      </button>
      <button
        type="button"
        className={value === "four" ? "active" : ""}
        onClick={() => onChange("four")}
      >
        <Grid2X2 size={14} />
        4-up
      </button>
      <button type="button" aria-label="Add monitor" title="Add monitor">
        <Plus size={15} />
      </button>
    </div>
  );
}

function MonitorArea({
  layout,
  runs,
  selected,
  selection,
  mode,
  monitorTab,
  onSelect,
  onTabChange,
  onExpand,
}: {
  layout: LayoutMode;
  runs: StudioRun[];
  selected: StudioRun;
  selection: StudioSelection;
  mode: DataMode;
  monitorTab: MonitorTab;
  onSelect: (run: StudioRun) => void;
  onTabChange: (tab: MonitorTab) => void;
  onExpand: () => void;
}) {
  const count = layout === "focus" ? 1 : layout === "two" ? 2 : 4;
  const visible = [selected, ...runs.filter((run) => run !== selected)].slice(
    0,
    count,
  );
  return (
    <div className={`monitor-layout monitor-layout-${layout}`}>
      {visible.map((run, index) => (
        <article
          className={`monitor-frame ${
            run.run.id === selected.run.id ? "selected" : ""
          }`}
          key={run.run.id}
          onClick={() => {
            if (layout !== "focus") {
              onSelect(run);
            }
          }}
        >
          <MonitorHeader
            run={run}
            focused={layout === "focus"}
            monitorTab={monitorTab}
            onTabChange={onTabChange}
            onExpand={onExpand}
          />
          <div className="monitor-content">
            {layout !== "focus" && index > 0 ? (
              mode === "demo" ? (
                <DisconnectedState />
              ) : (
                <SitePreview variant={index} compact />
              )
            ) : (
              <MonitorContent
                tab={monitorTab}
                selection={selection}
                mode={mode}
              />
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function MonitorHeader({
  run,
  focused,
  monitorTab,
  onTabChange,
  onExpand,
}: {
  run: StudioRun;
  focused: boolean;
  monitorTab: MonitorTab;
  onTabChange: (tab: MonitorTab) => void;
  onExpand: () => void;
}) {
  const label = candidateLabel(run);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="monitor-header">
      <div className="monitor-title">
        <span className="drag-handle" aria-hidden>
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <strong>{label}</strong>
        <span>•</span>
        <span>{titleCase(run.assignment?.strategyLabel ?? run.run.stage)}</span>
      </div>
      <div className="monitor-status">
        <span className={`run-state ${run.run.status}`}>
          {titleCase(run.run.stage)}
        </span>
      </div>
      <div className="monitor-actions">
        <button
          className="icon-button small"
          type="button"
          aria-label="Inspect components"
          title="Inspect components"
          onClick={() => onTabChange("components")}
        >
          <CircleDot size={15} />
        </button>
        <button
          className="icon-button small"
          type="button"
          aria-label={focused ? "Expand to grid" : "Focus monitor"}
          title={focused ? "Expand to grid" : "Focus monitor"}
          onClick={onExpand}
        >
          <Maximize2 size={15} />
        </button>
        <div className="monitor-menu-wrap">
          <button
            className="icon-button small"
            type="button"
            aria-label="Monitor view menu"
            title="Monitor view menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Menu size={16} />
          </button>
          {menuOpen ? (
            <>
              <button
                className="monitor-menu-backdrop"
                type="button"
                aria-label="Close monitor menu"
                onClick={() => setMenuOpen(false)}
              />
              <div className="monitor-menu" role="menu">
                {monitorTabs.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={monitorTab === id}
                    className={monitorTab === id ? "active" : ""}
                    onClick={() => {
                      onTabChange(id);
                      setMenuOpen(false);
                    }}
                  >
                    <Icon size={14} strokeWidth={1.7} />
                    {label}
                    {monitorTab === id ? <Check size={13} /> : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MonitorContent({
  tab,
  selection,
  mode,
}: {
  tab: MonitorTab;
  selection: StudioSelection;
  mode: DataMode;
}) {
  if (mode === "demo") {
    return <DisconnectedState />;
  }
  if (tab === "preview") {
    if (selection.preview?.url) {
      return (
        <iframe
          className="preview-iframe"
          src={selection.preview.url}
          title={`Raw operator preview for ${selection.run.run.candidateId}`}
          sandbox="allow-forms allow-scripts allow-same-origin"
        />
      );
    }
    return <SitePreview variant={selection.run.run.slotId ?? 1} />;
  }
  if (tab === "code") {
    return <CodeMonitor events={selection.events} mode={mode} />;
  }
  if (tab === "diff") {
    return (
      <DiffMonitor events={selection.events} evidence={selection.evidence} />
    );
  }
  if (tab === "terminal") {
    return <TerminalMonitor events={selection.events} />;
  }
  return <ComponentMonitor run={selection.run} />;
}

function DisconnectedState() {
  return (
    <div className="disconnected-state">
      <Unplug size={26} />
      <p>Disconnected</p>
      <span>
        The build backend is not reachable. Live monitors will appear once a
        connection is established.
      </span>
    </div>
  );
}

function SitePreview({
  variant = 1,
  compact = false,
}: {
  variant?: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`site-preview variant-${(variant % 4) + 1} ${compact ? "compact" : ""}`}
    >
      <header className="site-nav">
        <div className="site-logo">
          <Mountain size={28} strokeWidth={1.5} />
          <span>
            <strong>MISSION PEAK</strong>
            <small>ELECTRIC</small>
          </span>
        </div>
        <nav aria-label="Preview website navigation">
          <span>Services</span>
          <span>About</span>
          <span>Contact</span>
          {compact ? (
            <span className="site-cta">Request an estimate</span>
          ) : (
            <button type="button">Request an estimate</button>
          )}
        </nav>
      </header>
      <section className="site-hero">
        <div className="site-copy">
          <p className="eyebrow">RESIDENTIAL ELECTRICAL</p>
          <h1>
            Powering
            <br />
            what’s next.
          </h1>
          <p>
            EV chargers and electrical panels for Fremont, Newark, and Union
            City.
          </p>
          {compact ? (
            <span className="site-cta">Request an estimate</span>
          ) : (
            <button type="button">Request an estimate</button>
          )}
        </div>
        <ChargingScene variant={variant} />
      </section>
      <footer className="site-services">
        <div>
          <PlugZap size={25} />
          <span>EV chargers</span>
        </div>
        <div>
          <PanelsTopLeft size={25} />
          <span>Electrical panels</span>
        </div>
        <div>
          <Mountain size={25} />
          <span>Fremont · Newark · Union City</span>
        </div>
      </footer>
    </div>
  );
}

function ChargingScene({ variant }: { variant: number }) {
  return (
    <div
      className={`charging-scene scene-${(variant % 4) + 1}`}
      aria-label="EV charger installation"
    >
      <span className="wall-line one" />
      <span className="wall-line two" />
      <div className="charger">
        <span className="charger-screen" />
        <span className="charger-port" />
      </div>
      <div className="cable cable-one" />
      <div className="cable cable-two" />
      <div className="panel-box">
        <span />
        <span />
        <span />
      </div>
      <div className="plant">
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

function MonitorTabs({
  value,
  onChange,
  previewUrl,
}: {
  value: MonitorTab;
  onChange: (tab: MonitorTab) => void;
  previewUrl: string | undefined;
}) {
  return (
    <div className="monitor-tabs">
      <div
        className="monitor-tab-list"
        role="tablist"
        aria-label="Monitor view"
      >
        {monitorTabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            role="tab"
            aria-selected={value === id}
            className={value === id ? "active" : ""}
            onClick={() => onChange(id)}
            key={id}
          >
            <Icon size={15} strokeWidth={1.7} />
            {label}
          </button>
        ))}
      </div>
      <div className="viewport-tools">
        <button className="active" type="button" aria-label="Desktop viewport">
          <Monitor size={16} />
        </button>
        <button type="button" aria-label="Tablet viewport">
          <PanelLeft size={15} />
        </button>
        <button type="button" aria-label="Mobile viewport">
          <Command size={15} />
        </button>
        {previewUrl ? (
          <a href={previewUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />
            Open raw preview
          </a>
        ) : null}
      </div>
    </div>
  );
}

function CandidateStrip({
  runs,
  selectedId,
  mode,
  onSelect,
}: {
  runs: StudioRun[];
  selectedId: string;
  mode: DataMode;
  onSelect: (run: StudioRun) => void;
}) {
  return (
    <section className="candidate-section">
      <header>
        <div>
          <strong>Candidates</strong>
          <span className="candidate-count">{runs.length} active slots</span>
        </div>
        <button className="compare-control" type="button">
          <span />
          Compare selected
        </button>
      </header>
      <div className="candidate-strip">
        {runs.slice(0, 4).map((run, index) => (
          <button
            className={`candidate-card ${
              run.run.id === selectedId ? "selected" : ""
            } ${mode === "demo" ? "disconnected" : ""}`}
            type="button"
            key={run.run.id}
            onClick={() => onSelect(run)}
          >
            <div className="candidate-thumb">
              {mode === "demo" ? (
                <span className="thumb-disconnected">
                  <Unplug size={18} />
                  Offline
                </span>
              ) : (
                <SitePreview variant={index + 1} compact />
              )}
              <Maximize2 size={14} />
            </div>
            <div className="candidate-meta">
              <span>
                {String(run.run.slotId ?? index + 1).padStart(2, "0")}
              </span>
              <strong>
                {candidateLabel(run).replace(/^Candidate \d+ · /, "")}
              </strong>
              <span className={`candidate-state ${run.run.status}`}>
                {titleCase(run.run.stage)}
              </span>
            </div>
            <p>
              {eventSummary(run.activity.latestEvent) ??
                titleCase(run.assignment?.strategyLabel ?? "Waiting for work")}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}

function Inspector({
  activeTab,
  onTabChange,
  selection,
  allRuns,
  mode,
  onNotice,
}: {
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  selection: StudioSelection;
  allRuns: StudioRun[];
  mode: DataMode;
  onNotice: (
    icon: "search" | "bell" | "contract" | "evidence",
    title: string,
    body: string,
  ) => void;
}) {
  return (
    <aside className="inspector">
      <div className="inspector-tabs" role="tablist" aria-label="Run inspector">
        {inspectorTabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => onTabChange(tab.id)}
            key={tab.id}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {activeTab === "activity" ? (
          <ActivityPanel selection={selection} allRuns={allRuns} mode={mode} />
        ) : null}
        {activeTab === "contract" ? (
          <ContractPanel selection={selection} />
        ) : null}
        {activeTab === "proof" ? <ProofPanel selection={selection} /> : null}
        {activeTab === "diff" ? (
          <DiffPanel events={selection.events} evidence={selection.evidence} />
        ) : null}
        {activeTab === "tree" ? <TreePanel run={selection.run} /> : null}
      </div>
      <div className="inspector-footer">
        <button
          type="button"
          onClick={() => {
            onTabChange("contract");
            onNotice(
              "contract",
              "Acceptance contract",
              "Opening the contract panel. Requirements and verifiers are shown for the selected candidate.",
            );
          }}
        >
          <FileText size={14} />
          Acceptance contract
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => {
            onTabChange("proof");
            onNotice(
              "evidence",
              "Immutable evidence",
              "Opening the proof panel. Evidence receipts are shown for the selected candidate.",
            );
          }}
        >
          <ShieldCheck size={14} />
          Immutable evidence
          <ChevronRight size={14} />
        </button>
      </div>
    </aside>
  );
}

function ActivityPanel({
  selection,
  allRuns,
  mode,
}: {
  selection: StudioSelection;
  allRuns: StudioRun[];
  mode: DataMode;
}) {
  const selected = selection.run;
  const totalEvents = allRuns.reduce(
    (total, run) => total + run.activity.eventCount,
    0,
  );
  return (
    <>
      <section className="inspector-section live-run">
        <div className="section-heading">
          <div>
            <h2>Live run</h2>
            <p>
              {allRuns.length} candidates · {totalEvents} events · Contract v
              {selected.assignment?.contract.contractRevision ?? "—"}
            </p>
          </div>
          <span className={`mode-indicator ${mode}`}>
            {mode === "live" ? "LIVE" : "DEMO"}
          </span>
        </div>
      </section>

      <section className="inspector-section agents-now">
        <h3>Now</h3>
        <div className="agent-list">
          {allRuns.slice(0, 4).map((run, index) => (
            <article className="agent-row" key={run.run.id}>
              <div className="agent-line">
                <span>A{String(index + 1).padStart(2, "0")}</span>
                <strong>
                  {candidateLabel(run).replace(/^Candidate \d+ · /, "")}
                </strong>
                <small>{titleCase(run.run.stage)}</small>
              </div>
              <div className="agent-detail">
                <span>
                  {eventSummary(run.activity.latestEvent) ??
                    "Waiting for the next durable event"}
                </span>
                <code>{eventFileHint(run.activity.latestEvent)}</code>
              </div>
              <StageProgress stage={run.run.stage} status={run.run.status} />
            </article>
          ))}
        </div>
      </section>

      <section className="inspector-section run-stages">
        <h3>Run stages</h3>
        <StageList run={selected} />
      </section>

      <section className="inspector-section attention-section">
        <h3>Attention</h3>
        {selected.proof.failed + selected.proof.errors > 0 ? (
          <button className="attention-card" type="button">
            <Gauge size={15} />
            <span>
              {selected.proof.failed + selected.proof.errors} proof checks need
              review
            </span>
            <ChevronRight size={15} />
          </button>
        ) : (
          <div className="quiet-state">
            <CheckCircle2 size={15} />
            No unresolved proof failures for this candidate
          </div>
        )}
      </section>
    </>
  );
}

function StageProgress({
  stage,
  status,
}: {
  stage: RunStage;
  status: StudioRun["run"]["status"];
}) {
  const index = stageOrder.indexOf(stage);
  const width =
    status === "passed"
      ? 100
      : status === "failed" || status === "rejected"
        ? Math.max(12, ((index + 1) / stageOrder.length) * 100)
        : Math.max(8, ((index + 0.55) / stageOrder.length) * 100);
  return (
    <div className="stage-progress" aria-label={`Run is ${stage}`}>
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

function StageList({ run }: { run: StudioRun }) {
  const current = stageOrder.indexOf(run.run.stage);
  const stages = [
    { id: "queued", label: "Intake", detail: "assignment accepted" },
    { id: "provisioning", label: "Payment", detail: "verified upstream" },
    { id: "generating", label: "Candidate build", detail: "sandbox work" },
    { id: "verifying", label: "Automated review", detail: "durable checks" },
    { id: "reviewing", label: "Proof gate", detail: "evidence review" },
    { id: "finalizing", label: "Frozen preview", detail: "immutable output" },
    { id: "complete", label: "Deploy + delivery", detail: "artifact release" },
  ] as const;
  return (
    <ol className="stage-list">
      {stages.map((stage) => {
        const index = stageOrder.indexOf(stage.id);
        const complete =
          run.run.status === "passed" || (current > index && current >= 0);
        const active = run.run.stage === stage.id;
        return (
          <li
            className={complete ? "complete" : active ? "active" : "locked"}
            key={stage.id}
          >
            <span className="stage-node">
              {complete ? (
                <Check size={11} />
              ) : active ? (
                <CircleDot size={11} />
              ) : null}
            </span>
            <strong>{stage.label}</strong>
            <small>
              {complete ? "complete" : active ? "active" : stage.detail}
            </small>
          </li>
        );
      })}
    </ol>
  );
}

function ContractPanel({ selection }: { selection: StudioSelection }) {
  const contract = selection.run.assignment?.contract;
  if (!contract) {
    return (
      <EmptyInspector icon={FileText} text="Contract data is unavailable." />
    );
  }
  return (
    <>
      <section className="inspector-section">
        <div className="section-heading">
          <div>
            <h2>Acceptance contract</h2>
            <p>
              Revision {contract.contractRevision} · approved{" "}
              {timeAgo(contract.approvedAt)}
            </p>
          </div>
          <span className="contract-badge">Locked</span>
        </div>
      </section>
      <section className="inspector-section">
        <h3>Requirements</h3>
        <div className="requirement-list">
          {contract.requirements.map((requirement, index) => (
            <article key={requirement.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{requirement.description}</strong>
                <small>
                  {requirement.priority} ·{" "}
                  {requirement.verifierKinds.join(" + ")}
                </small>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="inspector-section">
        <h3>Approved facts</h3>
        <ul className="fact-list">
          {contract.approvedFacts.map((fact) => (
            <li key={fact.id}>
              <Check size={13} />
              {fact.statement}
            </li>
          ))}
        </ul>
      </section>
      <section className="inspector-section">
        <h3>Claims blocked unless proven</h3>
        <ul className="claim-list">
          {contract.forbiddenClaims.map((claim) => (
            <li key={claim}>{claim}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

function ProofPanel({ selection }: { selection: StudioSelection }) {
  const evidence = selection.evidence;
  const passCount = evidence.filter((item) => item.status === "PASS").length;
  return (
    <>
      <section className="inspector-section">
        <div className="section-heading">
          <div>
            <h2>Proof ledger</h2>
            <p>
              {passCount} passed · {evidence.length - passCount} unresolved
            </p>
          </div>
          <ShieldCheck size={19} className="success-icon" />
        </div>
      </section>
      <section className="inspector-section">
        <h3>Evidence receipts</h3>
        {evidence.length > 0 ? (
          <div className="proof-list">
            {evidence.map((receipt) => (
              <article key={receipt.receiptId}>
                <span
                  className={`proof-status ${receipt.status.toLowerCase()}`}
                >
                  {receipt.status === "PASS" ? (
                    <Check size={12} />
                  ) : (
                    <X size={12} />
                  )}
                </span>
                <div>
                  <strong>{titleCase(receipt.kind)}</strong>
                  <small>
                    {receipt.provider} · {formatDuration(receipt.durationMs)}
                  </small>
                </div>
                <time>{timeAgo(receipt.completedAt)}</time>
              </article>
            ))}
          </div>
        ) : (
          <div className="quiet-state">
            <TestTube2 size={15} />
            Proof has not produced any receipts yet
          </div>
        )}
      </section>
      <section className="inspector-section">
        <h3>Gate</h3>
        <div className="gate-card">
          <ShieldCheck size={18} />
          <div>
            <strong>
              {selection.run.run.status === "passed"
                ? "Candidate is proven"
                : "Delivery remains locked"}
            </strong>
            <p>
              Promotion requires passing evidence for every hard requirement.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

function DiffPanel({
  events,
  evidence,
}: {
  events: RunEvent[];
  evidence: EvidenceReceipt[];
}) {
  const changes = deriveChanges(events, evidence);
  return (
    <>
      <section className="inspector-section">
        <div className="section-heading">
          <div>
            <h2>Change summary</h2>
            <p>Derived from durable events and review receipts</p>
          </div>
          <FileDiff size={18} />
        </div>
      </section>
      <section className="inspector-section">
        <div className="change-list">
          {changes.map((change, index) => (
            <article key={`${change.title}-${index}`}>
              <span className={change.tone}>{change.kind}</span>
              <div>
                <strong>{change.title}</strong>
                <p>{change.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function TreePanel({ run }: { run: StudioRun }) {
  const requirements = run.assignment?.contract.requirements ?? [];
  return (
    <>
      <section className="inspector-section">
        <div className="section-heading">
          <div>
            <h2>Project tree</h2>
            <p>Contract-derived view · no sandbox file reads</p>
          </div>
          <Braces size={18} />
        </div>
      </section>
      <section className="inspector-section project-tree">
        <TreeRow icon={Folder} label="app" open depth={0} />
        <TreeRow icon={Folder} label="(site)" open depth={1} />
        <TreeRow icon={FileCode2} label="page.tsx" depth={2} active />
        <TreeRow icon={Folder} label="components" open depth={1} />
        {requirements.map((requirement) => (
          <TreeRow
            key={requirement.id}
            icon={FileCode2}
            label={`${titleCase(requirement.id)}.tsx`}
            depth={2}
          />
        ))}
        <TreeRow icon={Folder} label="tests" depth={1} />
        <TreeRow icon={FileCode2} label="acceptance.spec.ts" depth={2} />
      </section>
    </>
  );
}

function TreeRow({
  icon: Icon,
  label,
  depth,
  open,
  active,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  depth: number;
  open?: boolean;
  active?: boolean;
}) {
  return (
    <div
      className={`tree-row ${active ? "active" : ""}`}
      style={{ paddingLeft: `${10 + depth * 18}px` }}
    >
      {open !== undefined ? (
        open ? (
          <ChevronDown size={13} />
        ) : (
          <ChevronRight size={13} />
        )
      ) : (
        <span className="tree-spacer" />
      )}
      <Icon size={14} />
      <span>{label}</span>
    </div>
  );
}

function CodeMonitor({ events, mode }: { events: RunEvent[]; mode: DataMode }) {
  const payload = events.at(-1)?.payload ?? {
    message: "Waiting for a durable run event",
  };
  const lines = JSON.stringify(payload, null, 2).split("\n");
  return (
    <div className="code-monitor">
      <aside className="code-tree">
        <div className="code-tree-title">EXPLORER</div>
        <TreeRow icon={Folder} label="app" open depth={0} />
        <TreeRow icon={Folder} label="(site)" open depth={1} />
        <TreeRow icon={FileCode2} label="page.tsx" depth={2} active />
        <TreeRow icon={Folder} label="components" open depth={1} />
        <TreeRow icon={FileCode2} label="Hero.tsx" depth={2} />
        <TreeRow icon={FileCode2} label="EstimateForm.tsx" depth={2} />
      </aside>
      <div className="code-editor">
        <div className="editor-tab">
          <FileCode2 size={14} />
          Latest event payload
          <span>{mode === "live" ? "REST" : "SAMPLE"}</span>
        </div>
        <pre>
          {lines.map((line, index) => (
            <span className="code-line" key={`${line}-${index}`}>
              <i>{index + 1}</i>
              <code>{line}</code>
            </span>
          ))}
        </pre>
        <div className="editor-notice">
          Source browsing is intentionally separate from the current read-only
          studio API.
        </div>
      </div>
    </div>
  );
}

function DiffMonitor({
  events,
  evidence,
}: {
  events: RunEvent[];
  evidence: EvidenceReceipt[];
}) {
  const changes = deriveChanges(events, evidence);
  return (
    <div className="diff-monitor">
      <header>
        <span>Verified change summary</span>
        <small>{changes.length} durable signals</small>
      </header>
      {changes.map((change, index) => (
        <div className="diff-row" key={`${change.title}-${index}`}>
          <span className={`diff-marker ${change.tone}`}>
            {change.tone === "positive"
              ? "+"
              : change.tone === "negative"
                ? "−"
                : "•"}
          </span>
          <div>
            <strong>{change.title}</strong>
            <p>{change.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function TerminalMonitor({ events }: { events: RunEvent[] }) {
  return (
    <div className="terminal-monitor">
      <header>
        <span>TERMINAL</span>
        <small>Durable event output</small>
      </header>
      <div className="terminal-lines">
        {events.length > 0 ? (
          events.map((event) => (
            <p key={event.sequence}>
              <time>{formatClock(event.createdAt)}</time>
              <span
                className={event.type.includes("fail") ? "error" : "prompt"}
              >
                ›
              </span>
              <strong>{event.type}</strong>
              <span>{eventSummary(event)}</span>
            </p>
          ))
        ) : (
          <p>
            <span className="prompt">›</span>
            Waiting for the first durable event…
          </p>
        )}
      </div>
    </div>
  );
}

function ComponentMonitor({ run }: { run: StudioRun }) {
  const requirements = run.assignment?.contract.requirements ?? [];
  return (
    <div className="component-monitor">
      <header>
        <div>
          <span>Component map</span>
          <small>Mapped from acceptance requirements</small>
        </div>
        <Boxes size={18} />
      </header>
      <div className="component-canvas">
        <ComponentNode label="App shell" type="root" />
        <div className="component-branch">
          {requirements.map((requirement) => (
            <ComponentNode
              key={requirement.id}
              label={titleCase(requirement.id)}
              type={requirement.priority}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ComponentNode({ label, type }: { label: string; type: string }) {
  return (
    <div className={`component-node ${type}`}>
      <Braces size={15} />
      <span>{label}</span>
      <small>{type}</small>
    </div>
  );
}

function AssistantBar({
  value,
  onChange,
  onSubmit,
  reviewDraft,
  onClearReview,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  reviewDraft: string;
  onClearReview: () => void;
}) {
  return (
    <footer className="assistant-shell">
      <div className="assistant-center">
        {reviewDraft ? (
          <div className="review-banner">
            <ShieldCheck size={15} />
            <span>Draft prepared for admin review: “{reviewDraft}”</span>
            <button
              type="button"
              onClick={onClearReview}
              aria-label="Dismiss draft"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
        <div className="assistant-input">
          <span className="assistant-spark">
            <Sparkles size={16} />
          </span>
          <textarea
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Inspect this run, compare candidates, or draft a verified change brief…"
            aria-label="Draft a reviewed operator action"
          />
          <button
            className="review-button"
            type="button"
            disabled={!value.trim()}
            onClick={onSubmit}
          >
            Review action
            <Send size={14} />
          </button>
        </div>
        <p className="safety-copy">
          <ShieldCheck size={13} />
          Drafts do not reach the build swarm until an admin approves them.
        </p>
      </div>
    </footer>
  );
}

function EmptyInspector({
  icon: Icon,
  text,
}: {
  icon: ComponentType<{ size?: number }>;
  text: string;
}) {
  return (
    <div className="empty-inspector">
      <Icon size={22} />
      <p>{text}</p>
    </div>
  );
}

const navPageMeta: Record<
  NavView,
  { title: string; blurb: string; icon: ComponentType<{ size?: number }> }
> = {
  home: {
    title: "Overview",
    blurb: "A snapshot of active builds, slots, and recent proof activity.",
    icon: Home,
  },
  runs: {
    title: "Runs",
    blurb: "Every visible build run across projects. Open one to inspect it.",
    icon: ListChecks,
  },
  projects: {
    title: "Projects",
    blurb: "Customer workspaces grouped by project.",
    icon: Folder,
  },
  delivery: {
    title: "Delivery",
    blurb:
      "Frozen proven previews, deployed artifacts, and delivery records live here once a candidate passes the proof gate.",
    icon: PanelsTopLeft,
  },
  people: {
    title: "People",
    blurb: "Customer and internal operator records.",
    icon: Users,
  },
  integrations: {
    title: "Integrations",
    blurb:
      "Provider configuration and health for Daytona, Fireworks, Braintrust, ElevenLabs, CopilotKit, and CodeRabbit.",
    icon: PlugZap,
  },
  studio: { title: "Studio", blurb: "", icon: Monitor },
};

function NavPage({
  view,
  runs,
  mode,
  onSelectRun,
}: {
  view: NavView;
  runs: StudioRun[];
  mode: DataMode;
  onSelectRun: (run: StudioRun) => void;
}) {
  const meta = navPageMeta[view];
  const Icon = meta.icon;
  if (view === "home") {
    const active = runs.filter((r) => r.run.status === "running").length;
    const proven = runs.filter((r) => r.run.status === "passed").length;
    const failed = runs.filter(
      (r) => r.run.status === "failed" || r.run.status === "rejected",
    ).length;
    return (
      <main className="nav-page">
        <NavPageHeader title={meta.title} blurb={meta.blurb} icon={Icon} />
        <div className="nav-card-grid">
          <NavStat
            icon={Activity}
            label="Active runs"
            value={active}
            tone="active"
          />
          <NavStat
            icon={CheckCircle2}
            label="Proven"
            value={proven}
            tone="good"
          />
          <NavStat icon={X} label="Failed" value={failed} tone="bad" />
          <NavStat
            icon={Boxes}
            label="Slots in use"
            value={`${runs.length} / 4`}
            tone="neutral"
          />
        </div>
        <RunTable
          runs={runs.slice(0, 6)}
          onSelect={onSelectRun}
          mode={mode}
          empty="No build runs are visible right now."
        />
      </main>
    );
  }
  if (view === "runs") {
    return (
      <main className="nav-page">
        <NavPageHeader title={meta.title} blurb={meta.blurb} icon={Icon} />
        <RunTable
          runs={runs}
          onSelect={onSelectRun}
          mode={mode}
          empty="No build runs are visible right now."
        />
      </main>
    );
  }
  if (view === "projects") {
    const projects = new Map<string, StudioRun[]>();
    for (const run of runs) {
      const list = projects.get(run.run.projectId) ?? [];
      list.push(run);
      projects.set(run.run.projectId, list);
    }
    return (
      <main className="nav-page">
        <NavPageHeader title={meta.title} blurb={meta.blurb} icon={Icon} />
        <div className="nav-card-grid">
          {Array.from(projects.entries()).map(([projectId, projectRuns]) => (
            <button
              key={projectId}
              type="button"
              className="nav-card project-card"
              onClick={() => {
                const first = projectRuns[0];
                if (first) {
                  onSelectRun(first);
                }
              }}
            >
              <Folder size={18} />
              <div>
                <strong>{formatProjectName(projectId)}</strong>
                <small>
                  {projectRuns.length} candidate
                  {projectRuns.length === 1 ? "" : "s"}
                </small>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </main>
    );
  }
  return (
    <main className="nav-page">
      <NavPageHeader title={meta.title} blurb={meta.blurb} icon={Icon} />
      <div className="nav-placeholder">
        <Icon size={26} />
        <p>This area is part of the studio information architecture.</p>
        <span>It is reserved and not yet wired to live data.</span>
      </div>
    </main>
  );
}

function NavPageHeader({
  title,
  blurb,
  icon: Icon,
}: {
  title: string;
  blurb: string;
  icon: ComponentType<{ size?: number }>;
}) {
  return (
    <header className="nav-page-header">
      <span className="nav-page-icon">
        <Icon size={18} />
      </span>
      <div>
        <h1>{title}</h1>
        <p>{blurb}</p>
      </div>
    </header>
  );
}

function NavStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  value: number | string;
  tone: "active" | "good" | "bad" | "neutral" | "warn";
}) {
  return (
    <div className={`nav-stat ${tone}`}>
      <div className="nav-stat-top">
        <span className="nav-stat-icon">
          <Icon size={15} />
        </span>
        <strong>{value}</strong>
      </div>
      <span>{label}</span>
    </div>
  );
}

const statusLabels: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

function RunTable({
  runs,
  onSelect,
  empty,
}: {
  runs: StudioRun[];
  onSelect: (run: StudioRun) => void;
  mode: DataMode;
  empty: string;
}) {
  if (runs.length === 0) {
    return (
      <div className="nav-placeholder">
        <ListChecks size={26} />
        <p>{empty}</p>
        <span>Runs appear here once the backend reports them.</span>
      </div>
    );
  }
  return (
    <div className="run-table">
      <div className="run-table-head">
        <span>Project</span>
        <span>Candidate</span>
        <span>Status</span>
        <span>Stage</span>
        <span>Proof</span>
        <span>Updated</span>
      </div>
      {runs.map((run) => {
        const proofTotal = run.proof.total;
        const proofPassed = run.proof.passed;
        return (
          <button
            key={run.run.id}
            type="button"
            className="run-table-row"
            onClick={() => onSelect(run)}
          >
            <span className="run-table-project">
              <span className={`run-status-dot ${run.run.status}`} />
              {formatProjectName(run.run.projectId)}
            </span>
            <span className="run-table-candidate">{candidateLabel(run)}</span>
            <span>
              <span className={`run-badge run-badge-${run.run.status}`}>
                {statusLabels[run.run.status]}
              </span>
            </span>
            <span className="run-table-stage">{titleCase(run.run.stage)}</span>
            <span className="run-table-proof">
              {proofTotal > 0 ? (
                <>
                  <span className="run-proof-bar">
                    <span
                      className="run-proof-fill"
                      style={{
                        width: `${(proofPassed / proofTotal) * 100}%`,
                      }}
                    />
                  </span>
                  <small>
                    {proofPassed}/{proofTotal}
                  </small>
                </>
              ) : (
                <small className="run-proof-pending">—</small>
              )}
            </span>
            <span className="run-table-time">{timeAgo(run.run.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

function deriveChanges(events: RunEvent[], evidence: EvidenceReceipt[]) {
  const changes: Array<{
    kind: string;
    title: string;
    detail: string;
    tone: "positive" | "negative" | "neutral";
  }> = [];
  for (const event of events.slice(-4)) {
    changes.push({
      kind: "EVENT",
      title: titleCase(event.type),
      detail: eventSummary(event) ?? `Stage advanced to ${event.stage}.`,
      tone: event.type.includes("fail") ? "negative" : "neutral",
    });
  }
  for (const receipt of evidence.slice(-3)) {
    changes.push({
      kind: receipt.status,
      title: `${titleCase(receipt.kind)} receipt`,
      detail:
        receipt.summary ??
        `${titleCase(receipt.provider)} recorded a ${receipt.status.toLowerCase()} result.`,
      tone: receipt.status === "PASS" ? "positive" : "negative",
    });
  }
  return changes.length > 0
    ? changes
    : [
        {
          kind: "WAITING",
          title: "No durable changes yet",
          detail: "This panel will fill as the candidate emits run events.",
          tone: "neutral" as const,
        },
      ];
}

function candidateLabel(run: StudioRun): string {
  const suffix =
    run.run.candidateId
      .replace(/^candidate[-_]?/i, "")
      .replace(/[-_]+/g, " ")
      .trim() || "candidate";
  const slot = run.run.slotId ?? 1;
  return `Candidate ${String(slot).padStart(2, "0")} · ${titleCase(suffix)}`;
}

function eventSummary(event: RunEvent | null): string | null {
  if (!event) {
    return null;
  }
  if (!event.payload || typeof event.payload !== "object") {
    return titleCase(event.type);
  }
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.toolName === "string") {
    const status = payload.ok === false ? "failed" : "completed";
    return `${titleCase(payload.toolName)} ${status}`;
  }
  if (typeof payload.command === "string") {
    return `${payload.command} ${
      typeof payload.status === "string"
        ? payload.status.toLowerCase()
        : "completed"
    }`;
  }
  if (typeof payload.finding === "string") {
    return `Repairing ${payload.finding}`;
  }
  if (typeof payload.repairedFindings === "number") {
    return `${payload.repairedFindings} review findings repaired`;
  }
  if (Array.isArray(payload.routes)) {
    return `${payload.routes.length} routes rendered`;
  }
  return titleCase(event.type);
}

function eventFileHint(event: RunEvent | null): string {
  if (!event?.payload || typeof event.payload !== "object") {
    return "";
  }
  const payload = event.payload as Record<string, unknown>;
  for (const key of ["file", "fileName", "path"]) {
    if (typeof payload[key] === "string") {
      return payload[key];
    }
  }
  return "";
}

function formatProjectName(projectId: string): string {
  return projectId
    .replace(/^project[-_]?/i, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function timeAgo(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "time unavailable";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `started ${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

function formatDuration(value?: number): string {
  if (value === undefined) {
    return "duration not recorded";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(1)}s`;
}
