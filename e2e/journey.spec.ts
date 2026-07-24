import { expect, test, type Response } from "@playwright/test";

import { JOURNEY_HOSTS } from "./lib/environment.js";
import {
  JOURNEY_CUSTOMER,
  journeyTranscriptText,
} from "./lib/journey-fixture.js";
import { readJourneyRuntime } from "./lib/runtime.js";
import { elevenLabsSignatureHeader } from "./lib/signing.js";
import type {
  CapturedMail,
  StubCheckoutSession,
} from "./stubs/provider-stub.js";

const runtime = readJourneyRuntime();
const OPAQUE_PROJECT_ALIAS = /^prj_[A-Za-z0-9_-]{22}$/;
const UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
/** The intake bridge budget the 29.4s regression blew through. */
const INTAKE_LATENCY_BUDGET_MS = 5_000;

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${runtime.audioFixturePath}`,
      "--autoplay-policy=no-user-gesture-required",
      // The emailed login link is a real public HTTPS URL. Rather than rewrite
      // it (which would defeat the point of the test) the browser is taught to
      // resolve that hostname at the loopback TLS front for the dashboard.
      `--host-resolver-rules=MAP ${JOURNEY_HOSTS.dashboard} 127.0.0.1:${String(runtime.dashboardTlsPort)}`,
    ],
  },
});

interface JourneyState {
  conversationId: string;
  projectId: string;
  checkoutUrl: string;
  checkoutSessionId: string;
  loginLink: string;
  projectAlias: string;
}

const state: JourneyState = {
  conversationId: "",
  projectId: "",
  checkoutUrl: "",
  checkoutSessionId: "",
  loginLink: "",
  projectAlias: "",
};

test.describe.configure({ mode: "serial" });

test.describe("BuildLabs cross-service journey", () => {
  test.skip(
    runtime.mode === "live" && process.env.E2E_LIVE !== "1",
    "Live mode requires E2E_LIVE=1 and real provider credentials",
  );

  test("voice intake reaches a proven, delivered build", async ({
    page,
    request,
  }) => {
    const voiceUnavailable = runtime.degradations.find((note) =>
      note.startsWith("voice-intake"),
    );

    await test.step("hop 1: browser voice intake with a fake microphone", async () => {
      test.skip(
        voiceUnavailable !== undefined,
        `Voice intake service unavailable: ${voiceUnavailable ?? ""}`,
      );
      await page.goto(`${runtime.origins.voiceIntake}/`, {
        waitUntil: "domcontentloaded",
      });

      // Proves the fake-device flags actually took effect: a real Chromium
      // media pipeline is producing audio from the generated WAV fixture.
      const microphone = await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const track = stream.getAudioTracks()[0];
        const result = {
          tracks: stream.getAudioTracks().length,
          live: track?.readyState === "live",
          label: track?.label ?? "",
        };
        for (const each of stream.getTracks()) {
          each.stop();
        }
        return result;
      });
      expect(microphone.tracks, "fake microphone track count").toBe(1);
      expect(microphone.live, "fake microphone is live").toBe(true);

      // The browser-originated session mint is the first real cross-service
      // hop: page -> voice worker -> ElevenLabs.
      const session = await page.evaluate(async () => {
        const response = await fetch("/api/conversation-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        return {
          status: response.status,
          body: (await response.text()).slice(0, 2_000),
        };
      });
      expect(
        session.status,
        `voice worker -> ElevenLabs session mint failed: ${session.body}`,
      ).toBe(200);
      const parsed = JSON.parse(session.body) as {
        signedUrl: string;
        conversationId: string;
      };
      expect(parsed.signedUrl).toMatch(
        /^wss:\/\/api\.elevenlabs\.io\/v1\/convai\/conversation\?/,
      );
      expect(parsed.conversationId).toMatch(/^conv_[A-Za-z0-9_-]+$/);
      state.conversationId = parsed.conversationId;
    });

    await test.step("hop 2: post-call bridge answers well inside its timeout", async () => {
      // The bridge itself rejects unsigned callbacks. That check runs entirely
      // inside the voice worker, so it is drivable even in stub mode.
      if (voiceUnavailable === undefined) {
        const unsigned = await request.post(
          `${runtime.origins.voiceIntake}/api/webhooks/elevenlabs`,
          {
            headers: { "content-type": "application/json" },
            data: { type: "post_call_transcription", data: {} },
          },
        );
        expect(
          unsigned.status(),
          "unsigned ElevenLabs post-call webhook must be rejected",
        ).toBe(401);

        const payload = JSON.stringify({
          type: "post_call_transcription",
          event_timestamp: Math.floor(Date.now() / 1_000),
          data: {
            conversation_id: state.conversationId || "conv_journeystub01",
          },
        });
        const signed = await request.post(
          `${runtime.origins.voiceIntake}/api/webhooks/elevenlabs`,
          {
            headers: {
              "content-type": "application/json",
              "elevenlabs-signature": elevenLabsSignatureHeader(
                payload,
                runtime.secrets.elevenLabsWebhook,
              ),
            },
            data: payload,
          },
        );
        expect(
          [202, 503],
          `signed post-call webhook returned ${String(signed.status())}`,
        ).toContain(signed.status());
      }

      // The regression guard proper: the orchestrator's intake endpoint must
      // answer far inside the bridge's abort budget. The measured defect was
      // 29.4s against a 15s client timeout.
      const body = voiceIntakeRequestBody();
      const started = Date.now();
      const response = await request.post(
        `${runtime.origins.orchestrator}/v1/orchestration/intakes`,
        {
          headers: {
            authorization: `Bearer ${runtime.tokens.orchestrator}`,
            "content-type": "application/json",
            "idempotency-key": body.intakeId,
          },
          data: body,
          timeout: 60_000,
        },
      );
      const elapsedMs = Date.now() - started;
      expect(response.status(), `intake failed: ${await response.text()}`).toBe(
        202,
      );
      const accepted = (await response.json()) as {
        accepted: boolean;
        project: { projectId: string; status: string };
      };
      expect(accepted.accepted).toBe(true);
      expect(accepted.project.projectId).toMatch(UUID);
      state.projectId = accepted.project.projectId;
      expect(
        elapsedMs,
        `POST /v1/orchestration/intakes took ${String(elapsedMs)}ms; the voice bridge aborts long before that`,
      ).toBeLessThan(INTAKE_LATENCY_BUDGET_MS);

      // Idempotency: the bridge retries with the same key on transport errors.
      const replay = await request.post(
        `${runtime.origins.orchestrator}/v1/orchestration/intakes`,
        {
          headers: {
            authorization: `Bearer ${runtime.tokens.orchestrator}`,
            "content-type": "application/json",
            "idempotency-key": body.intakeId,
          },
          data: body,
        },
      );
      expect(replay.status()).toBe(202);
      expect(
        ((await replay.json()) as { project: { projectId: string } }).project
          .projectId,
      ).toBe(state.projectId);
    });

    await test.step("hop 3: verified email yields a version-bound checkout link", async () => {
      test.skip(
        runtime.stubControlOrigin === "",
        "Reading outbound mail requires the stub mailbox",
      );
      const verification = await request.post(
        `${runtime.origins.orchestrator}/v1/orchestration/projects/${state.projectId}/email-verifications`,
        {
          headers: {
            authorization: `Bearer ${runtime.tokens.orchestrator}`,
            "content-type": "application/json",
          },
          data: {
            method: "passwordless_email",
            provider: "buildlabs_journey",
            providerEventId: `journey-verification-${state.projectId}`,
            email: JOURNEY_CUSTOMER.email,
            verifiedAt: new Date().toISOString(),
          },
        },
      );
      expect(
        verification.status(),
        `email verification failed: ${await verification.text()}`,
      ).toBe(202);

      const checkout = await waitForCheckoutSession();
      state.checkoutSessionId = checkout.id;
      state.checkoutUrl = checkout.url;
      expect(checkout.customerEmail).toBe(JOURNEY_CUSTOMER.email);
      expect(checkout.metadata.buildlabs_project_id).toBe(state.projectId);
      // Version binding is what stops a paid old proposal from shipping.
      expect(checkout.metadata.buildlabs_proposal_version).toMatch(/^\d+$/);
      expect(checkout.metadata.buildlabs_proposal_digest).toMatch(
        /^[a-f0-9]{64}$/,
      );

      const proposalMail = await waitForMail((mail) =>
        mail.links.some((link) => link.includes(checkout.id)),
      );
      expect(proposalMail.to).toContain(JOURNEY_CUSTOMER.email);
    });

    await test.step("hop 4: a signed paid webhook dispatches the build", async () => {
      const paid = await request.post(
        `${runtime.stubControlOrigin}/__e2e/checkout-sessions/${state.checkoutSessionId}/pay`,
        { data: {} },
      );
      expect(paid.status()).toBe(200);
      const result = (await paid.json()) as { status: number; body: string };
      expect(
        result.status,
        `orchestrator rejected the signed Stripe webhook: ${result.body}`,
      ).toBe(204);

      await expect
        .poll(
          async () => {
            const evidence = await request.get(
              `${runtime.origins.orchestrator}/v1/orchestration/projects/${state.projectId}/evidence`,
              {
                headers: {
                  authorization: `Bearer ${runtime.tokens.orchestrator}`,
                },
              },
            );
            return evidence.ok() ? await evidence.text() : "";
          },
          {
            message: "orchestrator never recorded the settled payment",
            timeout: 60_000,
          },
        )
        .toContain(state.checkoutSessionId);
    });

    await test.step("hop 5: the emailed login link lands on the dashboard", async () => {
      const loginMail = await waitForMail((mail) =>
        mail.links.some((link) => link.includes("/v1/customer/access#token=")),
      );
      const loginLink = loginMail.links.find((link) =>
        link.includes("/v1/customer/access#token="),
      );
      expect(loginLink, "no customer login link was emailed").toBeDefined();
      state.loginLink = loginLink ?? "";
      const parsed = new URL(state.loginLink);

      // The exact dead end this test exists to prevent: the orchestrator used
      // to mail a link to its own origin, whose redirect target
      // (/dashboard/projects/...) only the Next.js dashboard serves.
      expect(
        parsed.origin,
        "the emailed login link must target the dashboard origin",
      ).toBe(runtime.dashboardPublicOrigin);
      expect(parsed.origin).not.toBe(`https://${JOURNEY_HOSTS.orchestrator}`);
      expect(parsed.pathname).toBe("/v1/customer/access");
      expect(parsed.hash).toMatch(/^#token=[A-Za-z0-9_.-]+$/);

      await page.goto(state.loginLink, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/dashboard\/projects\/[^/]+$/, {
        timeout: 30_000,
      });
      const landed = new URL(page.url());
      expect(landed.origin).toBe(runtime.dashboardPublicOrigin);
      const alias = landed.pathname.split("/").pop() ?? "";
      expect(alias, "customer URLs must carry an opaque alias").toMatch(
        OPAQUE_PROJECT_ALIAS,
      );
      expect(
        alias,
        "customer URLs must never expose an internal id",
      ).not.toMatch(UUID);
      state.projectAlias = alias;

      const cookies = await page
        .context()
        .cookies(runtime.dashboardPublicOrigin);
      expect(
        cookies.map((cookie) => cookie.name),
        "the dashboard must own the customer session cookie",
      ).toContain("buildlabs_dashboard_session");
    });

    await test.step("hop 6: customer-visible surfaces leak no sandbox identity", async () => {
      const bodies: string[] = [];
      page.on("response", (response: Response) => {
        void response
          .text()
          .then((text) => bodies.push(text))
          .catch(() => undefined);
      });
      await page.reload({ waitUntil: "networkidle" });
      const dom = await page.content();
      bodies.push(dom);

      for (const body of bodies) {
        expect(body, "a Daytona URL reached the customer").not.toMatch(
          /https?:\/\/[^\s"']*daytona[^\s"']*/i,
        );
        expect(body, "a sandbox identifier reached the customer").not.toMatch(
          /\bsandbox(?:Id|_id)\b/i,
        );
        expect(
          body,
          "an internal project id reached the customer",
        ).not.toContain(state.projectId);
      }
    });
  });

  test.fixme("hop 1 (remainder): a real ElevenLabs conversation is spoken end to end", () => {
    // Not drivable in stub mode, for two independent reasons:
    //   1. apps/voice-intake ships an operator call archive at `/`; it has no
    //      in-page conversation widget, so there is no button that starts a
    //      WebRTC session for Playwright to click.
    //   2. `createBrowserConversationSession` pins the signed URL to
    //      wss://api.elevenlabs.io with no port, and the voice worker runs in
    //      workerd, which does not honour the Node proxy env the rest of the
    //      harness uses. Terminating that socket locally would require
    //      editing apps/voice-intake, which this change may not do.
    // To finish this: add a voice widget with a stable test id, and make the
    // ElevenLabs endpoint host configurable so a local wss stub can serve it.
  });

  test.fixme("hop 2 (remainder): the post-call bridge forwards a real transcript", () => {
    // `POST /api/webhooks/elevenlabs` verifies its signature locally (asserted
    // above) and then calls getCompletedElevenLabsConversation, which fetches
    // https://api.elevenlabs.io from inside workerd. workerd ignores
    // HTTPS_PROXY/NODE_EXTRA_CA_CERTS, so the stub cannot answer it and the
    // route fails closed with 503 before reaching forwardVoiceIntake.
    // To finish this: run the voice app on the Node runtime for the journey,
    // or let the ElevenLabs API origin be configured per environment.
  });

  test.fixme("hop 7: proof gate, winner, frozen preview, deploy, final URL", () => {
    // The build-agent backend loop needs a real Daytona sandbox (SDK calls plus
    // an in-sandbox `docker build`), the CodeRabbit CLI, and flyctl. Daytona is
    // reachable over the stub proxy, but the loop also shells out to docker and
    // coderabbit inside the sandbox, and the deploy step shells out to flyctl —
    // none of which a network stub can satisfy. Faking a proof receipt here
    // would defeat the invariant this repository exists to protect.
    // To finish this: run this hop only in E2E_LIVE mode, or introduce a
    // recorded-sandbox provider behind SandboxProvider for the journey.
  });
});

