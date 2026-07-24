# Orchestration runtime

During development, run the Node.js 24+ services separately:

```sh
npm run dev
npm run dev:orchestration
```

After `npm run build`, the default production command supervises both compiled
backends:

```sh
npm start
```

The supervisor sets `NODE_ENV=production`, starts the build backend and general
orchestrator, forwards shutdown signals, and stops the complete runtime if
either child exits. To manage the processes independently, set the intended
`NODE_ENV` and run:

```sh
npm run start:build-backend
npm run start:orchestration
```

## Configuration

The process fails before listening when required configuration is absent or
invalid. See `.env.example` for every variable.

- Runtime: `ORCHESTRATION_HOST`, `ORCHESTRATION_PORT`,
  `ORCHESTRATION_DATABASE_PATH`, `ORCHESTRATION_INTERNAL_TOKEN`,
  `ORCHESTRATION_PUBLIC_BASE_URL`.
- Protected state: `ORCHESTRATION_ENCRYPTION_KEY_BASE64` must decode to exactly
  32 bytes. `ORCHESTRATION_REPLY_SECRET_BASE64` must decode to at least 32
  bytes. Generate them independently and never commit them. The reply secret
  root derives purpose-separated keys for signed reply addresses, proof-summary
  capabilities, 15-minute dashboard login links, seven-day dashboard sessions,
  and session-bound CSRF tokens. Rotating it invalidates all of those signed
  capabilities. Production rejects an in-memory database.
- Email routing: `ORCHESTRATION_REPLY_DOMAIN`, `ORCHESTRATION_FROM_EMAIL`,
  `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`.
