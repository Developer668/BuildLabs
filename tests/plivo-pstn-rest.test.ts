import { afterEach, describe, expect, it, vi } from "vitest";

import { PlivoRestPstnAdmin } from "../src/adapters/plivo/plivo-reconciler.js";

const AUTH_ID = "authbuildlabs001";
const AUTH_TOKEN = "plivo-token-at-least-twenty-bytes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Plivo REST PSTN adapter", () => {
  it("completes bounded offset pagination without exposing credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = new URL(fetchUrl(input));
      const offset = Number(url.searchParams.get("offset"));
      return Promise.resolve(
        Response.json(
          offset === 0
            ? {
                meta: {
                  limit: 20,
                  offset: 0,
                  total_count: 21,
                  next: "/next",
                },
                objects: Array.from({ length: 20 }, (_, index) => ({
                  id: `resource_${index}`,
                })),
              }
            : {
                meta: {
                  limit: 20,
                  offset: 20,
                  total_count: 21,
                  next: null,
                },
                objects: [{ id: "resource_20" }],
              },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const resources = await new PlivoRestPstnAdmin(
      AUTH_ID,
      AUTH_TOKEN,
    ).listTrunks();
    expect(resources).toHaveLength(21);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(fetchUrl(url)).not.toContain(AUTH_TOKEN);
      expect(fetchUrl(url)).toContain(`/Account/${AUTH_ID}/`);
      expect(options?.headers).toMatchObject({
        accept: "application/json",
      });
    }
  });

  it("fails closed on incomplete pagination and malformed JSON", async () => {
    const incomplete = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          meta: {
            limit: 20,
            offset: 0,
            total_count: 2,
            next: null,
          },
          objects: [{ id: "only_one" }],
        }),
      ),
    );
    vi.stubGlobal("fetch", incomplete);
    await expect(
      new PlivoRestPstnAdmin(AUTH_ID, AUTH_TOKEN).listOriginationUris(),
    ).rejects.toThrow("incomplete");

    const malformed = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("{", { status: 200 })),
    );
    vi.stubGlobal("fetch", malformed);
    await expect(
      new PlivoRestPstnAdmin(AUTH_ID, AUTH_TOKEN).listTrunks(),
    ).rejects.toThrow("malformed JSON");
  });

  it("does not blindly retry a failed mutation", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({ error: "provider failure" }, { status: 503 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new PlivoRestPstnAdmin(AUTH_ID, AUTH_TOKEN);

    await expect(
      provider.assignNumberToTrunk("+15105550123", "trunk_buildlabs_001"),
    ).rejects.toThrow("status 503");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(fetchUrl(url).endsWith("/Number/15105550123/")).toBe(true);
    expect(options?.method).toBe("POST");
    const rawBody = options?.body;
    expect(typeof rawBody).toBe("string");
    if (typeof rawBody !== "string") throw new Error("Missing JSON body");
    expect(JSON.parse(rawBody)).toEqual({
      app_id: "trunk_buildlabs_001",
    });
  });
});

function fetchUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}
