# BuildLabs voice intake

This workspace is the local operator surface and signed post-call bridge for
BuildLabs ElevenLabs intake sessions.

## Boundaries

- The Call Lab reads at most 100 completed conversations directly from
  ElevenLabs. It does not create a second transcript database.
- A valid `post_call_transcription` webhook is accepted only for the configured
  agent and a provider-marked complete intake. The normalized transcript is sent
  to the existing BuildLabs orchestration intake endpoint with a stable
  idempotency key.
- Voice-captured email is always forwarded as unverified, and the bridge never
  claims research consent.
- This workspace does not implement the browser conversation client, customer
  authentication, or a PSTN transport.

## Local development

Install once from the repository root:

```bash
npm install
```

Create an ignored `apps/voice-intake/.env.local` with the required local values:

```text
ELEVENLABS_AGENT_ID
ELEVENLABS_API_KEY
ELEVENLABS_WEBHOOK_SECRET
ORCHESTRATION_INTERNAL_TOKEN
BUILDLABS_ORCHESTRATION_URL
CALL_LAB_ACCESS_CODE
```

`BUILDLABS_ORCHESTRATION_URL` defaults to `http://127.0.0.1:3100`. Run the
orchestrator and Call Lab from separate terminals:

```bash
npm run dev:orchestration
npm run dev:voice
```

The Call Lab is served on the next available Vinext development port. The
ElevenLabs post-call webhook route is `/api/webhooks/elevenlabs`.
