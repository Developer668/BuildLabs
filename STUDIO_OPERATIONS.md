# Running BuildLabs Studio

This guide covers development, production builds, backend connection, and
validation for the internal Studio frontend.

## Requirements

- Node.js 24 or newer
- npm
- The existing BuildLabs environment variables when running the full backend

Install dependencies:

```powershell
npm install
```

## Frontend development

Start only the Vite frontend:

```powershell
npm run dev:studio
```

Open:

```text
http://127.0.0.1:5173/studio/
```

Vite proxies `/v1`, `/health`, and `/ready` to `http://127.0.0.1:3000`. If the
build backend is not running, the page shows an explicit unavailable state and
does not render candidate or proof data.

Start the build backend in a second terminal:

```powershell
npm run dev
```

When `BUILDLABS_INTERNAL_TOKEN` is configured, open Settings in Studio and enter
that token. The value is kept only for the current browser-tab session.

## Production build

Build both the backend and frontend:

```powershell
npm run build
```

The command performs:

1. `tsc -p tsconfig.build.json`
2. `vite build --config studio/vite.config.ts`

The frontend output is written to:

```text
dist/studio/
```

When that directory exists, the build backend serves the shell at:

```text
/studio/
```

Static Studio assets are public because they contain no build data. Every `/v1`
request continues through the existing internal bearer-token check.

## REST endpoints used by Studio

### Recent candidates

```http
GET /v1/studio/runs?limit=24
Authorization: Bearer <BUILDLABS_INTERNAL_TOKEN>
```

Optional project filter:

```http
GET /v1/studio/runs?projectId=<project-id>&limit=24
```

The response includes run state, a sanitized contract summary, event count,
proof counts, and preview/artifact availability. It excludes transcript
contents.

### Candidate events

```http
GET /v1/build-runs/:runId/events?after=0&limit=500
```

### Candidate evidence

```http
GET /v1/build-runs/:runId/evidence
```

### Raw operator preview

```http
GET /v1/build-runs/:runId/preview
```

This endpoint returns a short-lived mutable Daytona preview and must remain
operator-only. It is not the customer frozen-preview flow.

## Polling behavior

Studio refreshes recent runs every eight seconds. Selecting **Pause live
updates** stops browser polling only. It does not pause or cancel backend work.

The selected candidate’s events, evidence, and preview are refreshed when the
selected run or live run list changes.

## Validation commands

Run type checks:

```powershell
npm run typecheck
```

Run lint:

```powershell
npm run lint
```

Run the Studio endpoint test:

```powershell
npm test -- tests/http-server.test.ts -t "lists recent studio candidates"
```

Run run-store tests:

```powershell
npm test -- tests/run-store.test.ts
```

Build production assets:

```powershell
npm run build
```

## Troubleshooting

### Studio shows unavailable

The unavailable state appears when:

- the backend is not reachable;
- the internal token is missing or incorrect;
- the backend returned no runs.

Open Settings to read the current connection message. If the backend is
reachable but has no runs, the Studio shows no candidates or proof records.

### Studio returns 401

Set the same value as the backend `BUILDLABS_INTERNAL_TOKEN` in the Studio
Settings dialog.

### Preview does not appear

A mutable preview is available only after a run has both `sandboxId` and
`previewPort`. If preview signing fails or the run has not started its preview,
Studio shows the unavailable preview state.

### Source code is not visible in Code view

The current REST surface does not expose sandbox file contents. Code view
intentionally displays the latest durable event payload and states that source
browsing is separate. Do not add an unauthenticated filesystem endpoint to fill
this gap.

## Deliberate non-features

- No CopilotKit UI dependency
- No AG-UI frontend client
- No automatic application of operator drafts
- No pause/stop swarm control
- No raw transcript in the recent-runs feed
- No customer access to mutable Daytona previews
- No invented completion percentage or ETA
