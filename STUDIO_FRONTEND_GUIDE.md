# BuildLabs Studio frontend guide

BuildLabs Studio is the internal operator workspace for inspecting candidate
website builds. It is deliberately separate from the customer dashboard:
operators can inspect mutable work-in-progress previews and durable build
events, while customers should only receive the sanitized progress projection
and frozen proven previews described in `CUSTOMER_DASHBOARD_SPEC.md`.

The frontend lives in `studio/` and is built with React, TypeScript, Vite, and
Lucide icons. It does not use CopilotKit UI components or an AG-UI client. Live
state is read through ordinary authenticated REST requests.

## Page structure

The desktop page has five persistent areas:

1. The left navigation rail moves between major internal product areas.
2. The top bar identifies the project and summarizes its lifecycle.
3. The center workbench contains the selected monitor and candidate filmstrip.
4. The right inspector explains what the swarm is doing and why.
5. The bottom review bar drafts operator requests without applying them
   automatically.

The layout uses a compact graphite palette, square-to-soft corners, restrained
blue accents, and status colors only when they communicate meaning. It
intentionally avoids neon gradients, floating glass cards, oversized empty
space, and decorative “AI” effects.

## Left navigation rail

The narrow rail keeps the working canvas large. Every icon has an accessible
label and browser tooltip.

| Icon      | Item             | Purpose                                                                                        |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| House     | Home             | Returns to the internal overview. It is a visual placeholder until an overview route is added. |
| Monitor   | Studio           | The active screen. Opens candidate inspection and run supervision.                             |
| Checklist | Runs             | Intended for the full build-run index and history.                                             |
| Folder    | Projects         | Intended for project and customer workspaces.                                                  |
| Panels    | Delivery         | Intended for frozen previews, artifacts, deployment, and delivery records.                     |
| People    | People           | Intended for customer and internal operator records.                                           |
| Plug      | Integrations     | Intended for provider configuration and health.                                                |
| Inbox     | Queue            | Opens the working run queue drawer in the current frontend.                                    |
| Sliders   | Settings         | Opens the functional backend connection dialog.                                                |
| Initials  | Operator profile | Identifies the current operator.                                                               |

Only Studio, Queue, and Settings perform local actions in this first frontend
release. The other rail entries establish the complete information architecture
without pretending that routes already exist.

On screens below 720 pixels, the rail becomes a bottom navigation bar.
Lower-priority items are hidden to keep tap targets usable.

## Top project bar

The top bar contains:

- **Studio**: names the current operator surface.
- **Project switcher**: shows a human-readable form of the backend `projectId`.
- **Lifecycle**: shows paid, contract, active build stage, proof, and delivery
  state.
- **Search**: reserved for cross-run search.
- **Slot count**: shows the number of visible active or terminal candidates out
  of the four-slot build limit.
- **Notifications**: reserved for attention events.
- **Settings**: opens backend connection settings.

Lifecycle labels are derived from run status and stage. The UI does not
manufacture an ETA. Completed states use green, active work uses blue, waiting
states remain neutral, and failed states use red only when the backend reports a
failure.

## Studio toolbar

The toolbar under the top bar controls the working view.

### Run identity

The left side shows the selected slot, elapsed time, and a data-source badge:

- **Live** means the authenticated BuildLabs REST backend returned one or more
  runs.
- **Demo** means no runs were available or the backend could not be reached. All
  sample candidates are visibly labeled.
- **Connecting** means the first REST request is in progress.

### Monitor layout

- **Focus** shows one large monitor.
- **2-up** shows the selected candidate and one comparison candidate.
- **4-up** shows up to four candidates at equal size.
- **Add monitor** is reserved for a future custom-view chooser.

Selecting a candidate from a multi-monitor layout changes the active candidate.
Selecting a card from the filmstrip returns to Focus mode.

### Update and evidence controls

- **Pause live updates** pauses only browser polling. It does not pause, cancel,
  or stop any backend build.
- **Open evidence** selects the Proof inspector tab.

This distinction is intentional: the visual studio must not imply that it can
stop a swarm when no safe backend action was requested.

## Main monitor

The monitor header contains:

- a drag handle that communicates the planned draggable-panel behavior;
- the candidate slot and strategy;
- the current durable run stage;
- a Sample badge when demo data is active;
- inspect, expand, and menu affordances.

The monitor body supports five views.

### Preview

For a live run with `sandboxId` and `previewPort`, the studio requests the
existing operator-only endpoint:

`GET /v1/build-runs/:runId/preview`

The returned signed Daytona URL is displayed in a sandboxed iframe and can be
opened as a raw preview. It is never presented as customer-safe proof.

When no live preview is available, the monitor renders the clearly labeled
Mission Peak Electric sample. The sample is implemented in HTML and CSS so the
dashboard remains useful without remote image assets.

### Code

Displays the latest durable event payload in a code-style workspace. The project
tree communicates the planned source explorer. The footer states that source
browsing is not exposed by the current read-only API, so the UI does not pretend
to be a live filesystem.

