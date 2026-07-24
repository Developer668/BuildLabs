# BuildStax call transcripts

A small read-only dashboard for the BuildStax inbound website-intake phone
agent.

## Call flow

1. A caller dials the Plivo primary number.
2. Plivo forwards the call over an inbound SIP trunk.
3. The ElevenLabs agent listens, speaks, and gathers the website brief one
   question at a time.
4. After the call ends, open or reload the localhost dashboard. If ElevenLabs
   is still processing, wait a few seconds and press **Refresh**.
5. The server fetches only new completed calls from ElevenLabs, saves them to
   the project-local D1 database, and shows whether each call succeeded or
   failed and why.

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
ELEVENLABS_API_KEY
```

The dashboard is intended for `http://localhost:3000/`. It does not poll in the
background: the transcript API is called on initial load and when Refresh is
pressed. Local development needs no dashboard access code. Set
`CALL_LAB_ACCESS_CODE` only if the API is intentionally exposed beyond
localhost.
