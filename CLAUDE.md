# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this repo is

The BuildLabs monorepo — **four services**, one npm workspace:

- **build-agent backend** (`src/index.ts`, Fastify on `:3000`, package
  `@buildlabs/build-agent-backend`) — receives a `BuildAssignment` (a build
  prompt plus its Acceptance Contract) over an internal HTTP API, runs the
  **build → verify → prove → snapshot** loop for a single candidate inside a
  Daytona sandbox, and reports terminal results through an outbox. This service
  never deploys or emails.
- **general orchestrator** (`src/orchestration-index.ts`, Fastify on `:3100`) —
  the durable customer lifecycle: intake, immutable proposal/contract versions,
  Stripe Checkout, Resend mail, build dispatch and steering, winner selection,
  and the Fly.io deploy. It owns the production deploy token.
- **dashboard** (`apps/dashboard`, Next.js on `:3200`, package
  `@buildlabs/dashboard`) — the CopilotKit operator studio and customer
  workspace, plus the customer-facing BFF that proxies the orchestrator behind
  opaque aliases. It is the only public customer origin.
- **voice intake** (`apps/voice-intake`, vinext app on a Cloudflare Worker,
  package `@buildlabs/voice-intake`) — ElevenLabs browser-microphone and
  inbound-telephony intake with a server-only Fireworks custom-LLM bridge.

`npm start` runs `dist/production-index.js`, a supervisor that spawns the two
Node services and stops the pair if either exits. The dashboard and voice intake
are built, run, and deployed separately.

Most of this file describes the build-agent backend: it is the subsystem with
the most load-bearing invariants.

Authoritative docs, in priority order:

- [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — product source of truth.
- [`AGENTS.md`](./AGENTS.md) — guardrails and current development commands (read
  before changing behavior).

## Commands

Requires **Node >= 24** (uses the built-in `node:sqlite`).

```bash
npm install            # one workspace install for all four services

npm run dev              # build-agent backend  (tsx watch src/index.ts, reads .env)
npm run dev:orchestration # general orchestrator (tsx watch src/orchestration-index.ts)
npm run dev:dashboard     # Next.js dashboard on :3200
npm run dev:voice         # voice intake worker
npm run dev:studio        # Vite operator studio SPA (proxies the backend on :3000)

npm run build          # server (tsc -> dist/) + studio + dashboard
npm start              # node dist/production-index.js (supervises both Node services)
npm run start:build-backend / npm run start:orchestration  # one service at a time

npm test               # vitest run --dir tests (backend + orchestration)
npx vitest run tests/proof-gate.test.ts          # a single test file
npx vitest run -t "passes only a complete"       # a single test by name
npx vitest --dir tests                            # watch mode
npm run test:coverage
npm run test:dashboard    # vitest in apps/dashboard
npm run test:e2e:dashboard # Playwright in apps/dashboard

npm run typecheck      # server + studio + dashboard
npm run lint           # eslint . --max-warnings=0  (must be clean)
npm run format         # prettier --write .
npm run check          # format:check + lint + typecheck + build + coverage + dashboard/voice suites (run before committing)
npm run check:config   # per-service report of missing/invalid config (names and constraints only, never values)

npm run provision:daytona # create/reuse and live-probe the configured DIND snapshot
npm run smoke:providers   # live health check of Daytona/Fireworks/Braintrust/CodeRabbit (needs real keys in .env)
```

Each service reads a different env file: the two Node services read the
repo-root `.env`; the dashboard reads `apps/dashboard/.env.local`; voice intake
reads `apps/voice-intake/.env.local`. `check:config` checks each service against
the file it actually loads.

## Architecture

### Build-agent backend (`src/`, excluding `src/orchestration*`)

Hexagonal / ports-and-adapters. Dependencies point **inward**:
`adapters → application → ports → domain`.

- **`src/domain/`** — pure types, Zod schemas, and content-address digests; no
  I/O. `contract.ts` (`AcceptanceContract`, `BuildAssignment`, verifiers),
  `run.ts` (`BuildRun` status/stage state machine, `SlotLease`,
  `FrozenRevision`), `evidence.ts` (receipt union + `ProofDecision`),
  `artifact.ts` (`ProvenArtifact`, `OutboxEvent`), `customer-observability.ts`
  (the sanitized customer projection, pinned to `customerRenderable: false`).
- **`src/ports/index.ts`** — the interfaces the application depends on:
  `SandboxProvider` / `SandboxSession`, `ModelPort`, `CodeReviewPort`,
  `TracePort`, `RunStore`, `ArtifactStore`.
- **`src/application/`** — orchestration logic that depends only on ports +
  domain (unit-tested against in-memory fakes). `build-run-executor.ts` is the
  heart (drives one run); `proof-gate.ts` (`decideProof`), `build-scheduler.ts`,
  `verification.ts`, `agent-runner.ts`, `preview-inspector.ts`,
  `inspection-collector.ts`, `contract-evaluator.ts`, `receipts.ts`.
- **`src/adapters/`** — concrete port implementations, one directory per
  sponsor: `daytona` (`SandboxProvider`), `fireworks` (`ModelPort`),
  `coderabbit` (`CodeReviewPort`), `braintrust` (`TracePort`), `sqlite`
  (`RunStore`), `filesystem` (`ArtifactStore`), plus `elevenlabs` (speech engine
  and agent manifest/reconciler) and `plivo` (inbound-DID manifest/reconciler,
  driven by scripts, not by the run loop).
- **`src/http/server.ts`** — Fastify API (`POST /v1/build-runs`,
  `GET .../events`, `.../evidence`, `.../preview`, `.../customer-observability`,
  `POST .../cancel`, `GET .../artifacts/:artifactId`, `GET /v1/outbox`,
  `POST /v1/outbox/:id/ack`, `/v1/integrations*`, `/v1/studio/runs`, `/health`,
  `/ready`), and it serves the built `studio/` SPA at `/studio/`.
- **`src/index.ts`** — the composition root and the **only** place adapters are
  chosen: it builds each adapter from config and injects them into the executor,
  scheduler, and server. Read it first to see the port→adapter wiring.
- **`src/lib/`** — `canonical-json.ts` (deterministic hashing), `redaction.ts`,
  `config-diagnostics.ts`.

### General orchestrator (`src/orchestration/`, `src/orchestration-index.ts`)

Same inward-pointing shape, its own ports and adapters.

- **`domain/`** — projects, immutable proposal/contract versions, lifecycle
  events, store interfaces.
- **`application/`** — the gather → one typed action → verify → persist loop
  (`orchestration-agent.ts`), `contract-compiler.ts`, `pii.ts`,
  `proposal-builder.ts`, `winner-selection.ts`, `paid-scope-policy.ts`,
  `customer-dashboard-access.ts` (signed login/session capabilities),
  `customer-dashboard-projection.ts`, `proof-summary-links.ts`,
  `reply-address.ts`.
- **`ports/`** — `payment` (Stripe), `mail` (Resend), `website-research`,
  `build-backend`, `deployment` (Fly.io), `trace`.
- **`adapters/`** — provider clients, encrypted SQLite aggregate/event/effect
  store, verified-webhook inbox, Braintrust tracing.
- **`http/server.ts`** — intake, customer-dashboard access/read/steering,
  Stripe/Resend webhooks, operator evidence.
- **`runtime/`** — config schema, readiness probes, reconciliation worker.
- **`src/orchestration-index.ts`** — the orchestrator's composition root.

### Dashboard (`apps/dashboard/`)

Next.js App Router + CopilotKit on `:3200`; the only public customer origin.

- **`app/operator/*`, `app/api/operator/*`, `app/api/copilotkit/operator/*`** —
  the operator studio over the build backend's internal API.
- **`app/dashboard/projects/[projectAlias]/`, `app/v1/customer/*`,
  `app/api/copilotkit/customer/*`** — the customer workspace and its BFF.
- **`lib/server/`** — server-only boundary code: `access-proxy.ts` (proxies the
  orchestrator's passwordless exchange and swaps the raw project UUID for an
  alias), `aliases.ts` (opaque `prj_…`/`bld_…`/`frm_…` aliases in a sealed
  AES-256-GCM cookie), `cookies.ts` (session/CSRF/alias cookies re-issued on the
  dashboard origin), `customer-stream.ts` (resumable `Last-Event-ID` SSE),
  `wip-raster.ts` (sanitized, watermarked WIP frame gateway — consumer side
  only), `orchestration-client.ts`.
- **`lib/contracts/`** — Zod contracts for every customer/operator payload.

### Voice intake (`apps/voice-intake/`)

A vinext app deployed as a Cloudflare Worker. `app/api/conversation-session`
mints signed browser microphone sessions; `app/api/telephony/elevenlabs/init` is
the inbound Plivo → ElevenLabs SIP pre-call webhook;
`app/api/llm/v1/chat/completions` is the server-only Fireworks custom-LLM
bridge; `app/api/tools/intake/*` are the bounded intake tools;
`app/api/webhooks/elevenlabs` is the post-call bridge into the orchestrator.

### Operator studio SPA (`studio/`)

Vite/React, built to `dist/studio` and served by the build backend at
`/studio/`. It polls the authenticated REST API and predates the Next.js
operator surface.

## Run lifecycle (the proof gate)

Build-agent backend only.

`status`: `queued → running → passed | rejected | failed | cancelled`. `stage`:
`queued → provisioning → generating → verifying → reviewing → evaluating → finalizing → complete`.

`build-run-executor.ts` per run: create sandbox → `agent-runner` generates code
via Fireworks → `freeze()` to a `FrozenRevision` → run command verification
(Dockerfile check, build, tests, forbidden-claim greps, `docker build`,
per-requirement command verifiers) → container preview + page inspection →
CodeRabbit review → Fireworks/Braintrust contract evaluation. Each step emits a
typed **evidence receipt**. Then `decideProof(...)` gates; on reject it feeds
the reasons back to the agent and repairs (up to `limits.maxRepairRounds`); on
pass it snapshots the sandbox, persists the artifact, and marks the run
`passed`. Sandboxes are stopped on every terminal outcome except `passed`.

## Invariants that are load-bearing (don't break these)

- **Evidence-first proof.** `decideProof` is a **pure function** over
  `(contract, revisionHash, receipts)`. It never trusts in-flight status — it
  re-derives pass/fail from receipts, and only from receipts whose
  `revisionHash` matches the frozen revision. Every hard requirement's verifiers
  must have passing receipts; no unsupported claims; the hard, grounding, and
  supported-fact Braintrust gate scores must all be 1. Preference satisfaction
  is ranking-only and may be below 1.
- **Frozen-revision integrity.** After `freeze()`, the digest is re-asserted at
  several checkpoints (`assertFrozenDigest`). If source changes after freezing,
  the candidate is rejected. All proof targets one exact revision.
- **Determinism.** `digestJson`/`sha256` (canonical JSON: sorted keys, dropped
  `undefined`, rejected non-finite numbers) back every hash (contract,
  assignment, evidence, revision). Never feed nondeterministic serialization
  into anything hashed.
- **Zod schemas are the source of truth for types** — domain types are
  `z.infer<...>`. Validate all external input (config, HTTP bodies, rows read
  back from SQLite) through the schema.
- **Slot concurrency via leases + fencing tokens.** Max 4 slots.
  `RunStore.acquireSlot` issues a monotonic `fencingToken`; the scheduler
  heartbeats; a stale lease is fenced from all mutations (`StaleLeaseError`).
  Pass the current `SlotLease` to every mutating store call.
- **Outbox is how proven results leave.** Only a passed, proven candidate
  enqueues a typed `candidate.proven` `OutboxEvent`; rejected, failed, and
  cancelled runs do not. The orchestrator polls `GET /v1/outbox` and acks. Don't
  add side-channel notifications.
- **Idempotent creation.** `createRun` keys on `assignmentId`: identical body →
  existing run (`created: false`); conflicting body → `IdempotencyConflictError`
  (409).
- **Cancellation/timeouts** flow through `AbortSignal` (wall-clock via
  `AbortSignal.timeout`, combined with `AbortSignal.any`); `ensureActive()`
  re-checks between steps.
- **Auth:** `BUILDLABS_INTERNAL_TOKEN` bearer (constant-time compare), required
  in production or on a non-loopback host; `/health` and `/ready` are exempt.
  Each service has its own token: the orchestrator uses
  `ORCHESTRATION_INTERNAL_TOKEN`, the dashboard gates operators with
  `BUILDLABS_OPERATOR_TOKEN` and holds `BUILDLABS_INTERNAL_TOKEN` only
  server-side to call the build backend. Customers never hold any of them.

## Guardrails (from AGENTS.md — the prime directive)

- **Never deliver/deploy a build that hasn't passed the proof gate.** A
  hard-requirement failure cannot ship, no matter how high its quality score.
- **Never emit business facts absent from the transcript or confirmed
  research.** Enforced by forbidden-claim scans and Braintrust unsupported-claim
  rejection.
- **Production credentials — especially the Fly.io deploy token — MUST NOT enter
  a Daytona sandbox.** The general orchestrator (never the build-agent backend)
  deploys and emails.
- **Plivo is inbound-only on one dedicated existing test DID** — that PSTN
  transport _is_ selected (Zentrunk → TLS/SRTP → an ElevenLabs SIP resource on
  the testing branch). Still excluded: outbound calls, number purchase/release,
  production routing, Plivo recording/transcription, and a custom media proxy.
  Reconciliation stays plan-first with expected-base-digest CAS.
- **Vercel and v0 remain fully excluded.** Don't reuse prior codebases; don't
  mix customer data across projects. Route each responsibility to its sponsor
  owner.

## Conventions

These describe `src/`, `scripts/`, and `tests/`. `apps/dashboard` and
`apps/voice-intake` are separate workspaces with their own tsconfig, ESLint, and
Vitest configs — notably, they do **not** use `.js` import extensions.

- **ESM only** (`"type": "module"`, NodeNext): intra-repo imports use explicit
  `.js` extensions even though sources are `.ts` (e.g.
  `import { x } from "../domain/contract.js"`).
- **SQLite is `node:sqlite` (`DatabaseSync`)** — no `better-sqlite3` / native
  dependency. Schema lives in `src/adapters/sqlite/migrations.ts`.
- **Strict TS** with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`: build optional properties by conditional spread
  (`...(x ? { x } : {})`) rather than assigning `undefined`, and narrow index
  access before use.
- **ESLint is type-checked** (`no-floating-promises`, `no-misused-promises`);
  lint must pass with `--max-warnings=0`.
- **Tests** use Vitest globals; `tests/fixtures.ts` builds schema-valid
  assignments and a full passing evidence set — reuse it and mutate for the case
  under test.