interface VoiceIntakeRequestBody {
  channel: "voice";
  intakeId: string;
  sourceId: string;
  receivedAt: string;
  content: string;
  emailVerified: false;
  researchConsent: boolean;
  provider: "elevenlabs";
}

function voiceIntakeRequestBody(): VoiceIntakeRequestBody {
  // Mirrors buildVoiceIntakeRequest in apps/voice-intake/lib/orchestration.ts.
  const conversationId = state.conversationId || "conv_journeystub0000000001";
  return {
    channel: "voice",
    intakeId: `elevenlabs:${conversationId}`,
    sourceId: conversationId,
    receivedAt: new Date().toISOString(),
    content: journeyTranscriptText(),
    emailVerified: false,
    researchConsent: false,
    provider: "elevenlabs",
  };
}

async function fetchMailbox(): Promise<CapturedMail[]> {
  const response = await fetch(`${runtime.stubControlOrigin}/__e2e/mail`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await response.json()) as { items: CapturedMail[] };
  return body.items;
}

async function waitForMail(
  predicate: (mail: CapturedMail) => boolean,
  timeoutMs = 90_000,
): Promise<CapturedMail> {
  const deadline = Date.now() + timeoutMs;
  let seen: CapturedMail[] = [];
  while (Date.now() < deadline) {
    seen = await fetchMailbox();
    const match = seen.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error(
    `No matching outbound mail within ${String(timeoutMs)}ms. Captured subjects: ${seen
      .map((mail) => mail.subject)
      .join(" | ")}`,
  );
}

async function waitForCheckoutSession(
  timeoutMs = 90_000,
): Promise<StubCheckoutSession> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${runtime.stubControlOrigin}/__e2e/checkout-sessions`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const body = (await response.json()) as { items: StubCheckoutSession[] };
    const match = body.items.find(
      (session) => session.metadata.buildlabs_project_id === state.projectId,
    );
    if (match) {
      return match;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error(
    `The orchestrator never created a Stripe Checkout session for project ${state.projectId}`,
  );
}