- Payment: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_SUCCESS_URL`,
  `STRIPE_CANCEL_URL`, and the explicit `STRIPE_EXPECTED_LIVEMODE=true|false`.
- Reasoning: `FIREWORKS_API_KEY`, `FIREWORKS_BASE_URL`, `FIREWORKS_MODEL`.
- Build/deploy: `BUILD_BACKEND_BASE_URL`, `BUILD_BACKEND_INTERNAL_TOKEN`,
  `BUILD_BACKEND_REQUEST_TIMEOUT_MS`, `BUILD_BACKEND_PREVIEW_TIMEOUT_MS`,
  `BUILD_BACKEND_ARTIFACT_TIMEOUT_MS`, `FLY_ACCESS_TOKEN`, required
  `FLY_ORG_SLUG` and `FLY_PRIMARY_REGION`, `FLY_APP_NAME_PREFIX`, `FLYCTL_BIN`,
  `FLY_HEALTH_PATH`, `FLY_OPERATION_TIMEOUT_MS`, `DAYTONA_BUILD_SNAPSHOT`.
- Worker bounds: `ORCHESTRATION_RECONCILE_INTERVAL_MS`,
  `ORCHESTRATION_RECONCILE_BATCH_SIZE`, `ORCHESTRATION_RECONCILE_CONCURRENCY`,
  and `ORCHESTRATION_PROJECT_RECONCILE_TIMEOUT_MS`. A hung project is aborted
  and counted as failed without blocking the rest of the page or later cycles.
  The project deadline must exceed the artifact-transfer ceiling plus the total
  Fly operation ceiling, trace flush, and a one-minute control margin. An abort
  after a provider attempt still spends that effect's bounded retry.
- Trace durability: `ORCHESTRATION_TRACE_FLUSH_TIMEOUT_MS` fails closed if a
  Braintrust flush does not settle within the configured deadline.
- Durable-effect recovery: `ORCHESTRATION_EFFECT_MAX_ATTEMPTS`,
  `ORCHESTRATION_EFFECT_RETRY_INITIAL_MS`, and
  `ORCHESTRATION_EFFECT_RETRY_MAX_MS` bound exponential retries before a
  dead-lettered effect enters operator attention.
- Lifecycle deadlines: `ORCHESTRATION_BUILD_DEADLINE_MS`,
  `ORCHESTRATION_PROOF_EVENT_GRACE_MS`, and
  `ORCHESTRATION_MAIL_DELIVERY_DEADLINE_MS` bound candidate construction,
  delayed proof evidence, and required customer-email delivery verification.
- Proven preview: `ORCHESTRATION_PREVIEW_TTL_SECONDS` must exceed
  `ORCHESTRATION_PREVIEW_REVIEW_PERIOD_MS` by at least one hour.

Service URLs require HTTPS except for loopback build-backend development.
Checkout return URLs always require HTTPS. Internal tokens and provider secrets
are never included in responses or logs. The orchestrator and build backend use
distinct internal bearer tokens: `BUILD_BACKEND_INTERNAL_TOKEN` must match the
build service's `BUILDLABS_INTERNAL_TOKEN`, while
`ORCHESTRATION_INTERNAL_TOKEN` must be different.

Production requires `STRIPE_EXPECTED_LIVEMODE=true` and a recognizable live
Stripe secret or restricted key. It also rejects reserved placeholder hosts for
the Resend sender/reply domains, Stripe return URLs, and
`ORCHESTRATION_PUBLIC_BASE_URL`; use real routable customer-facing domains.

Production CodeRabbit checks use `CODERABBIT_AUTH_MODE=preauthenticated` with a
dedicated `CODERABBIT_AUTH_HOME` provisioned outside the runtime. The API key is
not retained in the service environment or passed through process arguments.

The Fly adapter derives one stable app name per project. On first delivery it
checks for that exact app, creates it in `FLY_ORG_SLUG` through Fly's Machines
Apps API when absent, and re-reads the app before deployment so retries and
concurrent creation are safe. Dynamic creation requires an org-scoped deploy
token (`fly tokens create org`). An app-scoped deploy token remains supported
when the exact derived app already exists; it is never asked to create an app.
Each deploy uses an orchestrator-generated temporary `fly.toml` outside the
proven artifact, pinning the derived app, configured primary region, exact
proven preview port, HTTPS service, and trusted health check. Deployments use
Fly's blue/green strategy, so the prior healthy Machines remain in service
unless the replacement passes the configured check. Artifact-supplied Fly
configuration cannot redirect the deploy to a different app, service port, or
health target. `FLY_OPERATION_TIMEOUT_MS` bounds the full preflight, remote
deploy, release fencing, and health-verification sequence rather than only the
`flyctl deploy` subprocess.

## HTTP operations

`/health`, `/ready`, intake, and per-project reconciliation require
`Authorization: Bearer $ORCHESTRATION_INTERNAL_TOKEN`. Stripe and Resend
webhooks are public only at the network layer: each is authenticated from its
provider signature over the untouched raw body.

### Customer dashboard backend

The current runtime includes the passwordless customer REST boundary. It does
not include the Next.js/CopilotKit frontend.

Voice intake cannot assert `emailVerified: true`. When intake has a transcribed
but unverified email, the orchestrator durably records `send_email_verification`
and sends a 15-minute project/email-bound link before proposal delivery. After
exact payment and complete build-batch dispatch, it durably records
`send_dashboard_access` and sends another project link. Both mail effects use
stable idempotency keys and the existing Resend delivery tracking. If a
capability is still unsent when its 15-minute lifetime ends, its effect fails
with `login_capability.expired_before_delivery` and the worker creates the next
durable generation with a fresh expiry.

The link shape is:

```text
<public-base>/v1/orchestration/customer-dashboard/access#token=<signed-login>
```

The fragment is not sent on the initial HTTP request. A normal or scanner GET to
the exact access path returns only a restrictive, no-store exchange page; query
strings and token-bearing path variants are rejected. The page clears the
fragment from browser history and performs:

```http
POST /v1/orchestration/customer-dashboard/access
Content-Type: application/json

{"token":"<signed-login>"}
```

The POST verifies expiry, signature, project, and normalized-email digest.
Within the same durable project transaction, it records the immutable SHA-256
token-consumption receipt and passwordless ownership event. Replays and all
invalid/mismatched forms receive the same generic 404. Success sets:

- `buildlabs_dashboard_session`: seven-day signed project/email session,
  `Secure`, `HttpOnly`, `SameSite=Strict`, scoped to
  `/v1/orchestration/customer-dashboard`;
- `buildlabs_dashboard_csrf`: session-derived double-submit value, `Secure`,
  `SameSite=Strict`, scoped to `/`.

When exchange returns a non-success response, the exchange page automatically
submits the original fragment token to:

```http
POST /v1/orchestration/customer-dashboard/access/requests
Content-Type: application/json

{"token":"<original signed-login>"}
```

This endpoint does not accept a typed email or browser-supplied project ID. It
considers only an authentic login capability that is still active or expired
within the last 30 days, then reloads the protected project, rechecks the
normalized-email digest, and sends a fresh 15-minute link only to the stored
address. Every request returns the same generic response, including malformed,
too-old, mismatched, throttled, and provider-failed cases:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"status":"accepted"}
```

