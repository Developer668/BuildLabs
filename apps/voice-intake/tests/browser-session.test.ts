import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OPTIONS as conversationSessionPreflight,
  POST as createConversationSession,
} from "../app/api/conversation-session/route";
import { verifyIntakeToolCapability } from "../lib/tool-capability";

const ORIGIN = "https://voice.buildlabs.test";
const AGENT_ID = "agent_buildlabs_browser";
const BRANCH_ID = "branch_buildlabs_development";
const AGENT_VERSION = "version_buildlabs_0001";
const API_KEY = "elevenlabs-server-api-key";

function configureBrowserVoice() {
  process.env.ELEVENLABS_API_KEY = API_KEY;
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  process.env.ELEVENLABS_BRANCH_ID = BRANCH_ID;
  process.env.ELEVENLABS_AGENT_VERSION_ID = AGENT_VERSION;
  process.env.ELEVENLABS_CAPABILITY_SECRET =
    "test-capability-secret-that-is-at-least-32-bytes";
  process.env.ELEVENLABS_TOOL_SECRET =
    "test-tool-secret-that-is-at-least-32-bytes";
  process.env.ELEVENLABS_CUSTOM_LLM_SECRET =
    "test-custom-llm-secret-that-is-at-least-32-bytes";
  process.env.VOICE_SESSION_SECRET =
    "test-browser-session-secret-at-least-32-bytes";
  process.env.FIREWORKS_API_KEY = "test-fireworks-server-key";
  process.env.FIREWORKS_VOICE_MODEL = "accounts/buildlabs/models/voice";
  process.env.VOICE_INTAKE_ALLOWED_ORIGINS = ORIGIN;
}

function sessionRequest(
  body: Record<string, unknown> = {},
  {
    origin = ORIGIN,
    contentType = "application/json",
  }: { origin?: string; contentType?: string } = {},
) {
  return new Request(`${ORIGIN}/api/conversation-session`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      origin,
    },
    body: JSON.stringify(body),
  });
}

