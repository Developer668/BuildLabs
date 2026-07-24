import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as initializeTelephony } from "../app/api/telephony/elevenlabs/init/route";
import { verifyIntakeToolCapability } from "../lib/tool-capability";

const AGENT_ID = "agent_buildlabs_telephony";
const AGENT_VERSION = "version_buildlabs_telephony_0001";
const BRANCH_ID = "branch_buildlabs_telephony_testing";
const CONVERSATION_ID = "conv_buildlabs_telephony_0001";
const CALLED_NUMBER = "+15105550123";
const CALL_ID = "call_buildlabs_telephony_0001";
const CALLER_ID = "+15105559876";
const PRECALL_SECRET = "precall-secret-that-is-at-least-thirty-two-bytes";

function configureTelephony() {
  process.env.ELEVENLABS_AGENT_ID = AGENT_ID;
  process.env.ELEVENLABS_AGENT_VERSION_ID = AGENT_VERSION;
  process.env.ELEVENLABS_BRANCH_ID = BRANCH_ID;
  process.env.ELEVENLABS_CAPABILITY_SECRET =
    "capability-secret-that-is-at-least-thirty-two-bytes";
  process.env.ELEVENLABS_PRECALL_SECRET = PRECALL_SECRET;
  process.env.PLIVO_BUILDLABS_NUMBER = CALLED_NUMBER;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    called_number: CALLED_NUMBER,
    caller_id: CALLER_ID,
    call_sid: CALL_ID,
    conversation_id: CONVERSATION_ID,
    ...overrides,
  };
}

function request(
  body: string | Record<string, unknown>,
  authorization = `Bearer ${PRECALL_SECRET}`,
  contentType = "application/json",
) {
  return new Request(
    "https://voice.buildlabs.test/api/telephony/elevenlabs/init",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": contentType,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  configureTelephony();
});

afterEach(() => {
  for (const name of [
    "ELEVENLABS_AGENT_ID",
    "ELEVENLABS_AGENT_VERSION_ID",
    "ELEVENLABS_BRANCH_ID",
    "ELEVENLABS_CAPABILITY_SECRET",
    "ELEVENLABS_PRECALL_SECRET",
    "PLIVO_BUILDLABS_NUMBER",
  ]) {
    delete process.env[name];
  }
});

describe("ElevenLabs SIP pre-call initialization", () => {
  it("mints a capability pinned to the testing branch without returning caller data", async () => {
    const response = await initializeTelephony(request(payload()));
    const body = (await response.json()) as {
      type: string;
      branch_id: string;
      environment: string;
      dynamic_variables: {
        secret__buildlabs_capability: string;
        buildlabs_project_id: string;
        buildlabs_contract_version: number;
        buildlabs_agent_version: string;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      type: "conversation_initiation_client_data",
      branch_id: BRANCH_ID,
      environment: "testing",
      dynamic_variables: {
        buildlabs_contract_version: 0,
        buildlabs_agent_version: AGENT_VERSION,
      },
    });
    expect(body.dynamic_variables.buildlabs_project_id).toMatch(
      /^intake_tel_[A-Za-z0-9_-]+$/u,
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(CALLER_ID);
    expect(serialized).not.toContain(CALL_ID);
    expect(serialized).not.toContain(CALLED_NUMBER);

    await expect(
      verifyIntakeToolCapability(
        body.dynamic_variables.secret__buildlabs_capability,
        {
          agentId: AGENT_ID,
          conversationId: CONVERSATION_ID,
          projectId: body.dynamic_variables.buildlabs_project_id,
          contractVersion: 0,
          agentVersion: AGENT_VERSION,
          scope: "intake:finalize",
        },
      ),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      projectId: body.dynamic_variables.buildlabs_project_id,
    });
  });

  it("derives stable project identity while rotating replayed capabilities", async () => {
    const first = (await (
      await initializeTelephony(request(payload()))
    ).json()) as {
      dynamic_variables: {
        secret__buildlabs_capability: string;
        buildlabs_project_id: string;
      };
    };
    const second = (await (
      await initializeTelephony(request(payload()))
    ).json()) as typeof first;

    expect(second.dynamic_variables.buildlabs_project_id).toBe(
      first.dynamic_variables.buildlabs_project_id,
    );
    expect(second.dynamic_variables.secret__buildlabs_capability).not.toBe(
      first.dynamic_variables.secret__buildlabs_capability,
    );
  });

  it("accepts the documented SIP call_id variant without caller identity", async () => {
    const sipPayload: Record<string, unknown> = payload();
    delete sipPayload.call_sid;
    delete sipPayload.caller_id;
    const response = await initializeTelephony(
      request({ ...sipPayload, call_id: CALL_ID }),
    );
    expect(response.status).toBe(200);
  });

  it("authenticates before parsing and rejects malformed or oversized payloads", async () => {
    const forged = await initializeTelephony(request("{", "Bearer forged"));
    expect(forged.status).toBe(401);
    await expect(forged.json()).resolves.toEqual({ error: "unauthorized" });

    const malformed = await initializeTelephony(request("{"));
    expect(malformed.status).toBe(400);

    const oversized = await initializeTelephony(
      request(
        JSON.stringify({
          ...payload(),
          caller_id: `+1${"2".repeat(8_300)}`,
        }),
      ),
    );
    expect(oversized.status).toBe(413);
  });

  it("rejects forged resources, extra fields, and non-JSON requests", async () => {
    for (const body of [
      payload({ agent_id: "agent_other_telephony" }),
      payload({ called_number: "+15105550000" }),
      payload({ conversation_id: "conv_invalid" }),
      payload({ call_sid: "short" }),
      payload({ branch_id: BRANCH_ID }),
    ]) {
      const response = await initializeTelephony(request(body));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    const wrongMedia = await initializeTelephony(
      request(payload(), `Bearer ${PRECALL_SECRET}`, "text/plain"),
    );
    expect(wrongMedia.status).toBe(415);
  });

  it("fails closed when any telephony fence is unconfigured", async () => {
    delete process.env.PLIVO_BUILDLABS_NUMBER;
    const response = await initializeTelephony(request(payload()));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "telephony_unconfigured",
    });
  });
});