Reissues are durable `send_dashboard_login` effect generations. A pending send
suppresses another, and aggregate state prevents a new generation until at least
one minute after the latest generation was created. This controls mail
generation across process restarts but is not an edge-wide request rate limit.

The response redirects the future frontend to `/dashboard/projects/:projectId`.
That page is not served by this repository yet.

Authenticated customer reads are:

```text
GET /v1/orchestration/customer-dashboard/projects/:projectId
GET /v1/orchestration/customer-dashboard/projects/:projectId/events?afterSequence=0&limit=100
```

The project route checks the signed session against the exact path project and
current verified-email digest. It returns a versioned, customer-oriented
projection with plan/payment state, the active parallel build batch, sanitized
per-run observations, and the latest valid frozen preview and healthy production
release. Those last known-good deliverables remain visible while a new revision
builds. The event route is bounded REST pagination, not SSE; `limit` defaults to
100 and is capped at 250. It returns only a fixed content-minimized event field
set.

Dashboard steering uses:

```http
POST /v1/orchestration/customer-dashboard/projects/:projectId/steering
x-buildlabs-csrf: <matching CSRF cookie value>
Idempotency-Key: <stable command key>
Content-Type: application/json

{
  "expectedRevision": 42,
  "expectedProposalVersion": 3,
  "subject": "Dashboard steering",
  "content": "Customer request"
}
```

The session-derived header/cookie pair must match in constant time. The
idempotency key, expected aggregate revision, and expected proposal version are
mandatory. A successful `202` means only `received`; the request then follows
the same immutable versioning, paid-scope, clarification, proof, and delivery
policy as authenticated email.

The orchestration service obtains build activity over its internal build token:

```text
GET <build-backend>/v1/build-runs/:runId/customer-observability?afterSequence=0&limit=100
```

That internal projection contains allowlisted status, stage, slot, aggregate
tool/proof counts, and a bounded categorized timeline. It contains no raw
Daytona URL or sandbox ID, commands, logs, files, prompts, reasoning, secrets,
or event payloads. Its schema always reports `customerRenderable: false`; there
is no customer raster frame route today.

Current backend gaps are a typed-email public link request, server-side session
revocation, logout/renewal, idle expiry, edge-wide dashboard rate limiting,
opaque customer ID aliases, SSE, and the controller-rendered WIP raster gateway.
Provider-backed end-to-end verification is also pending.

The privileged single-operator state endpoint is:

```text
GET /v1/orchestration/projects/:projectId/evidence?afterSequence=0&limit=100
```

It returns the exact encrypted-at-rest aggregate after decryption, a paginated
immutable event window (`limit` is capped at 500), effects, sanitized errors,
dead-letter summaries, inbound-mail recovery state, and
`traceCorrelation = sha256(projectId)`. Because the aggregate includes protected
customer content and contact fields, this endpoint is only for the trusted
operator backend; never call it from a customer browser or expose the internal
token. The current token authenticates the single operator globally rather than
authorizing individual projects. Project-scoped/multi-tenant operator auth
remains deferred.

Every final delivery email includes a deterministic capability URL under
`/v1/orchestration/proof-summaries/:token`. Before the final Resend call, the
orchestrator stores one encrypted, immutable canonical snapshot and records its
ID and digest in durable proof and mail effects. The HMAC capability binds only
that snapshot ID and digest; reads never rebuild from the mutable project
aggregate. The page reports the exact proposal/contract, `candidate.proven`
receipt, artifact, Braintrust trace, and verified Fly deployment recorded in
that snapshot. Publication fails closed on protected customer values,
deterministic PII, credential patterns, unsafe URLs, schema violations, or
size/count limits. Full person names are protected as exact phrases and
multi-part names add bounded partial tokens. To avoid treating ordinary prose
such as “will”, “may”, or “mark” as a person disclosure, single name tokens of
four letters or fewer are case-sensitive; longer name tokens are
case-insensitive.