### Diff

Builds a change summary from recent durable run events and proof receipts. It
shows verified signals rather than fabricated line additions or deletions.

### Terminal

Formats durable run events as a time-ordered console. This is an event monitor,
not an interactive shell.

### Components

Maps acceptance-contract requirements into a component graph. Hard requirements
and preferences use separate accents.

### Viewport controls

Desktop, tablet, and mobile icons establish the preview-device controls. Desktop
is active in this release. The raw-preview link only appears when the backend
returned a valid operator preview URL.

## Candidate filmstrip

The filmstrip shows up to four candidates because the backend limits parallel
slots to four.

Each card includes:

- slot number;
- strategy name;
- durable run stage;
- latest durable event summary;
- Sample label in demo mode;
- a small preview thumbnail.

The selected candidate has a restrained blue border. Candidate cards do not
claim a percentage unless a real percentage exists. Run stage and evidence are
the primary progress signals.

The Compare selected switch is a visual placeholder for a future explicit
comparison selection model. The working 2-up and 4-up controls already provide
visual comparison.

## Right inspector

The right inspector has five functional tabs.

### Activity

Activity answers “what is each agent doing now?” without relying on neon dots:

- candidate/agent slot;
- strategy;
- current backend stage;
- latest durable action;
- file hint when the event includes one;
- stage-derived progress bar;
- pipeline stage list;
- proof attention summary.

For live data, progress bars represent stage position, not an invented
completion probability. Demo mode is explicitly labeled.

### Contract

Shows the accepted contract revision, hard and preference requirements, verifier
types, approved facts, and blocked claims. Transcript contents are not sent by
the studio-list endpoint.

### Proof

Shows durable evidence receipts, provider, status, duration, and the delivery
gate. A candidate is described as proven only when its backend status is
`passed`.

### Diff

Summarizes durable changes and review results from events and receipts.

### Tree

Shows a contract-derived project tree. It is explicitly labeled as not reading
sandbox files.

The inspector footer links represent the two authoritative records operators
need most often: the acceptance contract and immutable evidence.

## Bottom review bar

The bottom text area accepts instructions such as changes to a page or a request
to compare candidates.

Pressing Enter or selecting **Review action** does not send the text to the
build swarm. It moves the text into a visible “prepared for admin review” state.
This preserves the requested safety model:

`operator draft → admin review → approved request → agent swarm`

The current backend does not expose an approved-change REST command, so the
frontend stops at the review draft rather than inventing a mutation.

## Queue drawer

The Queue button opens a drawer listing visible runs with:

- project;
- candidate;
- stage;
- status color;
- direct candidate selection.

The drawer uses the same live or demo run collection as the main studio.

## Backend connection dialog

Settings opens a connection dialog with:

- backend base URL;
- `BUILDLABS_INTERNAL_TOKEN` bearer token;
- connection status.

The base URL should stay empty when the built studio is served by the BuildLabs
backend. During Vite development, `/v1`, `/health`, and `/ready` are proxied to
`http://127.0.0.1:3000`.

The token is stored in `sessionStorage` only. It is not persisted in
`localStorage` and is attached only to REST requests made by the current browser
tab.

## Responsive behavior

- **Desktop**: left rail, large monitor, right inspector, and fixed review bar.
- **Tablet**: inspector moves below the workbench.
- **Mobile**: navigation moves to the bottom, candidate cards scroll
  horizontally, multi-monitor layouts become horizontal pages, and the review
  action becomes an icon button.
- The frontend honors `prefers-reduced-motion`.
- The 390-pixel layout is tested without horizontal document overflow.

## Source map

| File                               | Responsibility                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `studio/src/App.tsx`               | Page composition, state, polling, interactions, and UI components.                    |
| `studio/src/styles.css`            | Visual system, monitor mock, desktop/tablet/mobile layouts, and accessibility states. |
| `studio/src/api.ts`                | REST client and session-scoped connection storage.                                    |
| `studio/src/types.ts`              | Backend response and frontend state types.                                            |
| `studio/src/demo.ts`               | Explicit sample candidates, events, and receipts.                                     |
| `studio/src/main.tsx`              | React entry point.                                                                    |
| `studio/vite.config.ts`            | `/studio/` build base and local backend proxy.                                        |
| `src/http/server.ts`               | Studio static serving and authenticated recent-runs REST endpoint.                    |
| `src/adapters/sqlite/run-store.ts` | Recent-run query used by the studio.                                                  |

## Security and truthfulness rules

- The studio shell is static and contains no secrets.
- Build data endpoints remain protected by the existing internal bearer-token
  hook.
- Transcript contents are excluded from `GET /v1/studio/runs`.
- Raw mutable Daytona preview URLs remain operator-only.
- Demo data is always labeled.
- The UI never claims a build is proven unless backend evidence and status
  support it.
- Draft change requests do not auto-apply.
- No customer PII is introduced into the demo or sent to sandbox endpoints.
