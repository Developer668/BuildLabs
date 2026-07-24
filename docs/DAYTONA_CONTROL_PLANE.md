# Daytona Control Plane

This runbook covers the BuildLabs Daytona execution and proof boundary. Daytona
hosts builders, independent command and delivery verifiers, and frozen proven
previews. The controller still owns source digests, proof policy, delivery
authorization, resource ownership, and cleanup.

The non-negotiable isolation rules are:

- A builder never seeds, forks, or links into either verifier.
- Command and delivery verifiers start unused from the pinned clean snapshot and
  hydrate only the controller-attested source export.
- Delivery proof uses pinned Chromium output from the delivery verifier after
  `networkBlockAll`; source HTML and Computer Use output are not proof.
- `networkBlockAll` is read back after application and reapplied after a
  snapshot restart.
- A customer sees only a signed, frozen preview of the version that passed the
  complete gate. Raw Daytona URLs, IDs, tokens, and mutable WIP stay internal.

## Readiness States

`DaytonaSandboxProvider.readinessReport()` emits
`buildlabs.daytona.readiness.v1`. Interpret each capability independently:

| State                 | Meaning                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unconfigured`        | Required local or account-side configuration is absent, unknown, or disabled. No provider result is implied.                                                      |
| `configured`          | Configuration was detected, but the relevant bounded provider action has not been observed.                                                                       |
| `healthy`             | A local check or provider metadata/API check passed. This is not delivery proof.                                                                                  |
| `degraded`            | A check failed, drifted, fell back, was unobservable, or lacks a required privacy/policy attestation. The affected capability must not be represented as healthy. |
| `end_to_end_verified` | The exact capability completed a bounded provider-backed probe and produced evidence for this report or attestation.                                              |

The top-level `overall` state summarizes only the API, snapshot supply chain,
region/resources, and signed-preview core. It does not upgrade OTEL, warm pools,
Computer Use, lifecycle transport, limits, or metrics. Read the capability
entries and their `reasonCode`; do not treat `overall: healthy` as proof that
all Daytona features are configured.

The report covers:

- installed SDK version and API reachability;
- pinned snapshot state, resources, and supply-chain attestation;
- lifecycle event transport without inventing an unobservable stream state;
- signed-preview ingress;
- latest and historical resource metrics;
- SDK and sandbox OTEL;
- persistent controller telemetry;
- role-specific warm pools;
- live account quota/limit signals;
- operator-only Computer Use; and
- externally configured custom preview proxy state.

The current SDK selects lifecycle event transport automatically. An observed
event stream is `end_to_end_verified`; an observed polling fallback is
`degraded`; and automatic transport with no observable provider signal remains
`configured`. Never infer the transport from lifecycle speed.

Run the report with:

```sh
npx tsx scripts/daytona-readiness.ts
```

The output is machine-readable JSON. It contains evidence digests and opaque
resource references, not preview URLs, sandbox IDs, bearer tokens, command
output, or customer content. The command exits nonzero when `overall` is
`degraded` or `unconfigured`; capability states may still require separate
attention after a zero exit. Attestation-backed signed-preview and metric
entries carry `evidenceValidatedAt`; their `checkedAt` is the report time, not a
claim that the provider probe was repeated at that instant.

## Configuration

Set the Daytona values in the operator environment:

```dotenv
DAYTONA_API_KEY=...
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_TARGET=...
DAYTONA_BUILD_SNAPSHOT=buildlabs-dind-browser-v2
DAYTONA_SNAPSHOT_ATTESTATION_PATH=.buildlabs/daytona/snapshot-attestation.json
DAYTONA_PROVISIONER_SOURCE_PATH=scripts/provision-daytona-snapshot.ts
DAYTONA_TELEMETRY_PATH=.buildlabs/daytona/telemetry.jsonl
DAYTONA_WARM_POOL_ROLES=
DAYTONA_OTEL_ENABLED=false
```

This is the Daytona-specific subset, not a standalone `.env`: the scripts use
BuildLabs' application config loader, so the repository's other required
provider values must also be valid.

`DAYTONA_TARGET` is optional, but when set it becomes part of acquisition and
warm-pool matching. `DAYTONA_WARM_POOL_ROLES` is a comma-separated allowlist of
`builder`, `verifier-commands`, and `verifier-delivery`. Leaving it empty
disables pool claims.

`DAYTONA_OTEL_ENABLED=true` enables the Daytona SDK's native tracing only. It
does not configure an OTLP destination or attest a collector redaction policy.

## Snapshot Attestation

Provision and validate the pinned snapshot before enabling builds:

```sh
npm run provision:daytona
```

The provisioner creates or retrieves the named snapshot and exercises the real
provider runtime. Its declared inputs include the DIND base tag, explicit Alpine
package set, exact Playwright Core version, and CPU/memory/disk defaults. The
base tag and Alpine repository packages are not immutable upstream digests; the
attestation therefore also binds Daytona build-input hashes, provider snapshot
identity, and the exact observed Chromium and Docker versions. It then verifies:

- DIND readiness and an independent Docker build/run;
- exact Chromium and Docker server versions;
- Chromium-computed visible text and screenshot digests;
- fail-closed handling of stale DOM/pixel state;
- signed-preview ingress to a loopback-bound fixture;
- blocked direct-IP and registry egress under `networkBlockAll`;
- preserved loopback Docker/Chromium operation; and
- network isolation after stop/start and controller reapplication.

On success it atomically writes a mode-`0600`
`buildlabs.daytona.snapshot-attestation.v1` document at
`DAYTONA_SNAPSHOT_ATTESTATION_PATH`. The attestation binds:

- pinned image inputs and provisioner source digest;
- snapshot provider identity, name, regions, class, resources, and build input
  digests;
- observed Chromium and Docker versions;
- all validation outcomes; and
- validation time plus a canonical payload digest.

Do not hand-edit or copy an attestation to a different snapshot. Runtime
acquisition rejects a malformed digest, input drift, snapshot/API mismatch,
resource mismatch, browser or Docker version drift, and validation older than
seven days. Re-run provisioning to refresh a matching snapshot. If an existing
snapshot has image/resource identity drift, choose a new versioned
`DAYTONA_BUILD_SNAPSHOT` name and provision it; the script intentionally does
not replace an in-use snapshot in place. Provisioning deletes its probe sandbox
synchronously and disposes the SDK client.

## Acquisition And Timing

Each builder, command verifier, delivery verifier, and frozen preview has a
distinct role. Builder and verifier acquisition applies bounded create,
readiness, and teardown policy, verifies the controller ownership labels, and
places an unused marker in the sandbox so stale reuse fails closed. Create,
readiness, Docker startup, and synchronous teardown each use bounded controller
deadlines; the default provider policy is 120 seconds where the operation
supports that deadline.

`buildlabs.daytona.acquisition.v1` records these phase durations when exercised:

- `queue`
- `claim_or_create`
- `readiness`
- `docker`
- `browser_proof`
- `snapshot_restart`
- `retry`
- `teardown`

Receipts use content-free `runId`, `projectId`, `candidateId`, and `role`
labels, a policy digest, a redacted failure code, resource metrics, and one of
`verified_pool_hit`, `verified_cold_create`, or `unobserved`. A missing phase
means that path did not execute; it must not be reported as zero-duration work.

The provider exposes bounded in-memory copies through
`acquisitionMeasurements()` and `telemetryEvents()`, and appends the same
validated content-free events to the mode-`0600` JSONL file at
`DAYTONA_TELEMETRY_PATH`. A persistent write failure is redacted and reported as
degraded controller telemetry. Resource metrics come from Daytona's
latest/historical sandbox metrics APIs. They describe resource use, not proof
correctness.

## Warm Pools

Daytona warm-pool eligibility is exact, not best-effort. A create is eligible
only when all of the following match:

- the role is explicitly enabled;
- snapshot and target match the role policy;
- snapshot-default CPU, memory, and disk are used;
- the user is the default `daytona` user; and
- no custom environment, resources, volume, secret, or linked sandbox is
  requested.

BuildLabs observes warm sandboxes before acquisition. It records a
`verified_pool_hit` only when the returned sandbox has the same pre-observed
identity and its snapshot, target, user, and resources still match policy.
Provider timing, a fast response, labels, or a missing post-claim `warmPoolId`
never establish a hit. If inventory is unavailable, the result is `unobserved`;
benchmarks and proof reporting must not relabel it.

Controller environment and content-free OTEL labels are applied after a verified
claim. Every claimed verifier must also pass the unused marker and runtime
attestation checks. A mutable builder can never be a verifier parent. Frozen
previews use a unique proven delivery snapshot and are intentionally
warm-pool-ineligible; configuring `frozen-preview` as a warm role fails closed.

Warm pools are account-side Daytona resources. Repository configuration only
allows eligible roles; it does not create a pool or prove that the account has
one ready.

## OTEL And Privacy

BuildLabs emits and locally persists controller telemetry with content-free
labels, phase durations, quota signals, resource metrics, lifecycle outcomes,
and redacted failure codes. This JSONL stream is not native Daytona OTEL and
does not prove an OTLP export. Never add prompts, source, stdout/stderr, URLs,
provider resource IDs, tokens, business facts, or customer data to these events.

Native Daytona SDK and sandbox OTEL are separate trust boundaries. Native SDK
spans may include provider URLs, resource identities, or errors, and the sandbox
collector can observe process and application output. Therefore:

1. Keep `DAYTONA_OTEL_ENABLED=false` until the external collector, transport,
   retention, access controls, and drop/redaction policy are reviewed.
2. Configure `OTEL_EXPORTER_OTLP_ENDPOINT` or
   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` outside the repository.