function providerResponse(conversationId: string) {
  return new Response(
    JSON.stringify({
      signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&token=single-use-${conversationId}`,
      conversation_id: conversationId,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function nonCanonicalSignatureVariant(token: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("invalid test token");
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = signature.at(-1) ?? "";
  const index = alphabet.indexOf(last);
  if (index < 0) throw new Error("invalid test signature");
  const replacement = alphabet[(index & ~3) | ((index + 1) & 3)]!;
  return `${payload}.${signature.slice(0, -1)}${replacement}`;
}

beforeEach(() => {
  configureBrowserVoice();
});

afterEach(() => {
  for (const name of [
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_BRANCH_ID",
    "ELEVENLABS_AGENT_VERSION_ID",
    "ELEVENLABS_CAPABILITY_SECRET",
    "ELEVENLABS_TOOL_SECRET",
    "ELEVENLABS_CUSTOM_LLM_SECRET",
    "VOICE_SESSION_SECRET",
    "VOICE_INTAKE_ALLOWED_ORIGINS",
    "FIREWORKS_API_KEY",
    "FIREWORKS_VOICE_MODEL",
  ]) {
    delete process.env[name];
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser conversation sessions", () => {
  it("mints a testing-branch single-use session without exposing server keys", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      providerResponse("conv_browser_session_0001"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createConversationSession(sessionRequest());
    const body = (await response.json()) as {
      signedUrl: string;
      conversationId: string;
      reconnectAttempt: number;
      reconnectToken: string;
      initiation: {
        dynamic_variables: {
          secret__buildlabs_capability: string;
          buildlabs_project_id: string;
          buildlabs_contract_version: number;
          buildlabs_agent_version: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(body.conversationId).toBe("conv_browser_session_0001");
    expect(body.reconnectAttempt).toBe(0);
    expect(body.initiation.dynamic_variables).toMatchObject({
      buildlabs_contract_version: 0,
      buildlabs_agent_version: AGENT_VERSION,
    });
    expect(body.initiation.dynamic_variables.buildlabs_project_id).toMatch(
      /^intake_[A-Za-z0-9_-]+$/u,
    );
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(body).not.toHaveProperty("capability");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [providerUrl, options] = fetchMock.mock.calls[0]!;
    const parsedUrl = new URL(String(providerUrl));
    expect(parsedUrl.origin + parsedUrl.pathname).toBe(
      "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url",
    );
    expect(Object.fromEntries(parsedUrl.searchParams)).toEqual({
      agent_id: AGENT_ID,
      include_conversation_id: "true",
      branch_id: BRANCH_ID,
      environment: "testing",
    });
    expect(options?.headers).toEqual({
      accept: "application/json",
      "xi-api-key": API_KEY,
    });

    await expect(
      verifyIntakeToolCapability(
        body.initiation.dynamic_variables.secret__buildlabs_capability,
        {
          agentId: AGENT_ID,
          conversationId: body.conversationId,
          projectId: body.initiation.dynamic_variables.buildlabs_project_id,
          contractVersion: 0,
          agentVersion: AGENT_VERSION,
          scope: "intake:clarify",
        },
      ),
    ).resolves.toMatchObject({
      conversationId: body.conversationId,
      contractVersion: 0,
    });
  });

  it("permits configured dashboard origins to preflight a browser session", () => {
    const response = conversationSessionPreflight(
      new Request(`${ORIGIN}/api/conversation-session`, {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
  });

  it("issues a fresh provider URL for a bounded reconnect and rejects replay", async () => {
    let providerCall = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      providerCall += 1;
      return providerResponse(`conv_browser_reconnect_000${providerCall}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await createConversationSession(sessionRequest());
    const first = (await firstResponse.json()) as {
      signedUrl: string;
      reconnectToken: string;
      initiation: {
        dynamic_variables: { buildlabs_project_id: string };
      };
    };
    const secondResponse = await createConversationSession(
      sessionRequest({ reconnectToken: first.reconnectToken }),
    );
    const second = (await secondResponse.json()) as {
      signedUrl: string;
      reconnectAttempt: number;
      initiation: {
        dynamic_variables: { buildlabs_project_id: string };
      };
    };

    expect(secondResponse.status).toBe(200);
    expect(second.reconnectAttempt).toBe(1);
    expect(second.signedUrl).not.toBe(first.signedUrl);
    expect(second.initiation.dynamic_variables.buildlabs_project_id).toBe(
      first.initiation.dynamic_variables.buildlabs_project_id,
    );

    const replay = await createConversationSession(
      sessionRequest({ reconnectToken: first.reconnectToken }),
    );
    await expect(replay.json()).resolves.toEqual({
      error: "reconnect_replayed",
    });
    expect(replay.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired reconnect before contacting ElevenLabs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));
    const fetchMock = vi.fn<typeof fetch>(async () =>
      providerResponse("conv_browser_expiry_0001"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const initialResponse = await createConversationSession(sessionRequest());
    const initial = (await initialResponse.json()) as {
      reconnectToken: string;
    };
    vi.setSystemTime(new Date("2026-07-24T12:11:00.000Z"));

    const expired = await createConversationSession(
      sessionRequest({ reconnectToken: initial.reconnectToken }),
    );
    await expect(expired.json()).resolves.toEqual({
      error: "session_expired",
    });
    expect(expired.status).toBe(410);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects non-canonical reconnect signature encodings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      providerResponse("conv_browser_canonical_0001"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const initialResponse = await createConversationSession(sessionRequest());
    const initial = (await initialResponse.json()) as {
      reconnectToken: string;
    };

    const forged = await createConversationSession(
      sessionRequest({
        reconnectToken: nonCanonicalSignatureVariant(initial.reconnectToken),
      }),
    );

    expect(forged.status).toBe(400);
    await expect(forged.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects forged origins and non-JSON requests before provider access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const forged = await createConversationSession(
      sessionRequest({}, { origin: "https://attacker.example" }),
    );
    expect(forged.status).toBe(403);
    await expect(forged.json()).resolves.toEqual({
      error: "origin_not_allowed",
    });

    const wrongType = await createConversationSession(
      sessionRequest({}, { contentType: "text/plain" }),
    );
    expect(wrongType.status).toBe(415);
    await expect(wrongType.json()).resolves.toEqual({
      error: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without an explicit development branch and agent version", async () => {
    delete process.env.ELEVENLABS_BRANCH_ID;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await createConversationSession(sessionRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "session_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a provider-supplied WebSocket URL outside ElevenLabs", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            signed_url:
              "wss://attacker.example/v1/convai/conversation?token=stolen",
            conversation_id: "conv_browser_wrong_host_0001",
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createConversationSession(sessionRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider_unavailable",
    });
  });

  it("falls back to the conversation id carried inside the signed URL", async () => {
    const conversationId = "conv_browser_url_only_00001";
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&conversation_id=${conversationId}&token=single-use-url-only`,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createConversationSession(sessionRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversationId: string };
    expect(body.conversationId).toBe(conversationId);
  });

  it("rejects a provider response with no conversation id in either place", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&token=single-use-no-id`,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await createConversationSession(sessionRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider_unavailable",
    });
  });
});
