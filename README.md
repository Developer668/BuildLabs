# BuildStax call transcripts

A small read-only dashboard for the BuildStax inbound website-intake phone
agent.

## Call flow

1. A caller dials the Plivo primary number.
2. Plivo forwards the call over an inbound SIP trunk.
3. The ElevenLabs agent listens, speaks, and gathers the website brief one
   question at a time.
4. ElevenLabs sends a signed post-call transcript webhook.
5. The app verifies the signature, saves the transcript to D1, and shows the
   call as successful or failed.

## Local development

```bash
npm ci
npm run dev
```

The project uses the full ignored `.env.local` copied from BuildStax. The
runtime fields used by this dashboard are:

```text
PLIVO_PRIMARY_NUMBER
ELEVENLABS_AGENT_ID
ELEVENLABS_WEBHOOK_SECRET
CALL_LAB_ACCESS_CODE
```

The transcript webhook URL is `/api/webhooks/elevenlabs`. The dashboard list
API requires the access code in the `x-call-lab-key` header.