3. Treat an exporter setting as `configured`, not healthy.
4. Mark export failure or an unattested content policy `degraded`.
5. Claim `end_to_end_verified` only after a bounded export probe reaches the
   approved collector without content leakage.

Daytona account-side sandbox OTEL and custom preview proxy configuration cannot
be created or proven by repository code. Report them as unknown/unconfigured
until independently observed.

## Long Builds

Commands with a timeout of at least 600 seconds use
`executeDaytonaAsyncCommand()` through `DaytonaSandboxSession`. It creates a
unique persistent session, starts the same bounded output wrapper with
`runAsync`, polls for a terminal exit code, and always attempts session cleanup.
Create, launch, poll, delay, log, session-deletion, and whole-sandbox
termination waits are all controller-bounded; a provider promise that never
settles cannot defeat the execution deadline.

Cancellation, timeout, ambiguous launch/poll/log failure, or failed session
cleanup invokes the whole-sandbox terminator before returning a receipt.
Deleting only the session is not accepted as process cancellation because it
does not prove that child processes stopped. Do not reuse the terminated
sandbox.

Receipts bind the command, session, command, timing, exit code, and bounded
stdout/stderr digests. They do not expose log content. Provider failures return
`outcome=failed` with a redacted code and termination state; they never
manufacture a successful exit.

