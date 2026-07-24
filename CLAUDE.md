# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this repo is

The **build-agent backend** of BuildLabs (package
`@buildlabs/build-agent-backend`) — one subsystem, not the whole product. It
receives a `BuildAssignment` (build prompt + Acceptance Contract) over an
internal HTTP API, runs the **build → verify → prove → snapshot** loop for a
single candidate inside a Daytona sandbox, and reports terminal results through
an outbox. The voice intake agent, the CopilotKit studio, and the orchestrator
that deploys to Fly.io and emails the customer are **separate systems and
intentionally absent here** — this service never deploys or emails.

Authoritative docs, in priority order:

- [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md) — product source of truth.
- [`AGENTS.md`](./AGENTS.md) — guardrails and current development commands (read
  before changing behavior).

## Commands

Requires **Node >= 24** (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev            # tsx watch src/index.ts (reads .env if present)
npm run build          # tsc -> dist/ (tsconfig.build.json)
npm start              # node dist/index.js

npm test               # vitest run (all tests)
npx vitest run tests/proof-gate.test.ts          # a single test file
npx vitest run -t "passes only a complete"       # a single test by name
npx vitest                                        # watch mode
npm run test:coverage

npm run typecheck      # tsc --noEmit
npm run lint           # eslint . --max-warnings=0  (must be clean)
npm run format         # prettier --write .
npm run check          # format:check + lint + typecheck + test  (run before committing)

npm run provision:daytona # create/reuse and live-probe the configured DIND snapshot
npm run smoke:providers   # live health check of Daytona/Fireworks/Braintrust/CodeRabbit (needs real keys in .env)
```

## Architecture

Hexagonal / ports-and-adapters. Dependencies point **inward**:
`adapters → application → ports → domain`.

- **`src/domain/`** — pure types, Zod schemas, and content-address digests; no
  I/O. `contract.ts` (`AcceptanceContract`, `BuildAssignment`, verifiers),
  `run.ts` (`BuildRun` status/stage state machine, `SlotLease`,
  `FrozenRevision`), `evidence.ts` (receipt union + `ProofDecision`),
  `artifact.ts` (`ProvenArtifact`, `OutboxEvent`).
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
  (`RunStore`), `filesystem` (`ArtifactStore`).
- **`src/http/server.ts`** — Fastify API (`POST /v1/build-runs`,
  `GET .../events`, `.../evidence`, `.../preview`, `POST .../cancel`,
  `GET .../artifacts/:artifactId`, `GET /v1/outbox`, `POST /v1/outbox/:id/ack`,
  `/health`, `/ready`).
- **`src/index.ts`** — the composition root and the **only** place adapters are
  chosen: it builds each adapter from config and injects them into the executor,
  scheduler, and server. Read it first to see the port→adapter wiring.
- **`src/lib/`** — `canonical-json.ts` (deterministic hashing), `redaction.ts`.

### Run lifecycle (the proof gate)

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

## Guardrails (from AGENTS.md — the prime directive)

- **Never deliver/deploy a build that hasn't passed the proof gate.** A
  hard-requirement failure cannot ship, no matter how high its quality score.
- **Never emit business facts absent from the transcript or confirmed
  research.** Enforced by forbidden-claim scans and Braintrust unsupported-claim
  rejection.
- **Production credentials — especially the Fly.io deploy token — MUST NOT enter
  a Daytona sandbox.** The orchestrator (not this service) deploys. This repo
  does not deploy or email.
- Don't wire deferred/excluded vendors (Plivo, Vercel, v0); don't reuse prior
  codebases; don't mix customer data across projects. Route each responsibility
  to its sponsor owner.

## Conventions

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