This URL is a stable, forwardable bearer capability with no per-link expiry.
Anyone who receives it can use it until it is revoked or the signing root is
rotated. Append-only revocation is available to the authenticated operator at
`POST /v1/orchestration/proof-summary-snapshots/:snapshotId/revoke`.
Authenticate with `Authorization: Bearer <ORCHESTRATION_INTERNAL_TOKEN>` and
send `{"reason":"capability_compromised"}` as JSON. Allowed reasons are
`operator_requested`, `capability_compromised`, `privacy_request`, and
`security_policy`. Replaying the same reason is idempotent and returns
`revoked:false`; attempting to replace the immutable reason returns `409`.
Revoked, tampered, malformed, stale, missing, corrupt, and overlong public paths
return the same generic 404 and security headers. Snapshot rows are immutable
and retained indefinitely until a repository-wide retention policy is
implemented; there is intentionally no deletion path today. Signing uses a
purpose-derived key, but its root is currently
`ORCHESTRATION_REPLY_SECRET_BASE64`, so rotating that root invalidates all proof
capabilities and existing signed reply addresses.

The process disables application request logging and never echoes a capability,
but that does not protect logs or telemetry in an upstream proxy/CDN, email
scanner, browser history, or forwarded email. Production infrastructure must
redact or suppress the raw proof path end to end. A bounded in-process limiter
keys only on the verified capability digest before snapshot decryption and
ignores client IP and `X-Forwarded-For`; each application instance has its own
counter. Multi-instance production therefore also requires an edge-wide
rate-limit policy that does not log the raw capability.

Pending final-delivery effects created before immutable proof snapshots existed
remain readable after upgrade but fail closed into operator attention instead of
being resent without a snapshot binding. Any proof URL delivered by the older
pre-snapshot format is invalid after upgrade and resolves through the same
generic 404 path.

Missing or invalid Stripe/Resend signature headers are rejected only after a
minimal security fingerprint is committed. The SQLite receipt contains the
provider, SHA-256 body/header-tuple digests, a fixed failure code, and
timestamp; it never stores raw bodies, header values, or customer identifiers.
Exact replays deduplicate. Unique receipts have a hard default cap of 10,000;
once full, the database updates only one finite overflow counter per
provider/failure code, preventing attacker-controlled row growth. The protected
`GET /v1/orchestration/security/webhooks` endpoint exposes counts and time
bounds only.

Security receipts are immutable and are not aged automatically because a
repository-wide retention/deletion policy has not yet been selected. Operators
must include this bounded table in their approved archive/rotation process; the
cap protects database growth but is not a substitute for that policy.

Set `ORCHESTRATION_PUBLIC_BASE_URL` to the public HTTPS base of the orchestrator
and register these exact derived endpoints:

```text
<public-base>/v1/orchestration/webhooks/stripe
<public-base>/v1/orchestration/webhooks/resend
<public-base>/v1/orchestration/proof-summaries/<signed-capability>
```

The runtime does not create those registrations. `/ready` verifies that enabled
Stripe and Resend registrations with the required events already match the
derived URLs.

The orchestrator's unified `/ready` returns success only when its durable index,
Fireworks model, Braintrust project, Stripe account/webhook, Resend
domains/webhook, Fly organization/token, and build backend are healthy. The
build-backend probe uses its bearer token, validates the exact configured
Daytona snapshot, and transitively checks that backend's Daytona, Fireworks,
Braintrust, and CodeRabbit dependencies.

For inbound steering, the Resend adapter also downloads the provider-issued raw
RFC822 message URL and verifies an aligned DKIM signature using DNS. The runtime
therefore needs outbound HTTPS to Resend/its signed CloudFront or S3 URL and DNS
lookups for DKIM keys. Raw `Authentication-Results` headers are discarded.

## Provider smoke checks

`npm run smoke:providers` performs real, read-only health calls; it does not
create provider resources, register webhooks, send mail, take payment, dispatch
builds, or deploy. It requires all configured provider credentials and a
reachable, already-running authenticated build backend with the expected Daytona
snapshot. The command exits nonzero when any provider check fails.

The recurring worker scans only opaque project IDs in resumable lifecycle
states. It resumes intake analysis from the encrypted original intake,
clarification mail from stored questions, revisions from authenticated stored
messages, proposal/Checkout work, payment checks, partial fan-out, proof,
preview, deploy, and delivery. Discovery never decrypts customer aggregates;
each bounded worker item loads only its own project and re-verifies the exact
provider or evidence state before advancing. Provider-effect failures persist a
sanitized error and next-attempt time; retries keep the same idempotency key,
back off exponentially within the configured cap, and dead-letter after the
configured maximum.