## Computer Use

`captureDaytonaOperatorDiagnostics()` requires explicit operator authorization,
starts Computer Use, captures a PNG and bounded accessibility tree, stores them
through an operator artifact sink, and stops Computer Use in `finally`. Receipts
are permanently marked:

```json
{ "audience": "operator", "proofEligible": false }
```

These artifacts may diagnose a browser or desktop failure. They must never
replace the pinned Playwright/Chromium rendered receipt, satisfy a contract
verifier, reach the customer, or authorize preview/deployment.

## Orphan Reconciliation

The reconciler is dry-run first:

```sh
npx tsx scripts/reconcile-daytona-orphans.ts --grace-ms 3600000
```

It lists only resources older than the grace period carrying both
`buildlabs.owner=buildlabs-controller` and `buildlabs.managed=true`, refreshes
each resource, validates a managed role, and excludes controller-active IDs.
Output contains opaque hashes, counts, and redacted failure codes. Frozen
previews are additionally protected until their provider `autoDestroyAt` has
passed; a missing or malformed preview expiry fails closed as live.

By default, active IDs come from queued/running build records in the read-only
`BUILDLABS_DATABASE_PATH`. `--active-id-file PATH` uses a JSON array of
authoritative sandbox IDs instead, which is useful when the controller database
driver is unavailable. Deletion refuses to run without either a readable
controller database or this explicit file.

