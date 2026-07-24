import { afterEach, describe, expect, it } from "vitest";

import {
  isPrivateServiceHost,
  orchestrationBaseUrl,
} from "../lib/server/orchestration-client";

const ORIGINAL = process.env.BUILDLABS_ORCHESTRATION_URL;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.BUILDLABS_ORCHESTRATION_URL;
  } else {
    process.env.BUILDLABS_ORCHESTRATION_URL = ORIGINAL;
  }
});

describe("service URL safety", () => {
  it("treats loopback and Fly private (.internal) hosts as private", () => {
    expect(isPrivateServiceHost("127.0.0.1")).toBe(true);
    expect(isPrivateServiceHost("localhost")).toBe(true);
    expect(isPrivateServiceHost("::1")).toBe(true);
    expect(isPrivateServiceHost("buildlabs-orchestrator.internal")).toBe(true);
    expect(isPrivateServiceHost("internal")).toBe(true);
  });

  it("treats any publicly routable host as not private", () => {
    expect(isPrivateServiceHost("app.buildlabs.example")).toBe(false);
    expect(isPrivateServiceHost("internal.example.com")).toBe(false);
    expect(isPrivateServiceHost("169.254.169.254")).toBe(false);
  });

  it("accepts plaintext HTTP to a Fly private host", () => {
    process.env.BUILDLABS_ORCHESTRATION_URL =
      "http://buildlabs-orchestrator.internal:3100";
    expect(orchestrationBaseUrl().hostname).toBe(
      "buildlabs-orchestrator.internal",
    );
  });

  it("rejects plaintext HTTP to a public host", () => {
    process.env.BUILDLABS_ORCHESTRATION_URL =
      "http://orchestrator.buildlabs.example";
    expect(() => orchestrationBaseUrl()).toThrow();
  });
});
