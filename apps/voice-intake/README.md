# BuildLabs voice intake

This workspace is the signed browser voice service and post-call bridge for
BuildLabs ElevenLabs intake sessions. The customer conversation control lives
inside the unified `apps/dashboard` project workspace.

## Boundaries

- Browser voice starts only through a server-minted, single-use ElevenLabs
  signed URL pinned to the configured development branch and testing
  environment. The browser receives no provider API key.
- Each bounded browser session uses a server-created opaque intake project at
  contract version `0` and a short-lived controller-signed tool capability.
  Reconnects require a separate purpose-bound token and receive a fresh provider
  URL and conversation ID.
- Browser microphone audio uses the native ElevenAgents WebSocket PCM protocol.
  Live transcript turns exist only in memory and are cleared on reconnect,
  failure, completion, expiry, and unmount.
- The Call Lab reads at most 100 completed conversations directly from
  ElevenLabs. It does not create a second transcript database.
- A valid `post_call_transcription` webhook is accepted only for the configured
  agent, branch, version, testing environment, and an ordered set of accepted
  contact, research-consent, and finalization tool results. The normalized
  transcript is sent to the existing BuildLabs orchestration intake endpoint
  with a stable idempotency key.
- Voice-captured email is always forwarded as unverified. Research consent is
  forwarded only from the explicit, locally validated consent tool result.
- Inbound PSTN uses one existing dedicated Plivo test DID through a native
  TLS/SRTP Zentrunk route to ElevenLabs. An authenticated pre-call webhook mints
  the same conversation capability as browser voice. It discards caller ID and
  call correlation values; neither successful connection nor ANI verifies
  identity or phone ownership.
- Plivo does not record, transcribe, originate calls, purchase/release numbers,
  or own a second archive. ElevenLabs remains authoritative for ASR, turns,
  transcript, completion, and post-call normalization.
- This workspace does not implement customer authentication.
- Webhook processing returns success only after the downstream orchestration
  intake durably records the stable conversation-scoped idempotency key and
  exact normalized-intake digest. Until then it returns a retryable failure so
  ElevenLabs redelivers. That orchestration transaction is the durable inbox;
  this workspace intentionally does not persist a second webhook body or
  transcript copy.

## Local development

Install once from the repository root:

```bash
npm install
```

Create an ignored `apps/voice-intake/.env.local` with the required local values:

```text
ELEVENLABS_AGENT_ID
ELEVENLABS_API_KEY
ELEVENLABS_BRANCH_ID
ELEVENLABS_AGENT_VERSION_ID
ELEVENLABS_CAPABILITY_SECRET
ELEVENLABS_TOOL_SECRET
ELEVENLABS_CUSTOM_LLM_SECRET
ELEVENLABS_PRECALL_SECRET
ELEVENLABS_WEBHOOK_SECRET
FIREWORKS_API_KEY
FIREWORKS_VOICE_MODEL
ORCHESTRATION_INTERNAL_TOKEN
BUILDLABS_ORCHESTRATION_URL
CALL_LAB_ACCESS_CODE
VOICE_SESSION_SECRET
VOICE_INTAKE_ALLOWED_ORIGINS
PLIVO_BUILDLABS_NUMBER
```

The ElevenLabs workspace secret referenced by
`ELEVENLABS_TOOL_BEARER_SECRET_ID` must contain
`Bearer <ELEVENLABS_TOOL_SECRET>`; the local environment variable contains only
the raw secret. `ELEVENLABS_PRECALL_SECRET_ID` must likewise contain
`Bearer <ELEVENLABS_PRECALL_SECRET>`. Reconciliation also needs
`ELEVENLABS_VOICE_ID`,
`BUILDLABS_VOICE_PUBLIC_BASE_URL`, `ELEVENLABS_CUSTOM_LLM_SECRET_ID`,
`ELEVENLABS_TOOL_BEARER_SECRET_ID`, `ELEVENLABS_PRECALL_SECRET_ID`, and
`ELEVENLABS_WEBHOOK_ID`.

`BUILDLABS_ORCHESTRATION_URL` defaults to `http://127.0.0.1:3100`. Set
`VOICE_INTAKE_ALLOWED_ORIGINS` to the dashboard's exact public origin; the
dashboard's `NEXT_PUBLIC_BUILDLABS_VOICE_INTAKE_URL` must point back to this
service. Run the orchestrator, dashboard, and voice service from separate
terminals:

```bash
npm run dev:orchestration
npm run dev:dashboard
npm run dev:voice
```

The Call Lab is served on the next available Vinext development port. The
server-only browser session route is `/api/conversation-session`; the ElevenLabs
SIP pre-call route is `/api/telephony/elevenlabs/init`; the ElevenLabs post-call
webhook route is `/api/webhooks/elevenlabs`.

## Provider reconciliation

`npm run elevenlabs:reconcile` is read-only by default and emits the managed
resource diff plus the expected base version. Apply only through:

```bash
npm run elevenlabs:reconcile -- --apply \
  --expected-base-version=<version_id_from_the_plan>
```

Apply refuses to enable account versioning, change production traffic, merge a
branch, create or enable a workspace webhook, update shared tools, or continue
after a stale version read. `npm run elevenlabs:simulate` runs the attached
tests only when a zero-traffic development branch, exact version, webhook,
tools, tests, and managed agent configuration all read back without drift.

The Plivo reconciler is also read-only by default:

```bash
npm run plivo:probe
npm run plivo:reconcile
npm run plivo:reconcile -- --apply \
  --expected-base-digest=<digest_from_the_plan> \
  --allow-number-routing
```

It requires `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`,
`PLIVO_BUILDLABS_NUMBER`, and an independent
`PLIVO_RECONCILIATION_SECRET`, plus the exact ElevenLabs agent, branch, and
version variables. It creates only repository-owned inbound test resources,
stages the secure trunk disabled, assigns the exact ElevenLabs testing branch,
binds the previously unassigned test DID last, and reads both providers back.
It never adopts similarly named resources, mutates an active drifted route,
deletes provider resources, or retries an ambiguous mutation blindly.