Review the dry-run JSON, refresh the active-ID input from authoritative
controller state, then perform the same bounded selection with:

```sh
npx tsx scripts/reconcile-daytona-orphans.ts --grace-ms 3600000 --delete
```

An empty active set is safe only when authoritative controller state proves that
no run is active; never substitute a stale or guessed set. The `--delete` flag
does not relax ownership, age, role, refresh, or active-resource checks.

## Benchmark

Run the provider benchmark with a small bounded sample:

```sh
npx tsx scripts/benchmark-daytona.ts --iterations 3
```

`buildlabs.daytona.benchmark.v1` reports raw samples and
minimum/median/p95/maximum summaries for cold creation, verified warm claims,
and a controller-attested proof path. That path writes one fixture in a builder,
exports the controller digest, hydrates fresh command and delivery verifiers,
builds the Docker image only in delivery, applies `networkBlockAll`, and runs
the pinned Chromium renderer. It fails closed unless every measured warm sample
is a `verified_pool_hit`, all three references are distinct, and both network
and Chromium proof pass.

Each proof sample retains the snapshot-attestation digest, controller source
digest, observed pinned browser version, Chromium screenshot digests, and three
opaque resource references. This makes the isolation claim auditable without
exposing provider IDs or signed URLs.

An unavailable pool is reported as `warmPoolState=unavailable` with no warm
summary. An unobserved attempted claim, browser failure, reused sandbox, or
teardown failure makes the benchmark fail. The benchmark is
performance/isolation evidence; its fixture is not a customer Acceptance
Contract and cannot authorize delivery.

## Provider Probe Sequence

Use this order for a bounded live check:

```sh
npx tsx scripts/daytona-readiness.ts
npm run provision:daytona
npx tsx scripts/daytona-readiness.ts
npx tsx scripts/benchmark-daytona.ts --iterations 1
```

Report the results separately:

1. API authentication and account limit visibility.
2. Snapshot lifecycle and fresh supply-chain attestation.
3. Pool inventory and an identity-verified claim, if configured.
4. SDK/sandbox OTEL configuration and an independently observed export.
5. Delivery verifier isolation, network seal, Chromium receipt, and frozen
   signed-preview ingress.

Credential presence is only `configured`. A healthy API does not prove a pool
claim, OTEL export, browser proof, or delivery. Never print `.env`, signed
preview URLs, resource IDs, tokens, OTLP headers, or raw provider errors.
Daytona operator scripts install a process-level failure boundary that emits
only `buildlabs.daytona.script-failure.v1` plus a classified failure code.

`npm run smoke:providers` checks the wider sponsor stack and may fail because a
different sponsor is unavailable. Keep that result separate from Daytona's
capability report.

## Official Daytona References

- [TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/)
- [Sandbox lifecycle](https://www.daytona.io/docs/en/typescript-sdk/sandbox/)
- [Process and async execution](https://www.daytona.io/docs/en/process-code-execution/)
- [Snapshots](https://www.daytona.io/docs/en/snapshots/)
- [Warm pools](https://www.daytona.io/docs/en/warm-pools/)
- [OpenTelemetry collection](https://www.daytona.io/docs/en/observability/otel-collection/)
- [Scale](https://www.daytona.io/docs/en/scale/)
- [Computer Use](https://www.daytona.io/docs/en/computer-use/)
- [Custom preview proxy](https://www.daytona.io/docs/en/custom-preview-proxy/)
- [Limits](https://www.daytona.io/docs/limits/)
